'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const { normalizeCaptureEvent } = require('../bridge/capture/src/universal-capture');
const { buildSimpleCaptureEvent } = require('../bridge/capture/src/simple-capture');
const { createVaultMutationLedger } = require('../adapters/obsidian/src/vault-mutation-ledger');
const { ENSURE_EXISTS_RESOLUTION } = require('../adapters/obsidian/src/vault-mutation-reconciler');

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
  run.root = root;
  return run;
}

test('note status and resume use the original ID after a dropped create acknowledgement and restart', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented resumable note', words: 'mixed', model: 'invented-model' };
  const first = run({ capture, fault: 'after_note' });
  assert.equal(first.result.ok, false);
  assert.deepEqual(first.writes, ['Notes/Invented resumable note.md']);
  const progress = { opId: capture.opId, source: capture.source };
  const checked = run({ progress });
  assert.deepEqual(checked.ledger, first.ledger);
  assert.equal(checked.result.note, 'unconfirmed', JSON.stringify(checked));
  assert.equal(checked.result.notePath, first.writes[0]);
  assert.equal(checked.result.journal, 'pending');
  const recovered = run({ progress: { ...progress, resume: true } });
  assert.equal(recovered.result.state, 'complete', JSON.stringify(recovered));
  assert.deepEqual(recovered.notes, first.notes);
  assert.match(recovered.notes[0].content, /invented-model/);
  assert.equal(recovered.journal.split('[[Invented resumable note]]').length - 1, 1);
  const repeated = run({ progress: { ...progress, resume: true } });
  assert.equal(repeated.result.state, 'complete');
  assert.deepEqual(repeated.writes, []);
  assert.deepEqual(repeated.ledger, recovered.ledger);
  assert.deepEqual(repeated.notes, recovered.notes);
  assert.equal(repeated.journal, recovered.journal);

  const notePath = path.join(run.root, 'vault', first.writes[0]);
  const later = first.notes[0].content + '\nA subsequent invented edit.\n';
  fs.writeFileSync(notePath, later);
  const changed = run({ progress: { ...progress, resume: true } });
  assert.equal(changed.result.state, 'conflict');
  assert.deepEqual(changed.writes, []);
  assert.equal(changed.notes[0].content, later);
  assert.equal(changed.journal, recovered.journal);
});

function interruptJournalCreate(run) {
  const capture = { ...base, kind: 'note', title: 'Invented note with a lost journal acknowledgement' };
  const first = run({ capture, fault: 'after_journal_create' });
  const intentId = Object.keys(first.ledger.captures)[0];
  const createId = `${intentId}:note-link:create`;
  const linkId = `${intentId}:note-link:section`;
  const journalPath = `Journal/${capture.date}.md`;
  assert.equal(first.faultTriggered, true);
  assert.deepEqual(first.writes, [`Notes/${capture.title}.md`, journalPath]);
  assert.equal(first.ledger.operations[`${intentId}:note`].status, 'acknowledged');
  assert.equal(first.ledger.operations[createId].status, 'unknown_after_dispatch');
  assert.equal(first.ledger.operations[linkId], undefined);
  fs.appendFileSync(path.join(run.root, 'vault', journalPath), '\nAn invented journal edit.\n');
  return { capture, first, createId, linkId, journalPath };
}

test('resume links an earlier note after a later capture resolves its stuck journal create', (t) => {
  const run = fixture(t);
  const { capture, first, createId, linkId, journalPath } = interruptJournalCreate(run);
  const later = run({ capture: { ...base, opId: 'test-later-idea' } });
  assert.equal(later.result.ok, true);
  assert.equal(later.ledger.operations[createId].status, 'superseded');
  assert.equal(later.ledger.operations[createId].evidence.reason, ENSURE_EXISTS_RESOLUTION);
  assert.equal(later.ledger.operations[linkId], undefined);

  const progress = { opId: capture.opId, source: capture.source };
  const status = run({ progress });
  const recovered = run({ progress: { ...progress, resume: true } });
  assert.equal(recovered.result.state, 'complete');
  assert.equal(status.result.state, 'pending');
  assert.deepEqual(status.ledger, later.ledger);
  assert.deepEqual(recovered.notes, first.notes);
  assert.deepEqual(recovered.writes, [journalPath]);
  assert.equal(recovered.journal.split(`[[${capture.title}]]`).length - 1, 1);
  assert.match(recovered.journal, /An invented journal edit\./);
  assert.deepEqual(run({ progress: { ...progress, resume: true } }).writes, []);
});

