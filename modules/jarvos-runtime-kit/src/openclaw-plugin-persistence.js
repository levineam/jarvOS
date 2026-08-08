'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const CAPABILITY_VERSION = '2026.7.1';
const REGISTRY_SCHEMA = 'openclaw-plugin-registry.v1';
const INSPECTION_SCHEMA = 'openclaw-plugin-inspection-array.v1';
const VERSION_SCHEMA = 'openclaw-version-text.v1';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 512 * 1024;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_VERSION_LENGTH = 64;

const OPENCLAW_PERSISTENCE_CAPABILITIES = Object.freeze({
  version: CAPABILITY_VERSION,
  commands: Object.freeze([
    Object.freeze({
      id: 'version',
      args: Object.freeze(['--version']),
      schema: VERSION_SCHEMA,
      fields: Object.freeze(['version']),
      readOnly: true,
      activatesPluginCode: false,
    }),
    Object.freeze({
      id: 'registry',
      args: Object.freeze(['plugins', 'registry', '--json']),
      schema: REGISTRY_SCHEMA,
      fields: Object.freeze([
        'current.version',
        'current.hostContractVersion',
        'current.plugins[].pluginId',
        'current.plugins[].origin',
        'current.plugins[].source',
        'current.plugins[].rootDir',
        'current.plugins[].manifestPath',
        'current.plugins[].enabled',
        'current.plugins[].packageVersion',
        'current.installRecords.<pluginId>.installPath',
        'current.installRecords.<pluginId>.version',
      ]),
      readOnly: true,
      activatesPluginCode: false,
    }),
    Object.freeze({
      id: 'inspection',
      args: Object.freeze(['plugins', 'inspect', '--all', '--json']),
      schema: INSPECTION_SCHEMA,
      fields: Object.freeze([
        '[].plugin.id',
        '[].plugin.status',
        '[].plugin.enabled',
        '[].plugin.rootDir',
        '[].plugin.version',
        '[].diagnostics[].code',
      ]),
      readOnly: true,
      activatesPluginCode: false,
    }),
  ]),
});

