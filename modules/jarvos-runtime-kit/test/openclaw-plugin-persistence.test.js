'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OPENCLAW_PERSISTENCE_CAPABILITIES,
  assessOpenClawPluginPersistence,
  collectOpenClawPluginEvidence,
  runOpenClawCommand,
  verifyOpenClawPluginRegistration,
} = require('../src/openclaw-plugin-persistence.js');

const ROOT = '/synthetic/openclaw';
const STAGED_ADAPTER = `${ROOT}/jarvos/runtimes/openclaw/jarvos-next-turn-plugin.js`;

function snapshot({ plugins = [], installRecords = {}, inspections = plugins.map((plugin) => ({
  plugin: {
    id: plugin.pluginId,
    status: 'loaded',
    enabled: plugin.enabled,
    rootDir: plugin.rootDir,
    version: plugin.packageVersion,
  },
  diagnostics: [],
})), existing = () => true, stagedAdapter = {} } = {}) {
  return {
    version: { version: '2026.7.1' },
    registry: {
      current: {
        version: 1,
        hostContractVersion: '2026.7.1',
        plugins,
        installRecords,
      },
    },
    inspections,
    filesystem: {
      exists: existing,
      isFile: existing,
    },
    stagedAdapter: {
      path: STAGED_ADAPTER,
      exists: stagedAdapter.exists ?? true,
      manifestExists: stagedAdapter.manifestExists ?? true,
    },
  };
}

function npmPlugin(id, rootDir = `${ROOT}/managed/${id}`) {
  return {
    pluginId: id,
    origin: 'npm',
    source: `${rootDir}/index.js`,
    enabled: true,
    rootDir,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    packageName: `@example/${id}`,
    packageVersion: '1.2.3',
  };
}

function configPlugin(id, rootDir = `${ROOT}/extensions/${id}`) {
  return {
    pluginId: id,
    origin: 'config',
    source: `${rootDir}/index.js`,
    enabled: true,
    rootDir,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    packageName: id,
    packageVersion: '4.5.6',
  };
}

test('the capability matrix documents the supported read-only, non-activating commands', () => {
  assert.equal(OPENCLAW_PERSISTENCE_CAPABILITIES.version, '2026.7.1');
  assert.deepEqual(
    OPENCLAW_PERSISTENCE_CAPABILITIES.commands.map((command) => command.args),
    [
      ['--version'],
      ['plugins', 'registry', '--json'],
      ['plugins', 'inspect', '--all', '--json'],
    ],
  );
  for (const command of OPENCLAW_PERSISTENCE_CAPABILITIES.commands) {
    assert.equal(command.readOnly, true);
    assert.equal(command.activatesPluginCode, false);
    assert.ok(command.schema);
    assert.ok(command.fields.length > 0);
  }
});

test('derives arbitrary managed and path-loaded plugins without a fixed inventory', () => {
  const alpha = npmPlugin('alpha');
  const beta = configPlugin('beta');
  const result = assessOpenClawPluginPersistence(snapshot({
    plugins: [alpha, beta],
    installRecords: {
      alpha: {
        source: 'npm',
        installPath: alpha.rootDir,
        version: '1.2.3',
      },
    },
  }));

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.plugins.map((plugin) => plugin.id), ['alpha', 'beta']);
  assert.equal(result.plugins.find((plugin) => plugin.id === 'alpha').classification, 'healthy');
  assert.equal(result.plugins.find((plugin) => plugin.id === 'beta').classification, 'healthy');
  assert.equal(result.summary.protectedRootCount, 2);
  assert.equal(result.jarvosAdapter.status, 'healthy');
});

