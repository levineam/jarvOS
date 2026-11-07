'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const { normalizeCaptureEvent } = require('../bridge/capture/src/universal-capture');
const { buildSimpleCaptureEvent } = require('../bridge/capture/src/simple-capture');

const base = { kind: 'idea', text: 'An invented tidal garden.', words: 'user', asked: 'explicit',
  source: 'codex', date: '2030-02-03', opId: 'test-operation-001' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-operation-'));
  fs.mkdirSync(path.join(root, 'vault'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(__dirname, 'helpers/capture-lineage-process.js');
  const settings = (input) => ({ input: JSON.stringify({ root, simple: true, ...input }), encoding: 'utf8',
    env: { ...process.env, JARVOS_VAULT_DIR: path.join(root, 'vault'), JARVOS_NOTES_DIR: path.join(root, 'vault/Notes'),
      JARVOS_JOURNAL_DIR: path.join(root, 'vault/Journal'), JARVOS_KNOWLEDGE_DIR: path.join(root, 'knowledge'),
      JARVOS_CONFIG_PATH: path.join(root, 'missing-config.json'), JARVOS_TIMEZONE: 'UTC' } });
  const run = (input = {}) => JSON.parse(execFileSync(process.execPath, [script], settings(input)));
  run.crash = (input) => spawnSync(process.execPath, [script], settings(input));
  run.concurrent = (inputs) => Promise.all(inputs.map((input) => new Promise((resolve, reject) => {
    const options = settings(input);
    const child = execFile(process.execPath, [script], options, (error, stdout) => {
      if (error) reject(error); else resolve(JSON.parse(stdout));
    });
    child.stdin.end(options.input);
  })));
  return run;
}

test('opId validation survives normalization and rejects malformed values before storage', () => {
  for (const opId of ['test-001', 'A'.repeat(80), 'Test_001.abc-xyz']) {
    assert.equal(normalizeCaptureEvent(buildSimpleCaptureEvent({ ...base, opId })).opId, opId);
  }
  for (const opId of ['', null, 42, 'short', 'a'.repeat(81), '-test-001', 'test:001', 'test 001', 'test-001\n']) {
    assert.throws(() => buildSimpleCaptureEvent({ ...base, opId }), /opId must match/);
    assert.throws(() => normalizeCaptureEvent({ ...buildSimpleCaptureEvent(base), opId }), /opId must match/);
  }
});

for (const kind of ['idea', 'journal', 'note']) {
  test(`${kind} repeats across processes save one artifact and return the same message`, (t) => {
    const run = fixture(t);
    const capture = { ...base, kind, ...(kind === 'note' ? { title: 'Invented garden' } : {}) };
    const first = run({ capture });
    const second = run({ capture });
    assert.equal(first.result.ok, true, JSON.stringify(first));
    assert.equal(second.result.ok, true, JSON.stringify(second));
    assert.equal(second.result.message, first.result.message);
    assert.deepEqual(second.notes, first.notes);
    assert.equal(second.journal, first.journal);
    assert.deepEqual(second.writes, []);
    assert.equal(second.notes.length, kind === 'note' ? 1 : 0);
    const line = kind === 'note' ? '- [[Invented garden]]' : '- An invented tidal garden.';
    assert.equal(second.journal.split(line).length - 1, 1);
    if (kind === 'note') assert.equal(second.notes[0].name, 'Invented garden.md');
  });

  test(`${kind} rejects changed text, kind, title or date before any vault write`, (t) => {
    const run = fixture(t);
    const capture = { ...base, kind, ...(kind === 'note' ? { title: 'Invented garden' } : {}) };
    const first = run({ capture });
    const changes = [{ text: 'Another invented garden.' }, { date: '2030-02-04' },
      kind === 'note' ? { title: 'Invented orchard' } : { kind: 'note', title: 'Invented orchard' },
      { kind: kind === 'idea' ? 'journal' : 'idea', title: undefined }];
    for (const delta of changes) {
      const rejected = run({ capture: { ...capture, ...delta } });
      assert.match(rejected.error, /this operation id was already used for different content/);
      assert.deepEqual(rejected.writes, []);
      assert.deepEqual(rejected.notes, first.notes);
      assert.equal(rejected.journal, first.journal);
    }
  });

  test(`${kind} recovers an effect committed before acknowledgement without repeating it`, (t) => {
    const run = fixture(t);
    const capture = { ...base, kind, ...(kind === 'note' ? { title: 'Invented garden' } : {}) };
    const interrupted = run({ capture, fault: kind === 'note' ? 'after_note' : 'after_backlink' });
    assert.equal(interrupted.result.ok, false);
    assert.equal(interrupted.faultTriggered, true);
    assert.ok(Object.values(interrupted.ledger.operations).some(record => record.status === 'unknown_after_dispatch'));
    const recovered = run({ capture });
    assert.equal(recovered.result.ok, true, JSON.stringify(recovered));
    assert.deepEqual(recovered.notes, interrupted.notes);
    if (kind !== 'note') {
      assert.equal(recovered.journal, interrupted.journal);
      assert.deepEqual(recovered.writes, []);
    } else assert.equal(recovered.writes.some(name => name.startsWith('Notes/')), false);
    const again = run({ capture });
    assert.equal(again.result.message, recovered.result.message);
    assert.deepEqual(again.writes, []);
  });
}

test('a lost caller result after acknowledgement replays the original outcome', (t) => {
  const run = fixture(t);
  const interrupted = run({ capture: base, fault: 'after_capture_ack' });
  assert.equal(interrupted.result, null);
  assert.match(interrupted.error, /caller death/);
  const recovered = run({ capture: base });
  assert.equal(recovered.result.ok, true);
  assert.equal(recovered.result.message, 'Saved to Ideas for 2030-02-03.');
  assert.equal(recovered.journal, interrupted.journal);
  assert.deepEqual(recovered.writes, []);
});

test('process exit after the vault effect leaves a fenced intent that readback recovers', (t) => {
  for (const kind of ['idea', 'journal', 'note']) {
    const run = fixture(t);
    const capture = { ...base, kind, ...(kind === 'note' ? { title: 'Invented garden' } : {}) };
    const crashed = run.crash({ capture, fault: 'exit_after_effect', ledgerNow: 100_000 });
    assert.equal(crashed.status, 73, crashed.stderr);
    const before = run();
    assert.ok(Object.values(before.ledger.operations).some(record => record.status === 'dispatched'));
    const held = run({ capture, ledgerNow: 100_001 });
    assert.equal(held.result.ok, false);
    assert.deepEqual(held.writes, []);
    const recovered = run({ capture, ledgerNow: 200_000 });
    assert.equal(recovered.result.ok, true, JSON.stringify(recovered));
    assert.deepEqual(recovered.notes, before.notes);
    assert.equal(recovered.writes.some(name => name.startsWith('Notes/')), false);
    if (kind !== 'note') {
      assert.equal(recovered.journal, before.journal);
      assert.deepEqual(recovered.writes, []);
    }
  }
});

test('a queued request can finish on replay and changed content stays refused', (t) => {
  const run = fixture(t);
  const queued = run({ capture: base, fault: 'before_write' });
  assert.equal(queued.result.ok, false);
  assert.deepEqual(queued.writes, []);
  const changed = run({ capture: { ...base, text: 'A different invented request.' } });
  assert.match(changed.error, /already used for different content/);
  assert.deepEqual(changed.writes, []);
  assert.equal(run({ capture: base }).result.ok, true);
  assert.deepEqual(run({ capture: base }).writes, []);
});

test('an ambiguous unsatisfied backlink is held without blindly replaying the note', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented garden' };
  const interrupted = run({ capture, fault: 'before_backlink' });
  assert.equal(interrupted.result.ok, false);
  const repeated = run({ capture });
  assert.equal(repeated.result.ok, false);
  assert.deepEqual(repeated.notes, interrupted.notes);
  assert.equal(repeated.journal, interrupted.journal);
  assert.deepEqual(repeated.writes, []);
});

test('replaying an acknowledged capture preserves later additions to the same note', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented garden' };
  const first = run({ capture });
  assert.equal(first.result.ok, true);
  const added = run({ capture: { ...capture, text: 'Another invented garden detail.', opId: 'test-operation-002' } });
  assert.equal(added.result.ok, true, JSON.stringify(added));
  assert.match(added.notes[0].content, /Another invented garden detail/);
  const repeated = run({ capture });
  assert.equal(repeated.result.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.result.message, first.result.message);
  assert.deepEqual(repeated.notes, added.notes);
  assert.equal(repeated.journal, added.journal);
  assert.deepEqual(repeated.writes, []);
});

