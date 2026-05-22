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
  const env = {
    ...process.env,
    JARVOS_YES: '1',
    JARVOS_ASSISTANT_NAME: 'TestJarvis',
    JARVOS_USER_NAME: 'TestUser',
    JARVOS_COACH_NAME: 'TestCoach',
    JARVOS_VAULT_PATH: vault,
    JARVOS_WORKSPACE_PATH: workspace,
    JARVOS_RUNTIME: 'minimal',
  };

  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /jarvos init/);
  assert.match(help.stdout, /jarvos doctor/);

  const doctorHelp = run(['doctor', '--help']);
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr || doctorHelp.stdout);
  assert.match(doctorHelp.stdout, /public profile health checks/);

  const badProfile = run(['init', '--profile', 'full', '--yes']);
  assert.notEqual(badProfile.status, 0);
  assert.match(badProfile.stderr, /Unknown profile: full/);

  const init = run(['init', '--profile', 'minimal', '--yes'], { env });
  assert.equal(init.status, 0, init.stderr || init.stdout);
  assert.ok(fs.existsSync(path.join(workspace, 'jarvos.config.json')));

  const doctor = run(['doctor', '--profile', 'minimal', '--workspace', workspace], { env });
  assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
  assert.match(doctor.stdout, /PASS node-version/);
  assert.match(doctor.stdout, /PASS workspace-files/);
  assert.match(doctor.stdout, /PASS config-schema/);
  assert.match(doctor.stdout, /PASS vault-path/);
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
