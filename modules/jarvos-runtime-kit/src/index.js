'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const harnessDispatch = require('./harness-dispatch.js');
const stewardshipAdapter = require('./stewardship-adapter.js');
const stewardshipBootstrap = require('./stewardship-bootstrap.js');
const openclawPluginPersistence = require('./openclaw-plugin-persistence.js');

const DEFAULT_AGENT_CONTEXT_MCP = 'modules/jarvos-agent-context/scripts/jarvos-mcp.js';
const REQUIRED_MCP_TOOL = 'jarvos_hydrate';
const CONTROL_PLANE_TOOL = 'jarvos_control_plane';
const CONTROL_PLANE_MODULE = 'modules/jarvos-control-plane/scripts/jarvos-manager.js';
const HYDRATION_MODES = ['hook', 'manual', 'unsupported'];
const COMPOUND_ENGINEERING_CAPABILITY_VERSION = 'jarvos-codex-ce-capability.v1';
const COMPOUND_ENGINEERING_OPERATIONS = ['plan', 'work', 'compound'];
const COMPOUND_ENGINEERING_ADMISSION_STATES = ['unsupported', 'supported', 'disabled'];
const COMPOUND_ENGINEERING_REVISION = /^[a-f0-9]{40}$/i;
const CAPABILITY_ALLOWED_KEYS = new Set([
  'schemaVersion', 'version', 'provider', 'harness', 'admission', 'operations',
  'activation', 'discovery', 'invocation', 'proof', 'fixtureRoot', 'fixtureFiles',
  'fixtureTreeDigest',
]);

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

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isSafeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !path.posix.isAbsolute(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..')
    && value.split('\\').every((part) => part && part !== '.' && part !== '..');
}

