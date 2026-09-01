'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const harnessDispatch = require('./harness-dispatch.js');
const commonWorkService = require('./common-work-service.js');
const { isSha256 } = harnessDispatch;
const stewardshipAdapter = require('./stewardship-adapter.js');
const stewardshipBootstrap = require('./stewardship-bootstrap.js');
const dispatcherConformance = require('./dispatcher-conformance.js');
const openclawPluginPersistence = require('./openclaw-plugin-persistence.js');
const capabilityDescriptor = require('./capability-descriptor.js');
const operatorNotification = require('./operator-notification.js');
const operatorNotificationLint = require('./operator-notification-lint.js');
const managedActivation = require('./managed-activation.js');
const providerSelection = require('./provider-selection.js');
const providerPreference = require('./provider-preference.js');
const runtimeModeContract = require('./runtime-mode-contract.js');
const constrainedGeneration = require('./constrained-generation.js');

const DEFAULT_AGENT_CONTEXT_MCP = 'modules/jarvos-agent-context/scripts/jarvos-mcp.js';
const REQUIRED_MCP_TOOL = 'jarvos_hydrate';
const CONTROL_PLANE_TOOL = 'jarvos_control_plane';
const CONTROL_PLANE_MODULE = 'modules/jarvos-control-plane/scripts/jarvos-manager.js';
const GBRAIN_CONTINUITY_VERSION = 'jarvos-gbrain-continuity/v1';
const GBRAIN_PROVIDER_LAUNCHER = 'modules/jarvos-gbrain/scripts/jarvos-gbrain-provider.js';
const GBRAIN_DESCRIPTOR_ENV = 'JARVOS_GBRAIN_RUNTIME_DESCRIPTOR';
const GBRAIN_CONTINUITY_HARNESSES = new Set(['codex', 'hermes', 'openclaw']);
const GBRAIN_REQUIRED_TOOLS = Object.freeze(['get_brain_identity', 'recall', 'remember', 'list_skills', 'get_skill']);
const GBRAIN_NATIVE_REGISTRATION = Object.freeze({
  codex: {
    command: 'codex mcp add gbrain --env JARVOS_GBRAIN_RUNTIME_DESCRIPTOR=<owner-only-descriptor> -- node <provider-launcher>',
    verification: 'codex mcp get gbrain followed by a native recall turn',
  },
  hermes: {
    command: 'hermes mcp add gbrain --command node --env JARVOS_GBRAIN_RUNTIME_DESCRIPTOR=<owner-only-descriptor> --args <provider-launcher>',
    verification: 'hermes mcp test gbrain followed by a native recall turn',
  },
  openclaw: {
    command: 'openclaw mcp add gbrain --command node --arg <provider-launcher> --env JARVOS_GBRAIN_RUNTIME_DESCRIPTOR=<owner-only-descriptor>',
    verification: 'openclaw mcp probe gbrain --json followed by a native recall turn',
  },
});
const HYDRATION_MODES = ['hook', 'manual', 'unsupported'];
const COMPOUND_ENGINEERING_CAPABILITY_VERSION = 'jarvos-codex-ce-capability.v1';
const COMPOUND_ENGINEERING_OPERATIONS = ['plan', 'work', 'compound'];
const COMPOUND_ENGINEERING_ADMISSION_STATES = ['unsupported', 'supported', 'disabled'];
const COMPOUND_ENGINEERING_REVISION = /^[a-f0-9]{40}$/i;
const MANAGED_ACTIVATION_OWNER_EVIDENCE_VERSION = 'jarvos-managed-activation-owner-evidence/v1';
const MANAGED_ACTIVATION_HARNESS_ORDER = Object.freeze(['claude', 'codex', 'hermes', 'openclaw']);
const MANAGED_ACTIVATION_SESSION_EVENTS = new Set([
  'SessionStart',
  'on_session_start',
  'session-start',
  'session_start',
  'start-or-resume',
  'startOrResume',
  'launcher',
]);
const MANAGED_ACTIVATION_TURN_EVENTS = new Set([
  'UserPromptSubmit',
  'pre_llm_call',
  'agent_turn_prepare',
  'session-turn',
  'session_turn',
  'heartbeat',
  'user-prompt',
  'user_prompt',
]);
const MANAGED_ACTIVATION_SESSION_CAPABILITIES = new Set(['startOrResume']);
const MANAGED_ACTIVATION_TURN_CAPABILITIES = new Set(['heartbeat', 'nextTurnInput']);
const CAPABILITY_ALLOWED_KEYS = new Set([
  'schemaVersion', 'version', 'provider', 'harness', 'admission', 'operations',
  'activation', 'discovery', 'invocation', 'proof', 'fixtureRoot', 'fixtureFiles',
  'fixtureTreeDigest',
]);
const CONFORMANCE_ALLOWED_KEYS = new Set([
  'schemaVersion', 'provider', 'approvedVersion', 'approvedRevision', 'status',
  'discovery', 'activation', 'invocation', 'receipt', 'capabilityDenial',
  'rollback', 'fallback', 'admission', 'reviewedEvidence',
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
    if (typeof capability.activation.candidateOnly !== 'boolean') errors.push('capability.activation.candidateOnly must be boolean');
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
    if (!['characterized', 'conformant'].includes(capability.invocation.proof)) errors.push('capability.invocation.proof must be characterized or conformant');
  }
  if (!isObject(capability.proof)) {
    errors.push('capability.proof is required');
  } else {
    for (const field of ['artifactBoundary', 'discovery', 'invocation', 'receipt', 'activation']) {
      if (typeof capability.proof[field] !== 'string' || capability.proof[field].length === 0) errors.push(`capability.proof.${field} is required`);
    }
    if (typeof capability.proof.conformant !== 'boolean') errors.push('capability.proof.conformant must be boolean');
  }
  if (!isSafeRelativePath(capability.fixtureRoot)) errors.push('capability.fixtureRoot must be a safe repository-relative path');
  if (!Array.isArray(capability.fixtureFiles) || capability.fixtureFiles.length === 0
    || capability.fixtureFiles.some((file) => !isSafeRelativePath(file))) {
    errors.push('capability.fixtureFiles must contain safe relative paths');
  } else if (new Set(capability.fixtureFiles).size !== capability.fixtureFiles.length) {
    errors.push('capability.fixtureFiles must not contain duplicates');
  }
  if (!isSha256(capability.fixtureTreeDigest)) errors.push('capability.fixtureTreeDigest must be a SHA-256 digest');
  if (capability.admission === 'unsupported') {
    if (capability.activation?.candidateOnly !== true) errors.push('unsupported capability must remain candidate-only');
    if (capability.proof?.conformant !== false) errors.push('unsupported capability cannot claim conformance');
  } else {
    if (capability.activation?.candidateOnly !== false) errors.push('supported or disabled capability must not remain candidate-only');
    if (capability.proof?.conformant !== true) errors.push('supported or disabled capability requires conformance proof');
    if (capability.invocation?.proof !== 'conformant') errors.push('supported or disabled capability requires a conformant invocation proof');
  }
  return { ok: errors.length === 0, errors };
}

