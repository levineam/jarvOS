'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const crypto = require('crypto');
const {
  COMPOUND_ENGINEERING_CAPABILITY_VERSION,
  MANAGED_ACTIVATION_RECEIPT_VERSION,
  MANAGED_ACTIVATION_PRODUCER_EVENTS,
  MANAGED_ACTIVATION_STATUS_VERSION,
  buildSelectedTuple,
  checkRuntime,
  checkCompoundEngineeringCapability,
  classifyCompoundEngineeringProvider,
  computeCompoundEngineeringFixtureDigest,
  evaluateManagedActivation,
  getManagedActivationStatus,
  inspectCompoundEngineeringProvider,
  validateCodexConformanceReceipt,
  listRuntimeManifests,
  loadCompoundEngineeringCapability,
  loadOwnerEvidence,
  scaffoldRuntime,
  toPublicActivationStatus,
  validateCompoundEngineeringCapability,
  validateManifest,
} = require('../src/index.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('Codex Compound Engineering capability is conformance-backed and public-safe', () => {
  const capabilityPath = path.join(ROOT, 'runtimes/codex/compound-engineering-capability.json');
  const loaded = loadCompoundEngineeringCapability(capabilityPath, { root: ROOT });
  const validation = validateCompoundEngineeringCapability(loaded.capability);
  assert.equal(COMPOUND_ENGINEERING_CAPABILITY_VERSION, 'jarvos-codex-ce-capability.v1');
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(loaded.capability.admission, 'supported');
  assert.equal(loaded.capability.activation.candidateOnly, false);
  assert.equal(loaded.capability.proof.conformant, true);
  assert.deepEqual(loaded.capability.operations, ['plan', 'work', 'compound']);

  const result = checkCompoundEngineeringCapability(capabilityPath, { root: ROOT });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.fixture.treeDigest, loaded.capability.fixtureTreeDigest);
  assert.ok(result.fixture.files.includes('discovery.json'));
});

test('Compound Engineering capability rejects activation without conformance proof', () => {
  const capability = loadCompoundEngineeringCapability(
    path.join(ROOT, 'runtimes/codex/compound-engineering-capability.json'),
    { root: ROOT },
  ).capability;
  const promoted = {
    ...capability,
    admission: 'supported',
    activation: { ...capability.activation, candidateOnly: true },
    proof: { ...capability.proof, conformant: false },
  };
  const result = validateCompoundEngineeringCapability(promoted);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /supported or disabled capability|conformant capability/);
});

test('Compound Engineering provider status distinguishes discovery from activation truth', () => {
  const capabilityPath = path.join(ROOT, 'runtimes/codex/compound-engineering-capability.json');
  const loaded = loadCompoundEngineeringCapability(capabilityPath, { root: ROOT });
  const capabilityCheck = checkCompoundEngineeringCapability(capabilityPath, { root: ROOT });
  const discovered = classifyCompoundEngineeringProvider({
    capability: loaded.capability,
    capabilityCheck,
    evidence: {
      marketplaces: [{ name: 'compound-engineering-plugin', revision: loaded.capability.provider.revision }],
      installed: [{ pluginId: 'compound-engineering@compound-engineering-plugin', name: 'compound-engineering', marketplaceName: 'compound-engineering-plugin', version: '3.21.4', enabled: true }],
    },
  });
  assert.equal(discovered.status, 'degraded');
  assert.equal(discovered.activeVersion, '3.21.4');

  const healthy = classifyCompoundEngineeringProvider({
    capability: loaded.capability,
    capabilityCheck,
    evidence: {
      marketplaces: [{ name: 'compound-engineering-plugin', revision: loaded.capability.provider.revision }],
      installed: [{ pluginId: 'compound-engineering@compound-engineering-plugin', name: 'compound-engineering', marketplaceName: 'compound-engineering-plugin', version: '3.21.4', enabled: true }],
      conformance: { status: 'passed', providerRevision: loaded.capability.provider.revision },
    },
  });
  assert.equal(healthy.status, 'healthy');

  const unbound = classifyCompoundEngineeringProvider({
    capability: loaded.capability,
    capabilityCheck,
    evidence: {
      marketplaces: [{ name: 'compound-engineering-plugin', revision: loaded.capability.provider.revision }],
      installed: [{
        pluginId: 'evil-local@unapproved-marketplace',
        name: 'compound-engineering',
        marketplaceName: 'unapproved-marketplace',
        version: '3.21.4',
        enabled: true,
      }],
      conformance: { status: 'passed', providerRevision: loaded.capability.provider.revision },
    },
  });
  assert.equal(unbound.status, 'not-installed');

  const missing = classifyCompoundEngineeringProvider({
    capability: loaded.capability,
    capabilityCheck,
    evidence: { installed: [] },
  });
  assert.equal(missing.status, 'not-installed');

  const modified = classifyCompoundEngineeringProvider({
    capability: loaded.capability,
    capabilityCheck,
    evidence: { localModified: true, installed: [{ pluginId: 'compound-engineering@compound-engineering-plugin', name: 'compound-engineering', marketplaceName: 'compound-engineering-plugin', version: '3.21.4', enabled: true }] },
  });
  assert.equal(modified.status, 'local-modified');

  const stale = classifyCompoundEngineeringProvider({
    capability: loaded.capability,
    capabilityCheck,
    evidence: {
      marketplaces: [{ name: 'compound-engineering-plugin', revision: '1'.repeat(40) }],
      installed: [{ pluginId: 'compound-engineering@compound-engineering-plugin', name: 'compound-engineering', marketplaceName: 'compound-engineering-plugin', version: '3.21.4', enabled: true }],
    },
  });
  assert.equal(stale.status, 'incompatible');
});