test('resume keeps journal creates with other terminal resolutions in conflict', (t) => {
  for (const status of ['superseded', 'abandoned']) {
    const run = fixture(t);
    const { capture, createId, linkId } = interruptJournalCreate(run);
    const ledger = createVaultMutationLedger({ filePath: path.join(run.root, 'ledger.json') });
    ledger.resolve('test-operator', createId, status, 'Synthetic manual resolution');
    const resumed = run({ progress: { opId: capture.opId, source: capture.source, resume: true } });
    assert.equal(resumed.result.state, 'conflict');
    assert.equal(resumed.ledger.operations[linkId], undefined);
    assert.deepEqual(resumed.writes, []);
  }
});

test('resume recovers a queued backlink behind a stuck journal create', (t) => {
  const run = fixture(t);
  const { createId, journalPath } = interruptJournalCreate(run);
  const capture = { ...base, kind: 'note', opId: 'test-queued-backlink', title: 'Invented note with a queued backlink' };
  const queued = run({ capture, fault: 'journal_presence_unavailable' });
  const link = Object.values(queued.ledger.operations).find(record => record.operation.transformName === 'journal-backlink');
  assert.equal(queued.result.ok, false);
  assert.equal(queued.ledger.operations[createId].status, 'unknown_after_dispatch');
  assert.equal(link.status, 'planned');
  assert.equal(link.attempts, 0);

  const progress = { opId: capture.opId, source: capture.source, resume: true };
  const recovered = run({ progress });
  assert.equal(recovered.result.state, 'complete');
  assert.equal(recovered.ledger.operations[createId].evidence.reason, ENSURE_EXISTS_RESOLUTION);
  assert.equal(recovered.ledger.operations[link.operation.operationId].attempts, 1);
  assert.deepEqual(recovered.notes, queued.notes);
  assert.deepEqual(recovered.writes, [journalPath]);
  assert.equal(recovered.journal.split(`[[${capture.title}]]`).length - 1, 1);
  assert.deepEqual(run({ progress }).writes, []);
});

test('resume acknowledges an already-present queued backlink behind a stuck journal create', (t) => {
  const run = fixture(t);
  const { createId, journalPath } = interruptJournalCreate(run);
  const capture = { ...base, kind: 'note', opId: 'test-already-linked', title: 'Invented note linked in Obsidian' };
  const queued = run({ capture, fault: 'journal_presence_unavailable' });
  const link = Object.values(queued.ledger.operations).find(record => record.operation.transformName === 'journal-backlink');
  assert.equal(link.status, 'planned');
  assert.equal(queued.ledger.operations[createId].status, 'unknown_after_dispatch');
  const journal = queued.journal.replace(/^- ?$/m, `- [[${capture.title}]]`);
  fs.writeFileSync(path.join(run.root, 'vault', journalPath), journal);

  const progress = { opId: capture.opId, source: capture.source };
  const status = run({ progress });
  assert.equal(status.result.journal, 'unconfirmed');
  assert.deepEqual(status.ledger, queued.ledger);
  const recovered = run({ progress: { ...progress, resume: true } });
  assert.equal(recovered.result.state, 'complete');
  assert.equal(recovered.ledger.operations[createId].evidence.reason, ENSURE_EXISTS_RESOLUTION);
  assert.equal(recovered.ledger.operations[link.operation.operationId].status, 'acknowledged');
  assert.deepEqual(recovered.writes, []);
  assert.equal(recovered.journal, journal);
  assert.deepEqual(run({ progress: { ...progress, resume: true } }).ledger, recovered.ledger);
});

