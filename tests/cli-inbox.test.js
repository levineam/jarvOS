'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInboxCommand, renderHelp, normalizeArgvForInvocation } = require('../lib/jarvos-cli');

async function invoke(args, env = {}, apply) {
  let stdout = ''; let stderr = '';
  const code = await runInboxCommand(args, env, { stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } }, ...(apply ? { apply } : {}) });
  return { code, stdout, stderr };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-cli-inbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), JARVOS_CONFIG_PATH: path.join(root, 'config.json') };
  fs.writeFileSync(env.JARVOS_CONFIG_PATH, JSON.stringify({ paths: { vault: vaultRoot }, user: { timezone: 'UTC' } }));
  return { root, vaultRoot, env };
}

const summary = { counts: { saved: 1, not_confirmed: 1, not_saved: 1, invalid: 1, incomplete: 1, skipped: 1 },
  requests: [{ device: 'phone-invented', opId: 'operation-invented', status: 'saved' }], inProgress: false };

test('inbox CLI resolves config, honors explicit vault, parses limit and returns request status JSON', async (t) => {
  const f = fixture(t);
  for (const args of [['apply'], ['apply', '--vault', f.vaultRoot, '--limit', '7'], ['apply', `--vault=${f.vaultRoot}`, '--limit=7']]) {
    const result = await invoke([...args, '--json'], f.env, (options) => {
      assert.deepEqual(options, { vaultRoot: f.vaultRoot, limit: args.length === 1 ? 50 : 7 });
      return summary;
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), summary);
    assert.equal(result.stderr, '');
    assert.ok(!result.stdout.includes('text'));
  }
  const override = path.join(f.root, 'other-vault');
  await invoke(['apply', '--vault', override], f.env, ({ vaultRoot }) => { assert.equal(vaultRoot, override); return summary; });
  const result = await invoke(['apply'], f.env, () => summary);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.split('\n').length, 2);
  assert.match(result.stdout, /saved 1.*invalid 1/);
});

test('inbox CLI help appears next to capture and works without accessing storage', async () => {
  assert.match(renderHelp(), /jarvos capture[^\n]*\n  jarvos inbox apply \[--vault <abs path>\] \[--limit N\] \[--json\]/);
  for (const args of [['--help'], ['apply', '--help'], ['apply', '-h']]) {
    const result = await invoke(args, {}, () => assert.fail('help must not apply'));
    assert.equal(result.code, 0);
    assert.match(result.stdout, /jarvos inbox apply/);
  }
  assert.deepEqual(normalizeArgvForInvocation(['inbox', 'apply'], 'jarvos-bootstrap'), ['inbox', 'apply']);
});

test('inbox CLI bad arguments exit 1 before applying', async (t) => {
  const f = fixture(t);
  for (const args of [[], ['other'], ['apply', 'extra'], ['apply', '--unknown'], ['apply', '--vault'], ['apply', '--vault', 'relative'],
    ['apply', '--vault='], ['apply', '--limit'], ...['0', '-1', '1.5', 'NaN', '1e2', '', '9007199254740992'].map((n) => ['apply', `--limit=${n}`])]) {
    const result = await invoke(args, f.env, () => assert.fail('bad args must not apply'));
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.match(result.stderr, /^jarvos inbox apply failed:/);
    assert.equal(result.stdout, '');
  }
});

test('inbox CLI held lock and per-request failures exit 0; command failure exits 1', async (t) => {
  const f = fixture(t);
  const held = await invoke(['apply'], f.env, () => ({ ...summary, inProgress: true }));
  assert.equal(held.code, 0);
  assert.equal(held.stdout, 'another run is in progress\n');
  assert.equal((await invoke(['apply'], f.env, () => summary)).code, 0);
  const failed = await invoke(['apply'], f.env, () => { throw new Error('An invented filesystem failure.'); });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /invented filesystem failure/);
});

test('jarvos executable dispatches inbox apply with JSON and rejects malformed commands', (t) => {
  const f = fixture(t);
  const cli = path.join(__dirname, '../scripts/jarvos.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'inbox', ...args], { encoding: 'utf8', env: { ...process.env, ...f.env,
    JARVOS_VAULT_DIR: f.vaultRoot, JARVOS_TIMEZONE: 'UTC', JARVOS_SECONDBRAIN_DIR: path.join(__dirname, '../modules/jarvos-secondbrain') } });
  const result = run('apply', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { counts: { saved: 0, not_confirmed: 0, not_saved: 0, invalid: 0, incomplete: 0, skipped: 0 }, requests: [], inProgress: false });
  assert.deepEqual(fs.readdirSync(f.vaultRoot), []);
  assert.equal(run('apply', '--limit=0').status, 1);
  assert.equal(run('other').status, 1);
  assert.equal(run('apply', '--help').status, 0);
  fs.mkdirSync(path.join(f.vaultRoot, 'phanos/inbox/phone-invented'), { recursive: true });
  fs.writeFileSync(path.join(f.vaultRoot, 'phanos/inbox/phone-invented/operation-invented.md'), '---\nphanos_request: capture/v2\n---\nInvented text.\n\n<!-- phanos:end -->\n');
  const invalid = run('apply', '--json');
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).counts.invalid, 1);
  assert.ok(!invalid.stdout.includes('Invented text'));
});