test('classifies missing records, paths, manifests, load state, and staged adapter separately', () => {
  const missingRecord = npmPlugin('missing-record');
  const missingPath = npmPlugin('missing-path');
  const missingManifest = npmPlugin('missing-manifest');
  const unavailable = npmPlugin('unavailable');
  const result = assessOpenClawPluginPersistence(snapshot({
    plugins: [missingRecord, missingPath, missingManifest, unavailable],
    installRecords: {
      'missing-path': { source: 'npm', installPath: missingPath.rootDir, version: '1.2.3' },
      'missing-manifest': { source: 'npm', installPath: missingManifest.rootDir, version: '1.2.3' },
      unavailable: { source: 'npm', installPath: unavailable.rootDir, version: '1.2.3' },
    },
    inspections: [
      { plugin: { id: 'missing-record', status: 'loaded', enabled: true }, diagnostics: [] },
      { plugin: { id: 'missing-path', status: 'loaded', enabled: true, rootDir: missingPath.rootDir }, diagnostics: [] },
      { plugin: { id: 'missing-manifest', status: 'loaded', enabled: true, rootDir: missingManifest.rootDir }, diagnostics: [] },
      { plugin: { id: 'unavailable', status: 'error', enabled: true }, diagnostics: ['load failed'] },
    ],
    existing: (filePath) => !filePath.includes('missing-path')
      && !(filePath.includes('missing-manifest') && filePath.endsWith('openclaw.plugin.json')),
    stagedAdapter: { exists: false, manifestExists: false },
  }));

  const classifications = new Map(result.plugins.map((plugin) => [plugin.id, plugin.classification]));
  assert.equal(classifications.get('missing-record'), 'missing-install-record');
  assert.equal(classifications.get('missing-path'), 'missing-install-path');
  assert.equal(classifications.get('missing-manifest'), 'missing-manifest');
  assert.equal(classifications.get('unavailable'), 'unavailable');
  assert.equal(result.jarvosAdapter.status, 'missing-staged-adapter');
  assert.equal(result.status, 'warn');
});

test('does not turn disabled bundled plugins into missing-install failures', () => {
  const bundled = {
    ...npmPlugin('bundled-disabled', `${ROOT}/bundled/bundled-disabled`),
    origin: 'bundled',
    enabled: false,
  };
  const result = assessOpenClawPluginPersistence(snapshot({
    plugins: [bundled],
    installRecords: {},
    inspections: [{ plugin: { id: bundled.pluginId, status: 'disabled', enabled: false }, diagnostics: [] }],
    existing: () => false,
  }));

  assert.equal(result.status, 'ok');
  assert.equal(result.plugins[0].classification, 'disabled');
});

test('incomplete or changing evidence is indeterminate rather than healthy', () => {
  const plugin = npmPlugin('partial');
  const incomplete = assessOpenClawPluginPersistence({
    ...snapshot({ plugins: [plugin], installRecords: { partial: { source: 'npm', installPath: plugin.rootDir, version: '1.2.3' } } }),
    inspections: [],
  });
  assert.equal(incomplete.status, 'indeterminate');

  const changing = assessOpenClawPluginPersistence(snapshot({
    plugins: [plugin],
    installRecords: { partial: { source: 'npm', installPath: plugin.rootDir, version: '1.2.3' } },
    inspections: [{ plugin: { id: 'partial', status: 'loaded', enabled: true, rootDir: `${ROOT}/changed` }, diagnostics: [] }],
  }));
  assert.equal(changing.status, 'indeterminate');

  const prerelease = npmPlugin('prerelease');
  prerelease.packageVersion = '1.2.3-beta.1';
  const prereleaseResult = assessOpenClawPluginPersistence(snapshot({
    plugins: [prerelease],
    installRecords: { prerelease: { source: 'npm', installPath: prerelease.rootDir, version: '1.2.3-beta.1' } },
  }));
  assert.equal(prereleaseResult.status, 'indeterminate');
  assert.equal(prereleaseResult.plugins[0].classification, 'indeterminate');
});

test('rejects unsupported versions, schemas, malformed records, and raw credential-bearing fields', () => {
  const plugin = npmPlugin('safe-id');
  const result = assessOpenClawPluginPersistence({
    ...snapshot({ plugins: [plugin], installRecords: { 'safe-id': { source: 'npm', installPath: plugin.rootDir } } }),
    version: { version: '2026.8.0' },
    registry: {
      current: {
        version: 99,
        plugins: [{ ...plugin, pluginId: 'bad id with redaction-marker' }],
        installRecords: { 'bad id with redaction-marker': { installPath: '/synthetic/fixture/openclaw', token: 'redaction-marker-42' } },
      },
      stderr: 'Authorization: Bearer redaction-marker-42',
    },
  });

  assert.notEqual(result.status, 'ok');
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /synthetic\/fixture|redaction-marker-42|Bearer|bad id with redaction-marker/);
  assert.ok(['compatibility', 'indeterminate'].includes(result.status));
});