test('legacy capture inherits validated provenance in place before linking, with a durable original-operation audit', (t) => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const run = fixture(t);
  const capture = { ...base, text: 'An invented revision of the approved source.', kind: 'note', title: 'Invented revision', words: 'assistant' };
  const first = run({ capture, legacy: true, fault: 'after_note' });
  const note = first.notes[0].content;
  const intentId = Object.keys(first.ledger.captures)[0];
  const baselinePath = path.join(run.root, 'vault/Notes/Invented baseline.md');
  const baseline = [
    '---', 'content_origin: mixed', 'content_origin_basis: mixed_composition', 'human_evidence_eligible: false',
    'content_origin_drafting: [{"kind":"assistant_edit","harness":"invented-harness","model":"invented-model","model_evidence":"declared"}]',
    'jarvos_note_id: invented-baseline-id', '---', '', 'An invented approved source.',
  ].join('\n');
  fs.writeFileSync(baselinePath, baseline);
  const repair = { intentId, originalHash: hash(note), baselinePath, baselineHash: hash(baseline),
    revision: capture.text, revisionHash: hash(capture.text), journalPath: 'Journal/2030-02-03.md' };
  const premature = run({ progress: { opId: capture.opId, source: capture.source, resume: true } });
  assert.equal(premature.result.state, 'unsupported');
  assert.deepEqual(premature.ledger, first.ledger);
  const refused = run({ provenanceRepair: { ...repair, baselineHash: '0'.repeat(64) } });
  assert.deepEqual(refused.ledger, first.ledger);
  assert.equal(refused.result.state, 'conflict');
  const corrected = run({ provenanceRepair: repair });
  assert.equal(corrected.result?.state, 'corrected', JSON.stringify({ error: corrected.error, result: corrected.result }));
  assert.deepEqual(corrected.writes, ['Notes/Invented revision.md']);
  const revised = corrected.notes.find(file => file.name === 'Invented revision.md').content;
  const body = content => content.split(/^---$/m).slice(2).join('---');
  const noteId = content => content.match(/^jarvos_note_id: (.*)$/m)[1];
  assert.equal(body(revised), body(note));
  assert.equal(noteId(revised), noteId(note));
  assert.match(revised, /content_origin: mixed/);
  assert.match(revised, /human_evidence_eligible: false/);
  assert.match(revised, /invented-model/);
  assert.match(revised, /incorrect_whole_document_assistant_draft/);
  assert.equal(corrected.ledger.operations[`${intentId}:note`].operation.content, note);
  assert.equal(corrected.journal, null);
  const progress = { opId: capture.opId, source: capture.source, resume: true };
  const linked = run({ progress });
  assert.equal(linked.result.state, 'complete');
  assert.equal(linked.journal.split('[[Invented revision]]').length - 1, 1);
  const replay = run({ progress });
  assert.deepEqual(replay.writes, []);
  assert.deepEqual(replay.ledger, linked.ledger);
});