test('Compound Engineering inspection returns a public-safe healthy status for an installed provider', () => {
  const result = inspectCompoundEngineeringProvider({
    root: ROOT,
    evidence: {
      codexAvailable: true,
      codexVersion: '0.146.0',
      marketplaces: [{ name: 'compound-engineering-plugin', revision: 'e36ddb8cbd4dd902d3b6ddd96165a783b0ac4711' }],
      installed: [{ pluginId: 'compound-engineering@compound-engineering-plugin', name: 'compound-engineering', marketplaceName: 'compound-engineering-plugin', version: '3.21.4', enabled: true }],
    },
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.discovery.activeVersion, '3.21.4');
  assert.equal(result.discovery.marketplaceFound, true);
  assert.equal(JSON.stringify(result).includes('/Users/'), false);
});

test('Codex conformance receipt is strict and cannot be promoted by status alone', () => {
  const capability = loadCompoundEngineeringCapability(
    path.join(ROOT, 'runtimes/codex/compound-engineering-capability.json'),
    { root: ROOT },
  ).capability;
  const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/codex/compound-engineering-conformance.json'), 'utf8'));
  assert.equal(validateCodexConformanceReceipt(receipt, { capability }).ok, true);
  const forged = { ...receipt, receipt: { ...receipt.receipt, strictContract: 'implemented' } };
  const invalid = validateCodexConformanceReceipt(forged, { capability });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /strict receipt evidence/);
  const missingRevision = { ...receipt, discovery: { ...receipt.discovery, marketplaceRevision: undefined } };
  const invalidRevision = validateCodexConformanceReceipt(missingRevision, { capability });
  assert.equal(invalidRevision.ok, false);
  assert.match(invalidRevision.errors.join('\n'), /discovery evidence/);
});

