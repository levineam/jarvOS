'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_AGENT_CONTEXT_MCP = 'modules/jarvos-agent-context/scripts/jarvos-mcp.js';
const REQUIRED_MCP_TOOL = 'jarvos_hydrate';

function repoRootFrom(start = __dirname) {
  let dir = path.resolve(start);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'runtimes'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '..', '..', '..');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function rel(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function add(errors, message) {
  errors.push(message);
}

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!isObject(manifest)) return { ok: false, errors: ['manifest must be an object'], warnings };
  if (!manifest.schemaVersion) add(errors, 'schemaVersion is required');
  if (!manifest.id || !/^[a-z0-9-]+$/.test(manifest.id)) add(errors, 'id must be a kebab-case string');
  if (!manifest.displayName) add(errors, 'displayName is required');
  if (!manifest.setup || !manifest.setup.script) add(errors, 'setup.script is required');
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) add(errors, 'targets must be a non-empty array');
  if (!isObject(manifest.sharedAgentContext)) add(errors, 'sharedAgentContext is required');

  const shared = manifest.sharedAgentContext || {};
  if (shared.mcpServer !== DEFAULT_AGENT_CONTEXT_MCP) {
    add(errors, `sharedAgentContext.mcpServer must be ${DEFAULT_AGENT_CONTEXT_MCP}`);
  }
  if (!Array.isArray(shared.requiredTools) || !shared.requiredTools.includes(REQUIRED_MCP_TOOL)) {
    add(errors, `sharedAgentContext.requiredTools must include ${REQUIRED_MCP_TOOL}`);
  }

  for (const [index, target] of (manifest.targets || []).entries()) {
    if (!isObject(target)) {
      add(errors, `targets[${index}] must be an object`);
      continue;
    }
    if (!target.id) add(errors, 'target.id is required');
    if (!target.kind) add(errors, `target ${target.id || '?'} kind is required`);
    if (!target.mcp || target.mcp.supported !== true) {
      add(errors, `target ${target.id || '?'} must support shared MCP`);
    }
    if (!target.hydration || !target.hydration.mode) {
      add(errors, `target ${target.id || '?'} hydration.mode is required`);
    }
    if (target.hydration?.mode === 'unsupported' && !target.hydration.reason) {
      add(errors, `target ${target.id || '?'} unsupported hydration requires a reason`);
    }
  }

  if (manifest.configWrites && !manifest.configWrites.backupBeforeWrite) {
    add(errors, 'configWrites.backupBeforeWrite must be true when configWrites is declared');
  }
  if (manifest.unsupportedCapabilities && !Array.isArray(manifest.unsupportedCapabilities)) {
    add(errors, 'unsupportedCapabilities must be an array');
  }
  if (!Array.isArray(manifest.verification) || manifest.verification.length === 0) {
    warnings.push('verification commands are recommended');
  }

  return { ok: errors.length === 0, errors, warnings };
}

function loadManifest(manifestPath) {
  const absolute = path.resolve(manifestPath);
  return {
    path: absolute,
    manifest: readJson(absolute),
    runtimeDir: path.dirname(absolute),
  };
}

function listRuntimeManifests(root = repoRootFrom()) {
  const runtimesDir = path.join(root, 'runtimes');
  if (!fs.existsSync(runtimesDir)) return [];
  return fs.readdirSync(runtimesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runtimesDir, entry.name, 'adapter.json'))
    .filter((filePath) => fs.existsSync(filePath))
    .sort();
}

function sourceContains(filePath, patterns) {
  if (!fs.existsSync(filePath)) return false;
  if (!fs.statSync(filePath).isFile()) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  return patterns.some((pattern) => pattern.test(content));
}