test('resume preserves a later journal edit that placed the note link in another section', (t) => {
  const run = fixture(t);
  const title = 'Invented note with later placement';
  const capture = { ...base, kind: 'note', title };
  const first = run({ capture, fault: 'after_note' });
  const journal = '# Test Stream\n\n## Journal\n- [[' + title + '|Existing link]]\n\n## 📝 Notes\n\n';
  const journalDir = path.join(run.root, 'vault/Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(path.join(journalDir, capture.date + '.md'), journal);
  const resumed = run({ progress: { opId: capture.opId, source: capture.source, resume: true } });
  assert.equal(resumed.result.state, 'conflict');
  assert.deepEqual(resumed.notes, first.notes);
  assert.equal(resumed.journal, journal);
  assert.ok(Object.values(resumed.ledger.operations).some(record =>
    record.status === 'abandoned' && record.evidence?.errorClass === 'backlink_placement_conflict'));
  const unrelated = run({ capture: { ...base, opId: 'test-independent-idea', text: 'An independent invented idea.' } });
  assert.equal(unrelated.result.ok, true);
  assert.match(unrelated.journal, /An independent invented idea/);
});

test('resume refuses to redirect an unfinished link after the configured journal folder changes', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented pinned folder' };
  const first = run({ capture, fault: 'after_note' });
  const changed = run({ progress: { opId: capture.opId, source: capture.source, resume: true }, progressJournalFolder: 'Other' });
  assert.equal(changed.result.state, 'conflict');
  assert.deepEqual(changed.ledger, first.ledger);
  assert.deepEqual(changed.writes, []);
});

test('a standing create-only request saves and links once, then replays its create', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented garden', asked: 'standing_request', createOnly: true };
  const first = run({ capture });
  assert.equal(first.result.ok, true, JSON.stringify(first));
  assert.match(first.notes[0].content, /capture_asked: standing_request/);
  assert.equal(first.journal.split('[[Invented garden]]').length - 1, 1);
  const second = run({ capture });
  assert.equal(second.result.ok, true, JSON.stringify(second));
  assert.equal(second.result.result.note.receipt.replay, true);
  assert.deepEqual(second.notes, first.notes);
  assert.equal(second.journal, first.journal);
  assert.deepEqual(second.writes, []);
  for (const patch of [{ text: 'Another invented note.' }, { createOnly: false }, { asked: 'explicit' }]) {
    const changed = run({ capture: { ...capture, ...patch } });
    assert.match(changed.error, /already used for different content/);
    assert.deepEqual(changed.notes, first.notes);
    assert.equal(changed.journal, first.journal);
    assert.deepEqual(changed.writes, []);
  }
});

test('create-only refuses any existing title, including empty notes, without a journal mutation', (t) => {
  for (const content of ['', 'An invented existing note.', '---\ncontent_origin_drafting: invalid\n---\nAn invented malformed note.']) {
    for (const opId of [undefined, 'test-create-only-001']) {
      const run = fixture(t);
      const before = run({ capture: base });
      const notesDir = path.join(run.root, 'vault/Notes');
      fs.mkdirSync(notesDir);
      fs.writeFileSync(path.join(notesDir, 'Invented garden.md'), content);
      const capture = { ...base, kind: 'note', title: 'Invented garden', createOnly: true, opId };
      const rejected = run({ capture });
      assert.equal(rejected.result?.ok, false, JSON.stringify(rejected));
      assert.equal(rejected.result.result.note.receipt.status, 'conflict');
      assert.equal(rejected.result.result.note.receipt.reason, 'note_exists');
      assert.equal(rejected.result.message, 'Not saved: a note with this title already exists');
      assert.deepEqual(rejected.notes, [{ name: 'Invented garden.md', content }]);
      assert.equal(rejected.journal, before.journal);
      assert.deepEqual(rejected.writes, []);
      const retried = run({ capture });
      assert.equal(retried.result.result.note.receipt.reason, 'note_exists');
      assert.deepEqual(retried.notes, rejected.notes);
      assert.equal(retried.journal, before.journal);
      assert.deepEqual(retried.writes, []);
      const ledger = createVaultMutationLedger({ filePath: path.join(run.root, 'ledger.json') });
      const noteRecords = Object.values(ledger.verify().operations).filter(record => record.operation.vaultRelativePath === 'Notes/Invented garden.md');
      assert.equal(noteRecords.length, opId ? 1 : 2);
      assert.ok(noteRecords.every(record => record.status === 'abandoned'));
      const reconciled = run({ reconcile: true });
      assert.deepEqual(reconciled.ledger.operations, retried.ledger.operations);
      assert.deepEqual(reconciled.writes, []);
      const updated = run({ mutation: { vaultRelativePath: 'Notes/Invented garden.md',
        expectedContent: content, nextContent: `${content}\nAn invented follow-up.`, operationId: 'test-followup-001' } });
      assert.equal(updated.result?.status, 'committed', JSON.stringify(updated));
      assert.equal(updated.notes[0].content, `${content}\nAn invented follow-up.`);
      for (const record of noteRecords) assert.deepEqual(ledger.verify().operations[record.operation.operationId], record);
    }
  }
});

