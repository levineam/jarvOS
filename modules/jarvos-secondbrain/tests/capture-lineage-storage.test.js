'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { parseFrontmatter, frontmatterToObject } = require('../packages/jarvos-secondbrain-notes/src/lib/note-schema');

const identity = { namespace: 'workshop', id: 'opening', revision: 'A' };
const baseCapture = { text: 'note: The workshop date is undecided.', title: 'Workshop', date: '2030-02-03',
  source: 'codex', actor: 'human', captureMode: 'manual', privacyTier: 'local-private',
  origin: { kind: 'manual', ref: 'synthetic:workshop' }, evidence: [{ ref: 'synthetic:invitation' }],
  frontmatter: { project_ref: 'synthetic:project:workshop' }, captureIdentity: identity };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-lineage-'));
  fs.mkdirSync(path.join(root, 'vault'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(__dirname, 'helpers/capture-lineage-process.js');
  const childOptions = (options = {}) => ({
    input: JSON.stringify({ root, ...options }), encoding: 'utf8',
    env: { ...process.env, JARVOS_VAULT_DIR: path.join(root, 'vault'), JARVOS_NOTES_DIR: path.join(root, 'vault/Notes'),
      JARVOS_JOURNAL_DIR: path.join(root, 'vault/Journal'), JARVOS_KNOWLEDGE_DIR: path.join(root, 'knowledge'),
      JARVOS_CONFIG_PATH: path.join(root, 'missing-config.json'), JARVOS_TIMEZONE: 'UTC' },
  });
  const run = (options) => JSON.parse(execFileSync(process.execPath, [script], childOptions(options)));
  run.concurrent = (options) => Promise.all(options.map((input) => new Promise((resolve, reject) => {
    const settings = childOptions(input);
    const child = execFile(process.execPath, [script], settings, (error, stdout) => {
      if (error) reject(error); else resolve(JSON.parse(stdout));
    });
    child.stdin.end(settings.input);
  })));
  return run;
}
const captureRecords = (state) => Object.values(state.ledger.operations).filter((record) => record.operation.operationId.startsWith('capture:'));

test('concurrent first captures share one ledger identity and one logical note', async (t) => {
  const run = fixture(t);
  const attempts = await run.concurrent([{ capture: baseCapture }, { capture: baseCapture }]);
  for (const attempt of attempts) assert.equal(attempt.error, null);
  const recovered = run({ capture: baseCapture, reconcile: true });
  assert.equal(recovered.result.ok, true);
  assert.equal(recovered.notes.length, 1);
  assert.equal((recovered.journal.match(/\[\[Workshop -- /g) || []).length, 1);
  assert.equal(captureRecords(recovered).filter((record) => record.operation.operationId.endsWith(':note')).length, 1);
});

test('literal dollar substitution patterns in titles produce exact journal links', (t) => {
  const run = fixture(t);
  for (const title of ['Workshop: Plan', 'Cost $$ analysis', 'Cost $& analysis', 'Cost $` analysis', "Cost $' analysis"]) {
    const outcome = run({ capture: { ...baseCapture, title, captureIdentity: { ...identity, id: title } } });
    assert.equal(outcome.result.ok, true);
    assert.ok(outcome.journal.includes(`- [[${outcome.result.note.title}]]`));
    assert.equal(outcome.result.routing.plan.noteTitle, outcome.result.note.title);
    assert.ok(outcome.journal.includes(outcome.result.routing.plan.journalLine));
  }
});

test('planned capture replayed offline retains the note ID written in the stored bytes', (t) => {
  const run = fixture(t);
  const planned = run({ capture: baseCapture, fault: 'before_write' });
  const offline = run({ capture: baseCapture, fault: 'offline_stopped' });
  assert.equal(offline.result.ok, false);
  assert.equal(offline.result.note.receipt.status, 'saved_locally_sync_pending');
  assert.equal(offline.notes.length, 1);
  const storedId = frontmatterToObject(parseFrontmatter(offline.notes[0].content)).jarvos_note_id;
  assert.equal(storedId, captureRecords(planned)[0].operation.noteId);
  assert.equal(offline.result.note.noteId, storedId);
  const recovered = run({ capture: baseCapture, reconcile: true });
  assert.equal(recovered.result.ok, true);
  assert.equal(recovered.result.note.noteId, storedId);
});

test('polling observes pending callbacks and timeout recovery acknowledges a later effect', (t) => {
  const normal = fixture(t)({ capture: baseCapture });
  assert.equal(normal.result.ok, true);
  assert.ok(normal.pendingPolls > 0);
  for (const fault of ['poll_timeout', 'poll_deadline']) {
    const run = fixture(t);
    const timedOut = run({ capture: baseCapture, fault });
    assert.equal(timedOut.result.ok, false);
    assert.equal(timedOut.result.note.receipt.status, 'unknown_after_dispatch');
    assert.equal(timedOut.pendingPolls, fault === 'poll_timeout' ? 3 : 0);
    assert.equal(timedOut.notes.length, 1); // effect lands only after the adapter returned
    assert.equal(timedOut.journal, null);
    const blocked = run({ capture: baseCapture });
    assert.equal(blocked.result.ok, false);
    assert.deepEqual(blocked.writes, []);
    const recovered = run({ capture: baseCapture, reconcile: true });
    assert.equal(recovered.result.ok, true);
    assert.deepEqual(recovered.notes, timedOut.notes);
    assert.equal(recovered.writes.some((name) => name.startsWith('Notes/')), false);
  }
});

test('separate-process readback and replay preserve one note and one backlink; changed requests conflict', (t) => {
  const run = fixture(t);
  const first = run({ capture: baseCapture });
  assert.equal(first.error, null);
  assert.equal(first.result.ok, true);
  assert.equal(first.notes.length, 1);
  assert.match(first.notes[0].content, /capture_identity:/);
  assert.match(first.notes[0].content, /capture_provenance:/);
  const metadata = frontmatterToObject(parseFrontmatter(first.notes[0].content));
  assert.deepEqual(JSON.parse(metadata.capture_identity), identity);
  assert.equal(metadata.project_ref, baseCapture.frontmatter.project_ref);
  assert.deepEqual(JSON.parse(metadata.capture_provenance).evidence, baseCapture.evidence);
  assert.equal(JSON.parse(metadata.capture_provenance).actor, baseCapture.actor);
  const readback = run();
  assert.deepEqual(readback.notes, first.notes);
  const duplicate = run({ capture: baseCapture });
  assert.equal(duplicate.result.ok, true);
  assert.equal(duplicate.result.note.noteId, first.result.note.noteId);
  assert.deepEqual(duplicate.notes, first.notes);
  assert.equal(duplicate.journal, first.journal);
  assert.deepEqual(duplicate.writes, []);
  assert.equal(captureRecords(duplicate).length, 3); // note, one scaffold prerequisite, one backlink
  assert.equal((duplicate.journal.match(/\[\[Workshop -- /g) || []).length, 1);
  for (const delta of [{ text: 'note: Changed.' }, { evidence: [{ ref: 'synthetic:changed' }] },
    { title: 'Changed' }, { frontmatter: { custom: 'changed' } }, { origin: { kind: 'manual', ref: 'changed' } },
    { captureIdentity: { ...identity, relation: { kind: 'withdraws', target: { ...identity, revision: '0' } } } }]) {
    const changed = run({ capture: { ...baseCapture, ...delta } });
    assert.equal(changed.result.ok, false);
    assert.equal(changed.result.note.receipt.status, 'conflict');
    assert.deepEqual(changed.writes, []);
    assert.deepEqual(changed.notes, first.notes);
    assert.equal(changed.journal, first.journal);
  }
});

test('equal titles, opaque new revisions, corrections and withdrawals are separate additive records', (t) => {
  const run = fixture(t);
  run({ capture: baseCapture });
  const identities = [{ ...identity, id: 'other' }, { ...identity, revision: 'draft B' },
    { ...identity, revision: 'correction', relation: { kind: 'corrects', target: identity } },
    { ...identity, revision: 'withdrawal', relation: { kind: 'withdraws', target: identity } }];
  for (const captureIdentity of identities) assert.equal(run({ capture: { ...baseCapture, captureIdentity } }).result.ok, true);
  const result = run();
  assert.equal(result.notes.length, 5);
  const stored = result.notes.map((note) => JSON.parse(frontmatterToObject(parseFrontmatter(note.content)).capture_identity));
  for (const expected of [identity, ...identities]) {
    assert.deepEqual(stored.find((value) => value.namespace === expected.namespace && value.id === expected.id && value.revision === expected.revision), expected);
  }
  assert.equal(new Set(result.notes.map((note) => note.name)).size, 5);
  assert.equal((result.journal.match(/\[\[/g) || []).length >= 5, true);
});

test('partial note/journal and backlink-effect interruptions resume through canonical reconciliation', (t) => {
  for (const fault of ['after_note_before_journal', 'after_backlink']) {
    const run = fixture(t);
    const failed = run({ capture: baseCapture, fault });
    assert.equal(failed.result.ok, false);
    assert.equal(failed.notes.length, 1);
    const recovered = run({ capture: baseCapture, reconcile: true });
    assert.equal(recovered.result.ok, true);
    assert.deepEqual(recovered.notes, failed.notes);
    assert.equal(recovered.writes.some((name) => name.startsWith('Notes/')), false);
    assert.equal((recovered.journal.match(/\[\[Workshop -- /g) || []).length, 1);
    if (fault === 'after_backlink') assert.deepEqual(recovered.writes, []);
  }
});

test('malformed identities and missing date fail before any operation is planned', (t) => {
  const run = fixture(t);
  for (const captureIdentity of [null, {}, { ...identity, relation: { kind: 'corrects', target: identity } }]) {
    const state = run({ capture: { ...baseCapture, captureIdentity } });
    assert.match(state.error, /captureIdentity/);
    assert.equal(Object.keys(state.ledger.operations).length, 0);
    assert.deepEqual(state.writes, []);
  }
  const state = run({ capture: { ...baseCapture, date: undefined } });
  assert.match(state.error, /date/);
  assert.equal(Object.keys(state.ledger.operations).length, 0);
});

test('before-write failure reuses the planned operation after restart', (t) => {
  const run = fixture(t);
  const failed = run({ capture: baseCapture, fault: 'before_write' });
  assert.equal(failed.result.ok, false);
  assert.deepEqual(failed.writes, []);
  const retried = run({ capture: baseCapture });
  assert.equal(retried.result.ok, true);
  assert.equal(retried.notes.length, 1);
  assert.deepEqual(captureRecords(retried)[0].operation, captureRecords(failed)[0].operation);
});

test('effect-before-ack remains blocked until existing readback reconciliation, with no duplicate effect', (t) => {
  const run = fixture(t);
  const failed = run({ capture: baseCapture, fault: 'after_note' });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.notes.length, 1);
  assert.equal(failed.journal, null);
  assert.equal(captureRecords(failed)[0].status, 'unknown_after_dispatch');
  const blocked = run({ capture: baseCapture });
  assert.equal(blocked.result.ok, false);
  assert.deepEqual(blocked.writes, []);
  const recovered = run({ capture: baseCapture, reconcile: true });
  assert.equal(recovered.result.ok, true);
  assert.deepEqual(recovered.notes, failed.notes);
  assert.equal(recovered.writes.some((name) => name.startsWith('Notes/')), false);
});

test('partial note/backlink failure is not success and an unsatisfied ambiguous write is never blindly retried', (t) => {
  const run = fixture(t);
  const failed = run({ capture: baseCapture, fault: 'before_backlink' });
  assert.equal(failed.result.ok, false);
  assert.equal(failed.notes.length, 1);
  assert.equal(captureRecords(failed).some((record) => record.status === 'unknown_after_dispatch'), true);
  const retried = run({ capture: baseCapture, reconcile: true });
  assert.equal(retried.result.ok, false);
  assert.deepEqual(retried.notes, failed.notes);
  assert.equal(retried.journal, failed.journal);
  assert.deepEqual(retried.writes, []);
});
