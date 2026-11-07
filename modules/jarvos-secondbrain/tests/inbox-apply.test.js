'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { applyInbox } = require('../bridge/capture/src/inbox-apply');

const device = 'phone-47ba92';
const opId = '0f012026-caf1-4e59-99cd-5db5d4e5097f';
const now = () => new Date('2030-02-03T12:00:00Z');

function request(fields = {}, text = 'An invented first line.\nAn invented second line.', newline = '\n') {
  return ['---', ...Object.entries({ phanos_request: 'capture/v1', op_id: opId, device, kind: 'journal', words: 'user',
    asked: 'explicit', model: 'test-model', created: '2030-02-03T07:00:00-05:00', date: '2030-02-03', ...fields })
    .filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`), '---', text, '', '<!-- phanos:end -->', ''].join('\n').replace(/\n/g, newline);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-inbox-'));
  const vaultRoot = path.join(root, 'vault');
  const folder = path.join(vaultRoot, 'phanos/inbox', device);
  const receipts = path.join(vaultRoot, 'phanos/receipts', device);
  fs.mkdirSync(folder, { recursive: true });
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(root, 'state');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  const capture = (input, options) => { calls.push({ input, options }); return { ok: true, message: 'Saved an invented request.' }; };
  const put = (source = request(), name = opId) => fs.writeFileSync(path.join(folder, `${name}.md`), source);
  return { root, vaultRoot, folder, receipts, put, calls,
    apply: (options = {}) => applyInbox({ vaultRoot, capture, now, ...options }),
    receipt: (id = opId) => fs.readFileSync(path.join(receipts, `${id}.md`), 'utf8') };
}

for (const newline of ['\n', '\r\n']) {
  test(`phone fixtures pass exact text and declarations (${JSON.stringify(newline)})`, async (t) => {
    const f = fixture(t);
    for (const [index, kind] of ['idea', 'journal', 'note'].entries()) {
      const id = `fixture-operation-${index}`;
      const text = kind === 'journal' ? 'An invented first line.\nAn invented second line.' : 'An invented tidal garden.';
      f.put(request({ kind, op_id: id, ...(kind === 'note' ? { title: '"A test note"', model: undefined } : {}) }, text, newline), id);
    }
    const result = await f.apply();
    assert.equal(result.counts.saved, 3);
    assert.equal(f.calls.length, 3);
    for (const { input, options } of f.calls) {
      assert.equal(input.source, 'phanos-mobile');
      assert.equal(input.words, 'user');
      assert.equal(input.asked, 'explicit');
      assert.equal(input.date, '2030-02-03');
      assert.equal(input.text, input.kind === 'journal' ? `An invented first line.${newline}An invented second line.` : 'An invented tidal garden.');
      assert.deepEqual(options, { vaultRoot: f.vaultRoot, journalDir: path.join(f.vaultRoot, 'Journal'), notesDir: path.join(f.vaultRoot, 'Notes') });
      if (input.kind === 'note') { assert.equal(input.title, 'A test note'); assert.equal(input.model, undefined); }
      const receipt = f.receipt(input.opId);
      assert.match(receipt, new RegExp(`status: saved\nkind: ${input.kind}\napplied: .*[-+]\\d\\d:\\d\\d\n`));
      assert.ok(!receipt.includes('\r'));
    }
    assert.ok(!JSON.stringify(result).includes('invented'));
    assert.equal((await f.apply()).counts.skipped, 3);
    assert.equal(f.calls.length, 3);
  });
}

test('real capture and persistent mutation ledger save exactly once, including after lost receipts', async (t) => {
  const f = fixture(t);
  for (const [index, kind] of ['idea', 'journal', 'note'].entries()) {
    const id = `fixture-operation-${index}`;
    f.put(request({ kind, op_id: id, ...(kind === 'note' ? { title: '"A test note"' } : {}) },
      kind === 'journal' ? 'An invented first line.\nAn invented second line.' : `An invented ${kind} about tidal gardens.`), id);
  }
  const original = fs.readdirSync(f.folder).map((name) => [name, fs.readFileSync(path.join(f.folder, name), 'utf8'), fs.statSync(path.join(f.folder, name)).mtimeMs]);
  const run = () => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers/capture-lineage-process.js')], {
    input: JSON.stringify({ root: f.root, inbox: true }), encoding: 'utf8', env: { ...process.env,
      JARVOS_VAULT_DIR: f.vaultRoot, JARVOS_NOTES_DIR: path.join(f.root, 'wrong-notes'), VAULT_NOTES_DIR: path.join(f.root, 'wrong-notes'),
      JARVOS_JOURNAL_DIR: path.join(f.root, 'wrong-journal'), JOURNAL_DIR: path.join(f.root, 'wrong-journal'),
      JARVOS_KNOWLEDGE_DIR: path.join(f.root, 'knowledge'), JARVOS_CONFIG_PATH: path.join(f.root, 'missing-config.json'),
      JARVOS_TIMEZONE: 'UTC' },
  }));
  const first = run();
  assert.equal(first.error, null);
  assert.equal(first.result.counts.saved, 3, fs.readdirSync(f.receipts).map((name) => fs.readFileSync(path.join(f.receipts, name), 'utf8')).join('\n'));
  assert.equal(first.notes.length, 1);
  assert.equal(first.journal.split('- An invented idea about tidal gardens.').length - 1, 1);
  assert.equal(first.journal.split('An invented first line.').length - 1, 1);
  assert.equal(first.journal.split('[[A test note]]').length - 1, 1);
  const second = run();
  assert.equal(second.result.counts.skipped, 3);
  assert.deepEqual(second.writes, []);
  fs.rmSync(f.receipts, { recursive: true });
  const third = run();
  assert.equal(third.result.counts.saved, 3, JSON.stringify(third));
  assert.deepEqual(third.writes, []);
  assert.deepEqual(third.notes, first.notes);
  assert.equal(third.journal, first.journal);
  assert.equal(fs.existsSync(path.join(f.root, 'wrong-notes')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'wrong-journal')), false);
  assert.deepEqual(fs.readdirSync(f.folder).map((name) => [name, fs.readFileSync(path.join(f.folder, name), 'utf8'), fs.statSync(path.join(f.folder, name)).mtimeMs]), original);
});

test('not_confirmed is retried with the same opId and receipt rewritten', async (t) => {
  const f = fixture(t); f.put();
  assert.equal((await f.apply({ capture: () => ({ ok: false, message: 'Not confirmed yet: an invented delay.' }) })).counts.not_confirmed, 1);
  assert.match(f.receipt(), /status: not_confirmed/);
  assert.equal((await f.apply()).counts.saved, 1);
  assert.equal(f.calls[0].input.opId, opId);
  assert.match(f.receipt(), /status: saved/);
  assert.equal((await f.apply()).counts.skipped, 1);
});

test('partial, hidden, temp and non-Markdown files create no receipts', async (t) => {
  const f = fixture(t); f.put(request().replace('<!-- phanos:end -->', ''));
  for (const name of ['.hidden.md', 'unfinished.tmp', 'readme.txt']) fs.writeFileSync(path.join(f.folder, name), request());
  assert.equal((await f.apply()).counts.incomplete, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.receipts), false);
});

const invalid = [
  [{ kind: 'other' }, /kind must be/], [{ words: 'assistant' }, /words must be user/],
  [{ asked: 'accepted_offer' }, /asked must be explicit/], [{ kind: 'idea', title: '"A test note"' }, /only for notes/],
  [{ op_id: 'different-operation' }, /op_id must match/], [{ device: 'phone-invented' }, /device must match/],
  [{ extra: 'invented' }, /unknown frontmatter key/], [{ phanos_request: 'capture/v2' }, /capture\/v1/],
  [{ date: '2030-02-30' }, /valid YYYY-MM-DD/], [{ kind: 'note', title: 'unquoted' }, /JSON double-quoted/],
  ...['".hidden"', '"-hidden"', '"a/b"', '"a\\\\b"', '"a\\nb"', JSON.stringify('a'.repeat(201))].map((title) => [{ kind: 'note', title }, /title must be one line/]),
];
for (const [fields, reason] of invalid) test(`invalid request: ${JSON.stringify(fields)}`, async (t) => {
  const f = fixture(t); f.put(request(fields));
  assert.equal((await f.apply()).counts.invalid, 1);
  assert.match(f.receipt(), /status: invalid/);
  assert.match(f.receipt(), reason);
  assert.equal(f.calls.length, 0);
});

test('oversized requests are invalid and duplicate fields are refused', async (t) => {
  const f = fixture(t);
  f.put(request({}, 'x'.repeat(256 * 1024)));
  assert.equal((await f.apply()).counts.invalid, 1);
  assert.match(f.receipt(), /exceeds 256 KB/);
  fs.unlinkSync(path.join(f.receipts, `${opId}.md`));
  f.put(request().replace('kind: journal', 'kind: journal\nkind: idea'));
  assert.equal((await f.apply()).counts.invalid, 1);
  assert.equal(f.calls.length, 0);
});

test('capture validation exceptions and opId conflicts are invalid; other not-ok is not_saved', async (t) => {
  const f = fixture(t); f.put();
  for (const [capture, status] of [
    [() => { throw new Error('An invented validation error.'); }, 'invalid'],
    [() => ({ ok: false, message: 'this operation id was already used for different content' }), 'invalid'],
    [() => ({ ok: false, message: 'Not saved: an invented failure.' }), 'not_saved'],
  ]) {
    assert.equal((await f.apply({ capture })).counts[status], 1);
    assert.match(f.receipt(), new RegExp(`status: ${status}`));
    fs.unlinkSync(path.join(f.receipts, `${opId}.md`));
  }
});

test('missing date uses host local today, trims one separator blank line and keeps other bytes', async (t) => {
  const f = fixture(t);
  const text = '  An invented first line.  \n\nAn invented second line.  \n';
  f.put(request({ date: undefined, created: 'informational' }, text) + '\n\n');
  await f.apply();
  assert.equal(f.calls[0].input.text, text);
  const date = now();
  assert.equal(f.calls[0].input.date, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
});

test('limit applies oldest eligible requests first and skips terminal receipts without consuming it', async (t) => {
  const f = fixture(t);
  for (const [index, id] of ['fixture-oldest', 'fixture-middle', 'fixture-newest'].entries()) {
    f.put(request({ op_id: id }), id);
    fs.utimesSync(path.join(f.folder, `${id}.md`), index + 1, index + 1);
  }
  assert.equal((await f.apply({ limit: 1 })).counts.saved, 1);
  assert.equal(f.calls[0].input.opId, 'fixture-oldest');
  const second = await f.apply({ limit: 1 });
  assert.equal(second.counts.saved, 1);
  assert.equal(second.counts.skipped, 1);
  assert.equal(f.calls[1].input.opId, 'fixture-middle');
});

for (const target of ['phanos', 'inbox', 'device', 'request', 'receipts', 'receipt-device', 'receipt']) {
  test(`symlinked ${target} is rejected without capture or writes outside the vault`, async (t) => {
    const f = fixture(t); f.put();
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const locations = { phanos: path.join(f.vaultRoot, 'phanos'), inbox: path.dirname(f.folder), device: f.folder,
      request: path.join(f.folder, `${opId}.md`), receipts: path.dirname(f.receipts), 'receipt-device': f.receipts, receipt: path.join(f.receipts, `${opId}.md`) };
    const targetPath = locations[target];
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.rmSync(targetPath, { force: true, recursive: true });
    fs.symlinkSync(outside, targetPath);
    await assert.rejects(f.apply(), /symlink|real directories/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}

test('exclusive per-vault lock blocks overlapping runs and is released afterward', async (t) => {
  const f = fixture(t); f.put();
  let finish;
  const first = f.apply({ capture: () => new Promise((resolve) => { finish = resolve; }) });
  const held = await f.apply();
  assert.equal(held.inProgress, true);
  assert.equal(held.message, 'another run is in progress');
  assert.equal(fs.existsSync(f.receipts), false);
  finish({ ok: true, message: 'Saved an invented request.' });
  assert.equal((await first).counts.saved, 1);
  assert.equal((await f.apply()).inProgress, false);
});

test('abandoned ten-minute lock is reclaimed; lock and state stay outside the vault', async (t) => {
  const f = fixture(t); f.put();
  const folder = path.join(f.root, 'state/jarvos/vault-mutations');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `inbox-${createHash('sha256').update(fs.realpathSync(f.vaultRoot)).digest('hex')}.lock`);
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, new Date(0), new Date(0));
  assert.equal((await f.apply()).counts.saved, 1);
  assert.equal(fs.existsSync(file), false);
  process.env.XDG_STATE_HOME = path.join(f.vaultRoot, 'state');
  await assert.rejects(f.apply(), /outside the vault/);
  assert.equal(fs.existsSync(path.join(f.vaultRoot, 'state')), false);
});