function isSafeArgv(argv) {
  return Array.isArray(argv)
    && argv.length > 0
    && argv.every((part) => typeof part === 'string' && part.length > 0 && !/[;&|`$()\n\r]/.test(part));
}

function validateCompoundEngineeringCapability(capability) {
  const errors = [];
  if (!isObject(capability)) return { ok: false, errors: ['Compound Engineering capability must be an object'] };
  for (const key of Object.keys(capability)) {
    if (!CAPABILITY_ALLOWED_KEYS.has(key)) errors.push(`capability has unknown field: ${key}`);
  }
  if (capability.schemaVersion !== 1) errors.push('capability.schemaVersion must be 1');
  if (capability.version !== COMPOUND_ENGINEERING_CAPABILITY_VERSION) {
    errors.push(`capability.version must be ${COMPOUND_ENGINEERING_CAPABILITY_VERSION}`);
  }
  if (!isObject(capability.provider)) {
    errors.push('capability.provider is required');
  } else {
    for (const field of ['id', 'version', 'owner', 'repository', 'revision', 'license']) {
      if (typeof capability.provider[field] !== 'string' || capability.provider[field].length === 0) {
        errors.push(`capability.provider.${field} is required`);
      }
    }
    if (capability.provider.id !== 'compound-engineering') errors.push('capability.provider.id must be compound-engineering');
    if (!COMPOUND_ENGINEERING_REVISION.test(capability.provider.revision || '')) errors.push('capability.provider.revision must be an immutable commit');
    if (capability.provider.license !== 'MIT') errors.push('capability.provider.license must be MIT');
    if (!/^https:\/\/github\.com\/EveryInc\/compound-engineering-plugin\.git$/.test(capability.provider.repository || '')) {
      errors.push('capability.provider.repository must be the canonical Compound Engineering repository');
    }
  }
  if (capability.harness !== 'codex') errors.push('capability.harness must be codex');
  if (!COMPOUND_ENGINEERING_ADMISSION_STATES.includes(capability.admission)) {
    errors.push(`capability.admission must be one of: ${COMPOUND_ENGINEERING_ADMISSION_STATES.join(', ')}`);
  }
  if (!Array.isArray(capability.operations)
    || capability.operations.length !== COMPOUND_ENGINEERING_OPERATIONS.length
    || capability.operations.some((operation, index) => operation !== COMPOUND_ENGINEERING_OPERATIONS[index])) {
    errors.push(`capability.operations must be exactly: ${COMPOUND_ENGINEERING_OPERATIONS.join(', ')}`);
  }
  if (!isObject(capability.activation)) {
    errors.push('capability.activation is required');
  } else {
    if (capability.activation.mechanism !== 'codex-plugin-marketplace') errors.push('capability.activation.mechanism must be codex-plugin-marketplace');
    if (capability.activation.candidateOnly !== true) errors.push('capability.activation.candidateOnly must be true until U5 conformance');
    if (capability.activation.requiresRestart !== true) errors.push('capability.activation.requiresRestart must be true');
    for (const field of ['marketplaceArgv', 'pluginArgv']) {
      if (!isSafeArgv(capability.activation[field])) errors.push(`capability.activation.${field} must be a safe argv array`);
    }
  }
  if (!isObject(capability.discovery) || !Array.isArray(capability.discovery.commands) || capability.discovery.commands.length === 0) {
    errors.push('capability.discovery.commands must be a non-empty array');
  } else {
    capability.discovery.commands.forEach((command, index) => {
      if (!isObject(command) || typeof command.id !== 'string' || !isSafeArgv(command.argv)) {
        errors.push(`capability.discovery.commands[${index}] requires id and safe argv`);
        return;
      }
      if (command.argv[0] !== 'codex') errors.push(`capability.discovery.commands[${index}] must invoke codex`);
      if (command.readOnly !== true) errors.push(`capability.discovery.commands[${index}].readOnly must be true`);
      if (command.activatesPluginCode !== false) errors.push(`capability.discovery.commands[${index}].activatesPluginCode must be false`);
    });
  }
  if (!isObject(capability.invocation)) {
    errors.push('capability.invocation is required');
  } else {
    if (capability.invocation.surface !== 'codex exec') errors.push('capability.invocation.surface must be codex exec');
    if (capability.invocation.proof !== 'characterized') errors.push('capability.invocation.proof must be characterized before activation');
  }
  if (!isObject(capability.proof)) {
    errors.push('capability.proof is required');
  } else {
    for (const field of ['artifactBoundary', 'discovery', 'invocation', 'receipt', 'activation']) {
      if (typeof capability.proof[field] !== 'string' || capability.proof[field].length === 0) errors.push(`capability.proof.${field} is required`);
    }
    if (capability.proof.conformant !== false) errors.push('capability.proof.conformant must remain false until U5 conformance');
  }
  if (!isSafeRelativePath(capability.fixtureRoot)) errors.push('capability.fixtureRoot must be a safe repository-relative path');
  if (!Array.isArray(capability.fixtureFiles) || capability.fixtureFiles.length === 0
    || capability.fixtureFiles.some((file) => !isSafeRelativePath(file))) {
    errors.push('capability.fixtureFiles must contain safe relative paths');
  } else if (new Set(capability.fixtureFiles).size !== capability.fixtureFiles.length) {
    errors.push('capability.fixtureFiles must not contain duplicates');
  }
  if (!isSha256(capability.fixtureTreeDigest)) errors.push('capability.fixtureTreeDigest must be a SHA-256 digest');
  if (capability.admission === 'supported' || capability.proof?.conformant === true || capability.activation?.candidateOnly === false) {
    errors.push('candidate-only capability must remain unsupported until the full Codex conformance packet passes');
  }
  return { ok: errors.length === 0, errors };
}

function collectCompoundEngineeringFixtureEntries(root, relative = '') {
  const entries = [];
  const directory = relative ? path.join(root, relative) : root;
  const names = fs.readdirSync(directory).sort();
  for (const name of names) {
    const childRelative = relative ? path.posix.join(relative.replace(/\\/g, '/'), name) : name;
    const child = path.join(root, childRelative);
    const stat = fs.lstatSync(child);
    if (stat.isDirectory()) {
      entries.push(...collectCompoundEngineeringFixtureEntries(root, childRelative));
    } else if (stat.isFile()) {
      entries.push({
        path: childRelative.replace(/\\/g, '/'),
        type: 'file',
        mode: stat.mode & 0o777,
        digest: crypto.createHash('sha256').update(fs.readFileSync(child)).digest('hex'),
      });
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: childRelative.replace(/\\/g, '/'), type: 'symlink', mode: stat.mode & 0o777 });
    } else {
      entries.push({ path: childRelative.replace(/\\/g, '/'), type: 'special', mode: stat.mode & 0o777 });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function computeCompoundEngineeringFixtureDigest(root) {
  const entries = collectCompoundEngineeringFixtureEntries(root);
  const canonical = entries.map((entry) => `${entry.path}\0${entry.type}\0${entry.mode.toString(8)}\0${entry.digest || ''}\n`).join('');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function loadCompoundEngineeringCapability(capabilityPath, options = {}) {
  const root = path.resolve(options.root || repoRootFrom());
  const absolute = path.isAbsolute(capabilityPath) ? capabilityPath : path.join(root, capabilityPath);
  return { path: path.resolve(absolute), capability: readJson(absolute) };
}

function checkCompoundEngineeringCapability(capabilityPath, options = {}) {
  const root = path.resolve(options.root || repoRootFrom());
  const loaded = loadCompoundEngineeringCapability(capabilityPath, { root });
  const capability = loaded.capability;
  const validation = validateCompoundEngineeringCapability(capability);
  const errors = [...validation.errors];
  const fixtureRoot = path.resolve(root, capability.fixtureRoot || '');
  const relativeFixtureRoot = rel(root, fixtureRoot);
  const rootRelative = path.relative(root, fixtureRoot);
  if (rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) errors.push('capability fixtureRoot must remain inside the repository root');
  let entries = [];
  if (errors.length === 0) {
    try {
      const rootStat = fs.lstatSync(fixtureRoot);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) errors.push('capability fixtureRoot must be a real directory');
      else entries = collectCompoundEngineeringFixtureEntries(fixtureRoot);
    } catch (error) {
      errors.push(`capability fixtureRoot is unreadable: ${error.code || error.message}`);
    }
  }
  if (entries.length > 0) {
    const expected = new Set(capability.fixtureFiles || []);
    const actual = new Set(entries.map((entry) => entry.path));
    for (const file of expected) if (!actual.has(file)) errors.push(`capability fixture is missing: ${file}`);
    for (const file of actual) if (!expected.has(file)) errors.push(`capability fixture contains unexpected entry: ${file}`);
    for (const entry of entries) {
      if (entry.type !== 'file') errors.push(`capability fixture entry ${entry.path} must be a regular file`);
      if ((entry.mode & 0o111) !== 0) errors.push(`capability fixture entry ${entry.path} must not be executable`);
    }
    const digest = computeCompoundEngineeringFixtureDigest(fixtureRoot);
    if (isSha256(capability.fixtureTreeDigest) && digest !== capability.fixtureTreeDigest.toLowerCase()) {
      errors.push('capability fixtureTreeDigest does not match the checked-in fixture tree');
    }
  }
  return {
    ok: errors.length === 0,
    capability: {
      id: capability.provider?.id || null,
      version: capability.provider?.version || null,
      admission: capability.admission || null,
      revision: capability.provider?.revision || null,
      fixtureRoot: relativeFixtureRoot,
    },
    fixture: {
      files: entries.filter((entry) => entry.type === 'file').map((entry) => entry.path),
      treeDigest: entries.length > 0 ? computeCompoundEngineeringFixtureDigest(fixtureRoot) : null,
    },
    errors,
  };
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
  if (manifest.controlPlane) {
    if (manifest.controlPlane.module !== CONTROL_PLANE_MODULE) add(errors, `controlPlane.module must be ${CONTROL_PLANE_MODULE}`);
    if (!shared.requiredTools?.includes(CONTROL_PLANE_TOOL)) add(errors, `sharedAgentContext.requiredTools must include ${CONTROL_PLANE_TOOL} when controlPlane is declared`);
    // Omitted hostService is a single "required" error — do not also emit the
    // "must be JARVOS_CONTROL_PLANE_SERVICE_MODULE" message for the same field.
    if (!manifest.controlPlane.hostService) {
      add(errors, 'controlPlane.hostService is required when controlPlane is declared');
    } else if (manifest.controlPlane.hostService !== 'JARVOS_CONTROL_PLANE_SERVICE_MODULE') {
      add(errors, 'controlPlane.hostService must be JARVOS_CONTROL_PLANE_SERVICE_MODULE');
    }
    if (manifest.controlPlane.credentialFile
      && manifest.controlPlane.credentialFile !== 'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE') {
      add(errors, 'controlPlane.credentialFile must be JARVOS_CONTROL_PLANE_CREDENTIAL_FILE');
    }
  }

  for (const [index, target] of (manifest.targets || []).entries()) {
    if (!isObject(target)) {
      add(errors, `targets[${index}] must be an object`);
      continue;
    }
    if (!target.id) add(errors, 'target.id is required');
    if (!target.kind) add(errors, `target ${target.id || '?'} kind is required`);
    if (!target.mcp || typeof target.mcp.supported !== 'boolean') {
      add(errors, `target ${target.id || '?'} mcp.supported is required`);
    }
    if (target.mcp?.supported === false && !target.mcp.reason) {
      add(errors, `target ${target.id || '?'} unsupported MCP requires a reason`);
    }
    if (!target.hydration || !target.hydration.mode) {
      add(errors, `target ${target.id || '?'} hydration.mode is required`);
    }
    if (target.hydration?.mode && !HYDRATION_MODES.includes(target.hydration.mode)) {
      add(errors, `target ${target.id || '?'} hydration.mode must be one of: ${HYDRATION_MODES.join(', ')}`);
    }
    if (target.hydration?.mode === 'unsupported' && !target.hydration.reason) {
      add(errors, `target ${target.id || '?'} unsupported hydration requires a reason`);
    }
  }

  if (manifest.configWrites && !manifest.configWrites.backupBeforeWrite) {
    add(errors, 'configWrites.backupBeforeWrite must be true when configWrites is declared');
  }
  if (manifest.stewardshipAdapter) {
    const bootstrap = stewardshipBootstrap.validateStewardshipBootstrap(manifest.stewardshipAdapter.bootstrap, manifest.id);
    if (!bootstrap.ok) for (const error of bootstrap.errors) add(errors, error);
    const persistence = manifest.stewardshipAdapter.persistence;
    if (persistence !== undefined) {
      if (!isObject(persistence)) {
        add(errors, 'stewardshipAdapter.persistence must be an object');
      } else {
        if (typeof persistence.owner !== 'string' || persistence.owner.length === 0) add(errors, 'stewardshipAdapter.persistence.owner is required');
        const validationContract = persistence.validation;
        if (!isObject(validationContract)) {
          add(errors, 'stewardshipAdapter.persistence.validation is required');
        } else {
          if (!Array.isArray(validationContract.command) || validationContract.command.length === 0 || validationContract.command.some((part) => typeof part !== 'string' || part.length === 0)) {
            add(errors, 'stewardshipAdapter.persistence.validation.command must be a non-empty argv array');
          }
          if (typeof validationContract.schema !== 'string' || validationContract.schema.length === 0) add(errors, 'stewardshipAdapter.persistence.validation.schema is required');
          if (validationContract.readOnly !== true) add(errors, 'stewardshipAdapter.persistence.validation.readOnly must be true');
          if (validationContract.activatesPluginCode !== false) add(errors, 'stewardshipAdapter.persistence.validation.activatesPluginCode must be false');
          if (typeof validationContract.targetPluginId !== 'string' || validationContract.targetPluginId.length === 0) add(errors, 'stewardshipAdapter.persistence.validation.targetPluginId is required');
        }
      }
    }
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

  const mcpServerPath = manifest.sharedAgentContext?.mcpServer;
  const mcpServer = mcpServerPath === DEFAULT_AGENT_CONTEXT_MCP ? path.join(root, mcpServerPath) : null;
  if (mcpServerPath === DEFAULT_AGENT_CONTEXT_MCP && !fs.existsSync(mcpServer)) {
    add(errors, `shared MCP server missing: ${rel(root, mcpServer)}`);
  }
  if (mcpServer && fs.existsSync(mcpServer)) {
    try {
      const mcp = require(mcpServer);
      const tools = Array.isArray(mcp.TOOLS) ? mcp.TOOLS.map((tool) => tool.name) : [];
      if (!tools.includes(REQUIRED_MCP_TOOL)) add(errors, `shared MCP server does not expose ${REQUIRED_MCP_TOOL}`);
      // When a runtime declares controlPlane, the live MCP tool surface must
      // include the control-plane tool — not only jarvos_hydrate.
      if (manifest.controlPlane && !tools.includes(CONTROL_PLANE_TOOL)) {
        add(errors, `shared MCP server does not expose ${CONTROL_PLANE_TOOL}`);
      }
    } catch (error) {
      add(errors, `shared MCP server could not be loaded: ${error.message}`);
    }
  }

  if (manifest.configWrites?.backupBeforeWrite) {
    if (!sourceContains(setupScript, [/backup/i, /copyFileSync/, /\bcp\s+/])) {
      add(errors, 'setup script declares config writes but no backup behavior was detected');
    }
  }

  if (manifest.controlPlane && fs.existsSync(setupScript)) {
    // Manifest-driven: require the declared host/credential env names and an
    // env binding for the host service. Avoid hardcoding a specific runtime CLI
    // (e.g. "codex mcp add") so non-Codex adapters can share the same check.
    const hostEnv = manifest.controlPlane.hostService || 'JARVOS_CONTROL_PLANE_SERVICE_MODULE';
    const credFileEnv = manifest.controlPlane.credentialFile || 'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE';
    const hostEnvRe = new RegExp(escapeRegExp(hostEnv));
    const hostEnvBindRe = new RegExp(`--env\\s+["']?${escapeRegExp(hostEnv)}=`);
    const credFileEnvRe = new RegExp(escapeRegExp(credFileEnv));
    const credFileEnvBindRe = new RegExp(`--env\\s+["']?${escapeRegExp(credFileEnv)}=`);
    // Require host env presence and binding independently. sourceContains uses
    // .some() (OR), so a single call would pass when only one pattern exists.
    if (!sourceContains(setupScript, [hostEnvRe])) {
      add(errors, `control-plane runtime setup must configure ${hostEnv} for the MCP host`);
    } else if (!sourceContains(setupScript, [hostEnvBindRe])) {
      add(errors, `control-plane runtime setup must bind ${hostEnv} into the MCP host environment`);
    }
    // Setup may persist only a non-secret credential *file path*. Registering
    // the raw credential env would put the secret on argv and in host config.
    // Negative lookahead keeps CREDENTIAL_FILE registrations from matching.
    if (sourceContains(setupScript, [
      /--env\s+["']?JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)=/,
    ])) {
      add(errors, 'control-plane runtime setup must not register JARVOS_CONTROL_PLANE_CREDENTIAL (use JARVOS_CONTROL_PLANE_CREDENTIAL_FILE)');
    }
    if (!sourceContains(setupScript, [credFileEnvRe])) {
      add(errors, `control-plane runtime setup must configure ${credFileEnv} for the MCP host`);
    } else if (!sourceContains(setupScript, [credFileEnvBindRe])) {
      add(errors, `control-plane runtime setup must bind ${credFileEnv} into the MCP host environment`);
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

  if (manifest.id === 'codex') {
    const capabilityPath = path.join(runtimeDir, 'compound-engineering-capability.json');
    if (!fs.existsSync(capabilityPath)) {
      add(errors, 'Codex Compound Engineering capability record is missing');
    } else {
      const capabilityCheck = checkCompoundEngineeringCapability(capabilityPath, { root });
      if (!capabilityCheck.ok) {
        for (const error of capabilityCheck.errors) add(errors, `Codex Compound Engineering capability: ${error}`);
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
    verification: [`node modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js check ${JSON.stringify(path.join(targetDir, 'adapter.json'))}`],
  };

  fs.writeFileSync(path.join(targetDir, 'adapter.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'README.md'), `# jarvOS — ${runtimeId} Runtime\n\nThis scaffold registers the shared jarvOS MCP server and keeps hydration manual until the host exposes a supported startup context hook.\n\n## Targets\n\n- ${runtimeId}-cli: manual hydration. Document the exact command or host workflow before shipping this adapter.\n`, 'utf8');
  fs.writeFileSync(path.join(targetDir, 'setup.sh'), '#!/usr/bin/env bash\nset -euo pipefail\n\nbackup_config() {\n  local config_path="$1"\n  if [ -f "$config_path" ]; then\n    cp "$config_path" "$config_path.bak-jarvos-$(date -u +%Y%m%dT%H%M%SZ)"\n  fi\n}\n\necho "TODO: register jarvOS MCP for this runtime after calling backup_config for any user config writes"\n', { encoding: 'utf8', mode: 0o755 });
  return { ok: true, dir: targetDir };
}

module.exports = {
  ...harnessDispatch,
  ...stewardshipAdapter,
  ...stewardshipBootstrap,
  ...openclawPluginPersistence,
  DEFAULT_AGENT_CONTEXT_MCP,
  HYDRATION_MODES,
  REQUIRED_MCP_TOOL,
  CONTROL_PLANE_MODULE,
  CONTROL_PLANE_TOOL,
  COMPOUND_ENGINEERING_CAPABILITY_VERSION,
  checkCompoundEngineeringCapability,
  checkRuntime,
  computeCompoundEngineeringFixtureDigest,
  listRuntimeManifests,
  loadCompoundEngineeringCapability,
  loadManifest,
  repoRootFrom,
  scaffoldRuntime,
  validateCompoundEngineeringCapability,
  validateManifest,
};
