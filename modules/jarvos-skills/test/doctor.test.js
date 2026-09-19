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
const DISTRIBUTION_RUNBOOK = path.join(__dirname, '..', '..', '..', 'docs', 'runbooks', 'shared-skill-distribution.md');

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
  assert.equal(report.readOnly, true);
  const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
  assert.equal(byId['package-tests'].status, 'pass');
  assert.equal(byId['isolated-matrix-dogfood'].status, 'pass');
  assert.equal(byId['doctor-shared'].status, 'pass');
  assert.equal(byId['claude-interactive-probe'].status, 'pending_owner');
  assert.deepEqual(byId['claude-interactive-probe'].evidence, {
    preflightRanModelProbe: false,
    ownerModelProbeRequired: true,
    liveGates: 'off',
  });
  assert.equal(byId['active-assistant-fresh-discovery'].status, 'pending_owner');
  assert.deepEqual(byId['active-assistant-fresh-discovery'].evidence, {
    preflightRanModelProbe: false,
    ownerModelProbeRequired: true,
    delivery: false,
    consumer: 'openclaw-active-assistant',
    sourceKind: 'file-backed',
    proofBoundary: 'fresh-session-discovery',
    modelSelection: 'configured-primary',
  });
  assert.equal(byId['active-assistant-existing-session-refresh'].status, 'pending_owner');
  assert.deepEqual(byId['active-assistant-existing-session-refresh'].evidence, {
    preflightRanModelProbe: false,
    ownerModelProbeRequired: true,
    delivery: false,
    consumer: 'openclaw-active-assistant',
    sourceKind: 'file-backed',
    proofBoundary: 'existing-session-next-turn-refresh',
    watchRequired: true,
    sameSessionRequired: true,
    managedLibraryRequiresExplicitRefresh: true,
  });
  assert.match(byId['active-assistant-fresh-discovery'].summary, /fresh-session discovery/u);
  assert.match(byId['active-assistant-existing-session-refresh'].summary, /same existing Active Assistant session/u);
  assert.match(report.next, /fresh-discovery and existing-session refresh proofs/u);
  assert.match(report.next, /do not change managed runtime selection or enable a live harness gate/u);
  assert.equal(byId['live-harness-gates'].status, 'off');
  assert.ok(byId['runtime-activation'], 'runtime-activation item required');
  assert.ok(['info', 'pass', 'pending', 'pending_owner'].includes(byId['runtime-activation'].status));
  assert.ok(Array.isArray(byId['runtime-activation'].evidence?.statuses));
  assert.equal(byId['runtime-activation'].evidence.statuses.length, 4);
  for (const status of byId['runtime-activation'].evidence.statuses) {
    assert.equal(status.schemaVersion, 'jarvos-managed-activation-status/v1');
    assert.ok(['claude', 'codex', 'hermes', 'openclaw'].includes(status.harness));
    assert.ok(typeof status.state === 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(status, 'receipts'), false);
  }
  // Informational activation status must not fail the package gate when unconfigured.
  assert.notEqual(byId['runtime-activation'].status, 'fail');
});

test('shared-skill runbook keeps Active Assistant discovery and refresh proof boundaries distinct', () => {
  const runbook = fs.readFileSync(DISTRIBUTION_RUNBOOK, 'utf8');
  const shellBlocks = [...runbook.matchAll(/```sh\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
  const existingSessionBlocks = shellBlocks.filter((block) => block.includes('openclaw agent --session-id <existing-session-id>'));
  assert.match(runbook, /fresh-session discovery, existing-session refresh/u);
  assert.match(runbook, /effective `skills\.load\.watch` value must be `true`/u);
  assert.match(runbook, /omitted `watch` key counts\s+only when the installed OpenClaw documentation declares its default to be\s+`true`/u);
  assert.match(runbook, /`openclaw-workspace`, `openclaw-extra`,\s+and `openclaw-managed`/u);
  assert.match(runbook, /`openclaw-managed` is OpenClaw's watched,\s+file-backed user skill root/u);
  assert.match(runbook, /headless `agent exec` surface proves fresh-session discovery only/u);
  assert.match(runbook, /`openclaw agent exec --help`/u);
  assert.match(runbook, /`openclaw\s+agent --help` and confirm that `--session-id`, `--message`, `--json`/u);
  assert.match(runbook, /confirm the watcher event was\s+processed, or wait longer than the installed watcher's documented debounce/u);
  assert.equal(existingSessionBlocks.length, 2);
  for (const block of existingSessionBlocks) {
    assert.match(block, /openclaw agent --session-id <existing-session-id> --json\s+\\\s+--message/u);
    assert.doesNotMatch(block, /--deliver/u);
  }
  assert.match(existingSessionBlocks[0], /expected-version-1-behavior/u);
  assert.match(existingSessionBlocks[1], /expected-version-2-behavior/u);
  assert.match(runbook, /`openclaw skills library refresh` for the selected\s+session/u);
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
    assert.ok(
      report.configPath === '[redacted-path]' || /^~/.test(String(report.configPath || '')),
      'config path must be collapsed or redacted',
    );
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
