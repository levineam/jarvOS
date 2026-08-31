'use strict';

// This is the only mutating path for the managed Codex CE provider. It is kept
// separate from discovery/doctor so a health check can never install, update,
// or remove a plugin. The setup shell passes an explicit profile mode:
// `new-managed` for a new managed coding profile, or `opt-in` for an existing
// profile. The default is preservation of the existing profile.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  checkCompoundEngineeringCapability,
  loadCompoundEngineeringCapability,
  validateCodexConformanceReceipt,
} = require('../../modules/jarvos-runtime-kit/src');

const ROOT = path.resolve(__dirname, '..', '..');
const CAPABILITY_PATH = path.join(__dirname, 'compound-engineering-capability.json');
const CONFORMANCE_PATH = path.join(__dirname, 'compound-engineering-conformance.json');
const STATE_VERSION = 'jarvos-codex-provider-state/v1';
const CODEX_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PROVIDER_ID = 'compound-engineering';
const MARKETPLACE_NAME = 'compound-engineering-plugin';
const PLUGIN_SELECTOR = 'compound-engineering@compound-engineering-plugin';
const APPROVED_REPOSITORY = 'https://github.com/EveryInc/compound-engineering-plugin.git';
const SHA1 = /^[a-f0-9]{40}$/i;
const SAFE_MODE = new Set(['existing', 'new-managed', 'opt-in', 'disabled']);

