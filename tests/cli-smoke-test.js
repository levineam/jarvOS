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

function snapshotTree(root) {
  const entries = [];
  function visit(directory, relative = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const entry = relative ? path.join(relative, name) : name;
      const stat = fs.lstatSync(absolute);
      const record = {
        path: entry,
        type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        mode: stat.mode & 0o7777,
        mtimeMs: stat.mtimeMs,
      };
      if (stat.isFile()) record.content = fs.readFileSync(absolute, 'utf8');
      if (stat.isSymbolicLink()) record.link = fs.readlinkSync(absolute);
      entries.push(record);
      if (stat.isDirectory()) visit(absolute, entry);
    }
  }
  visit(root);
  return entries;
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
  fs.mkdirSync(path.join(tmp, 'codex-home'), { recursive: true });
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
  assert.match(initHelp.stdout, /fresh host or for a new harness workspace/);
  assert.match(initHelp.stdout, /--use-existing-vault: init creates the starter workspace files/);
  assert.match(initHelp.stdout, /Do not use jarvos sync as a replacement for init/);
  assert.doesNotMatch(initHelp.stdout, /Use jarvos sync to attach/);
  assert.match(initHelp.stdout, /Profiles:\n\s+minimal\s+Minimal/);

  const doctorHelp = run(['doctor', '--help']);
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr || doctorHelp.stdout);
  assert.match(doctorHelp.stdout, /public profile health checks/);

  const syncHelp = run(['sync', '--help']);
  assert.equal(syncHelp.status, 0, syncHelp.stderr || syncHelp.stdout);
  assert.match(syncHelp.stdout, /Sync with an existing jarvOS installation \(config-only handoff\)/);
  assert.match(syncHelp.stdout, /only for a harness workspace that is already installed/);
  assert.match(syncHelp.stdout, /does not create starter workspace files, install\n+a harness, or initialize vault folders/);
  assert.match(syncHelp.stdout, /fresh host or new harness\nworkspace, use jarvos init with --use-existing-vault instead/);
  assert.match(syncHelp.stdout, /In ordinary, uncontended use the command validates Notes\/, Journal\/, and Tags\/\nand writes no config contents inside the vault/);
  // The contract is target-only and must describe the exclusive final target,
  // readback proof, and intentionally non-mutating failure cleanup.
  assert.match(syncHelp.stdout, /In ordinary, uncontended use sync selects the config directory outside the vault/);
  assert.match(syncHelp.stdout, /vaultWrites\s+and\s+vaultContentsWritten/);
  assert.match(syncHelp.stdout, /legacy-shaped config is reported as manual-reconcile/);
  assert.match(syncHelp.stdout, /jarvOS never rewrites an existing config in place/);
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

  // Doctor and the runtime normalize a trailing separator. A fresh sync must
  // use that same comparison and publish normally for an equivalent override.
  const equivalentOverrideWorkspace = path.join(tmp, 'equivalent-override-workspace');
  const equivalentOverride = run(
    [
      'sync', '--workspace', equivalentOverrideWorkspace, '--vault', syncVault,
      '--name', 'TestUser', '--timezone', 'UTC',
    ],
    { env: { ...env, JARVOS_TAGS_DIR: `${path.join(syncVault, 'Tags')}${path.sep}` } },
  );
  assert.equal(equivalentOverride.status, 0, equivalentOverride.stderr || equivalentOverride.stdout);
  assert.equal(fs.existsSync(path.join(equivalentOverrideWorkspace, 'jarvos.config.json')), true);

  // A missing config must not be published when the current process would
  // immediately resolve a JARVOS_* path override instead of the written path.
  const overrideCreateWorkspace = path.join(tmp, 'override-create-workspace');
  const overrideCreateTags = path.join(tmp, 'override-create-tags');
  fs.mkdirSync(overrideCreateTags);
  const overrideCreate = run(
    [
      'sync', '--workspace', overrideCreateWorkspace, '--vault', syncVault,
      '--name', 'TestUser', '--timezone', 'UTC',
    ],
    { env: { ...env, JARVOS_TAGS_DIR: overrideCreateTags } },
  );
  assert.notEqual(overrideCreate.status, 0);
  assert.match(overrideCreate.stderr, /effective JARVOS path overrides diverge/);
  assert.equal(fs.existsSync(overrideCreateWorkspace), false, 'rejected fresh sync must not create its workspace or config target');

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

  // A fresh host/new harness workspace must use init's explicit existing-vault
  // path. It installs the starter workspace while preserving the existing
  // vault, after which sync is a read-only config handoff and reports the
  // portable config as already synced.
  const attachWorkspace = path.join(tmp, 'attach-existing-vault-workspace');
  const attachVault = path.join(tmp, 'attach-existing-vault');
  for (const directory of ['Notes', 'Journal', 'Tags']) {
    fs.mkdirSync(path.join(attachVault, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(attachVault, 'Notes', 'existing-note.md'), 'keep this note\n', 'utf8');
  fs.writeFileSync(path.join(attachVault, 'Journal', '2026-08-30.md'), '# Existing journal\n', 'utf8');
  const attachVaultBefore = snapshotTree(attachVault);
  const attachEnv = {
    ...env,
    JARVOS_WORKSPACE_PATH: attachWorkspace,
    JARVOS_VAULT_PATH: attachVault,
  };
  const attachInit = run([
    'init', '--profile', 'minimal', '--workspace', attachWorkspace,
    '--vault', attachVault, '--use-existing-vault', '--yes',
  ], { env: attachEnv });
  assert.equal(attachInit.status, 0, attachInit.stderr || attachInit.stdout);
  assert.match(attachInit.stdout, /Intended action:\s+attach-existing-vault/);
  assert.ok(fs.existsSync(path.join(attachWorkspace, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(attachWorkspace, 'jarvos.config.json')));
  assert.deepEqual(snapshotTree(attachVault), attachVaultBefore, 'init must preserve existing vault content');

  const attachDoctor = run([
    'doctor', '--profile', 'minimal', '--workspace', attachWorkspace,
  ], { env: attachEnv });
  assert.equal(attachDoctor.status, 0, attachDoctor.stderr || attachDoctor.stdout);
  assert.match(attachDoctor.stdout, /✅ workspace-files/);
  assert.match(attachDoctor.stdout, /✅ vault-path/);
  assert.match(attachDoctor.stdout, /jarvOS System Doctor/);
  assert.doesNotMatch(attachDoctor.stdout, /\bPASS\b|\bFAIL\b|READY/);

  const attachSync = run([
    'sync', '--workspace', attachWorkspace, '--dry-run', '--json',
  ], { env: attachEnv });
  assert.equal(attachSync.status, 0, attachSync.stderr || attachSync.stdout);
  const attachSyncPayload = JSON.parse(attachSync.stdout);
  assert.equal(attachSyncPayload.targetAction, 'already-synced');
  assert.equal(attachSyncPayload.vaultWrites, false);
  assert.equal(attachSyncPayload.vaultContentsWritten, false);
  assert.equal(attachSyncPayload.changed, false);
  assert.deepEqual(snapshotTree(attachVault), attachVaultBefore, 'sync dry-run must not change the existing vault');

  const syncExistingWithoutRedundantIdentity = run(['sync', '--workspace', syncWorkspace, '--dry-run']);
  assert.equal(syncExistingWithoutRedundantIdentity.status, 0, syncExistingWithoutRedundantIdentity.stderr || syncExistingWithoutRedundantIdentity.stdout);
  assert.match(syncExistingWithoutRedundantIdentity.stdout, /Config action: already-synced/);

  // Existing portable installs may omit a derived child path. The resolver
  // derives Tags from the configured vault, so sync must recognize this shape
  // as already-synced rather than demanding manual reconciliation.
  const syncExistingWithoutTags = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8'));
  delete syncExistingWithoutTags.paths.tags;
  fs.writeFileSync(syncConfigPath, `${JSON.stringify(syncExistingWithoutTags, null, 2)}\n`);
  const syncWithoutTags = run(['sync', '--workspace', syncWorkspace, '--dry-run']);
  assert.equal(syncWithoutTags.status, 0, syncWithoutTags.stderr || syncWithoutTags.stdout);
  assert.match(syncWithoutTags.stdout, /Config action: already-synced/);
  const runtimeConfig = JSON.parse(fs.readFileSync(syncConfigPath, 'utf8'));
  assert.equal(Object.hasOwn(runtimeConfig.paths, 'tags'), false);

  const overriddenTags = path.join(tmp, 'sync-runtime-tags');
  fs.mkdirSync(overriddenTags);
  const beforeOverrideAssessment = fs.readFileSync(syncConfigPath, 'utf8');
  const syncWithDivergentRuntimeOverride = run(
    ['sync', '--workspace', syncWorkspace, '--dry-run', '--json'],
    { env: { ...env, JARVOS_TAGS_DIR: overriddenTags } },
  );
  assert.equal(
    syncWithDivergentRuntimeOverride.status,
    0,
    syncWithDivergentRuntimeOverride.stderr || syncWithDivergentRuntimeOverride.stdout,
  );
  const overrideAssessment = JSON.parse(syncWithDivergentRuntimeOverride.stdout);
  assert.equal(overrideAssessment.action, 'manual-reconcile');
  assert.equal(overrideAssessment.targetAction, 'manual-reconcile');
  assert.equal(fs.readFileSync(syncConfigPath, 'utf8'), beforeOverrideAssessment, 'sync assessment is read-only');

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

  // A dormant init intentionally leaves the selected vault untouched. The
  // doctor fixture opts into a shaped vault explicitly so its vault-health
  // checks have a target to inspect.
  for (const directory of ['Notes', 'Journal', 'Tags']) fs.mkdirSync(path.join(vault, directory), { recursive: true });

  // Fresh generic minimal install: no private host service configured.
  const envWithoutHost = { ...env };
  delete envWithoutHost.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
  const doctorNoHost = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env: envWithoutHost });
  assert.equal(doctorNoHost.status, 0, doctorNoHost.stderr || doctorNoHost.stdout);
  assert.match(doctorNoHost.stdout, /✅ control-plane-module/);
  assert.match(doctorNoHost.stdout, /host service not configured/);
  assert.doesNotMatch(doctorNoHost.stdout, /\bPASS\b|READY/);

  const doctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /✅ node-version/);
  assert.match(doctor.stdout, /✅ workspace-files/);
  assert.match(doctor.stdout, /✅ config-schema/);
  assert.match(doctor.stdout, /✅ vault-path/);
  assert.match(doctor.stdout, /✅ vault-path-stale/);
  assert.match(doctor.stdout, /✅ journal-conflict/);
  assert.match(doctor.stdout, /✅ control-plane-module/);
  assert.match(doctor.stdout, /authenticated host service/);
  assert.doesNotMatch(doctor.stdout, /\bPASS\b|\bFAIL\b|READY/);

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
  assert.match(syncDoctor.stdout, /✅ config-schema/);
  assert.match(syncDoctor.stdout, /✅ vault-path/);
  assert.doesNotMatch(syncDoctor.stdout, /\bPASS\b|READY/);

  fs.rmSync(path.join(syncVault, 'Tags'), { recursive: true });
  fs.writeFileSync(path.join(syncVault, 'Tags'), 'not a directory\n');
  const fileTagsDoctor = run(['doctor', '--profile', 'minimal', '--workspace', syncWorkspace], { env });
  assert.notEqual(fileTagsDoctor.status, 0);
  assert.match(fileTagsDoctor.stdout, /❌ vault-path/);
  fs.rmSync(path.join(syncVault, 'Tags'));
  fs.mkdirSync(path.join(syncVault, 'Tags'));

  const configured = JSON.parse(fs.readFileSync(path.join(workspace, 'jarvos.config.json'), 'utf8'));
  configured.runtimeMode = {
    version: 'jarvos-runtime-mode/v1',
    mode: 'multi',
    installedAdapters: [{ id: 'hermes' }, { id: 'openclaw' }],
    workloadRoutes: [
      { workload: 'telegram.updates', adapter: 'hermes' },
      { workload: 'telegram.updates', adapter: 'openclaw' },
    ],
    capabilityTruth: [],
  };
  fs.writeFileSync(path.join(workspace, 'jarvos.config.json'), JSON.stringify(configured, null, 2));
  const duplicateTelegramDoctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env });
  assert.equal(duplicateTelegramDoctor.status, 1, duplicateTelegramDoctor.stderr || duplicateTelegramDoctor.stdout);
  assert.match(duplicateTelegramDoctor.stdout, /❌ config-schema/);
  assert.match(duplicateTelegramDoctor.stdout, /only one Telegram update consumer/);
  delete configured.runtimeMode;
  fs.writeFileSync(path.join(workspace, 'jarvos.config.json'), JSON.stringify(configured, null, 2));

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
  assert.equal(moduleReport.systemDoctor.status, 'healthy');
  assert.equal(moduleReport.systemDoctor.components.some((component) => component.id === 'module.memory'), false);
  assert.deepEqual(moduleReport.modules, [{
    id: 'memory',
    state: 'update available',
    generation: 1,
    observedAt: '2026-08-12T23:00:00.000Z',
    validUntil: '2099-08-13T23:00:00.000Z',
    reasonClass: 'update-available',
  }]);
  const moduleTextDoctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env });
  assert.equal(moduleTextDoctor.status, 0, moduleTextDoctor.stderr || moduleTextDoctor.stdout);
  assert.match(moduleTextDoctor.stdout, /jarvOS System Doctor — Minimal/);
  assert.doesNotMatch(moduleTextDoctor.stdout, /Optional modules:|READY|\bPASS\b/);

  const systemSnapshotPath = path.join(healthModules, 'system.json');
  fs.writeFileSync(systemSnapshotPath, `${JSON.stringify({
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: 'system',
    generation: 2,
    observedAt: '2026-08-12T23:00:00.000Z',
    validUntil: '2099-08-13T23:00:00.000Z',
    trust: 'trusted',
    factsVersion: 'jarvos-system-doctor-facts/v1',
    facts: {
      profile: 'minimal',
      components: [{
        id: 'provider.searxng',
        state: 'healthy',
        reasonClass: 'none',
        evidence: { httpReachable: true, searchResultCount: 0, runtimeToolAvailable: false },
      }],
    },
  })}\n`, 'utf8');
  fs.chmodSync(systemSnapshotPath, 0o600);
  const systemJsonDoctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace, '--json'], { env });
  assert.equal(systemJsonDoctor.status, 1, systemJsonDoctor.stderr || systemJsonDoctor.stdout);
  const systemReport = JSON.parse(systemJsonDoctor.stdout);
  assert.equal(systemReport.systemDoctor.schema, 'jarvos-system-doctor-report/v1');
  const searxng = systemReport.systemDoctor.components.find((component) => component.id === 'provider.searxng');
  assert.equal(searxng.state, 'warning');
  assert.equal(searxng.reasonClass, 'search-empty');
  const systemTextDoctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env });
  assert.equal(systemTextDoctor.status, 1, systemTextDoctor.stderr || systemTextDoctor.stdout);
  assert.match(systemTextDoctor.stdout, /⚠️ SearXNG — reachable, but search returned no results/);
  assert.doesNotMatch(systemTextDoctor.stdout, /WARN|NOT READY|Selected optional components/);
  fs.unlinkSync(systemSnapshotPath);

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
  assert.equal(localReport.systemDoctor.status, 'healthy');
  const persistence = localReport.checks.find((check) => check.component === 'openclaw.pluginPersistence');
  assert.equal(persistence.status, 'ok');
  assert.equal(persistence.driftCount, 0);

  fs.writeFileSync(systemSnapshotPath, `${JSON.stringify({
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: 'system',
    generation: 3,
    observedAt: '2026-08-12T23:00:00.000Z',
    validUntil: '2099-08-13T23:00:00.000Z',
    trust: 'trusted',
    factsVersion: 'jarvos-system-doctor-facts/v1',
    facts: {
      profile: 'local-openclaw',
      components: [{ id: 'provider.paperclip', state: 'warning', reasonClass: 'unavailable', evidence: null }],
    },
  })}\n`, 'utf8');
  fs.chmodSync(systemSnapshotPath, 0o600);
  const blockedLocalDoctor = run([
    'doctor', '--profile', 'local-openclaw', '--workspace', workspace,
    '--openclaw-dir', openclawStateDir, '--staged-runtime-root', ROOT, '--json',
  ], { env: localDoctorEnv });
  assert.equal(blockedLocalDoctor.status, 1, blockedLocalDoctor.stderr || blockedLocalDoctor.stdout);
  const blockedLocalReport = JSON.parse(blockedLocalDoctor.stdout);
  assert.equal(blockedLocalReport.ok, false);
  assert.equal(blockedLocalReport.systemDoctor.status, 'needs your attention');
  fs.unlinkSync(systemSnapshotPath);

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
  assert.match(doctorBadHost.stdout, /❌ control-plane-module/);
  assert.match(doctorBadHost.stdout, /configure a usable JARVOS_CONTROL_PLANE_SERVICE_MODULE/);
  assert.doesNotMatch(doctorBadHost.stdout, /missing-host\.js/);

  console.log('CLI smoke tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
