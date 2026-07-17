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
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: controlPlaneHost,
  };
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

  const doctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /PASS node-version/);
  assert.match(doctor.stdout, /PASS workspace-files/);
  assert.match(doctor.stdout, /PASS config-schema/);
  assert.match(doctor.stdout, /PASS vault-path/);
  assert.match(doctor.stdout, /PASS vault-path-stale/);
  assert.match(doctor.stdout, /PASS journal-conflict/);
  assert.match(doctor.stdout, /PASS control-plane-module/);
  assert.match(doctor.stdout, /READY/);

  const jsonDoctor = run(['doctor', '--profile=minimal', '--workspace', workspace, '--json'], { env });
  assert.equal(jsonDoctor.status, 0, jsonDoctor.stderr || jsonDoctor.stdout);
  const report = JSON.parse(jsonDoctor.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.profile.id, 'minimal');

  console.log('CLI smoke tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