test('command collection uses only the checked-in fixed argv and returns redacted evidence', async () => {
  const calls = [];
  const plugin = npmPlugin('alpha');
  const result = await collectOpenClawPluginEvidence({
    runCommand: async (command) => {
      calls.push(command);
      if (command.id === 'version') return { status: 'ok', stdout: 'OpenClaw 2026.7.1\n', stderr: '' };
      if (command.id === 'registry') return { status: 'ok', stdout: JSON.stringify({ current: { version: 1, hostContractVersion: '2026.7.1', plugins: [plugin], installRecords: { alpha: { source: 'npm', installPath: plugin.rootDir, version: '1.2.3' } } } }), stderr: '' };
      return { status: 'ok', stdout: JSON.stringify([{ plugin: { id: 'alpha', status: 'loaded', enabled: true, rootDir: plugin.rootDir }, diagnostics: [] }]), stderr: '' };
    },
    filesystem: { exists: () => true, isFile: () => true },
    stagedAdapter: { path: STAGED_ADAPTER, exists: true, manifestExists: true },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((command) => command.args), OPENCLAW_PERSISTENCE_CAPABILITIES.commands.map((command) => command.args));
  assert.equal(calls.every((command) => command.executable === 'openclaw'), true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic\/openclaw/);
});

test('registration verification uses the fixed read-only version and inspection commands', async () => {
  const calls = [];
  const pluginPath = '/synthetic/stable/jarvos-openclaw-stewardship-plugin';
  const result = await verifyOpenClawPluginRegistration({
    pluginPath,
    runCommand: async (command) => {
      calls.push(command);
      if (command.id === 'version') return { status: 'ok', stdout: 'OpenClaw 2026.7.1\n', stderr: '' };
      return {
        status: 'ok',
        stdout: JSON.stringify([{
          plugin: { id: 'jarvos-stewardship', status: 'loaded', enabled: true, rootDir: pluginPath, version: '1.0.0' },
          diagnostics: [],
        }]),
        stderr: '',
      };
    },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((command) => command.args), [
    ['--version'],
    ['plugins', 'inspect', '--all', '--json'],
  ]);
  assert.equal(calls.every((command) => command.executable === 'openclaw'), true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic/);
});

test('registration verification never accepts an unavailable or path-mismatched staged plugin', async () => {
  const base = {
    pluginPath: '/synthetic/stable/jarvos-openclaw-stewardship-plugin',
    runCommand: async (command) => command.id === 'version'
      ? { status: 'ok', stdout: 'OpenClaw 2026.7.1', stderr: '' }
      : { status: 'ok', stdout: JSON.stringify([{ plugin: { id: 'jarvos-stewardship', status: 'error', enabled: true, rootDir: '/synthetic/other' }, diagnostics: ['redaction-marker-42'] }]), stderr: '' },
  };
  const result = await verifyOpenClawPluginRegistration(base);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'plugin-path-mismatch');
  assert.doesNotMatch(JSON.stringify(result), /synthetic|redaction-marker-42/);
});

test('unsupported command, invalid JSON, nonzero exit, output overflow, and timeout stay bounded', async () => {
  const unsupported = await collectOpenClawPluginEvidence({
    runCommand: async () => ({ status: 'unsupported', reason: 'command-not-supported', stdout: '', stderr: 'redaction-marker-42' }),
  });
  assert.equal(unsupported.status, 'compatibility');
  assert.doesNotMatch(JSON.stringify(unsupported), /redaction-marker-42/);

  const invalid = await collectOpenClawPluginEvidence({
    runCommand: async (command) => command.id === 'version'
      ? { status: 'ok', stdout: 'OpenClaw 2026.7.1', stderr: '' }
      : { status: 'ok', stdout: '{not-json', stderr: 'credential=redaction-marker-42' },
  });
  assert.equal(invalid.status, 'compatibility');
  assert.doesNotMatch(JSON.stringify(invalid), /credential|redaction-marker-42/);

  const outputLimit = await runOpenClawCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(100000))'] }, { outputLimit: 1024, timeoutMs: 5000 });
  assert.equal(outputLimit.status, 'compatibility');
  assert.equal(outputLimit.reason, 'output-limit');

  const timeout = await runOpenClawCommand({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, { outputLimit: 1024, timeoutMs: 50 });
  assert.equal(timeout.status, 'indeterminate');
  assert.equal(timeout.reason, 'timeout');
});
