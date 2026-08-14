'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { doctorSharedSkills, initOperator } = require('../src');

const CLI = path.join(__dirname, '..', 'scripts', 'install-skills.js');
const PREFLIGHT = path.join(__dirname, '..', 'scripts', 'live-preflight-checklist.js');

function temp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

test('doctor-shared is ready on a fresh isolated config and never enables gates', () => {
  const home = temp('jarvos-doctor-home-');
  const control = path.join(home, '.jarvos', 'shared-skills');
  const configPath = path.join(control, 'config.json');
  try {
    initOperator({ configPath, controlRoot: control });
    const report = doctorSharedSkills({ configPath, home, platform: 'darwin' });
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok), null, 2));
    assert.equal(report.scheduler.enabled, false);
    assert.ok(report.checks.some((c) => c.id === 'adapter-claude'));
    assert.ok(report.checks.every((c) => c.id !== 'live-gates' || c.ok));
    assert.equal(JSON.stringify(report).includes('SKILL.md content'), false);

    const cli = spawnSync(process.execPath, [CLI, 'doctor-shared', '--config', configPath, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const body = JSON.parse(cli.stdout);
    assert.equal(body.ok, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live-preflight checklist stays non-activating and reports owner-pending steps', () => {
  const result = spawnSync(process.execPath, [PREFLIGHT, '--json'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.activating, false);
  const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
  assert.equal(byId['package-tests'].status, 'pass');
  assert.equal(byId['isolated-matrix-dogfood'].status, 'pass');
  assert.equal(byId['doctor-shared'].status, 'pass');
  assert.equal(byId['claude-interactive-probe'].status, 'pending_owner');
  assert.equal(byId['live-harness-gates'].status, 'off');
});