for (const fault of ['race_before_dispatch', 'race_create', 'race_identical_create']) {
  test(`create-only rejects a note appearing between plan and write: ${fault}`, (t) => {
    const run = fixture(t);
    const before = run({ capture: base });
    const capture = { ...base, kind: 'note', title: 'Invented garden', createOnly: true, opId: 'test-create-only-001' };
    const rejected = run({ capture, fault });
    assert.equal(rejected.faultTriggered, true);
    assert.equal(rejected.result?.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.result.result.note.receipt.reason, 'note_exists');
    assert.equal(rejected.journal, before.journal);
    assert.deepEqual(rejected.writes, []);
    const original = Object.values(rejected.ledger.operations).find(record => record.operation.vaultRelativePath === 'Notes/Invented garden.md');
    assert.equal(rejected.notes[0].content, fault === 'race_identical_create' ? original.operation.content : 'An invented competing note.');
    assert.equal(original.status, 'abandoned');
    const retried = run({ capture });
    assert.equal(retried.result.result.note.receipt.reason, 'note_exists');
    assert.deepEqual(retried.notes, rejected.notes);
    assert.equal(retried.journal, before.journal);
    assert.deepEqual(retried.writes, []);
    const reconciled = run({ reconcile: true });
    assert.equal(reconciled.recovery.processed, 0);
    assert.deepEqual(reconciled.ledger.operations, rejected.ledger.operations);
    assert.deepEqual(reconciled.writes, []);
    const updated = run({ capture: { ...capture, createOnly: false, opId: 'test-followup-001', text: 'An invented follow-up.' } });
    assert.equal(updated.result?.ok, true, JSON.stringify(updated));
    assert.match(updated.notes[0].content, /An invented follow-up\./);
    const ledger = createVaultMutationLedger({ filePath: path.join(run.root, 'ledger.json') });
    assert.deepEqual(ledger.verify().operations[original.operation.operationId], original);
    const replayAfterUpdate = run({ capture });
    assert.equal(replayAfterUpdate.result.result.note.receipt.reason, 'note_exists');
    assert.deepEqual(replayAfterUpdate.notes, updated.notes);
    assert.equal(replayAfterUpdate.journal, updated.journal);
    assert.deepEqual(replayAfterUpdate.writes, []);
  });
}

test('an offline create-only collision is settled and cannot block a later update', (t) => {
  const run = fixture(t);
  const before = run({ capture: base });
  fs.mkdirSync(path.join(run.root, 'vault/Notes'));
  fs.writeFileSync(path.join(run.root, 'vault/Notes/Invented garden.md'), 'An invented existing note.');
  const capture = { ...base, kind: 'note', title: 'Invented garden', createOnly: true, opId: 'test-offline-create-001' };
  const rejected = run({ capture, fault: 'offline_stopped' });
  assert.equal(rejected.result.result.note.receipt.reason, 'note_exists');
  assert.equal(rejected.notes[0].content, 'An invented existing note.');
  assert.equal(rejected.journal, before.journal);
  assert.deepEqual(rejected.writes, []);
  const original = Object.values(rejected.ledger.operations).find(record => record.operation.vaultRelativePath === 'Notes/Invented garden.md');
  assert.equal(original.status, 'abandoned');
  const retried = run({ capture, fault: 'offline_stopped' });
  assert.equal(retried.result.result.note.receipt.reason, 'note_exists');
  assert.deepEqual(retried.notes, rejected.notes);
  assert.equal(retried.journal, before.journal);
  assert.deepEqual(retried.writes, []);
  const reconciled = run({ reconcile: true });
  assert.equal(reconciled.recovery.processed, 0);
  assert.deepEqual(reconciled.ledger.operations, rejected.ledger.operations);
  assert.deepEqual(reconciled.writes, []);
  const updated = run({ capture: { ...capture, createOnly: false, opId: 'test-followup-001', text: 'An invented follow-up.' } });
  assert.equal(updated.result?.ok, true, JSON.stringify(updated));
  assert.match(updated.notes[0].content, /An invented follow-up\./);
  const ledger = createVaultMutationLedger({ filePath: path.join(run.root, 'ledger.json') });
  assert.deepEqual(ledger.verify().operations[original.operation.operationId], original);
});

