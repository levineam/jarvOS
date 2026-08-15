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
    assert.equal(report.checks.find((c) => c.id === 'scheduler-command')?.ok, true);
    assert.match(report.checks.find((c) => c.id === 'scheduler-command')?.message || '', /autonomous-repair/);
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

test('doctor-shared reports an absent control plane without creating it', () => {
  const root = temp('jarvos-doctor-read-only-');
  const control = path.join(root, 'absent-control');
  const configPath = path.join(root, 'config.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify({
      schemaVersion: 'jarvos.shared-skill-config/v1',
      controlRoot: control,
      publicCatalogPath: path.join(control, 'public-catalog.json'),
      localOverlayPath: path.join(control, 'local-overlay.json'),
      publicSourceRoot: null,
      localSourceRoot: null,
      harnesses: Object.fromEntries(['codex', 'claude', 'openclaw', 'hermes'].map((id) => [id, {
        enabled: false,
        root: path.join(root, id),
      }])),
      scheduler: { enabled: false, intervalMinutes: 60, unitName: 'jarvos-shared-skills' },
      liveDogfood: { authorized: false, receiptPath: null, egress: {} },
    }));
    const report = doctorSharedSkills({ configPath, home: root, platform: 'darwin' });
    assert.equal(report.ok, false);
    assert.equal(fs.existsSync(control), false);
    assert.equal(report.checks.find((item) => item.id === 'control-root').ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preflight CLI accepts an explicit control root, keeping populated default roots out of isolated config', () => {
  const root = temp('jarvos-control-root-'); const configPath = path.join(root, 'config.json'); const controlRoot = path.join(root, 'isolated-control');
  try {
    const result = spawnSync(process.execPath, [CLI, 'init-config', '--config', configPath, '--control-root', controlRoot, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout); assert.equal(path.resolve(body.controlRoot), path.resolve(controlRoot));
    assert.equal(fs.existsSync(path.join(controlRoot, 'public-catalog.json')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init-config refuses a concurrent owner lease in its explicit control root', () => {
  const root = temp('jarvos-init-lock-'); const configPath = path.join(root, 'config.json'); const controlRoot = path.join(root, 'isolated-control');
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(controlRoot, '.shared-skill-cli.lock'), 'held\n', { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [CLI, 'init-config', '--config', configPath, '--control-root', controlRoot, '--json'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /already running/);
    assert.equal(fs.existsSync(configPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init-config leases beside a custom config path when --control-root is omitted', () => {
  const root = temp('jarvos-init-fallback-lock-'); const configPath = path.join(root, 'nested', 'config.json'); const controlRoot = path.dirname(configPath);
  fs.mkdirSync(controlRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(controlRoot, '.shared-skill-cli.lock'), 'held\n', { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [CLI, 'init-config', '--config', configPath, '--json'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /already running/);
    assert.equal(fs.existsSync(configPath), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

test('live-preflight rejects write opt-in and remains a read-only release gate', () => {
  const result = spawnSync(process.execPath, [PREFLIGHT, '--allow-writes', '--json'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /permanently read-only/);
});

test('doctor-shared redacts absolute paths from outward JSON', () => {
  const home = temp('jarvos-doctor-redact-');
  const control = path.join(home, '.jarvos', 'shared-skills');
  const configPath = path.join(control, 'config.json');
  try {
    initOperator({ configPath, controlRoot: control });
    const report = doctorSharedSkills({ configPath, home, platform: 'darwin' });
    const encoded = JSON.stringify(report);
    assert.equal(encoded.includes(home), false, 'raw home path must not appear');
    assert.equal(Object.prototype.hasOwnProperty.call(report, 'controlRoot'), false);
    assert.equal(report.controlRootPresent, true);
    assert.match(String(report.configPath || ''), /^~/);
    for (const check of report.checks || []) {
      if (check.detail == null) continue;
      const detail = JSON.stringify(check.detail);
      assert.equal(detail.includes(home), false, `check ${check.id} leaked home path`);
      assert.equal(/"(?:\/Users|\/home)\//.test(detail), false, `check ${check.id} leaked absolute path`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