function validateCodexConformanceReceipt(receipt, { capability } = {}) {
  const errors = [];
  if (!isObject(receipt)) return { ok: false, errors: ['Codex conformance receipt must be an object'] };
  for (const key of Object.keys(receipt)) if (!CONFORMANCE_ALLOWED_KEYS.has(key)) errors.push(`conformance receipt has unknown field: ${key}`);
  if (receipt.schemaVersion !== 'jarvos-codex-provider-conformance/v1') errors.push('conformance receipt schemaVersion is invalid');
  if (receipt.provider !== 'compound-engineering') errors.push('conformance receipt provider must be compound-engineering');
  if (typeof receipt.approvedVersion !== 'string' || receipt.approvedVersion !== capability?.provider?.version) errors.push('conformance receipt approvedVersion is not the shipped pin');
  if (typeof receipt.approvedRevision !== 'string' || receipt.approvedRevision !== capability?.provider?.revision) errors.push('conformance receipt approvedRevision is not the shipped pin');
  if (receipt.status !== 'passed') errors.push('conformance receipt status must be passed');
  if (receipt.admission !== 'supported') errors.push('conformance receipt admission must be supported');
  const discovery = receipt.discovery;
  if (!isObject(discovery) || typeof discovery.codexVersion !== 'string' || discovery.marketplaceRevisionObserved !== true || discovery.installedVersionObserved !== true || discovery.profileBoundary !== 'CODEX_HOME'
    || discovery.marketplaceRevision !== receipt.approvedRevision
    || discovery.marketplaceSource !== 'https://github.com/EveryInc/compound-engineering-plugin.git') {
    errors.push('conformance receipt discovery evidence is incomplete');
  }
  const activation = receipt.activation;
  if (!isObject(activation) || activation.mechanism !== 'codex-plugin-marketplace' || activation.pinObserved !== true || activation.configurationPreserved !== true || activation.restartBoundary !== 'verified') {
    errors.push('conformance receipt activation evidence is incomplete');
  }
  const invocation = receipt.invocation;
  if (!isObject(invocation) || invocation.surface !== 'codex exec' || invocation.status !== 'passed' || invocation.profile !== 'disposable CODEX_HOME' || invocation.restartBoundary !== 'verified' || !Array.isArray(invocation.operations) || !['plan', 'work'].every((operation) => invocation.operations.includes(operation))) {
    errors.push('conformance receipt invocation evidence is incomplete');
  }
  const receiptEvidence = receipt.receipt;
  if (!isObject(receiptEvidence) || receiptEvidence.status !== 'passed' || receiptEvidence.strictContract !== 'validated' || receiptEvidence.providerIndependentAuthority !== 'validated' || !isSha256(receiptEvidence.planArtifactDigest) || !isSha256(receiptEvidence.workArtifactDigest)) {
    errors.push('conformance receipt strict receipt evidence is incomplete');
  }
  const denial = receipt.capabilityDenial;
  if (!isObject(denial) || denial.status !== 'passed' || denial.filesystem !== 'worktree-only' || denial.sandbox !== 'read-only denial verified' || !Array.isArray(denial.required) || !['credentials', 'network', 'profile-state', 'privileged-tools'].every((capabilityName) => denial.required.includes(capabilityName))) {
    errors.push('conformance receipt denied-capability evidence is incomplete');
  }
  const rollback = receipt.rollback;
  if (!isObject(rollback) || rollback.status !== 'passed' || rollback.pluginRemoved !== true || rollback.marketplaceRemoved !== true || rollback.unrelatedConfigPreserved !== true) {
    errors.push('conformance receipt rollback evidence is incomplete');
  }
  const fallback = receipt.fallback;
  if (!isObject(fallback) || fallback.status !== 'passed' || fallback.route !== 'jarvos-native-workflow' || fallback.sameRun !== true || fallback.sameWorktree !== true) {
    errors.push('conformance receipt fallback evidence is incomplete');
  }
  if (typeof receipt.reviewedEvidence !== 'string' || receipt.reviewedEvidence.length < 1 || receipt.reviewedEvidence.length > 500 || /[\0\r\n]/.test(receipt.reviewedEvidence)) errors.push('conformance receipt reviewedEvidence must be bounded text');
  return { ok: errors.length === 0, errors, receipt };
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

function computeCompoundEngineeringFixtureDigest(root, entries = null) {
  const fixtureEntries = entries || collectCompoundEngineeringFixtureEntries(root);
  const canonical = fixtureEntries.map((entry) => `${entry.path}\0${entry.type}\0${entry.mode.toString(8)}\0${entry.digest || ''}\n`).join('');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function loadCompoundEngineeringCapability(capabilityPath, options = {}) {
  const root = path.resolve(options.root || repoRootFrom());
  const absolute = path.isAbsolute(capabilityPath) ? capabilityPath : path.join(root, capabilityPath);
  return { path: path.resolve(absolute), capability: readJson(absolute) };
}

function checkCompoundEngineeringCapability(capabilityPath, options = {}) {
  const root = path.resolve(options.root || repoRootFrom());
  const loaded = options.capability
    ? { path: path.resolve(capabilityPath), capability: options.capability }
    : loadCompoundEngineeringCapability(capabilityPath, { root });
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
    const digest = computeCompoundEngineeringFixtureDigest(fixtureRoot, entries);
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
      treeDigest: entries.length > 0 ? computeCompoundEngineeringFixtureDigest(fixtureRoot, entries) : null,
    },
    errors,
  };
}