const MANAGED_ORIGINS = new Set(['npm', 'marketplace', 'archive', 'git']);
const HEALTHY_INSPECTION_STATUSES = new Set(['loaded', 'ready', 'ok', 'active']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, maxLength = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function safeIdentifier(value) {
  const identifier = boundedString(value, MAX_IDENTIFIER_LENGTH);
  return identifier && /^[A-Za-z0-9](?:[A-Za-z0-9._@/-]{0,127})$/.test(identifier)
    ? identifier
    : null;
}

function safeVersion(value) {
  const version = boundedString(value, MAX_VERSION_LENGTH);
  return version && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

function isAbsoluteLocalPath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function internalPath(value) {
  return isAbsoluteLocalPath(value) ? boundedString(value, 2048) : null;
}

function fixedResult(status, reason, extra = {}) {
  return {
    status,
    reason,
    ...extra,
  };
}

function compatibility(reason, extra = {}) {
  return fixedResult('compatibility', reason, extra);
}

function indeterminate(reason, extra = {}) {
  return fixedResult('indeterminate', reason, extra);
}

function extractVersion(versionEvidence) {
  if (isObject(versionEvidence)) {
    const direct = safeVersion(versionEvidence.version);
    if (direct) return direct;
    const stdout = typeof versionEvidence.stdout === 'string' && versionEvidence.stdout.length <= 256
      ? versionEvidence.stdout
      : null;
    const match = stdout?.match(/\b(\d+\.\d+\.\d+)\b/);
    return match ? safeVersion(match[1]) : null;
  }
  return safeVersion(versionEvidence);
}

function parseJsonOutput(output) {
  if (typeof output !== 'string' || output.length === 0 || output.length > DEFAULT_OUTPUT_LIMIT) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function normalizeFilesystem(filesystem) {
  if (!isObject(filesystem)) return null;
  if (typeof filesystem.exists !== 'function' || typeof filesystem.isFile !== 'function') return null;
  return filesystem;
}

function normalizeRegistry(registry) {
  if (!isObject(registry) || !isObject(registry.current)) return null;
  const current = registry.current;
  if (current.version !== 1 || current.hostContractVersion !== CAPABILITY_VERSION) return null;
  if (!Array.isArray(current.plugins) || !isObject(current.installRecords)) return null;

  const plugins = [];
  for (const entry of current.plugins) {
    if (!isObject(entry)) return null;
    const id = safeIdentifier(entry.pluginId);
    const origin = boundedString(entry.origin, 64);
    const source = internalPath(entry.source);
    const rootDir = internalPath(entry.rootDir) || (source ? path.dirname(source) : null);
    const manifestPath = internalPath(entry.manifestPath);
    if (!id || !origin || !rootDir || typeof entry.enabled !== 'boolean') return null;
    const packageVersion = entry.packageVersion === undefined ? null : safeVersion(entry.packageVersion);
    if (entry.packageVersion !== undefined && !packageVersion) return null;
    plugins.push({
      id,
      origin,
      source,
      rootDir,
      manifestPath,
      enabled: entry.enabled,
      packageVersion,
    });
  }

  const installRecords = new Map();
  for (const [rawId, rawRecord] of Object.entries(current.installRecords)) {
    const id = safeIdentifier(rawId);
    if (!id || !isObject(rawRecord)) return null;
    const installPath = internalPath(rawRecord.installPath);
    const version = rawRecord.version === undefined
      ? safeVersion(rawRecord.resolvedVersion)
      : safeVersion(rawRecord.version);
    const source = rawRecord.source === undefined ? null : boundedString(rawRecord.source, 64);
    if (!installPath || !version || (rawRecord.source !== undefined && !source)) return null;
    installRecords.set(id, { installPath, version, source });
  }

  return { plugins, installRecords };
}

function normalizeInspections(inspections) {
  if (!Array.isArray(inspections)) return null;
  const normalized = new Map();
  for (const entry of inspections) {
    if (!isObject(entry) || !isObject(entry.plugin)) return null;
    const id = safeIdentifier(entry.plugin.id);
    const status = boundedString(entry.plugin.status, 64);
    if (!id || !status || typeof entry.plugin.enabled !== 'boolean') return null;
    const rootDir = entry.plugin.rootDir === undefined ? null : internalPath(entry.plugin.rootDir);
    const version = entry.plugin.version === undefined ? null : safeVersion(entry.plugin.version);
    if (entry.plugin.rootDir !== undefined && !rootDir) return null;
    if (entry.plugin.version !== undefined && !version) return null;
    const diagnostics = Array.isArray(entry.diagnostics)
      ? entry.diagnostics.map((diagnostic) => (isObject(diagnostic) ? boundedString(diagnostic.code, 64) : boundedString(diagnostic, 64))).filter(Boolean)
      : [];
    normalized.set(id, { status, enabled: entry.plugin.enabled, rootDir, version, diagnostics });
  }
  return normalized;
}

function checkPath(filesystem, filePath, fileCheck = false) {
  try {
    return Boolean(fileCheck ? filesystem.isFile(filePath) : filesystem.exists(filePath));
  } catch {
    return false;
  }
}

function publicPlugin(plugin, classification) {
  return {
    id: plugin.id,
    classification,
    origin: plugin.origin,
    enabled: plugin.enabled,
    version: plugin.packageVersion,
  };
}

function assessOpenClawPluginPersistence(input = {}) {
  const version = extractVersion(input.version);
  if (version !== CAPABILITY_VERSION) return compatibility('unsupported-version', { evidence: { version: version || 'unknown' } });

  const registry = normalizeRegistry(input.registry);
  if (!registry) return compatibility('unsupported-registry-schema');
  const inspections = normalizeInspections(input.inspections);
  if (!inspections) return compatibility('unsupported-inspection-schema');
  const filesystem = normalizeFilesystem(input.filesystem);
  if (!filesystem) return compatibility('filesystem-evidence-unavailable');

  const stagedAdapter = isObject(input.stagedAdapter) ? input.stagedAdapter : null;
  if (!stagedAdapter || typeof stagedAdapter.exists !== 'boolean' || typeof stagedAdapter.manifestExists !== 'boolean') {
    return indeterminate('staged-adapter-evidence-incomplete');
  }

  const resultPlugins = [];
  let hasIndeterminate = false;
  let hasDrift = false;
  let protectedRootCount = 0;

  for (const plugin of registry.plugins) {
    if (!plugin.enabled && plugin.origin === 'bundled') {
      resultPlugins.push(publicPlugin(plugin, 'disabled'));
      continue;
    }

    protectedRootCount += 1;
    const record = registry.installRecords.get(plugin.id);
    const managed = MANAGED_ORIGINS.has(plugin.origin) || Boolean(record);
    if (managed && !record) {
      hasDrift = true;
      resultPlugins.push(publicPlugin(plugin, 'missing-install-record'));
      continue;
    }

    const inspection = inspections.get(plugin.id);
    if (!inspection) {
      hasIndeterminate = true;
      resultPlugins.push(publicPlugin(plugin, 'indeterminate'));
      continue;
    }
    if (inspection.rootDir && inspection.rootDir !== plugin.rootDir) {
      hasIndeterminate = true;
      resultPlugins.push(publicPlugin(plugin, 'indeterminate'));
      continue;
    }
    if (plugin.packageVersion && inspection.version && plugin.packageVersion !== inspection.version) {
      hasDrift = true;
      resultPlugins.push(publicPlugin(plugin, 'version-drift'));
      continue;
    }
    if (plugin.enabled && !HEALTHY_INSPECTION_STATUSES.has(inspection.status)) {
      hasDrift = true;
      resultPlugins.push(publicPlugin(plugin, 'unavailable'));
      continue;
    }
    const installPath = record?.installPath || plugin.rootDir;
    if (!checkPath(filesystem, installPath)) {
      hasDrift = true;
      resultPlugins.push(publicPlugin(plugin, 'missing-install-path'));
      continue;
    }
    if (plugin.manifestPath && !checkPath(filesystem, plugin.manifestPath, true)) {
      hasDrift = true;
      resultPlugins.push(publicPlugin(plugin, 'missing-manifest'));
      continue;
    }
    resultPlugins.push(publicPlugin(plugin, plugin.enabled ? 'healthy' : 'disabled'));
  }

  const jarvosAdapter = stagedAdapter.exists && stagedAdapter.manifestExists
    ? { status: 'healthy' }
    : { status: 'missing-staged-adapter' };
  if (jarvosAdapter.status !== 'healthy') hasDrift = true;

  const status = hasIndeterminate ? 'indeterminate' : (hasDrift ? 'warn' : 'ok');
  return {
    status,
    evidence: {
      version,
      registry: REGISTRY_SCHEMA,
      inspection: INSPECTION_SCHEMA,
      filesystem: 'complete',
    },
    summary: {
      pluginCount: resultPlugins.length,
      protectedRootCount,
      driftCount: resultPlugins.filter((plugin) => !['healthy', 'disabled'].includes(plugin.classification)).length
        + (jarvosAdapter.status === 'healthy' ? 0 : 1),
    },
    plugins: resultPlugins,
    jarvosAdapter,
  };
}

function commandFailure(result) {
  if (!result || result.status !== 'ok') {
    const status = result?.status === 'indeterminate' ? 'indeterminate' : 'compatibility';
    return fixedResult(status, result?.reason || 'command-failed');
  }
  if (typeof result.stdout !== 'string') return compatibility('command-output-unavailable');
  return null;
}

async function collectOpenClawPluginEvidence(options = {}) {
  const executable = options.executable || 'openclaw';
  const runCommand = options.runCommand || ((command) => runOpenClawCommand(command, options));
  const outputs = {};
  for (const capability of OPENCLAW_PERSISTENCE_CAPABILITIES.commands) {
    const result = await runCommand({
      id: capability.id,
      executable,
      args: [...capability.args],
    });
    const failure = commandFailure(result);
    if (failure) return failure;
    outputs[capability.id] = result.stdout;
  }

  const version = extractVersion({ stdout: outputs.version });
  const registry = parseJsonOutput(outputs.registry);
  const inspections = parseJsonOutput(outputs.inspection);
  if (!version || !registry || !inspections) return compatibility('invalid-command-output');
  return assessOpenClawPluginPersistence({
    ...options,
    version: { version },
    registry,
    inspections,
  });
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

function runOpenClawCommand(command, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const outputLimit = Number.isFinite(options.outputLimit) ? Math.max(256, options.outputLimit) : DEFAULT_OUTPUT_LIMIT;
  const executable = boundedString(command?.executable, 256);
  const args = Array.isArray(command?.args) && command.args.every((arg) => typeof arg === 'string' && arg.length <= 512)
    ? command.args
    : null;
  if (!executable || !args) return Promise.resolve(compatibility('invalid-command-vector'));

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(compatibility('spawn-failed'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let outcome = null;
    let timer;
    let killTimer;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };

    const stop = (result) => {
      if (!outcome) outcome = result;
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 100);
    };

    const append = (target, chunk) => {
      const next = `${target}${chunk.toString('utf8')}`;
      if (Buffer.byteLength(next) > outputLimit) {
        stop(compatibility('output-limit'));
        return target;
      }
      return next;
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', () => finish(compatibility('spawn-failed')));
    child.once('close', (code, signal) => {
      if (outcome) {
        finish(outcome);
      } else if (code === 0) {
        finish({ status: 'ok', stdout, stderr: '' });
      } else {
        finish(compatibility('nonzero-exit'));
      }
    });
    timer = setTimeout(() => stop(indeterminate('timeout')), timeoutMs);
  });
}

module.exports = {
  OPENCLAW_PERSISTENCE_CAPABILITIES,
  assessOpenClawPluginPersistence,
  collectOpenClawPluginEvidence,
  runOpenClawCommand,
};