test('same ID is independent across source labels, and omitted date stays pinned', (t) => {
  const run = fixture(t);
  const capture = { ...base, date: undefined };
  const first = run({ capture });
  const second = run({ capture });
  assert.equal(second.result.ok, true, JSON.stringify(second));
  assert.equal(second.result.message, first.result.message);
  assert.deepEqual(second.writes, []);
  const date = Object.values(first.ledger.captures)[0].plan.date;
  const changed = run({ capture: { ...capture, date } });
  assert.match(changed.error, /already used for different content/);
  for (const source of ['Fixture phone A', 'Fixture phone B']) {
    const independent = run({ capture: { ...base, source } });
    assert.equal(independent.result.ok, true, JSON.stringify(independent));
  }
  assert.equal(Object.keys(run().ledger.captures).length, 3);
});

test('overlapping captures share one reservation; different requests have one winner', async (t) => {
  for (const different of [false, true]) {
    const run = fixture(t);
    const captures = [base, different ? { ...base, kind: 'note', title: 'Invented garden' } : base];
    const results = await run.concurrent(captures.map(capture => ({ capture })));
    assert.equal(results.filter(result => result.error).length, different ? 1 : 0);
    const winner = results.findIndex(result => !result.error);
    const recovered = run({ capture: captures[winner] });
    assert.equal(recovered.result.ok, true, JSON.stringify(recovered));
    assert.equal(Object.keys(recovered.ledger.captures).length, 1);
    assert.equal(recovered.notes.length, captures[winner].kind === 'note' ? 1 : 0);
    assert.equal(recovered.journal.split('- An invented tidal garden.').length - 1, captures[winner].kind === 'idea' ? 1 : 0);
  }
});