function checkRuntime(manifestPath, options = {}) {
  const root = path.resolve(options.root || repoRootFrom());
  const loaded = loadManifest(path.isAbsolute(manifestPath) ? manifestPath : path.join(root, manifestPath));
  const { manifest, runtimeDir } = loaded;
  const validation = validateManifest(manifest);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];

  const setupScript = path.join(runtimeDir, manifest.setup?.script || '');
  if (!fs.existsSync(setupScript)) add(errors, `setup script missing: ${rel(root, setupScript)}`);

  const readmePath = path.join(runtimeDir, 'README.md');
  if (!fs.existsSync(readmePath)) add(errors, `README missing: ${rel(root, readmePath)}`);

  const mcpServer = path.join(root, manifest.sharedAgentContext?.mcpServer || '');
  if (!fs.existsSync(mcpServer)) add(errors, `shared MCP server missing: ${rel(root, mcpServer)}`);
  if (fs.existsSync(mcpServer)) {
    try {
      const mcp = require(mcpServer);
      const tools = Array.isArray(mcp.TOOLS) ? mcp.TOOLS.map((tool) => tool.name) : [];
      if (!tools.includes(REQUIRED_MCP_TOOL)) add(errors, `shared MCP server does not expose ${REQUIRED_MCP_TOOL}`);
    } catch (error) {
      add(errors, `shared MCP server could not be loaded: ${error.message}`);
    }
  }

  if (manifest.configWrites?.backupBeforeWrite) {
    if (!sourceContains(setupScript, [/backup/i, /copyFileSync/, /\bcp\s+/])) {
      add(errors, 'setup script declares config writes but no backup behavior was detected');
    }
  }

  for (const target of manifest.targets || []) {
    if (!isObject(target)) continue;
    if (target.hydration?.mode === 'hook') {
      const hookScript = path.join(runtimeDir, target.hydration.script || '');
      if (!fs.existsSync(hookScript)) {
        add(errors, `hook script missing for ${target.id}: ${rel(root, hookScript)}`);
      } else if (!sourceContains(hookScript, [/fail open/i, /writeJson\(\{\}\)/, /JSON\.stringify\(\{\}\)/])) {
        add(errors, `hook script for ${target.id} does not appear to fail open`);
      }
    }
    if (target.hydration?.mode === 'manual' || target.hydration?.mode === 'unsupported') {
      const targetIdPattern = new RegExp(escapeRegExp(target.id || ''), 'i');
      const documentsTarget = fs.existsSync(readmePath) && sourceContains(readmePath, [targetIdPattern]);
      const documentsHydrationMode = fs.existsSync(readmePath) && sourceContains(readmePath, [/manual|unsupported|not supported/i]);
      if (!documentsTarget || !documentsHydrationMode) {
        add(errors, `README must document manual or unsupported hydration for ${target.id}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    manifest: rel(root, loaded.path),
    id: manifest.id,
    errors,
    warnings,
  };
}

function scaffoldRuntime(runtimeId, outDir) {
  if (!runtimeId || !/^[a-z0-9-]+$/.test(runtimeId)) throw new Error('runtime id must be kebab-case');
  const targetDir = path.resolve(outDir || path.join(process.cwd(), runtimeId));
  fs.mkdirSync(targetDir, { recursive: true });

  const manifest = {
    schemaVersion: 1,
    id: runtimeId,
    displayName: runtimeId,
    sharedAgentContext: {
      mcpServer: DEFAULT_AGENT_CONTEXT_MCP,
      requiredTools: ['jarvos_current_work', 'jarvos_recall', 'jarvos_create_note', 'jarvos_startup_brief', REQUIRED_MCP_TOOL],
    },
    targets: [
      {
        id: `${runtimeId}-cli`,
        kind: 'cli',
        mcp: { supported: true, registration: 'documented' },
        hydration: { mode: 'manual', reason: 'Add a native hook when the host supports startup context injection.' },
      },
    ],
    setup: { script: 'setup.sh' },
    configWrites: { backupBeforeWrite: true },
    unsupportedCapabilities: [],
    verification: [`node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check ${runtimeId}`],
  };

  fs.writeFileSync(path.join(targetDir, 'adapter.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'README.md'), `# jarvOS — ${runtimeId} Runtime\n\nThis scaffold registers the shared jarvOS MCP server and keeps hydration manual until the host exposes a supported startup context hook.\n\n## Targets\n\n- ${runtimeId}-cli: manual hydration. Document the exact command or host workflow before shipping this adapter.\n`, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'setup.sh'), '#!/usr/bin/env bash\nset -euo pipefail\n\nbackup_config() {\n  local config_path="$1"\n  if [ -f "$config_path" ]; then\n    cp "$config_path" "$config_path.bak-jarvos-$(date -u +%Y%m%dT%H%M%SZ)"\n  fi\n}\n\necho "TODO: register jarvOS MCP for this runtime after calling backup_config for any user config writes"\n', { encoding: 'utf8', mode: 0o755 });
  return { ok: true, dir: targetDir };
}

module.exports = {
  DEFAULT_AGENT_CONTEXT_MCP,
  REQUIRED_MCP_TOOL,
  checkRuntime,
  listRuntimeManifests,
  loadManifest,
  repoRootFrom,
  scaffoldRuntime,
  validateManifest,
};