test('Codex provider activation is profile-scoped, pinned, and exactly reversible', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-provider-activation-'));
  try {
    const home = path.join(tmp, 'home');
    const codexHome = path.join(tmp, 'codex-home');
    const bin = path.join(tmp, 'bin');
    const fakeCodex = path.join(bin, 'codex');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.CODEX_HOME;
const statePath = path.join(home, 'fake-codex-state.json');
fs.mkdirSync(home, { recursive: true });
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { installed: [], marketplaces: [] };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('codex-cli 0.146.0\\n'); process.exit(0); }
if (args.join(' ') === 'plugin list --json') { process.stdout.write(JSON.stringify({ installed: state.installed })); process.exit(0); }
if (args.join(' ') === 'plugin marketplace list --json') { process.stdout.write(JSON.stringify({ marketplaces: state.marketplaces })); process.exit(0); }
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  const root = path.join(home, 'marketplace'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-marketplace-install.json'), JSON.stringify({ source_type: 'git', source: 'https://github.com/EveryInc/compound-engineering-plugin.git', revision: 'e36ddb8cbd4dd902d3b6ddd96165a783b0ac4711' }));
  state.marketplaces = state.marketplaces.filter((entry) => entry.name !== 'compound-engineering-plugin');
  state.marketplaces.push({ name: 'compound-engineering-plugin', root }); save(); process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'add') {
  state.installed = state.installed.filter((entry) => entry.pluginId !== 'compound-engineering@compound-engineering-plugin');
  state.installed.push({ pluginId: 'compound-engineering@compound-engineering-plugin', name: 'compound-engineering', marketplaceName: 'compound-engineering-plugin', version: '3.21.4', enabled: true }); save(); process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'remove') {
  state.installed = state.installed.filter((entry) => entry.pluginId !== args[2]); save(); process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  state.marketplaces = state.marketplaces.filter((entry) => entry.name !== args[3]); save(); process.exit(0);
}
process.exit(1);
`, { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(fakeCodex, 0o755);
    fs.mkdirSync(home, { recursive: true });
    const unrelatedConfig = path.join(codexHome, 'config.toml');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(unrelatedConfig, '[unrelated]\nvalue = true\n');
    const manager = path.join(ROOT, 'runtimes/codex/compound-engineering-activation.js');
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      JARVOS_CODEX_EXECUTABLE: fakeCodex,
      JARVOS_CODEX_PROVIDER_MODE: 'new-managed',
    };
    const activated = spawnSync(process.execPath, [manager], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(activated.status, 0, activated.stderr || activated.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-codex-state.json'), 'utf8'));
    assert.equal(state.installed[0].version, '3.21.4');
    assert.equal(state.marketplaces[0].name, 'compound-engineering-plugin');
    assert.equal(fs.existsSync(path.join(codexHome, 'jarvos-compound-engineering.state.json')), true);
    assert.equal(fs.readFileSync(unrelatedConfig, 'utf8'), '[unrelated]\nvalue = true\n');

    const rolledBack = spawnSync(process.execPath, [manager], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...env, JARVOS_CODEX_PROVIDER_MODE: 'existing', JARVOS_MANAGED_HARNESS_ROLLBACK: '1' },
    });
    assert.equal(rolledBack.status, 0, rolledBack.stderr || rolledBack.stdout);
    const afterRollback = JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-codex-state.json'), 'utf8'));
    assert.deepEqual(afterRollback.installed, []);
    assert.deepEqual(afterRollback.marketplaces, []);
    assert.equal(fs.existsSync(path.join(codexHome, 'jarvos-compound-engineering.state.json')), false);
    assert.equal(fs.readFileSync(unrelatedConfig, 'utf8'), '[unrelated]\nvalue = true\n');

    const oldRevision = '1'.repeat(40);
    const oldMarketplaceRoot = path.join(codexHome, 'old-marketplace');
    fs.mkdirSync(oldMarketplaceRoot, { recursive: true });
    fs.writeFileSync(path.join(oldMarketplaceRoot, '.codex-marketplace-install.json'), JSON.stringify({
      source_type: 'git',
      source: 'https://github.com/EveryInc/compound-engineering-plugin.git',
      revision: oldRevision,
    }));
    fs.writeFileSync(path.join(codexHome, 'fake-codex-state.json'), JSON.stringify({
      installed: [{
        pluginId: 'compound-engineering@compound-engineering-plugin',
        name: 'compound-engineering',
        marketplaceName: 'compound-engineering-plugin',
        version: '3.21.3',
        enabled: true,
      }],
      marketplaces: [{ name: 'compound-engineering-plugin', root: oldMarketplaceRoot }],
    }));
    fs.writeFileSync(path.join(codexHome, 'jarvos-compound-engineering.state.json'), JSON.stringify({
      schemaVersion: 'jarvos-codex-provider-state/v1',
      provider: 'compound-engineering',
      version: '3.21.3',
      revision: oldRevision,
      marketplace: 'compound-engineering-plugin',
      plugin: 'compound-engineering@compound-engineering-plugin',
      marketplaceAdded: true,
      pluginAdded: true,
    }));
    const updated = spawnSync(process.execPath, [manager], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    const afterUpdate = JSON.parse(fs.readFileSync(path.join(codexHome, 'fake-codex-state.json'), 'utf8'));
    assert.equal(afterUpdate.installed[0].version, '3.21.4');
    assert.equal(fs.existsSync(path.join(codexHome, 'jarvos-compound-engineering.state.json')), true);
    assert.equal(fs.readFileSync(unrelatedConfig, 'utf8'), '[unrelated]\nvalue = true\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Compound Engineering capability rejects traversal, symlink, and executable fixture content', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ce-capability-'));
  try {
    const fixtureDir = path.join(tmp, 'fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'safe.json'), '{}\n', 'utf8');
    fs.symlinkSync(path.join(fixtureDir, 'safe.json'), path.join(fixtureDir, 'linked.json'));
    fs.writeFileSync(path.join(fixtureDir, 'executable.json'), '{}\n', { encoding: 'utf8', mode: 0o755 });
    const capability = {
      schemaVersion: 1,
      version: COMPOUND_ENGINEERING_CAPABILITY_VERSION,
      provider: {
        id: 'compound-engineering',
        version: '3.21.4',
        owner: 'EveryInc',
        repository: 'https://github.com/EveryInc/compound-engineering-plugin.git',
        revision: 'e36ddb8cbd4dd902d3b6ddd96165a783b0ac4711',
        license: 'MIT',
      },
      harness: 'codex',
      admission: 'unsupported',
      operations: ['plan', 'work', 'compound'],
      activation: {
        mechanism: 'codex-plugin-marketplace',
        marketplaceArgv: ['codex', 'plugin', 'marketplace', 'add', 'EveryInc/compound-engineering-plugin', '--ref', 'e36ddb8cbd4dd902d3b6ddd96165a783b0ac4711'],
        pluginArgv: ['codex', 'plugin', 'add', 'compound-engineering@compound-engineering-plugin'],
        candidateOnly: true,
        requiresRestart: true,
      },
      discovery: { commands: [{ id: 'version', argv: ['codex', '--version'], readOnly: true, activatesPluginCode: false }] },
      invocation: { surface: 'codex exec', proof: 'characterized' },
      proof: { artifactBoundary: 'characterized', discovery: 'observed', invocation: 'characterized', receipt: 'jarvos-contract', activation: 'unproven', conformant: false },
      fixtureRoot: 'fixtures',
      fixtureFiles: ['safe.json', 'linked.json', 'executable.json'],
      fixtureTreeDigest: computeCompoundEngineeringFixtureDigest(fixtureDir),
    };
    const capabilityPath = path.join(tmp, 'capability.json');
    fs.writeFileSync(capabilityPath, JSON.stringify(capability, null, 2));
    const result = checkCompoundEngineeringCapability(capabilityPath, { root: tmp });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /symlink|executable/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function runHermesSetup({ healthy = true, isolatedHermesHome = false, rejectGuardedPluginFlag = false, existingMcp = false, routeBinding = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-hermes-setup-'));
  const home = path.join(tmp, 'home');
  const hermesHome = isolatedHermesHome ? path.join(tmp, 'hermes-home') : path.join(home, '.hermes');
  const workspace = path.join(tmp, 'workspace');
  const binDir = path.join(tmp, 'bin');
  const logPath = path.join(tmp, 'hermes.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  if (existingMcp) {
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(path.join(hermesHome, 'config.yaml'), 'terminal:\n  cwd: /tmp\nmcp_servers:\n  jarvos:\n    command: node\n', 'utf8');
  }
  const routeSecretFile = path.join(tmp, 'route.secret');
  if (routeBinding) fs.writeFileSync(routeSecretFile, 'test-route-secret\n', { encoding: 'utf8', mode: 0o600 });
  const fakeList = existingMcp ? "printf 'jarvos  node  all  ✓ enabled\\n'; exit 0" : 'exit 1';
  const fakeHermes = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
    `if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "list" ]; then ${fakeList}; fi`,
    'if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "add" ]; then',
    '  mkdir -p "$HERMES_HOME"',
    "  printf 'terminal:\\n' > \"$HERMES_HOME/config.yaml\"",
    '  exit 0',
    'fi',
    `if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "test" ]; then exit ${healthy ? 0 : 1}; fi`,
    'if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "remove" ]; then exit 0; fi',
    ...(rejectGuardedPluginFlag ? [
      'if [ "${1:-}" = "plugins" ] && [ "${2:-}" = "enable" ] && [ "${4:-}" = "--no-allow-tool-override" ]; then',
      '  printf "%s\\n" "usage: hermes plugins enable [OPTIONS]" "error: unrecognized arguments: --no-allow-tool-override" >&2',
      '  exit 2',
      'fi',
    ] : []),
    'exit 0',
    '',
  ].join('\n');
  const fakePath = path.join(binDir, 'hermes');
  fs.writeFileSync(fakePath, fakeHermes, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(fakePath, 0o755);
  const result = spawnSync('bash', [path.join(ROOT, 'runtimes', 'hermes', 'setup.sh'), workspace], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...(isolatedHermesHome ? { HERMES_HOME: hermesHome } : {}), ...(routeBinding ? { JARVOS_ROUTE_BINDING_SECRET_FILE: routeSecretFile } : {}), PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    tmp,
    hermesHome,
    routeSecretFile,
    logPath,
    result,
    cleanup() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

test('Hermes setup registers and verifies MCP for a fresh config', () => {
  const run = runHermesSetup();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const log = fs.readFileSync(run.logPath, 'utf8');
    assert.match(log, /plugins enable jarvos-context --no-allow-tool-override/);
    assert.match(log, /mcp add jarvos --command node --args/);
    assert.match(log, /mcp test jarvos/);
    assert.match(run.result.stdout, /Hermes MCP entry 'jarvos' is healthy/);
    assert.ok(fs.existsSync(path.join(run.tmp, 'home', '.hermes', 'plugins', 'jarvos-context', 'plugin.yaml')));
  } finally {
    run.cleanup();
  }
});

test('Hermes setup retries plugin enablement when the CLI rejects the guarded flag', () => {
  const run = runHermesSetup({ rejectGuardedPluginFlag: true });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const log = fs.readFileSync(run.logPath, 'utf8');
    assert.match(log, /plugins enable jarvos-context --no-allow-tool-override/);
    assert.match(log, /plugins enable jarvos-context\n/);
    assert.match(run.result.stdout, /bounded jarvOS context plugin enabled/);
  } finally {
    run.cleanup();
  }
});

test('Hermes setup keeps MCP, plugin, and skills in an explicitly requested home', () => {
  const run = runHermesSetup({ isolatedHermesHome: true });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    assert.ok(fs.existsSync(path.join(run.hermesHome, 'config.yaml')));
    assert.ok(fs.existsSync(path.join(run.hermesHome, 'plugins', 'jarvos-context', 'plugin.yaml')));
    assert.ok(fs.existsSync(path.join(run.hermesHome, 'skills')));
    assert.equal(fs.existsSync(path.join(run.tmp, 'home', '.hermes', 'config.yaml')), false);
  } finally {
    run.cleanup();
  }
});

test('Hermes setup fails closed when a newly registered MCP is unhealthy', () => {
  const run = runHermesSetup({ healthy: false });
  try {
    assert.notEqual(run.result.status, 0);
    const log = fs.readFileSync(run.logPath, 'utf8');
    assert.match(log, /mcp add jarvos --command node --args/);
    assert.match(log, /mcp test jarvos/);
    assert.match(log, /mcp remove jarvos/);
    assert.match(run.result.stdout, /did not establish a healthy Hermes MCP connection/);
  } finally {
    run.cleanup();
  }
});

test('Hermes setup reconciles an existing MCP entry when private route binding is requested', () => {
  const run = runHermesSetup({ existingMcp: true, routeBinding: true });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const log = fs.readFileSync(run.logPath, 'utf8');
    assert.match(log, /mcp remove jarvos/);
    assert.match(log, /mcp add jarvos --command node --args/);
    assert.match(log, /JARVOS_ROUTE_BINDING_SECRET_FILE=/);
    assert.match(log, /JARVOS_REQUIRE_ROUTE_CAPABILITY=1/);
    assert.match(run.result.stdout, /reconciled with the private binding/);
  } finally {
    run.cleanup();
  }
});

test('validateManifest accepts the Codex runtime manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/codex/adapter.json'), 'utf8'));
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(manifest.sharedAgentContext.requiredTools.includes('jarvos_control_plane'));
  assert.equal(manifest.controlPlane.module, 'modules/jarvos-control-plane/scripts/jarvos-manager.js');
});

test('private continuity harnesses share one provider-native GBrain contract', () => {
  for (const harness of ['codex', 'hermes', 'openclaw']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, `runtimes/${harness}/adapter.json`), 'utf8'));
    const result = validateManifest(manifest);
    assert.equal(result.ok, true, `${harness}: ${result.errors.join('\n')}`);
    assert.equal(manifest.gbrainContinuity.transport, 'provider-native-stdio');
    assert.equal(manifest.gbrainContinuity.availability, 'optional-public-required-private');
    assert.equal(manifest.gbrainContinuity.skillProjection.owner, 'gbrain');
    assert.equal(manifest.gbrainContinuity.skillProjection.mode, 'provider-resolver');
    assert.equal(manifest.gbrainContinuity.skillProjection.copiedIntoJarvosSkills, false);
    assert.equal(manifest.gbrainContinuity.maintenance.sweepDisabled, true);
  }
});

test('private continuity manifest rejects copied Skillify and missing provider tools', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/codex/adapter.json'), 'utf8'));
  manifest.gbrainContinuity = {
    ...manifest.gbrainContinuity,
    requiredTools: ['recall'],
    skillProjection: {
      ...manifest.gbrainContinuity.skillProjection,
      copiedIntoJarvosSkills: true,
    },
  };
  const result = validateManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /requiredTools.*list_skills/);
  assert.match(result.errors.join('\n'), /provider-owned and resolver-backed/);
});

test('private continuity manifests reject prose or misordered native registration commands', () => {
  const hermes = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/hermes/adapter.json'), 'utf8'));
  hermes.gbrainContinuity.registration.command = 'hermes mcp add gbrain --command node --args launcher --env descriptor';
  const hermesResult = validateManifest(hermes);
  assert.equal(hermesResult.ok, false);
  assert.match(hermesResult.errors.join('\n'), /verified hermes native MCP command contract/);

  const openclaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/openclaw/adapter.json'), 'utf8'));
  openclaw.gbrainContinuity.registration.command = 'Register gbrain somehow';
  const openclawResult = validateManifest(openclaw);
  assert.equal(openclawResult.ok, false);
  assert.match(openclawResult.errors.join('\n'), /verified openclaw native MCP command contract/);
});

test('validateManifest accepts the OpenClaw persistence ownership and validation contract', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/openclaw/adapter.json'), 'utf8'));
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(manifest.stewardshipAdapter.persistence.owner, 'openclaw-plugin-registry');
  assert.deepEqual(manifest.stewardshipAdapter.persistence.validation.command, ['plugins', 'inspect', '--all', '--json']);
  assert.equal(manifest.stewardshipAdapter.persistence.validation.readOnly, true);
  assert.equal(manifest.stewardshipAdapter.persistence.validation.activatesPluginCode, false);
});

test('validateManifest rejects incomplete control-plane parity declarations', () => {
  const result = validateManifest({
    schemaVersion: 1, id: 'bad-runtime', displayName: 'Bad Runtime', setup: { script: 'setup.sh' },
    sharedAgentContext: { mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js', requiredTools: ['jarvos_hydrate'] },
    targets: [{ id: 'bad-cli', kind: 'cli', mcp: { supported: true }, hydration: { mode: 'manual', reason: 'test' } }],
    controlPlane: { module: 'wrong.js' },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /controlPlane\.module/);
  assert.match(result.errors.join('\n'), /jarvos_control_plane/);
  assert.match(result.errors.join('\n'), /hostService/);
});

test('validateManifest requires the secure control-plane host-service environment boundary', () => {
  const result = validateManifest({
    schemaVersion: 1, id: 'bad-runtime', displayName: 'Bad Runtime', setup: { script: 'setup.sh' },
    sharedAgentContext: { mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js', requiredTools: ['jarvos_hydrate', 'jarvos_control_plane'] },
    targets: [{ id: 'bad-cli', kind: 'cli', mcp: { supported: true }, hydration: { mode: 'manual', reason: 'test' } }],
    controlPlane: { module: 'modules/jarvos-control-plane/scripts/jarvos-manager.js', hostService: 'unsafe-service-path' },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /JARVOS_CONTROL_PLANE_SERVICE_MODULE/);
});

test('validateManifest emits a single hostService error when the field is omitted', () => {
  const result = validateManifest({
    schemaVersion: 1, id: 'bad-runtime', displayName: 'Bad Runtime', setup: { script: 'setup.sh' },
    sharedAgentContext: { mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js', requiredTools: ['jarvos_hydrate', 'jarvos_control_plane'] },
    targets: [{ id: 'bad-cli', kind: 'cli', mcp: { supported: true }, hydration: { mode: 'manual', reason: 'test' } }],
    controlPlane: { module: 'modules/jarvos-control-plane/scripts/jarvos-manager.js' },
  });
  assert.equal(result.ok, false);
  const hostServiceErrors = result.errors.filter((message) => /hostService/.test(message));
  assert.deepEqual(hostServiceErrors, [
    'controlPlane.hostService is required when controlPlane is declared',
  ]);
});

test('validateManifest rejects missing shared jarvos_hydrate tool', () => {
  const result = validateManifest({
    schemaVersion: 1,
    id: 'bad-runtime',
    displayName: 'Bad Runtime',
    setup: { script: 'setup.sh' },
    sharedAgentContext: {
      mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
      requiredTools: ['jarvos_current_work'],
    },
    targets: [{ id: 'bad-cli', kind: 'cli', mcp: { supported: true }, hydration: { mode: 'manual', reason: 'test' } }],
    configWrites: { backupBeforeWrite: true },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /jarvos_hydrate/);
});

test('validateManifest reports malformed target entries', () => {
  const result = validateManifest({
    schemaVersion: 1,
    id: 'bad-runtime',
    displayName: 'Bad Runtime',
    setup: { script: 'setup.sh' },
    sharedAgentContext: {
      mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
      requiredTools: ['jarvos_hydrate'],
    },
    targets: [null],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /targets\[0\] must be an object/);
});

test('validateManifest requires a reason for unsupported MCP targets', () => {
  const manifest = {
    schemaVersion: 1,
    id: 'sample-runtime',
    displayName: 'Sample Runtime',
    setup: { script: 'setup.sh' },
    sharedAgentContext: {
      mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
      requiredTools: ['jarvos_hydrate'],
    },
    targets: [{
      id: 'sample-runtime-cli',
      kind: 'cli',
      mcp: { supported: false },
      hydration: { mode: 'manual', reason: 'test' },
    }],
  };

  const rejected = validateManifest(manifest);
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join('\n'), /unsupported MCP requires a reason/);

  manifest.targets[0].mcp.reason = 'Host has no MCP registration surface yet.';
  assert.equal(validateManifest(manifest).ok, true);
});

test('validateManifest rejects unsupported hydration modes', () => {
  const result = validateManifest({
    schemaVersion: 1,
    id: 'bad-runtime',
    displayName: 'Bad Runtime',
    setup: { script: 'setup.sh' },
    sharedAgentContext: {
      mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
      requiredTools: ['jarvos_hydrate'],
    },
    targets: [{
      id: 'bad-runtime-cli',
      kind: 'cli',
      mcp: { supported: true },
      hydration: { mode: 'hooks' },
    }],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /hydration\.mode must be one of: hook, manual, unsupported/);
});

test('checkRuntime passes every checked-in adapter manifest', () => {
  const manifests = listRuntimeManifests(ROOT);
  assert.ok(manifests.length >= 3);
  for (const manifest of manifests) {
    const result = checkRuntime(manifest, { root: ROOT });
    assert.equal(result.ok, true, `${result.manifest}\n${result.errors.join('\n')}`);
  }
});

test('checkRuntime reports unloadable MCP servers without throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-bad-mcp-'));
  try {
    const runtimeDir = path.join(tmp, 'runtimes/sample-runtime');
    const mcpDir = path.join(tmp, 'modules/jarvos-agent-context/scripts');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'jarvos-mcp.js'), 'throw new Error("boom");\n', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'README.md'), 'Manual hydration is documented for sample-runtime-cli.\n', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'setup.sh'), '#!/usr/bin/env bash\ncp "$1" "$1.bak"\n', { encoding: 'utf8', mode: 0o755 });
    const manifestPath = path.join(runtimeDir, 'adapter.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      sharedAgentContext: {
        mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
        requiredTools: ['jarvos_hydrate'],
      },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      configWrites: { backupBeforeWrite: true },
    }, null, 2));

    const result = checkRuntime(manifestPath, { root: tmp });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /shared MCP server could not be loaded: boom/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkRuntime does not load repo root for malformed shared MCP config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-missing-shared-'));
  try {
    const manifestPath = path.join(tmp, 'adapter.json');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'Manual hydration is documented for sample-runtime-cli.\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'setup.sh'), '#!/usr/bin/env bash\ncp "$1" "$1.bak"\n', { encoding: 'utf8', mode: 0o755 });
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      configWrites: { backupBeforeWrite: true },
    }, null, 2));

    const result = checkRuntime(manifestPath, { root: ROOT });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /sharedAgentContext is required/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkRuntime requires README manual hydration docs to name the target', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-readme-docs-'));
  try {
    const manifestPath = path.join(tmp, 'adapter.json');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'Manual hydration is documented for this runtime.\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'setup.sh'), '#!/usr/bin/env bash\ncp "$1" "$1.bak"\n', { encoding: 'utf8', mode: 0o755 });
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      sharedAgentContext: {
        mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
        requiredTools: ['jarvos_hydrate'],
      },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      configWrites: { backupBeforeWrite: true },
    }, null, 2));

    const result = checkRuntime(manifestPath, { root: ROOT });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /README must document manual or unsupported hydration for sample-runtime-cli/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkRuntime reports missing setup scripts without throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-missing-setup-'));
  try {
    const manifestPath = path.join(tmp, 'adapter.json');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'Manual hydration is documented for sample-runtime-cli.\n', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      sharedAgentContext: {
        mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
        requiredTools: ['jarvos_hydrate'],
      },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      configWrites: { backupBeforeWrite: true },
    }, null, 2));

    const result = checkRuntime(manifestPath, { root: ROOT });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /setup script missing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex runtime setup uses credential-file binding without registering the secret', () => {
  const setupPath = path.join(ROOT, 'runtimes/codex/setup.sh');
  const source = fs.readFileSync(setupPath, 'utf8');
  assert.match(source, /JARVOS_CONTROL_PLANE_CREDENTIAL_FILE/);
  assert.match(source, /--env "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=/);
  assert.doesNotMatch(source, /--env\s+["']?JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)=/);
  const result = checkRuntime(path.join(ROOT, 'runtimes/codex/adapter.json'), { root: ROOT });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('checkRuntime requires host env presence and --env binding for control-plane setup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-cp-setup-'));
  try {
    const runtimeDir = path.join(tmp, 'runtimes/sample-runtime');
    const mcpDir = path.join(tmp, 'modules/jarvos-agent-context/scripts');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'jarvos-mcp.js'), [
      "module.exports = { TOOLS: [{ name: 'jarvos_hydrate' }, { name: 'jarvos_control_plane' }] };",
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'README.md'), 'Manual hydration is documented for sample-runtime-cli.\n', 'utf8');

    const baseManifest = {
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      sharedAgentContext: {
        mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
        requiredTools: ['jarvos_hydrate', 'jarvos_control_plane'],
      },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      controlPlane: {
        module: 'modules/jarvos-control-plane/scripts/jarvos-manager.js',
        hostService: 'JARVOS_CONTROL_PLANE_SERVICE_MODULE',
        credentialFile: 'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE',
      },
      configWrites: { backupBeforeWrite: true },
    };
    const manifestPath = path.join(runtimeDir, 'adapter.json');
    fs.writeFileSync(manifestPath, JSON.stringify(baseManifest, null, 2));

    // Host env name alone is not enough — setup must also bind it via --env.
    fs.writeFileSync(path.join(runtimeDir, 'setup.sh'), [
      '#!/usr/bin/env bash',
      'cp "$1" "$1.bak"',
      'echo "$JARVOS_CONTROL_PLANE_SERVICE_MODULE"',
      'echo "$JARVOS_CONTROL_PLANE_CREDENTIAL_FILE"',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    let result = checkRuntime(manifestPath, { root: tmp });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /bind JARVOS_CONTROL_PLANE_SERVICE_MODULE into the MCP host environment/);

    // --env for something else must fail without the host env token.
    fs.writeFileSync(path.join(runtimeDir, 'setup.sh'), [
      '#!/usr/bin/env bash',
      'cp "$1" "$1.bak"',
      'mcp add --env "OTHER=1" jarvos -- node server.js',
      'echo "$JARVOS_CONTROL_PLANE_CREDENTIAL_FILE"',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    result = checkRuntime(manifestPath, { root: tmp });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /configure JARVOS_CONTROL_PLANE_SERVICE_MODULE for the MCP host/);

    // Credential-file env name alone is not enough — setup must bind the
    // non-secret path into the MCP host environment too.
    fs.writeFileSync(path.join(runtimeDir, 'setup.sh'), [
      '#!/usr/bin/env bash',
      'cp "$1" "$1.bak"',
      'mcp add --env "JARVOS_CONTROL_PLANE_SERVICE_MODULE=$JARVOS_CONTROL_PLANE_SERVICE_MODULE" jarvos -- node server.js',
      'echo "$JARVOS_CONTROL_PLANE_CREDENTIAL_FILE"',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    result = checkRuntime(manifestPath, { root: tmp });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /bind JARVOS_CONTROL_PLANE_CREDENTIAL_FILE into the MCP host environment/);

    // Host env bound via --env (runtime-agnostic) plus credential-file boundary passes.
    fs.writeFileSync(path.join(runtimeDir, 'setup.sh'), [
      '#!/usr/bin/env bash',
      'cp "$1" "$1.bak"',
      'mcp add --env "JARVOS_CONTROL_PLANE_SERVICE_MODULE=$JARVOS_CONTROL_PLANE_SERVICE_MODULE" \\',
      '  --env "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=$JARVOS_CONTROL_PLANE_CREDENTIAL_FILE" \\',
      '  jarvos -- node server.js',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    result = checkRuntime(manifestPath, { root: tmp });
    assert.equal(result.ok, true, result.errors.join('\n'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkRuntime requires live MCP TOOLS to include jarvos_control_plane when controlPlane is declared', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-cp-tools-'));
  try {
    const runtimeDir = path.join(tmp, 'runtimes/sample-runtime');
    const mcpDir = path.join(tmp, 'modules/jarvos-agent-context/scripts');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(mcpDir, { recursive: true });
    // Negative: hydrate present, control-plane tool missing.
    fs.writeFileSync(path.join(mcpDir, 'jarvos-mcp.js'), [
      "module.exports = { TOOLS: [{ name: 'jarvos_hydrate' }] };",
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'README.md'), 'Manual hydration is documented for sample-runtime-cli.\n', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'setup.sh'), [
      '#!/usr/bin/env bash',
      'cp "$1" "$1.bak"',
      'mcp add --env "JARVOS_CONTROL_PLANE_SERVICE_MODULE=$JARVOS_CONTROL_PLANE_SERVICE_MODULE" \\',
      '  --env "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=$JARVOS_CONTROL_PLANE_CREDENTIAL_FILE" \\',
      '  jarvos -- node server.js',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    const manifestPath = path.join(runtimeDir, 'adapter.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      sharedAgentContext: {
        mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
        requiredTools: ['jarvos_hydrate', 'jarvos_control_plane'],
      },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      controlPlane: {
        module: 'modules/jarvos-control-plane/scripts/jarvos-manager.js',
        hostService: 'JARVOS_CONTROL_PLANE_SERVICE_MODULE',
        credentialFile: 'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE',
      },
      configWrites: { backupBeforeWrite: true },
    }, null, 2));

    const result = checkRuntime(manifestPath, { root: tmp });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /shared MCP server does not expose jarvos_control_plane/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scaffoldRuntime creates a valid starter adapter', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-'));
  try {
    const result = scaffoldRuntime('sample-runtime', path.join(tmp, 'sample-runtime'));
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(path.join(result.dir, 'adapter.json')));
    assert.ok(fs.existsSync(path.join(result.dir, 'README.md')));
    assert.ok(fs.existsSync(path.join(result.dir, 'setup.sh')));
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'adapter.json'), 'utf8'));
    assert.equal(validateManifest(manifest).ok, true);
    assert.equal(checkRuntime(path.join(result.dir, 'adapter.json'), { root: ROOT }).ok, true);
    assert.match(manifest.verification[0], /adapter\.json/);
    const output = execFileSync(process.execPath, [
      path.join(ROOT, 'modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js'),
      'check',
      path.join(result.dir, 'adapter.json'),
      '--json',
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(JSON.parse(output).ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shipped shared-skill adapters declare a complete projection contract', () => {
  for (const harness of ['codex', 'claude', 'openclaw', 'hermes']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', harness, 'adapter.json'), 'utf8'));
    assert.equal(validateManifest(manifest).ok, true, `${harness}: ${validateManifest(manifest).errors.join('; ')}`);
    assert.equal(manifest.skillProjection.version, 'jarvos-skill-projection-adapter/v1');
    assert.equal(manifest.skillProjection.renderer, 'raw-skill-bundle');
    assert.ok(['exact-path', 'interactive-smoke'].includes(manifest.skillProjection.verificationTier));
  }
});

function writeOwnerEvidenceFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function digestOf(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('registration health or missing evidence cannot activate OpenClaw', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  const missing = getManagedActivationStatus({
    runtime: 'openclaw',
    root: ROOT,
    now,
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.status.state, 'unconfigured');
  assert.notEqual(missing.status.state, 'active');

  const healthOnly = getManagedActivationStatus({
    runtime: 'openclaw',
    root: ROOT,
    now,
    evidence: {
      schemaVersion: 'jarvos-managed-activation-owner-evidence/v1',
      harnesses: {
        openclaw: {
          configured: true,
          prepared: true,
          health: { available: true, healthy: true },
          rollback: { status: 'none' },
        },
      },
    },
  });
  assert.equal(healthOnly.status.state, 'prepared');
  assert.notEqual(healthOnly.status.state, 'active');

  const registeredWithoutLive = getManagedActivationStatus({
    runtime: 'openclaw',
    root: ROOT,
    now,
    evidence: {
      schemaVersion: 'jarvos-managed-activation-owner-evidence/v1',
      harnesses: {
        openclaw: {
          configured: true,
          prepared: true,
          generation: 'openclaw-gen-1',
          // paths omitted → attestation unavailable; registration alone is not live proof
          health: { available: true, healthy: true },
          challenges: [{ correlation: 'openclaw-challenge-1', harness: 'openclaw', baselineAt: '2026-08-16T11:50:00.000Z' }],
          receipts: [],
          rollback: { status: 'none' },
        },
      },
    },
  });
  assert.ok(['prepared', 'awaiting_live_proof'].includes(registeredWithoutLive.status.state));
  assert.notEqual(registeredWithoutLive.status.state, 'active');
});

test('Hermes requires the ordered session then turn sequence for activation', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-activation-hermes-')));
  fs.chmodSync(root, 0o700);
  try {
    const asset = path.join(root, 'asset.js');
    const entry = path.join(root, 'entry.js');
    const config = path.join(root, 'config.json');
    writeOwnerEvidenceFile(asset, 'hermes-asset');
    writeOwnerEvidenceFile(entry, 'hermes-entry');
    writeOwnerEvidenceFile(config, '{"hermes":true}');
    const generation = 'hermes-gen-1';
    const tuple = buildSelectedTuple({
      harness: 'hermes',
      generation,
      assetDigest: digestOf('hermes-asset'),
      entrypointDigest: digestOf('hermes-entry'),
      configBindingDigest: digestOf('{"hermes":true}'),
    });
    const session = {
      schemaVersion: MANAGED_ACTIVATION_RECEIPT_VERSION,
      harness: 'hermes',
      correlation: 'hermes-challenge-1',
      eventClass: 'session',
      producer: 'selected-runtime-bridge',
      producerEvent: MANAGED_ACTIVATION_PRODUCER_EVENTS.hermes.session,
      tupleDigest: tuple.tupleDigest,
      producedAt: '2026-08-16T11:54:00.000Z',
    };
    const turn = {
      schemaVersion: MANAGED_ACTIVATION_RECEIPT_VERSION,
      harness: 'hermes',
      correlation: 'hermes-challenge-1',
      eventClass: 'turn',
      producer: 'selected-runtime-bridge',
      producerEvent: MANAGED_ACTIVATION_PRODUCER_EVENTS.hermes.turn,
      tupleDigest: tuple.tupleDigest,
      producedAt: '2026-08-16T11:55:00.000Z',
    };
    const baseHarness = {
      configured: true,
      prepared: true,
      generation,
      assetPaths: [asset],
      entrypointPath: entry,
      configBindingPath: config,
      challenges: [{ correlation: 'hermes-challenge-1', harness: 'hermes', baselineAt: '2026-08-16T11:50:00.000Z' }],
      health: { available: false },
      rollback: { status: 'none' },
    };

    const incomplete = getManagedActivationStatus({
      runtime: 'hermes',
      root: ROOT,
      now,
      evidence: {
        schemaVersion: 'jarvos-managed-activation-owner-evidence/v1',
        harnesses: { hermes: { ...baseHarness, receipts: [session] } },
      },
    });
    assert.equal(incomplete.status.state, 'awaiting_live_proof');

    const ordered = getManagedActivationStatus({
      runtime: 'hermes',
      root: ROOT,
      now,
      evidence: {
        schemaVersion: 'jarvos-managed-activation-owner-evidence/v1',
        harnesses: { hermes: { ...baseHarness, receipts: [session, turn] } },
      },
    });
    assert.equal(ordered.status.state, 'active');

    const outOfOrder = getManagedActivationStatus({
      runtime: 'hermes',
      root: ROOT,
      now,
      evidence: {
        schemaVersion: 'jarvos-managed-activation-owner-evidence/v1',
        harnesses: {
          hermes: {
            ...baseHarness,
            receipts: [
              { ...turn, producedAt: '2026-08-16T11:54:00.000Z' },
              { ...session, producedAt: '2026-08-16T11:55:00.000Z' },
            ],
          },
        },
      },
    });
    assert.notEqual(outOfOrder.status.state, 'active');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI and library activation-status are equivalent and public-safe', () => {
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-activation-cli-')));
  fs.chmodSync(root, 0o700);
  const cli = path.join(ROOT, 'modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js');
  try {
    const evidencePath = path.join(root, 'evidence.json');
    const privatePath = '/Users/andrew/.jarvos/private/state/session-abc123';
    const privateSession = 'session-abc-xyz-999';
    const privateProcess = 'pid-4242';
    const privateDiag = 'raw hook output: SessionStart failed at /tmp/private';
    writeOwnerEvidenceFile(evidencePath, `${JSON.stringify({
      schemaVersion: 'jarvos-managed-activation-owner-evidence/v1',
      harnesses: {
        codex: {
          configured: true,
          prepared: true,
          privatePath,
          sessionId: privateSession,
          processId: privateProcess,
          diagnostic: privateDiag,
          health: { available: false },
          rollback: { status: 'none' },
        },
      },
    }, null, 2)}\n`);

    const libraryAll = getManagedActivationStatus({
      runtime: 'all',
      root: ROOT,
      evidencePath,
      now,
    });
    assert.equal(libraryAll.ok, true);
    assert.deepEqual(libraryAll.results.map((item) => item.harness), ['claude', 'codex', 'hermes', 'openclaw']);
    const libraryCodex = libraryAll.results.find((item) => item.harness === 'codex');
    assert.equal(libraryCodex.state, 'prepared');
    assert.equal(libraryCodex.schemaVersion, MANAGED_ACTIVATION_STATUS_VERSION);

    const cliJson = spawnSync(process.execPath, [
      cli, 'activation-status', 'all', '--evidence', evidencePath, '--test-now', String(now), '--json',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, JARVOS_MANAGED_ACTIVATION_TEST_MODE: '1' },
    });
    assert.equal(cliJson.status, 0, cliJson.stderr || cliJson.stdout);
    const cliResult = JSON.parse(cliJson.stdout);
    assert.deepEqual(
      JSON.parse(JSON.stringify(cliResult)),
      JSON.parse(JSON.stringify(libraryAll)),
    );

    const encoded = JSON.stringify(cliResult);
    assert.equal(encoded.includes(privatePath), false);
    assert.equal(encoded.includes(privateSession), false);
    assert.equal(encoded.includes(privateProcess), false);
    assert.equal(encoded.includes(privateDiag), false);
    assert.equal(encoded.includes('/Users/'), false);
    assert.equal(encoded.includes('sessionId'), false);
    assert.equal(encoded.includes('processId'), false);
    assert.equal(encoded.includes('privatePath'), false);

    const human = spawnSync(process.execPath, [
      cli, 'activation-status', 'codex', '--evidence', evidencePath, '--test-now', String(now),
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, JARVOS_MANAGED_ACTIVATION_TEST_MODE: '1' },
    });
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.match(human.stdout, /codex/);
    assert.match(human.stdout, /prepared/);
    assert.doesNotMatch(human.stdout, /\/Users\//);
    assert.doesNotMatch(human.stdout, /session-abc/);

    // Library evaluation must match evaluateManagedActivation + toPublicActivationStatus.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/codex/adapter.json'), 'utf8'));
    const loaded = loadOwnerEvidence(evidencePath);
    assert.equal(loaded.ok, true);
    const evaluated = evaluateManagedActivation({
      contract: manifest.managedActivation,
      evidence: {
        configured: true,
        prepared: true,
        attestation: { ok: false, reasonCode: 'attestation_unavailable' },
        challenges: [],
        receipts: [],
        health: { available: false },
        rollback: { status: 'none' },
      },
      now,
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(toPublicActivationStatus(evaluated))),
      JSON.parse(JSON.stringify(libraryCodex)),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activation-status is read-only and never claims active without evidence', () => {
  const cli = path.join(ROOT, 'modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js');
  const before = listRuntimeManifests(ROOT).map((filePath) => ({
    filePath,
    body: fs.readFileSync(filePath, 'utf8'),
  }));
  const result = spawnSync(process.execPath, [cli, 'activation-status', 'all', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, JARVOS_MANAGED_ACTIVATION_NOW: '0' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.results.length, 4);
  for (const status of payload.results) {
    assert.notEqual(status.state, 'active');
    assert.ok(['unconfigured', 'prepared', 'awaiting_live_proof', 'degraded', 'rollback_pending', 'rolled_back'].includes(status.state));
    assert.ok(Date.parse(status.evaluatedAt) > Date.parse('2020-01-01T00:00:00.000Z'));
  }
  for (const entry of before) {
    assert.equal(fs.readFileSync(entry.filePath, 'utf8'), entry.body);
  }

  const forbiddenTestClock = spawnSync(process.execPath, [
    cli, 'activation-status', 'all', '--test-now', '0', '--json',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(forbiddenTestClock.status, 0);
  assert.match(forbiddenTestClock.stderr, /explicit managed-activation test mode/);
});

test('activation-status rejects a relative evidence path instead of resolving it from cwd', () => {
  const result = getManagedActivationStatus({
    runtime: 'codex',
    root: ROOT,
    evidencePath: 'owner-evidence.json',
    now: Date.parse('2026-08-16T12:00:00.000Z'),
  });
  assert.deepEqual(result, {
    ok: false,
    error: 'evidence_unreadable',
    results: [],
  });
});