test('create-only recovers an interrupted original create without rewriting the note', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented garden', createOnly: true };
  const interrupted = run({ capture, fault: 'after_note' });
  assert.equal(interrupted.result.ok, false);
  const recovered = run({ capture });
  assert.equal(recovered.result.ok, true, JSON.stringify(recovered));
  assert.deepEqual(recovered.notes, interrupted.notes);
  assert.equal(recovered.writes.some(name => name.startsWith('Notes/')), false);
  assert.equal(recovered.journal.split('[[Invented garden]]').length - 1, 1);
});

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
  const knowledge = added.result.result.note.knowledge;
  for (const file of [knowledge.queuePath, knowledge.memoryWikiQueuePath]) {
    assert.match(JSON.parse(fs.readFileSync(file, 'utf8')).entries['Notes/Invented garden.md'].summary, /Another invented garden detail/);
  }
  const repeated = run({ capture });
  assert.equal(repeated.result.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.result.message, first.result.message);
  assert.deepEqual(repeated.notes, added.notes);
  assert.equal(repeated.journal, added.journal);
  assert.deepEqual(repeated.writes, []);
  assert.equal(repeated.result.result.note.receipt.replay, true);
  const refreshed = repeated.result.result.note.knowledge;
  assert.equal(refreshed?.optimized, true);
  for (const file of [refreshed.queuePath, refreshed.memoryWikiQueuePath]) {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')).entries['Notes/Invented garden.md'];
    assert.match(entry.summary, /An invented tidal garden/);
    assert.match(entry.summary, /Another invented garden detail/);
  }
});

test('an acknowledged note whose indexing threw is indexed from current bytes on replay', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented garden' };
  const knowledgeDir = path.join(run.root, 'knowledge');
  fs.writeFileSync(knowledgeDir, 'An invented indexing obstruction.');
  const interrupted = run({ capture });
  assert.match(interrupted.error, /EEXIST|ENOTDIR/);
  const note = Object.values(interrupted.ledger.operations).find(({ operation }) => operation.vaultRelativePath.startsWith('Notes/'));
  assert.equal(note.status, 'acknowledged');
  fs.unlinkSync(knowledgeDir);
  const file = path.join(run.root, 'vault/Notes/Invented garden.md');
  const current = fs.readFileSync(file, 'utf8').replace(/^---\n/, '---\naliases: ["Invented current alias"]\n')
    + '\nAn invented later orchard detail.\n';
  fs.writeFileSync(file, current);
  const recovered = run({ capture });
  assert.equal(recovered.result.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.result.result.note.receipt.replay, true);
  assert.equal(recovered.notes[0].content, current);
  assert.equal(recovered.writes.some((name) => name.startsWith('Notes/')), false);
  const knowledge = recovered.result.result.note.knowledge;
  assert.equal(knowledge?.optimized, true);
  for (const queue of [knowledge.queuePath, knowledge.memoryWikiQueuePath]) {
    const entry = JSON.parse(fs.readFileSync(queue, 'utf8')).entries['Notes/Invented garden.md'];
    assert.match(entry.summary, /An invented later orchard detail/);
    assert.ok(entry.aliases.includes('Invented current alias'));
  }
});