/**
 * Classify the active Codex CE installation without granting it admission.
 * Discovery evidence is deliberately a small public projection; callers must
 * not pass raw config paths or command output through this boundary.
 */
function classifyCompoundEngineeringProvider({ capability, capabilityCheck, evidence = {} } = {}) {
  if (!capabilityCheck?.ok || !isObject(capability)) {
    return {
      status: 'incompatible',
      reason: 'capability-record-invalid',
      recoveryAction: 'repair the shipped capability record before retrying provider discovery',
    };
  }
  if (evidence.localModified === true) {
    return {
      status: 'local-modified',
      reason: 'managed provider state differs from the jarvOS-owned projection',
      recoveryAction: 'preserve local changes, inspect the profile, and explicitly reconcile or disable the provider',
    };
  }
  const marketplace = Array.isArray(evidence.marketplaces)
    ? evidence.marketplaces.find((entry) => entry?.name === 'compound-engineering-plugin')
    : null;
  if (marketplace && typeof marketplace.source === 'string'
    && marketplace.source !== 'https://github.com/EveryInc/compound-engineering-plugin.git') {
    return {
      status: 'incompatible',
      reason: 'configured provider marketplace source does not match the approved repository',
      recoveryAction: 'preserve the profile and reconcile only through the approved jarvOS pin',
      approvedVersion: capability.provider.version,
      activeVersion: null,
    };
  }
  if (marketplace && typeof marketplace.revision === 'string' && marketplace.revision !== capability.provider.revision) {
    return {
      status: 'incompatible',
      reason: 'configured provider marketplace revision does not match the approved pin',
      recoveryAction: 'preserve the profile and reconcile only through the approved jarvOS pin',
      approvedVersion: capability.provider.version,
      activeVersion: null,
    };
  }
  const active = Array.isArray(evidence.installed)
    ? evidence.installed.find((entry) => entry?.name === 'compound-engineering' || entry?.pluginId === 'compound-engineering@compound-engineering-plugin')
    : null;
  if (!active) {
    return {
      status: 'not-installed',
      reason: 'approved provider is not installed in the inspected Codex profile',
      recoveryAction: 'install the approved jarvOS provider only after the conformance receipt is reviewed',
      approvedVersion: capability.provider.version,
      activeVersion: null,
    };
  }
  if (active.enabled === false) {
    return {
      status: 'degraded',
      reason: 'approved provider is installed but disabled',
      recoveryAction: 'enable the jarvOS-owned provider or use the native jarvOS fallback',
      approvedVersion: capability.provider.version,
      activeVersion: active.version || null,
    };
  }
  if (!marketplace || marketplace.revision !== capability.provider.revision) {
    return {
      status: 'degraded',
      reason: 'installed provider does not have an independently verified approved marketplace revision',
      recoveryAction: 'rerun the profile-scoped provider reconciliation before relying on managed CE',
      approvedVersion: capability.provider.version,
      activeVersion: active.version || null,
    };
  }
  if (active.version !== capability.provider.version) {
    return {
      status: 'incompatible',
      reason: 'installed provider version does not match the approved pin',
      recoveryAction: 'stage a reviewed jarvOS provider pin before updating the active profile',
      approvedVersion: capability.provider.version,
      activeVersion: active.version || null,
    };
  }
  if (capability.admission !== 'supported' || capability.proof?.conformant !== true || capability.activation?.candidateOnly === true) {
    return {
      status: 'unsupported',
      reason: 'Codex provider installation is discovered, but the checked-in conformance proof does not admit activation',
      recoveryAction: 'continue through the jarvOS native workflow and review a Codex conformance receipt before activation',
      approvedVersion: capability.provider.version,
      activeVersion: active.version || null,
    };
  }
  if (evidence.conformance?.status !== 'passed' || evidence.conformance?.providerRevision !== capability.provider.revision) {
    return {
      status: 'degraded',
      reason: 'provider discovery passed but the required invocation and receipt conformance evidence is missing or stale',
      recoveryAction: 'rerun the disposable Codex conformance fixture before relying on managed CE',
      approvedVersion: capability.provider.version,
      activeVersion: active.version || null,
    };
  }
  return {
    status: 'healthy',
    reason: 'approved provider is installed, discovered, and backed by the reviewed conformance receipt',
    recoveryAction: 'none',
    approvedVersion: capability.provider.version,
    activeVersion: active.version || null,
  };
}

function compactCodexPlugin(entry = {}) {
  return {
    pluginId: typeof entry.pluginId === 'string' ? entry.pluginId : null,
    name: typeof entry.name === 'string' ? entry.name : null,
    version: typeof entry.version === 'string' ? entry.version : null,
    enabled: entry.enabled !== false,
  };
}

