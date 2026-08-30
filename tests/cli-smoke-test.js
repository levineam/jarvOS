#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'jarvos.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cli-')));
try {
  const workspace = path.join(tmp, 'workspace');
  const vault = path.join(tmp, 'vault');
  const syncWorkspace = path.join(tmp, 'sync-workspace');
  const syncVault = path.join(tmp, 'sync-vault');
  fs.mkdirSync(path.join(syncVault, 'Notes'), { recursive: true });
  fs.mkdirSync(path.join(syncVault, 'Journal'), { recursive: true });
  fs.mkdirSync(path.join(syncVault, 'Tags'), { recursive: true });
  const controlPlaneHost = path.join(tmp, 'control-plane-host.js');
  const controlPlaneSource = path.join(ROOT, 'modules', 'jarvos-control-plane', 'src', 'index.js');
  fs.writeFileSync(controlPlaneHost, [
    `const { createApplicationService, createMemoryApplicationStore } = require(${JSON.stringify(controlPlaneSource)});`,
    "module.exports = () => createApplicationService({ store: createMemoryApplicationStore(), resolveCredential: () => null, canRead: () => false, policy: () => ({ outcome: 'deny' }) });",
  ].join('\n'), 'utf8');
  const env = {
    ...process.env,
    JARVOS_YES: '1',
    JARVOS_ASSISTANT_NAME: 'TestJarvis',
    JARVOS_USER_NAME: 'TestUser',
    JARVOS_COACH_NAME: 'TestCoach',
    JARVOS_VAULT_PATH: vault,
    JARVOS_WORKSPACE_PATH: workspace,
    JARVOS_RUNTIME: 'minimal',
    // Keep doctor discovery inside the disposable CLI fixture; never inspect
    // the developer's live Codex profile during repository tests.
    CODEX_HOME: path.join(tmp, 'codex-home'),
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: controlPlaneHost,
  };
  const fakeOpenClaw = path.join(tmp, 'openclaw');
  const fakePluginRoot = path.join(ROOT, 'runtimes', 'openclaw');
  const fakePluginManifest = path.join(fakePluginRoot, 'adapter.json');
  const fakeRegistry = JSON.stringify({
    current: {
      version: 1,
      hostContractVersion: '2026.7.1',
      plugins: [{
        pluginId: 'cli-fixture',
        origin: 'path',
        source: fakePluginManifest,
        rootDir: fakePluginRoot,
        manifestPath: fakePluginManifest,
        enabled: true,
        packageVersion: '1.0.0',
      }],
      installRecords: {},
    },
  });
  const fakeInspection = JSON.stringify([{
    plugin: { id: 'cli-fixture', status: 'loaded', enabled: true, rootDir: fakePluginRoot, version: '1.0.0' },
    diagnostics: [],
  }]);
  fs.writeFileSync(fakeOpenClaw, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  printf \'%s\\n\' "OpenClaw 2026.7.1"',
    'elif [ "$1" = "plugins" ] && [ "$2" = "registry" ]; then',
    `  printf '%s\\n' ${JSON.stringify(fakeRegistry)}`,
    'elif [ "$1" = "plugins" ] && [ "$2" = "inspect" ]; then',
    `  printf '%s\\n' ${JSON.stringify(fakeInspection)}`,
    'else',
    '  exit 2',
    'fi',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeOpenClaw, 0o755);
  const openclawStateDir = path.join(tmp, 'openclaw-state');
  fs.mkdirSync(openclawStateDir);
  assert.equal(
    require(path.join(ROOT, 'modules', 'jarvos-control-plane', 'scripts', 'jarvos-manager.js')).verifyHostService(controlPlaneHost).ok,
    true,
  );

  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /jarvos init/);
  assert.match(help.stdout, /jarvos sync/);
  assert.match(help.stdout, /jarvos doctor/);
  assert.match(help.stdout, /minimal\s+Portable jarvOS starter workspace/);

  const initHelp = run(['init', '--help']);
  assert.equal(initHelp.status, 0, initHelp.stderr || initHelp.stdout);
  assert.match(initHelp.stdout, /jarvos init --profile minimal --yes/);
  assert.match(initHelp.stdout, /Profiles:\n\s+minimal\s+Minimal/);

  const doctorHelp = run(['doctor', '--help']);
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr || doctorHelp.stdout);
  assert.match(doctorHelp.stdout, /public profile health checks/);

  const syncHelp = run(['sync', '--help']);
  assert.equal(syncHelp.status, 0, syncHelp.stderr || syncHelp.stdout);
  assert.match(syncHelp.stdout, /Sync with an existing jarvOS installation/);
  assert.match(syncHelp.stdout, /ordinary, uncontended use the command validates Notes\/,\nJournal\/, and Tags\/ and writes no config contents inside the vault/);
  // The contract is target-only and must describe the exclusive final target,
  // readback proof, and intentionally non-mutating failure cleanup.
  assert.match(syncHelp.stdout, /In ordinary, uncontended use sync selects the config directory outside the vault/);
  assert.match(syncHelp.stdout, /vaultWrites\s+and\s+vaultContentsWritten/);
  assert.match(syncHelp.stdout, /legacy-shaped config is reported as manual-reconcile/);
  assert.match(syncHelp.stdout, /never rewrites an\nexisting config in place/);
  assert.match(syncHelp.stdout, /final target with O_EXCL through a retained file descriptor/);
  assert.match(syncHelp.stdout, /target pathname still names that descriptor/);
  assert.match(syncHelp.stdout, /reads the exact bytes back through the descriptor/);
  assert.match(syncHelp.stdout, /failed create may\nleave an empty 0600 config target/);
  assert.match(syncHelp.stdout, /never removes\nany pathname during cleanup/);
  assert.match(syncHelp.stdout, /simultaneous local filesystem changes are\nobserved by the identity checks, sync fails closed/);
  assert.doesNotMatch(syncHelp.stdout, /hard-link-capable filesystem/);
  assert.doesNotMatch(syncHelp.stdout, /publishes it by hard link/);
  assert.doesNotMatch(syncHelp.stdout, /republishes by rename/);

  const syncConfigPath = path.join(syncWorkspace, 'jarvos.config.json');
  const syncArgs = [
    'sync',
    '--workspace', syncWorkspace,
    '--vault', syncVault,
    '--name', 'TestUser',
    '--timezone', 'UTC',
  ];
  const syncDryRun = run([...syncArgs, '--dry-run', '--json']);
  assert.equal(syncDryRun.status, 0, syncDryRun.stderr || syncDryRun.stdout);
  const syncDryRunPayload = JSON.parse(syncDryRun.stdout);
  // Both fields record that no config contents were observed in the vault for
  // this completed dry-run operation.
  assert.equal(syncDryRunPayload.vaultWrites, false);
  assert.equal(syncDryRunPayload.vaultContentsWritten, false);
  assert.equal(fs.existsSync(syncConfigPath), false, 'sync dry-run must not create the config or workspace');

  const externalConfig = path.join(tmp, 'external-config', 'custom.json');
  const explicitConfigDryRun = run([...syncArgs, '--config', externalConfig, '--dry-run']);
  assert.equal(explicitConfigDryRun.status, 0, explicitConfigDryRun.stderr || explicitConfigDryRun.stdout);
  assert.match(explicitConfigDryRun.stdout, new RegExp(`Next: jarvos doctor .* --config ${JSON.stringify(externalConfig).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(fs.existsSync(path.dirname(externalConfig)), false);

  const vaultWorkspace = run([
    'sync',
    '--workspace', syncVault,
    '--vault', syncVault,
    '--name', 'TestUser',
    '--timezone', 'UTC',
  ]);
  assert.notEqual(vaultWorkspace.status, 0);
  assert.match(vaultWorkspace.stderr, /inside the shared vault/);
  assert.equal(fs.existsSync(path.join(syncVault, 'jarvos.config.json')), false, 'an ordinary sync target stays outside the vault');

  const explicitVaultConfig = run([...syncArgs, '--config', path.join(syncVault, 'outside-workspace.json'), '--dry-run']);
  assert.notEqual(explicitVaultConfig.status, 0);
  assert.match(explicitVaultConfig.stderr, /inside the shared vault/);
  assert.equal(fs.existsSync(path.join(syncVault, 'outside-workspace.json')), false);

  if (process.platform !== 'win32') {
    const symlinkParent = path.join(tmp, 'symlinked-workspace');
    const symlinkDestination = path.join(tmp, 'symlink-destination');
    fs.mkdirSync(symlinkDestination);
    fs.symlinkSync(symlinkDestination, symlinkParent, 'dir');
    const symlinkParentSync = run([
      'sync',
      '--workspace', symlinkParent,
      '--vault', syncVault,
      '--name', 'TestUser',
      '--timezone', 'UTC',
      '--dry-run',
    ]);
    assert.notEqual(symlinkParentSync.status, 0);
    assert.match(symlinkParentSync.stderr, /symlinked config path/);
    assert.equal(fs.existsSync(path.join(symlinkDestination, 'jarvos.config.json')), false);

    const danglingConfig = path.join(tmp, 'dangling-config.json');
    fs.symlinkSync(path.join(tmp, 'does-not-exist.json'), danglingConfig);
    const danglingConfigSync = run([...syncArgs, '--config', danglingConfig, '--dry-run']);
    assert.notEqual(danglingConfigSync.status, 0);
    assert.match(danglingConfigSync.stderr, /symlinked config path/);
  }

  const invalidTimezone = run([
    'sync',
    '--workspace', path.join(tmp, 'invalid-timezone-workspace'),
    '--vault', syncVault,
    '--name', 'TestUser',
    '--timezone', 'Not/AZone',
    '--dry-run',
  ]);
  assert.notEqual(invalidTimezone.status, 0);
  assert.match(invalidTimezone.stderr, /valid IANA timezone/);

  const syncApply = run(syncArgs);
  assert.equal(syncApply.status, 0, syncApply.stderr || syncApply.stdout);
  assert.match(syncApply.stdout, /Mode: APPLIED/);
  assert.match(syncApply.stdout, /Vault writes observed: none/);
  assert.ok(fs.existsSync(syncConfigPath));

  const syncAgain = run(syncArgs);
  assert.equal(syncAgain.status, 0, syncAgain.stderr || syncAgain.stdout);
  assert.match(syncAgain.stdout, /Mode: ALREADY SYNCED/);

  const syncExistingWithoutRedundantIdentity = run(['sync', '--workspace', syncWorkspace, '--dry-run']);
  assert.equal(syncExistingWithoutRedundantIdentity.status, 0, syncExistingWithoutRedundantIdentity.stderr || syncExistingWithoutRedundantIdentity.stdout);
  assert.match(syncExistingWithoutRedundantIdentity.stdout, /Config action: already-synced/);

  const syncConfigSuperset = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8'));
  syncConfigSuperset.privateExtension = { enabled: true };
  fs.writeFileSync(syncConfigPath, `${JSON.stringify(syncConfigSuperset, null, 2)}\n`);
  const syncCompatibleSuperset = run([...syncArgs, '--dry-run']);
  assert.equal(syncCompatibleSuperset.status, 0, syncCompatibleSuperset.stderr || syncCompatibleSuperset.stdout);
  assert.match(syncCompatibleSuperset.stdout, /Config action: already-synced/);

  const syncConflict = run(syncArgs.map((arg) => (arg === 'TestUser' ? 'DifferentUser' : arg)));
  assert.notEqual(syncConflict.status, 0);
  assert.match(syncConflict.stderr, /Refusing to overwrite an existing jarvos\.config\.json/);

  // A pre-sync bootstrap config has only legacy path keys and no timezone.
  // Sync must identify the target as manual-reconcile and leave it untouched;
  // it must never rewrite the legacy file in place.
  const legacySyncWorkspace = path.join(tmp, 'legacy-sync-workspace');
  fs.mkdirSync(legacySyncWorkspace);
  const legacySyncConfigPath = path.join(legacySyncWorkspace, 'jarvos.config.json');
  const legacySyncContents = JSON.stringify({
    workspacePath: legacySyncWorkspace,
    vaultPath: syncVault,
    userName: 'TestUser',
  });
  fs.writeFileSync(legacySyncConfigPath, legacySyncContents);
  const syncLegacyDryRun = run([
    'sync', '--workspace', legacySyncWorkspace, '--vault', syncVault,
    '--name', 'TestUser', '--timezone', 'UTC',
    '--dry-run', '--json',
  ]);
  assert.equal(syncLegacyDryRun.status, 0, syncLegacyDryRun.stderr || syncLegacyDryRun.stdout);
  const syncLegacyPayload = JSON.parse(syncLegacyDryRun.stdout);
  assert.equal(syncLegacyPayload.action, 'manual-reconcile');
  assert.equal(syncLegacyPayload.targetAction, 'manual-reconcile');
  assert.equal(syncLegacyPayload.manualReconciliation, true);
  assert.match(syncLegacyPayload.message, /Cannot automatically migrate.*never rewrites.*in place/);
  assert.equal(fs.readFileSync(legacySyncConfigPath, 'utf8'), legacySyncContents);
  const syncLegacyApply = run([
    'sync', '--workspace', legacySyncWorkspace, '--vault', syncVault,
    '--name', 'TestUser', '--timezone', 'UTC',
  ]);
  assert.notEqual(syncLegacyApply.status, 0);
  assert.match(syncLegacyApply.stderr, /Cannot automatically migrate/);
  assert.equal(fs.readFileSync(legacySyncConfigPath, 'utf8'), legacySyncContents);

  const blankName = run([
    'sync',
    '--workspace', path.join(tmp, 'blank-name-workspace'),
    '--vault', syncVault,
    '--name', '  ',
    '--timezone', 'UTC',
    '--dry-run',
  ]);
  assert.notEqual(blankName.status, 0);
  assert.match(blankName.stderr, /non-empty user name/);

  const nullConfigWorkspace = path.join(tmp, 'null-config-workspace');
  const nullConfigPath = path.join(nullConfigWorkspace, 'jarvos.config.json');
  fs.mkdirSync(nullConfigWorkspace, { recursive: true });
  fs.writeFileSync(nullConfigPath, 'null\n');
  const nullConfigArgs = [
    'sync',
    '--workspace', nullConfigWorkspace,
    '--vault', syncVault,
    '--name', 'TestUser',
    '--timezone', 'UTC',
  ];
  // Dry run and apply must agree: neither may report a plannable `create` for a
  // target that already holds a file the exclusive write cannot replace.
  for (const extra of [['--dry-run'], []]) {
    const nullConfigSync = run([...nullConfigArgs, ...extra]);
    assert.notEqual(nullConfigSync.status, 0);
    assert.match(nullConfigSync.stderr, /not a JSON object/);
  }
  assert.equal(fs.readFileSync(nullConfigPath, 'utf8'), 'null\n');

  const badProfile = run(['init', '--profile', 'full', '--yes']);
  assert.notEqual(badProfile.status, 0);
  assert.match(badProfile.stderr, /Unknown profile: full/);

  const init = run(['init', '--profile', 'minimal', '--yes'], { env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(fs.existsSync(path.join(workspace, 'jarvos.config.json')));

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin.jarvos, 'scripts/jarvos.js');
  assert.equal(packageJson.bin['jarvos-bootstrap'], 'scripts/jarvos.js');
  assert.equal(packageJson.bin['jarvos-init'], 'scripts/jarvos.js');

  const legacyTmp = path.join(tmp, 'legacy-bin');
  fs.mkdirSync(legacyTmp);
  const legacyAlias = path.join(legacyTmp, 'jarvos-bootstrap');
  fs.symlinkSync(CLI, legacyAlias);
  const legacyWorkspace = path.join(tmp, 'legacy-workspace');
  const legacyVault = path.join(tmp, 'legacy-vault');
  const legacyEnv = {
    ...env,
    JARVOS_VAULT_PATH: legacyVault,
    JARVOS_WORKSPACE_PATH: legacyWorkspace,
  };
  const legacyHelp = spawnSync(legacyAlias, ['--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(legacyHelp.status, 0, legacyHelp.stderr || legacyHelp.stdout);
  assert.match(legacyHelp.stdout, /jarvos init/);
  assert.match(legacyHelp.stdout, /Profiles:\n\s+minimal\s+Minimal/);

  const legacyInit = spawnSync(legacyAlias, ['--profile', 'minimal', '--yes'], {
    cwd: ROOT,
    env: legacyEnv,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(legacyInit.status, 0, legacyInit.stderr || legacyInit.stdout);
  assert.ok(fs.existsSync(path.join(legacyWorkspace, 'jarvos.config.json')));

  // Fresh generic minimal install: no private host service configured.
  const envWithoutHost = { ...env };
  delete envWithoutHost.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
  const doctorNoHost = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env: envWithoutHost });
  assert.equal(doctorNoHost.status, 0, doctorNoHost.stderr || doctorNoHost.stdout);
  assert.match(doctorNoHost.stdout, /PASS control-plane-module/);
  assert.match(doctorNoHost.stdout, /host service not configured/);
  assert.match(doctorNoHost.stdout, /READY/);

  const doctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /PASS node-version/);
  assert.match(doctor.stdout, /PASS workspace-files/);
  assert.match(doctor.stdout, /PASS config-schema/);
  assert.match(doctor.stdout, /PASS vault-path/);
  assert.match(doctor.stdout, /PASS vault-path-stale/);
  assert.match(doctor.stdout, /PASS journal-conflict/);
  assert.match(doctor.stdout, /PASS control-plane-module/);
  assert.match(doctor.stdout, /authenticated host service/);
  assert.match(doctor.stdout, /READY/);

  for (const file of [
    'AGENTS.md',
    'BOOTSTRAP.md',
    'HEARTBEAT.md',
    'MEMORY.md',
    'USER.md',
    'ONTOLOGY.md',
    'SOUL.md',
    'TOOLS.md',
  ]) {
    fs.copyFileSync(path.join(workspace, file), path.join(syncWorkspace, file));
  }
  const syncDoctor = run(['doctor', '--profile', 'minimal', '--workspace', syncWorkspace], { env });
  assert.equal(syncDoctor.status, 0, syncDoctor.stderr || syncDoctor.stdout);
  assert.match(syncDoctor.stdout, /PASS config-schema/);
  assert.match(syncDoctor.stdout, /PASS vault-path/);
  assert.match(syncDoctor.stdout, /READY/);

  fs.rmSync(path.join(syncVault, 'Tags'), { recursive: true });
  fs.writeFileSync(path.join(syncVault, 'Tags'), 'not a directory\n');
  const fileTagsDoctor = run(['doctor', '--profile', 'minimal', '--workspace', syncWorkspace], { env });
  assert.notEqual(fileTagsDoctor.status, 0);
  assert.match(fileTagsDoctor.stdout, /FAIL vault-path/);
  fs.rmSync(path.join(syncVault, 'Tags'));
  fs.mkdirSync(path.join(syncVault, 'Tags'));

  const jsonDoctor = run(['doctor', '--profile=minimal', '--workspace', workspace, '--json'], { env });
  assert.equal(jsonDoctor.status, 0, jsonDoctor.stderr || jsonDoctor.stdout);
  const report = JSON.parse(jsonDoctor.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.profile.id, 'minimal');
  assert.deepEqual(report.modules, []);

  const healthModules = path.join(workspace, '.jarvos', 'health-modules');
  fs.mkdirSync(healthModules, { recursive: true, mode: 0o700 });
  const memorySnapshotPath = path.join(healthModules, 'memory.json');
  fs.writeFileSync(memorySnapshotPath, `${JSON.stringify({
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: 'memory',
    generation: 1,
    observedAt: '2026-08-12T23:00:00.000Z',
    validUntil: '2099-08-13T23:00:00.000Z',
    trust: 'trusted',
    repairable: false,
    updateAvailable: true,
  })}\n`, 'utf8');
  fs.chmodSync(memorySnapshotPath, 0o600);
  const moduleDoctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace, '--json'], { env });
  assert.equal(moduleDoctor.status, 0, moduleDoctor.stderr || moduleDoctor.stdout);
  const moduleReport = JSON.parse(moduleDoctor.stdout);
  assert.deepEqual(moduleReport.modules, [{
    id: 'memory',
    state: 'update available',
    generation: 1,
    observedAt: '2026-08-12T23:00:00.000Z',
    validUntil: '2099-08-13T23:00:00.000Z',
    reasonClass: 'update-available',
  }]);

  const localDoctorEnv = {
    ...env,
    PATH: `${tmp}${path.delimiter}${process.env.PATH || ''}`,
  };
  fs.copyFileSync(path.join(ROOT, 'jarvos.config.schema.json'), path.join(workspace, 'jarvos.config.schema.json'));
  const localDoctor = run([
    'doctor',
    '--profile',
    'local-openclaw',
    '--workspace',
    workspace,
    '--openclaw-dir',
    openclawStateDir,
    '--staged-runtime-root',
    ROOT,
    '--json',
  ], { env: localDoctorEnv });
  assert.equal(localDoctor.status, 0, localDoctor.stderr || localDoctor.stdout);
  const localReport = JSON.parse(localDoctor.stdout);
  assert.equal(localReport.profile, 'local-openclaw');
  const persistence = localReport.checks.find((check) => check.component === 'openclaw.pluginPersistence');
  assert.equal(persistence.status, 'ok');
  assert.equal(persistence.driftCount, 0);

  const localConfigPath = path.join(tmp, 'local-openclaw-config.json');
  const localConfig = JSON.parse(fs.readFileSync(path.join(workspace, 'jarvos.config.json'), 'utf8'));
  localConfig.runtimeAdapters = { openclaw: { kind: 'openclaw' } };
  localConfig.skillPacks = { installed: ['local-openclaw'] };
  fs.writeFileSync(localConfigPath, `${JSON.stringify(localConfig, null, 2)}\n`, 'utf8');
  const explicitConfigDoctor = run([
    'doctor',
    '--profile',
    'local-openclaw',
    '--workspace',
    workspace,
    '--config',
    localConfigPath,
    '--openclaw-dir',
    openclawStateDir,
    '--staged-runtime-root',
    ROOT,
    '--json',
  ], { env: localDoctorEnv });
  const explicitConfigReport = JSON.parse(explicitConfigDoctor.stdout);
  const explicitConfigAdapter = explicitConfigReport.checks.find((check) => check.component === 'jarvos.openclawAdapter');
  assert.equal(explicitConfigAdapter.status, 'ok');

  const v050ConfigPath = path.join(tmp, 'v0-5-0-config.json');
  const v050Config = {
    ...localConfig,
    skillPacks: { installed: ['v0-5-0'] },
  };
  fs.writeFileSync(v050ConfigPath, `${JSON.stringify(v050Config, null, 2)}\n`, 'utf8');
  const explicitV050ConfigDoctor = run([
    'doctor',
    '--profile',
    'v0-5-0',
    '--workspace',
    workspace,
    '--config',
    v050ConfigPath,
    '--openclaw-dir',
    openclawStateDir,
    '--staged-runtime-root',
    ROOT,
    '--json',
  ], { env: localDoctorEnv });
  const explicitV050ConfigReport = JSON.parse(explicitV050ConfigDoctor.stdout);
  const explicitV050ConfigAdapter = explicitV050ConfigReport.checks.find((check) => check.component === 'jarvos.openclawAdapter');
  assert.equal(explicitV050ConfigAdapter.status, 'warn');
  assert.match(explicitV050ConfigAdapter.message, /adapter is present/i);

  // A configured but unusable host fails doctor without leaking the module path.
  const badHostEnv = {
    ...env,
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: path.join(tmp, 'missing-host.js'),
  };
  const doctorBadHost = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env: badHostEnv });
  assert.notEqual(doctorBadHost.status, 0);
  assert.match(doctorBadHost.stdout, /FAIL control-plane-module/);
  assert.match(doctorBadHost.stdout, /configure a usable JARVOS_CONTROL_PLANE_SERVICE_MODULE/);
  assert.doesNotMatch(doctorBadHost.stdout, /missing-host\.js/);

  console.log('CLI smoke tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