function fail(message) {
  const error = new Error(message);
  error.code = 'JARVOS_CODEX_PROVIDER_SETUP_FAILED';
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid`);
  }
}

function assertProfileDirectory(profilePath, { create = true } = {}) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) fail('CODEX_HOME must be absolute');
  const absolute = path.resolve(profilePath);
  if (!fs.existsSync(absolute)) {
    if (!create) return absolute;
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('CODEX_HOME must be a real directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('CODEX_HOME must be owned by the current user');
  if ((stat.mode & 0o022) !== 0) fail('CODEX_HOME must not be group- or world-writable');
  return absolute;
}

function assertStatePath(statePath) {
  const stat = fs.existsSync(statePath) ? fs.lstatSync(statePath) : null;
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) fail('jarvOS Codex provider state must be a regular file');
}

function writeState(statePath, value) {
  assertStatePath(statePath);
  const directory = path.dirname(statePath);
  const temporary = path.join(directory, `.${path.basename(statePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, statePath);
    fs.chmodSync(statePath, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  assertStatePath(statePath);
  const state = readJson(statePath, 'jarvOS Codex provider state');
  if (!isObject(state) || state.schemaVersion !== STATE_VERSION || state.provider !== PROVIDER_ID
    || typeof state.version !== 'string' || !SHA1.test(state.revision || '')
    || state.marketplace !== MARKETPLACE_NAME || state.plugin !== PLUGIN_SELECTOR
    || typeof state.marketplaceAdded !== 'boolean' || typeof state.pluginAdded !== 'boolean') {
    fail('jarvOS Codex provider state is not a recognized owned-state record');
  }
  return state;
}

function removeState(statePath) {
  assertStatePath(statePath);
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
}

function commandEnvironment() {
  // Do not pass ambient credentials or arbitrary session variables to the
  // third-party marketplace/plugin process. Codex reads its own auth from the
  // selected profile; jarvOS contributes only profile and process basics.
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env = {};
  for (const key of allowed) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  env.CODEX_HOME = process.env.CODEX_HOME;
  if (process.env.CODEX_CONFIG) env.CODEX_CONFIG = process.env.CODEX_CONFIG;
  return env;
}

function codexExecutable() {
  return process.env.JARVOS_CODEX_EXECUTABLE || 'codex';
}

function runCodex(args, { expectJson = false } = {}) {
  const result = spawnSync(codexExecutable(), args, {
    cwd: ROOT,
    env: commandEnvironment(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail(`Codex provider command failed: ${args.slice(0, 3).join(' ')}`);
  if (!expectJson) return null;
  try { return JSON.parse(result.stdout || '{}'); } catch (_) { fail(`Codex provider command returned invalid JSON: ${args.slice(0, 3).join(' ')}`); }
}

function marketplaceMetadata(entry) {
  if (!isObject(entry) || entry.name !== MARKETPLACE_NAME || typeof entry.root !== 'string' || !path.isAbsolute(entry.root)) return null;
  try {
    const profileRoot = path.resolve(process.env.CODEX_HOME || '');
    const root = path.resolve(entry.root);
    const relative = path.relative(profileRoot, root);
    if (!profileRoot || !relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const metadataPath = path.join(root, '.codex-marketplace-install.json');
    const stat = fs.lstatSync(metadataPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const metadata = readJson(metadataPath, 'Codex marketplace metadata');
    return {
      source: metadata.source,
      revision: metadata.revision,
    };
  } catch (_) {
    return null;
  }
}

function discoverRaw() {
  const installedPayload = runCodex(['plugin', 'list', '--json'], { expectJson: true });
  const marketplacePayload = runCodex(['plugin', 'marketplace', 'list', '--json'], { expectJson: true });
  const installed = Array.isArray(installedPayload.installed)
    ? installedPayload.installed.find((entry) => entry?.pluginId === PLUGIN_SELECTOR || entry?.name === PROVIDER_ID)
    : null;
  const marketplaceEntry = Array.isArray(marketplacePayload.marketplaces)
    ? marketplacePayload.marketplaces.find((entry) => entry?.name === MARKETPLACE_NAME)
    : null;
  const marketplace = marketplaceMetadata(marketplaceEntry);
  return { installed, marketplace, marketplaceEntry };
}

function discover(capability) {
  const result = discoverRaw();
  const { marketplaceEntry, marketplace } = result;
  if (marketplaceEntry && !marketplace) fail('configured Compound Engineering marketplace has no trusted immutable metadata');
  if (marketplace && marketplace.source !== APPROVED_REPOSITORY) fail('configured Compound Engineering marketplace source is not approved');
  if (marketplace && marketplace.revision !== capability.provider.revision) fail('configured Compound Engineering marketplace revision is not the approved pin');
  return result;
}

function providerState({ capability, marketplaceAdded, pluginAdded }) {
  return {
    schemaVersion: STATE_VERSION,
    provider: PROVIDER_ID,
    version: capability.provider.version,
    revision: capability.provider.revision,
    marketplace: MARKETPLACE_NAME,
    plugin: PLUGIN_SELECTOR,
    marketplaceAdded,
    pluginAdded,
  };
}

function ensureApprovedEvidence() {
  const loaded = loadCompoundEngineeringCapability(CAPABILITY_PATH, { root: ROOT });
  const capability = loaded.capability;
  const capabilityCheck = checkCompoundEngineeringCapability(CAPABILITY_PATH, { root: ROOT, capability });
  if (!capabilityCheck.ok) fail('shipped Compound Engineering capability record is invalid');
  const conformance = readJson(CONFORMANCE_PATH, 'Codex provider conformance receipt');
  const validation = validateCodexConformanceReceipt(conformance, { capability });
  if (!validation.ok) fail('shipped Codex provider conformance receipt is not approved');
  if (capability.admission !== 'supported' || capability.activation.candidateOnly !== false) fail('Compound Engineering provider is not admitted for activation');
  return { capability, conformance };
}

function readLiveCodexVersion() {
  const result = spawnSync(codexExecutable(), ['--version'], {
    cwd: ROOT,
    env: commandEnvironment(),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) fail('could not read the running Codex CLI version');
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const versions = output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g) || [];
  if (versions.length !== 1 || !CODEX_SEMVER.test(versions[0])) fail('running Codex CLI returned an unusable version');
  return versions[0];
}

function assertLiveCodexVersion(conformance) {
  const expected = conformance?.discovery?.codexVersion;
  if (typeof expected !== 'string' || !CODEX_SEMVER.test(expected)) fail('Codex provider conformance has no valid covered CLI version');
  const actual = readLiveCodexVersion();
  if (actual !== expected) {
    fail(`managed Compound Engineering activation is not covered for Codex CLI ${actual}; conformance covers ${expected}. Update Codex or repeat the disposable conformance validation before retrying`);
  }
  return actual;
}

function stateMatchesInstallation(state, current) {
  const plugin = current.installed;
  const marketplace = current.marketplace;
  const pluginMatches = plugin
    ? state?.pluginAdded === true
      && plugin.pluginId === state.plugin
      && plugin.marketplaceName === state.marketplace
      && plugin.version === state.version
      && plugin.enabled !== false
    : state?.pluginAdded === false;
  return Boolean(state && pluginMatches
    && marketplace
    && marketplace.source === APPROVED_REPOSITORY
    && marketplace.revision === state.revision);
}

function removeOwnedActivation({ state, statePath }) {
  const current = discoverRaw();
  if (current.marketplaceEntry && !current.marketplace) fail('managed Compound Engineering marketplace metadata is missing or unsafe');
  if (current.marketplace && current.marketplace.source !== APPROVED_REPOSITORY) fail('managed Compound Engineering marketplace source was locally changed');
  if (state.pluginAdded) {
    if (!current.installed) {
      state.pluginAdded = false;
      writeState(statePath, state);
    } else if (!stateMatchesInstallation(state, current)) {
      fail('managed Compound Engineering plugin was locally changed; preserving it');
    } else {
      runCodex(['plugin', 'remove', PLUGIN_SELECTOR, '--json']);
      state.pluginAdded = false;
      writeState(statePath, state);
    }
  }
  if (state.marketplaceAdded) {
    const afterPlugin = discoverRaw();
    if (afterPlugin.marketplaceEntry && !afterPlugin.marketplace) fail('managed Compound Engineering marketplace metadata is missing after plugin removal');
    const installedPayload = runCodex(['plugin', 'list', '--json'], { expectJson: true });
    const installedEntries = Array.isArray(installedPayload.installed) ? installedPayload.installed : [];
    const unrelated = installedEntries.some((entry) => entry?.marketplaceName === MARKETPLACE_NAME);
    if (!afterPlugin.marketplace) {
      state.marketplaceAdded = false;
      writeState(statePath, state);
    } else if (afterPlugin.marketplace.revision !== state.revision || unrelated) {
      fail('managed Compound Engineering marketplace was locally changed or is shared; preserving it');
    } else {
      runCodex(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']);
      state.marketplaceAdded = false;
      writeState(statePath, state);
    }
  }
  if (!state.pluginAdded && !state.marketplaceAdded) removeState(statePath);
}

function activate({ capability, statePath }) {
  let initial = discoverRaw();
  const alreadyApproved = initial.installed
    && initial.installed.version === capability.provider.version
    && initial.installed.enabled !== false
    && initial.marketplace?.source === APPROVED_REPOSITORY
    && initial.marketplace.revision === capability.provider.revision;
  if (alreadyApproved) {
    console.log('Compound Engineering is already installed at the approved pin; preserving the Codex profile.');
    return { status: 'already-installed' };
  }

  if (initial.installed || initial.marketplaceEntry) {
    const state = readState(statePath);
    if (!state || !stateMatchesInstallation(state, initial) || state.marketplaceAdded !== true) {
      fail('existing Compound Engineering installation is stale, disabled, or not jarvOS-owned; preserving local profile state');
    }
    removeOwnedActivation({ state, statePath });
    initial = discoverRaw();
  }

  let marketplaceAdded = false;
  let pluginAdded = false;
  try {
    if (!initial.marketplace) {
      const marketplaceArgv = capability.activation.marketplaceArgv;
      if (!Array.isArray(marketplaceArgv) || marketplaceArgv[0] !== 'codex') fail('shipped marketplace activation argv is invalid');
      marketplaceAdded = true;
      writeState(statePath, providerState({ capability, marketplaceAdded, pluginAdded }));
      runCodex(marketplaceArgv.slice(1));
      writeState(statePath, providerState({ capability, marketplaceAdded, pluginAdded }));
    }

    const pluginArgv = capability.activation.pluginArgv;
    if (!Array.isArray(pluginArgv) || pluginArgv[0] !== 'codex') fail('shipped plugin activation argv is invalid');
    pluginAdded = true;
    writeState(statePath, providerState({ capability, marketplaceAdded, pluginAdded }));
    runCodex(pluginArgv.slice(1));
    writeState(statePath, providerState({ capability, marketplaceAdded, pluginAdded }));

    const final = discover(capability);
    if (!final.marketplace || !final.installed || final.installed.version !== capability.provider.version || final.installed.enabled === false) {
      fail('Compound Engineering activation did not resolve the approved provider identity');
    }
    console.log('Activated the approved Compound Engineering provider for this CODEX_HOME; restart Codex before use.');
    return { status: 'activated' };
  } catch (error) {
    // Keep the exact owned-state record so an explicit rollback can safely
    // recover a half-completed activation without touching user-owned state.
    if (marketplaceAdded || pluginAdded) writeState(statePath, providerState({ capability, marketplaceAdded, pluginAdded }));
    throw error;
  }
}

function rollback({ statePath }) {
  const state = readState(statePath);
  if (!state) {
    console.log('No jarvOS-owned Compound Engineering activation was found; preserving the Codex profile.');
    return { status: 'not-owned' };
  }
  removeOwnedActivation({ state, statePath });
  console.log('Rolled back only the jarvOS-owned Compound Engineering Codex state.');
  return { status: 'rolled-back' };
}

function main() {
  const mode = process.env.JARVOS_CODEX_PROVIDER_MODE
    || (process.env.JARVOS_PROFILE === 'codex' ? 'new-managed' : 'existing');
  if (!SAFE_MODE.has(mode)) fail('JARVOS_CODEX_PROVIDER_MODE must be existing, new-managed, opt-in, or disabled');
  const rollbackRequested = process.env.JARVOS_MANAGED_HARNESS_ROLLBACK === '1';
  const preflightRequested = process.env.JARVOS_CODEX_PROVIDER_PREFLIGHT === '1';
  const managedMode = mode === 'new-managed' || mode === 'opt-in';
  if (preflightRequested && !managedMode) fail('Codex provider preflight requires new-managed or opt-in mode');
  const profile = assertProfileDirectory(
    process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'),
    { create: !preflightRequested && !rollbackRequested },
  );
  process.env.CODEX_HOME = profile;
  const statePath = path.join(profile, 'jarvos-compound-engineering.state.json');
  if (rollbackRequested) return rollback({ statePath });
  const evidence = ensureApprovedEvidence();
  const liveCodexVersion = managedMode ? assertLiveCodexVersion(evidence.conformance) : undefined;
  if (preflightRequested) {
    console.log(`Codex ${liveCodexVersion} is covered by the reviewed Compound Engineering conformance receipt; no provider changes were made.`);
    return { status: 'preflight', codexVersion: liveCodexVersion };
  }
  if (mode === 'existing' || mode === 'disabled') {
    console.log(`Compound Engineering provider setup is ${mode === 'disabled' ? 'disabled' : 'preserve-only'} for this Codex profile.`);
    return { status: mode };
  }
  return activate({ capability: evidence.capability, statePath });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`jarvOS Codex provider setup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  activate,
  assertLiveCodexVersion,
  discover,
  main,
  readLiveCodexVersion,
  rollback,
};