function compactCodexMarketplace(entry = {}) {
  const compact = {
    name: typeof entry.name === 'string' ? entry.name : null,
    source: null,
    revision: null,
  };
  if (typeof entry.root !== 'string' || !path.isAbsolute(entry.root)) return compact;
  try {
    const profileRoot = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const marketplaceRoot = path.resolve(entry.root);
    const relative = path.relative(profileRoot, marketplaceRoot);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return compact;
    const rootStat = fs.lstatSync(marketplaceRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return compact;
    const metadataPath = path.join(marketplaceRoot, '.codex-marketplace-install.json');
    const stat = fs.lstatSync(metadataPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return compact;
    const metadata = readJson(metadataPath);
    compact.source = typeof metadata.source === 'string' ? metadata.source : null;
    compact.revision = typeof metadata.revision === 'string' ? metadata.revision : null;
  } catch (_) {
    // A missing or malformed local metadata file is represented as an unverified
    // marketplace; classification will keep the provider degraded or incompatible.
  }
  return compact;
}

function collectCodexCompoundEngineeringEvidence(options = {}) {
  if (isObject(options.evidence)) return options.evidence;
  const executable = options.executable || 'codex';
  const env = options.env || process.env;
  const run = (args) => {
    const result = spawnSync(executable, args, {
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs || 5000,
      maxBuffer: options.maxBuffer || 512 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    try { return JSON.parse(result.stdout || '{}'); } catch (_) { return null; }
  };
  let codexVersion = null;
  const version = spawnSync(executable, ['--version'], {
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 5000,
    maxBuffer: options.maxBuffer || 64 * 1024,
  });
  if (!version.error && version.status === 0) {
    const match = String(version.stdout || '').match(/(?:codex-cli\s+)?([^\s]+)/i);
    codexVersion = match ? match[1] : null;
  }
  const installedPayload = run(['plugin', 'list', '--json']);
  const marketplacePayload = run(['plugin', 'marketplace', 'list', '--json']);
  return {
    codexAvailable: Boolean(codexVersion),
    codexVersion,
    installed: Array.isArray(installedPayload?.installed) ? installedPayload.installed.map(compactCodexPlugin) : [],
    marketplaces: Array.isArray(marketplacePayload?.marketplaces)
      ? marketplacePayload.marketplaces.map(compactCodexMarketplace)
      : [],
  };
}

function inspectCompoundEngineeringProvider(options = {}) {
  const root = path.resolve(options.root || repoRootFrom());
  const capabilityPath = options.capabilityPath || path.join(root, 'runtimes', 'codex', 'compound-engineering-capability.json');
  let loaded;
  let capabilityCheck;
  try {
    loaded = loadCompoundEngineeringCapability(capabilityPath, { root });
    capabilityCheck = checkCompoundEngineeringCapability(capabilityPath, { root, capability: loaded.capability });
  } catch (error) {
    return {
      status: 'incompatible',
      reason: 'capability-record-unreadable',
      recoveryAction: 'repair the shipped capability record before retrying provider discovery',
      error: error.message,
    };
  }
  const evidence = collectCodexCompoundEngineeringEvidence(options);
  let conformance = null;
  const conformancePath = options.conformancePath || path.join(root, 'runtimes', 'codex', 'compound-engineering-conformance.json');
  if (fs.existsSync(conformancePath)) {
    try {
      const receipt = readJson(conformancePath);
      const receiptValidation = validateCodexConformanceReceipt(receipt, { capability: loaded.capability });
      conformance = {
        status: receiptValidation.ok && receipt.status === 'passed' ? 'passed' : 'invalid',
        providerRevision: typeof receipt.approvedRevision === 'string' ? receipt.approvedRevision : null,
        errors: receiptValidation.errors,
      };
    } catch (_) {
      conformance = { status: 'invalid', providerRevision: null };
    }
  }
  const classification = classifyCompoundEngineeringProvider({
    capability: loaded.capability,
    capabilityCheck,
    evidence: { ...evidence, conformance },
  });
  const active = evidence.installed?.find((entry) => entry?.name === 'compound-engineering') || null;
  return {
    ...classification,
    capability: {
      id: loaded.capability.provider?.id || null,
      approvedVersion: loaded.capability.provider?.version || null,
      approvedRevision: loaded.capability.provider?.revision || null,
      admission: loaded.capability.admission || null,
    },
    discovery: {
      codexVersion: evidence.codexVersion || null,
      marketplaceFound: Boolean(evidence.marketplaces?.some((entry) => entry.name === 'compound-engineering-plugin')),
      installed: Boolean(active),
      activeVersion: active?.version || null,
      conformance: conformance?.status || 'missing',
    },
    errors: capabilityCheck.errors || [],
  };
}

function mapConcreteEventToPublicClass(event) {
  if (typeof event !== 'string' || event.length === 0) return null;
  if (MANAGED_ACTIVATION_SESSION_EVENTS.has(event)) return 'session';
  if (MANAGED_ACTIVATION_TURN_EVENTS.has(event)) return 'turn';
  if (/session[_\s-]?start|start[_\s-]?or[_\s-]?resume|^launcher$/i.test(event)) return 'session';
  if (/heartbeat|pre[_\s-]?llm|agent[_\s-]?turn|user[_\s-]?prompt|session[_\s-]?turn/i.test(event)) return 'turn';
  return null;
}

function expectedManagedActivationPolicy(harness) {
  const normalized = managedActivation.normalizeHarnessId(harness);
  if (!normalized) return null;
  const shared = {
    version: managedActivation.MANAGED_ACTIVATION_CONTRACT_VERSION,
    harness: normalized,
    preparation: { requiresExactSetup: true, requiresSelectedTuple: true },
    health: { mayActivate: false, mayExplainDegradation: true },
    rollback: {
      ownership: 'exact-owned',
      invalidatesGeneration: true,
      refuseModified: true,
    },
  };
  if (normalized === 'claude' || normalized === 'codex') {
    return {
      ...shared,
      executionOwner: 'native-hooks',
      backgroundProcess: { owner: 'none', jarvosStartsProcess: false },
      liveProof: {
        qualifyingEventClasses: ['session', 'turn'],
        producerEvents: managedActivation.MANAGED_ACTIVATION_PRODUCER_EVENTS[normalized],
        freshnessSeconds: managedActivation.LIVE_PROOF_FRESHNESS_SECONDS,
        forwardSkewSeconds: managedActivation.LIVE_PROOF_FORWARD_SKEW_SECONDS,
      },
    };
  }
  return {
    ...shared,
    executionOwner: 'harness-process',
    backgroundProcess: { owner: 'harness', jarvosStartsProcess: false },
    liveProof: {
      requiredSequence: ['session', 'turn'],
      producerEvents: managedActivation.MANAGED_ACTIVATION_PRODUCER_EVENTS[normalized],
      freshnessSeconds: managedActivation.LIVE_PROOF_FRESHNESS_SECONDS,
      forwardSkewSeconds: managedActivation.LIVE_PROOF_FORWARD_SKEW_SECONDS,
    },
  };
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validateManagedActivationPolicy(contract, expected, errors) {
  if (!expected) return;
  if (contract.executionOwner !== expected.executionOwner) {
    errors.push(`managedActivation.executionOwner must be ${expected.executionOwner}`);
  }
  if (!isObject(contract.backgroundProcess)
    || contract.backgroundProcess.owner !== expected.backgroundProcess.owner
    || contract.backgroundProcess.jarvosStartsProcess !== false) {
    errors.push(`managedActivation.backgroundProcess must be owner=${expected.backgroundProcess.owner} with jarvosStartsProcess=false`);
  }
  if (Array.isArray(expected.liveProof.qualifyingEventClasses)) {
    if (!sameStringSet(contract.liveProof?.qualifyingEventClasses, expected.liveProof.qualifyingEventClasses)
      || contract.liveProof?.requiredSequence !== undefined) {
      errors.push('managedActivation.liveProof must declare qualifyingEventClasses session|turn only');
    }
  } else if (!Array.isArray(contract.liveProof?.requiredSequence)
    || contract.liveProof.requiredSequence.length !== expected.liveProof.requiredSequence.length
    || contract.liveProof.requiredSequence.some((value, index) => value !== expected.liveProof.requiredSequence[index])
    || contract.liveProof?.qualifyingEventClasses !== undefined) {
    errors.push('managedActivation.liveProof must declare requiredSequence [session, turn]');
  }
  if (!isObject(contract.liveProof?.producerEvents)
    || contract.liveProof.producerEvents.session !== expected.liveProof.producerEvents.session
    || contract.liveProof.producerEvents.turn !== expected.liveProof.producerEvents.turn) {
    errors.push('managedActivation.liveProof.producerEvents must match exact harness lifecycle events');
  }
}

function stewardshipProducesEventClass(stewardshipAdapter, eventClass) {
  if (!isObject(stewardshipAdapter) || !isObject(stewardshipAdapter.capabilities)) return false;
  const capabilities = stewardshipAdapter.capabilities;
  const bootstrapActions = Array.isArray(stewardshipAdapter.bootstrap?.actions)
    ? stewardshipAdapter.bootstrap.actions
    : [];

  if (eventClass === 'session') {
    if (bootstrapActions.includes('session-start') || bootstrapActions.includes('harness-launch')) return true;
    const start = capabilities.startOrResume;
    if (!isObject(start)) return false;
    if (start.mode === 'managed-launcher') return true;
    if (start.mode === 'native-hook') {
      if (start.event == null) return true;
      return mapConcreteEventToPublicClass(start.event) === 'session';
    }
    return false;
  }

  if (eventClass === 'turn') {
    if (bootstrapActions.includes('session-turn')) return true;
    for (const name of MANAGED_ACTIVATION_TURN_CAPABILITIES) {
      const capability = capabilities[name];
      if (!isObject(capability)) continue;
      if (capability.mode === 'managed-launcher') return true;
      if (capability.mode === 'native-hook') {
        if (capability.event == null) continue;
        if (mapConcreteEventToPublicClass(capability.event) === 'turn') return true;
      }
    }
    return false;
  }

  return false;
}

function collectStewardshipLifecycleContradictions(stewardshipAdapter) {
  const errors = [];
  if (!isObject(stewardshipAdapter) || !isObject(stewardshipAdapter.capabilities)) {
    return ['stewardshipAdapter.capabilities is required for managed activation live-proof validation'];
  }
  for (const [name, capability] of Object.entries(stewardshipAdapter.capabilities)) {
    if (!isObject(capability) || typeof capability.event !== 'string') continue;
    const mapped = mapConcreteEventToPublicClass(capability.event);
    if (!mapped) {
      errors.push(`stewardship capability ${name} event ${capability.event} is not a known public live-proof class`);
      continue;
    }
    if (MANAGED_ACTIVATION_SESSION_CAPABILITIES.has(name) && mapped !== 'session') {
      errors.push(`stewardship capability ${name} event maps to ${mapped}, which contradicts the session live-proof class`);
    }
    if (MANAGED_ACTIVATION_TURN_CAPABILITIES.has(name) && mapped !== 'turn') {
      errors.push(`stewardship capability ${name} event maps to ${mapped}, which contradicts the turn live-proof class`);
    }
  }
  return errors;
}

function requiredLiveProofClasses(contract) {
  if (Array.isArray(contract.liveProof?.requiredSequence)) {
    return [...new Set(contract.liveProof.requiredSequence)];
  }
  if (Array.isArray(contract.liveProof?.qualifyingEventClasses)) {
    return [...new Set(contract.liveProof.qualifyingEventClasses)];
  }
  return [];
}

/**
 * Validate a managed activation contract against the adapter's stewardship lifecycle
 * declarations. Declared live-proof classes must be producible; contradictory concrete
 * event mappings fail closed.
 */
function validateManagedActivationAgainstStewardship(contract, stewardshipAdapter, manifestId) {
  const errors = [];
  const contractResult = managedActivation.validateManagedActivationContract(contract);
  if (!contractResult.ok) {
    return { ok: false, errors: contractResult.errors.map((error) => `managedActivation: ${error}`) };
  }
  const activeContract = contractResult.value;
  const expectedHarness = managedActivation.normalizeHarnessId(manifestId) || activeContract.harness;
  if (activeContract.harness !== expectedHarness) {
    errors.push(`managedActivation.harness must normalize to ${expectedHarness}`);
  }
  if (isObject(stewardshipAdapter)) {
    const stewardshipHarness = managedActivation.normalizeHarnessId(stewardshipAdapter.harness);
    if (stewardshipHarness && stewardshipHarness !== activeContract.harness) {
      errors.push('managedActivation.harness must match the canonical stewardship harness');
    }
    if (isObject(stewardshipAdapter.bootstrap)) {
      const bootstrapHarness = managedActivation.normalizeHarnessId(stewardshipAdapter.bootstrap.harness);
      if (bootstrapHarness && bootstrapHarness !== activeContract.harness) {
        errors.push('managedActivation.harness must match the stewardship bootstrap harness');
      }
    }
  }

  const expected = expectedManagedActivationPolicy(activeContract.harness);
  validateManagedActivationPolicy(activeContract, expected, errors);
  errors.push(...collectStewardshipLifecycleContradictions(stewardshipAdapter));

  for (const eventClass of requiredLiveProofClasses(activeContract)) {
    if (!stewardshipProducesEventClass(stewardshipAdapter, eventClass)) {
      errors.push(`managedActivation live-proof class ${eventClass} is not producible by stewardship lifecycle declarations`);
    }
  }

  return { ok: errors.length === 0, errors, value: activeContract };
}

function emptyHarnessEvidence() {
  return {
    configured: false,
    prepared: false,
    attestation: { ok: false, reasonCode: 'missing_configuration' },
    challenges: [],
    receipts: [],
    health: { available: false },
    rollback: { status: 'none' },
    consumedCorrelations: [],
  };
}

/**
 * Materialize evaluation evidence for one harness from owner-local input.
 * Attestation digests are recomputed from explicit absolute file paths when present;
 * receipt-supplied digests are never trusted as selected-tuple proof.
 */
function materializeHarnessEvidence(entry, harness) {
  if (!isObject(entry)) return emptyHarnessEvidence();

  const challenges = Array.isArray(entry.challenges) ? entry.challenges : [];
  const receipts = Array.isArray(entry.receipts) ? entry.receipts : [];
  const health = isObject(entry.health) ? entry.health : { available: false };
  const rollback = isObject(entry.rollback) ? entry.rollback : { status: 'none' };
  const consumedCorrelations = Array.isArray(entry.consumedCorrelations) ? entry.consumedCorrelations : [];
  const configured = entry.configured === true;
  const prepared = entry.prepared === true;

  let attestation = { ok: false, reasonCode: 'attestation_unavailable' };
  const hasAttestationInputs = typeof entry.generation === 'string'
    && Array.isArray(entry.assetPaths)
    && entry.assetPaths.length > 0
    && typeof entry.entrypointPath === 'string'
    && typeof entry.configBindingPath === 'string';
  if (hasAttestationInputs) {
    attestation = managedActivation.collectManagedActivationAttestation({
      harness,
      generation: entry.generation,
      assetPaths: entry.assetPaths,
      entrypointPath: entry.entrypointPath,
      configBindingPath: entry.configBindingPath,
    });
  }

  return {
    configured,
    prepared,
    attestation,
    challenges,
    receipts,
    health,
    rollback,
    consumedCorrelations,
  };
}

function extractOwnerEvidenceForHarness(ownerEvidence, harness) {
  if (!isObject(ownerEvidence)) return null;
  if (ownerEvidence.schemaVersion !== MANAGED_ACTIVATION_OWNER_EVIDENCE_VERSION) return null;
  if (!isObject(ownerEvidence.harnesses)) return null;
  const entry = ownerEvidence.harnesses[harness];
  return isObject(entry) ? entry : null;
}

function loadManagedActivationContractForHarness(harness, { root } = {}) {
  const normalized = managedActivation.normalizeHarnessId(harness);
  if (!normalized) {
    return { ok: false, errors: ['unknown harness'], harness: null, contract: null };
  }
  const repoRoot = path.resolve(root || repoRootFrom());
  const manifestPath = path.join(repoRoot, 'runtimes', normalized, 'adapter.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, errors: [`runtime adapter missing for ${normalized}`], harness: normalized, contract: null };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return { ok: false, errors: [`runtime adapter unreadable for ${normalized}`], harness: normalized, contract: null };
  }
  const against = validateManagedActivationAgainstStewardship(
    manifest.managedActivation,
    manifest.stewardshipAdapter,
    manifest.id || normalized,
  );
  if (!against.ok) {
    return { ok: false, errors: against.errors, harness: normalized, contract: null, manifestPath };
  }
  return {
    ok: true,
    errors: [],
    harness: normalized,
    contract: against.value,
    manifestPath,
    manifest,
  };
}

/**
 * Read-only managed activation status for one harness or all four canonical harnesses.
 * Missing evidence is a truthful non-active status, not a process failure.
 */
function getManagedActivationStatus({
  runtime = 'all',
  root,
  evidencePath,
  evidence,
  now = Date.now(),
} = {}) {
  const repoRoot = path.resolve(root || repoRootFrom());
  const requested = runtime === 'all'
    ? [...MANAGED_ACTIVATION_HARNESS_ORDER]
    : [managedActivation.normalizeHarnessId(runtime)].filter(Boolean);

  if (runtime !== 'all' && requested.length === 0) {
    return {
      ok: false,
      error: 'unknown runtime',
      results: [],
    };
  }

  let ownerEvidence = null;
  if (isObject(evidence)) {
    ownerEvidence = evidence;
  } else if (typeof evidencePath === 'string' && evidencePath.length > 0) {
    if (!path.isAbsolute(evidencePath)) {
      return {
        ok: false,
        error: 'evidence_unreadable',
        results: [],
      };
    }
    const loaded = managedActivation.loadOwnerEvidence(evidencePath);
    if (!loaded.ok) {
      return {
        ok: false,
        error: 'evidence_unreadable',
        results: [],
      };
    }
    ownerEvidence = loaded.value;
  }

  const results = [];
  for (const harness of requested) {
    const loadedContract = loadManagedActivationContractForHarness(harness, { root: repoRoot });
    if (!loadedContract.ok) {
      results.push(managedActivation.toPublicActivationStatus({
        state: 'unconfigured',
        harness,
        generationDigest: null,
        evidenceClasses: [],
        freshThrough: null,
        reasons: ['invalid_evidence'],
        evaluatedAt: new Date(Number(now)).toISOString(),
      }));
      continue;
    }

    const harnessEntry = ownerEvidence ? extractOwnerEvidenceForHarness(ownerEvidence, harness) : null;
    const evaluationEvidence = materializeHarnessEvidence(harnessEntry, harness);
    const evaluated = managedActivation.evaluateManagedActivation({
      contract: loadedContract.contract,
      evidence: evaluationEvidence,
      now,
    });
    results.push(managedActivation.toPublicActivationStatus(evaluated));
  }

  if (runtime === 'all') {
    return { ok: true, results };
  }
  return { ok: true, status: results[0], results };
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
  if (GBRAIN_CONTINUITY_HARNESSES.has(manifest.id)) {
    const continuity = manifest.gbrainContinuity;
    if (!isObject(continuity)) {
      add(errors, 'gbrainContinuity is required for private continuity harnesses');
    } else {
      if (continuity.version !== GBRAIN_CONTINUITY_VERSION) add(errors, `gbrainContinuity.version must be ${GBRAIN_CONTINUITY_VERSION}`);
      if (continuity.availability !== 'optional-public-required-private') add(errors, 'gbrainContinuity.availability must preserve the public/private boundary');
      if (continuity.provider !== 'gbrain') add(errors, 'gbrainContinuity.provider must be gbrain');
      if (continuity.transport !== 'provider-native-stdio') add(errors, 'gbrainContinuity.transport must be provider-native-stdio');
      if (continuity.launcher !== GBRAIN_PROVIDER_LAUNCHER) add(errors, `gbrainContinuity.launcher must be ${GBRAIN_PROVIDER_LAUNCHER}`);
      if (continuity.descriptorEnvironment !== GBRAIN_DESCRIPTOR_ENV) add(errors, `gbrainContinuity.descriptorEnvironment must be ${GBRAIN_DESCRIPTOR_ENV}`);
      if (!Array.isArray(continuity.requiredTools)
        || GBRAIN_REQUIRED_TOOLS.some((tool) => !continuity.requiredTools.includes(tool))) {
        add(errors, `gbrainContinuity.requiredTools must include ${GBRAIN_REQUIRED_TOOLS.join(', ')}`);
      }
      const skill = continuity.skillProjection;
      if (!isObject(skill) || skill.owner !== 'gbrain' || skill.mode !== 'provider-resolver'
        || skill.skill !== 'skillify' || skill.copiedIntoJarvosSkills !== false) {
        add(errors, 'gbrainContinuity.skillProjection must keep Skillify provider-owned and resolver-backed');
      }
      const maintenance = continuity.maintenance;
      if (!isObject(maintenance) || maintenance.sweepDisabled !== true
        || maintenance.owner !== 'scheduler-owned-delta-maintenance') {
        add(errors, 'gbrainContinuity.maintenance must disable serve sweeps and preserve the scheduler owner');
      }
      if (!isObject(continuity.registration)
        || typeof continuity.registration.command !== 'string' || !continuity.registration.command
        || typeof continuity.registration.verification !== 'string' || !continuity.registration.verification) {
        add(errors, 'gbrainContinuity.registration must declare native registration and verification');
      } else {
        const native = GBRAIN_NATIVE_REGISTRATION[manifest.id];
        if (continuity.registration.command !== native.command
          || continuity.registration.verification !== native.verification) {
          add(errors, `gbrainContinuity.registration must use the verified ${manifest.id} native MCP command contract`);
        }
      }
    }
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
  const managedCompound = manifest.managedProviders?.['compound-engineering'];
  if (managedCompound !== undefined) {
    if (!isObject(managedCompound)) {
      add(errors, 'managedProviders.compound-engineering must be an object');
    } else {
      for (const field of ['status', 'manifest', 'capabilityRecord', 'conformanceReceipt', 'profileBoundary', 'activation', 'discovery', 'invocation', 'fallback']) {
        if (typeof managedCompound[field] !== 'string' || managedCompound[field].length === 0) add(errors, `managedProviders.compound-engineering.${field} is required`);
      }
      if (!['supported', 'unsupported', 'disabled'].includes(managedCompound.status)) {
        add(errors, 'managedProviders.compound-engineering.status must be supported, unsupported, or disabled');
      }
      if (managedCompound.profileBoundary !== 'CODEX_HOME') add(errors, 'managedProviders.compound-engineering.profileBoundary must be CODEX_HOME');
    }
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
  const isCanonicalManagedHarness = managedActivation.CANONICAL_HARNESS_IDS.has(manifest.id);
  if (isCanonicalManagedHarness && manifest.managedActivation === undefined) {
    add(errors, 'managedActivation is required for canonical runtime adapters');
  }
  if (manifest.managedActivation !== undefined) {
    const against = validateManagedActivationAgainstStewardship(
      manifest.managedActivation,
      manifest.stewardshipAdapter,
      manifest.id,
    );
    if (!against.ok) for (const error of against.errors) add(errors, error);
  }
  if (manifest.unsupportedCapabilities && !Array.isArray(manifest.unsupportedCapabilities)) {
    add(errors, 'unsupportedCapabilities must be an array');
  }
  if (manifest.capabilityDescriptor) {
    const descriptor = capabilityDescriptor.validateCapabilityDescriptor(manifest.capabilityDescriptor);
    errors.push(...descriptor.errors.map((error) => `capabilityDescriptor: ${error}`));
    if (manifest.capabilityDescriptor.harness && manifest.id && manifest.capabilityDescriptor.harness !== manifest.id) {
      add(errors, 'capabilityDescriptor.harness must match manifest.id');
    }
  }
  if (manifest.skillProjection !== undefined) {
    const projection = manifest.skillProjection;
    if (!isObject(projection)) {
      add(errors, 'skillProjection must be an object');
    } else {
      if (projection.version !== 'jarvos-skill-projection-adapter/v1') add(errors, 'skillProjection.version is invalid');
      if (typeof projection.managedRoot !== 'string' || projection.managedRoot.length === 0 || path.isAbsolute(projection.managedRoot)) {
        add(errors, 'skillProjection.managedRoot must be a portable home-relative path');
      }
      if (!Array.isArray(projection.orderedScopes) || projection.orderedScopes.length === 0 || projection.orderedScopes.some((scope) => typeof scope !== 'string' || !scope)) {
        add(errors, 'skillProjection.orderedScopes must be a non-empty string array');
      }
      if (projection.renderer !== 'raw-skill-bundle') add(errors, 'skillProjection.renderer must be raw-skill-bundle');
      if (!['exact-path', 'interactive-smoke'].includes(projection.verificationTier)) add(errors, 'skillProjection.verificationTier is invalid');
      if (!isObject(projection.alias) || typeof projection.alias.pattern !== 'string' || !Number.isInteger(projection.alias.maxLength) || projection.alias.maxLength < 1 || !Array.isArray(projection.alias.reservedNames)) {
        add(errors, 'skillProjection.alias must declare pattern, maxLength, and reservedNames');
      }
      if (!isObject(projection.probeIsolation) || typeof projection.probeIsolation.unattended !== 'boolean' || typeof projection.probeIsolation.mode !== 'string') {
        add(errors, 'skillProjection.probeIsolation must declare mode and unattended');
      }
    }
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
  const shared = manifest.sharedAgentContext || {};
  const validation = validateManifest(manifest);
  const errors = [...validation.errors];
  const warnings = [...validation.warnings];

  const setupScript = path.join(runtimeDir, manifest.setup?.script || '');
  if (!fs.existsSync(setupScript)) add(errors, `setup script missing: ${rel(root, setupScript)}`);

  const readmePath = path.join(runtimeDir, 'README.md');
  if (!fs.existsSync(readmePath)) add(errors, `README missing: ${rel(root, readmePath)}`);

  if (manifest.gbrainContinuity?.launcher === GBRAIN_PROVIDER_LAUNCHER) {
    const launcher = path.join(root, GBRAIN_PROVIDER_LAUNCHER);
    if (!fs.existsSync(launcher)) {
      add(errors, `GBrain provider launcher missing: ${GBRAIN_PROVIDER_LAUNCHER}`);
    } else if (!sourceContains(launcher, [/prepareManagedGbrainProvider/, /stdio:\s*['"]inherit['"]/])) {
      add(errors, 'GBrain provider launcher must revalidate the managed runtime and preserve provider-owned stdio');
    }
  }

  const mcpServerPath = manifest.sharedAgentContext?.mcpServer;
  const mcpServer = mcpServerPath === DEFAULT_AGENT_CONTEXT_MCP ? path.join(root, mcpServerPath) : null;
  if (mcpServerPath === DEFAULT_AGENT_CONTEXT_MCP && !fs.existsSync(mcpServer)) {
    add(errors, `shared MCP server missing: ${rel(root, mcpServer)}`);
  }
  if (mcpServer && fs.existsSync(mcpServer)) {
    try {
      const mcp = require(mcpServer);
      const tools = Array.isArray(mcp.TOOLS) ? mcp.TOOLS.map((tool) => tool.name) : [];
      for (const requiredTool of shared.requiredTools || []) {
        if (!tools.includes(requiredTool)) add(errors, `shared MCP server does not expose ${requiredTool}`);
      }
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
    let capabilityRecord = null;
    if (!fs.existsSync(capabilityPath)) {
      add(errors, 'Codex Compound Engineering capability record is missing');
    } else {
      try { capabilityRecord = loadCompoundEngineeringCapability(capabilityPath, { root }).capability; } catch (_) { capabilityRecord = null; }
      const capabilityCheck = checkCompoundEngineeringCapability(capabilityPath, { root });
      if (!capabilityCheck.ok) {
        for (const error of capabilityCheck.errors) add(errors, `Codex Compound Engineering capability: ${error}`);
      }
    }
    const managedCompound = manifest.managedProviders?.['compound-engineering'];
    if (managedCompound) {
      for (const field of ['manifest', 'conformanceReceipt']) {
        const filePath = path.resolve(root, managedCompound[field]);
        if (!fs.existsSync(filePath)) add(errors, `Codex managed provider ${field} is missing`);
      }
      const receiptPath = path.resolve(root, managedCompound.conformanceReceipt || '');
      if (fs.existsSync(receiptPath)) {
        try {
          const receipt = readJson(receiptPath);
          const receiptValidation = validateCodexConformanceReceipt(receipt, { capability: capabilityRecord });
          if (!receiptValidation.ok) for (const error of receiptValidation.errors) add(errors, `Codex conformance receipt: ${error}`);
          if (capabilityRecord && receipt.admission !== capabilityRecord.admission) add(errors, 'Codex conformance receipt admission does not match the capability record');
          if (managedCompound.status === 'supported' && (receipt.status !== 'passed' || capabilityRecord?.admission !== 'supported' || capabilityRecord?.proof?.conformant !== true)) add(errors, 'supported Codex managed provider requires a passed conformance receipt and conformant capability record');
        } catch (error) {
          add(errors, `Codex conformance receipt could not be loaded: ${error.message}`);
        }
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
  ...commonWorkService,
  ...harnessDispatch,
  ...stewardshipAdapter,
  ...stewardshipBootstrap,
  ...dispatcherConformance,
  ...openclawPluginPersistence,
  ...capabilityDescriptor,
  ...operatorNotification,
  ...operatorNotificationLint,
  ...managedActivation,
  ...providerSelection,
  ...providerPreference,
  ...runtimeModeContract,
  ...constrainedGeneration,
  DEFAULT_AGENT_CONTEXT_MCP,
  HYDRATION_MODES,
  REQUIRED_MCP_TOOL,
  CONTROL_PLANE_MODULE,
  CONTROL_PLANE_TOOL,
  GBRAIN_CONTINUITY_VERSION,
  GBRAIN_PROVIDER_LAUNCHER,
  GBRAIN_DESCRIPTOR_ENV,
  GBRAIN_REQUIRED_TOOLS,
  COMPOUND_ENGINEERING_CAPABILITY_VERSION,
  MANAGED_ACTIVATION_HARNESS_ORDER,
  MANAGED_ACTIVATION_OWNER_EVIDENCE_VERSION,
  checkCompoundEngineeringCapability,
  classifyCompoundEngineeringProvider,
  collectCodexCompoundEngineeringEvidence,
  checkRuntime,
  computeCompoundEngineeringFixtureDigest,
  expectedManagedActivationPolicy,
  getManagedActivationStatus,
  listRuntimeManifests,
  loadCompoundEngineeringCapability,
  loadManagedActivationContractForHarness,
  loadManifest,
  inspectCompoundEngineeringProvider,
  materializeHarnessEvidence,
  repoRootFrom,
  scaffoldRuntime,
  validateCompoundEngineeringCapability,
  validateCodexConformanceReceipt,
  validateManagedActivationAgainstStewardship,
  validateManifest,
};