test('an offline capture replay indexes current local bytes while remaining pending', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented garden' };
  const first = run({ capture, fault: 'offline_stopped' });
  assert.equal(first.result.result.note.receipt.status, 'saved_locally_sync_pending');
  const file = path.join(run.root, 'vault/Notes/Invented garden.md');
  const current = fs.readFileSync(file, 'utf8') + '\nAn invented later orchard detail.\n';
  fs.writeFileSync(file, current);
  const repeated = run({ capture, fault: 'offline_stopped' });
  assert.equal(repeated.result.result.note.receipt.status, 'saved_locally_sync_pending');
  assert.equal(repeated.notes[0].content, current);
  assert.deepEqual(repeated.writes, []);
  assert.equal(repeated.result.result.note.receipt.replay, true);
  const knowledge = repeated.result.result.note.knowledge;
  assert.equal(knowledge?.optimized, true);
  for (const queue of [knowledge.queuePath, knowledge.memoryWikiQueuePath]) {
    assert.match(JSON.parse(fs.readFileSync(queue, 'utf8')).entries['Notes/Invented garden.md'].summary,
      /An invented later orchard detail/);
  }
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

test('a replayed note swapped for a link outside the vault is never read or indexed', (t) => {
  const run = fixture(t);
  const capture = { ...base, kind: 'note', title: 'Invented garden' };
  const first = run({ capture });
  assert.equal(first.result.ok, true);
  const notePath = first.result.result.note.path;
  const outside = path.join(run.root, 'outside-private.md');
  fs.writeFileSync(outside, '# Outside\n\nAN-INVENTED-PRIVATE-MARKER that must never be indexed.\n');
  fs.rmSync(notePath);
  fs.symlinkSync(outside, notePath);
  const repeated = run({ capture });
  // Either the writer refuses the escaped target outright, or the replay skips indexing.
  if (repeated.result) assert.equal(repeated.result.result.note.knowledge, null);
  else assert.match(repeated.error, /symlink/);
  const knowledgeDir = path.join(run.root, 'knowledge');
  const indexed = fs.existsSync(knowledgeDir)
    ? fs.readdirSync(knowledgeDir, { recursive: true }).map((name) => path.join(knowledgeDir, String(name))).filter((file) => fs.statSync(file).isFile()).map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    : '';
  assert.doesNotMatch(indexed, /AN-INVENTED-PRIVATE-MARKER/);
});

test('replay indexing reads a note only when every segment from the vault root is real and inside the vault', () => {
  const { readContainedNote } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'contained-note-'));
  try {
    const vault = path.join(base, 'vault');
    const notes = path.join(vault, 'Notes');
    const outsideDir = path.join(base, 'outside');
    fs.mkdirSync(notes, { recursive: true });
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(notes, 'plain.md'), 'An invented plain note.');
    fs.writeFileSync(path.join(outsideDir, 'plain.md'), 'AN-INVENTED-PRIVATE-MARKER');
    fs.symlinkSync(path.join(outsideDir, 'plain.md'), path.join(notes, 'link.md'));
    assert.equal(readContainedNote(path.join(notes, 'plain.md'), vault), 'An invented plain note.');
    assert.equal(readContainedNote(path.join(notes, 'link.md'), vault), null);
    assert.equal(readContainedNote(path.join(outsideDir, 'plain.md'), vault), null);
    assert.equal(readContainedNote(path.join(notes, 'plain.md'), undefined), null);
    // The notes folder itself replaced by a link to an outside folder.
    fs.renameSync(notes, path.join(base, 'Notes-moved'));
    fs.symlinkSync(outsideDir, notes);
    assert.equal(readContainedNote(path.join(notes, 'plain.md'), vault), null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
