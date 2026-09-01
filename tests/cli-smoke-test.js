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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cli-'));
try {
  const workspace = path.join(tmp, 'workspace');
  const vault = path.join(tmp, 'vault');
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
  assert.match(help.stdout, /jarvos doctor/);
  assert.match(help.stdout, /minimal\s+Portable jarvOS starter workspace/);

  const initHelp = run(['init', '--help']);
  assert.equal(initHelp.status, 0, initHelp.stderr || initHelp.stdout);
  assert.match(initHelp.stdout, /jarvos init --profile minimal --yes/);
  assert.match(initHelp.stdout, /Profiles:\n\s+minimal\s+Minimal/);

  const doctorHelp = run(['doctor', '--help']);
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr || doctorHelp.stdout);
  assert.match(doctorHelp.stdout, /public profile health checks/);

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
  assert.match(duplicateTelegramDoctor.stdout, /FAIL config-schema/);
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
  assert.notEqual(localDoctor.status, 0, 'local profile should report the incomplete minimal fixture as not ready');
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
