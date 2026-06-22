const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyStoragePlan,
  buildThreePackagePlan,
} = require('../bridge/routing/src/three-package-router');

function noteCapture() {
  return { trigger: 'note', text: 'Package naming decision rationale', title: 'Package naming decision' };
}

function recordingAdapter(writeNoteResult) {
  const calls = { appended: [] };
  return {
    calls,
    writeNote() { return writeNoteResult; },
    appendLineToJournalSection({ heading, line, date }) {
      calls.appended.push({ heading, line, date });
      return { journalPath: '/tmp/journal.md', heading, line, alreadyPresent: false };
    },
    ensureJournal() { return { ok: true }; },
  };
}

test('applyStoragePlan FAILS CLOSED: no journal wiki-link when the note write failed', () => {
  const plan = buildThreePackagePlan(noteCapture());
  assert.equal(plan.createNote, true);

  // writeNote reports an explicit failure — must NOT leave a dangling [[link]].
  const adapter = recordingAdapter({ written: false, error: 'misrouted write', title: 'Package naming decision' });
  const result = applyStoragePlan(plan, noteCapture(), { adapter });

  assert.equal(adapter.calls.appended.length, 0, 'must not append a dangling wiki-link');
  assert.equal(result.journalEntry, null);
  assert.equal(result.noteLink, null);
  assert.ok(result.noteLinkSkipped, 'records why the link was skipped');
  assert.equal(result.noteLinkSkipped.reason, 'note_not_written');
});

test('applyStoragePlan writes the journal wiki-link when the note write succeeded', () => {
  const plan = buildThreePackagePlan(noteCapture());
  const adapter = recordingAdapter({ written: true, path: '/tmp/Package naming decision.md', title: 'Package naming decision' });
  const result = applyStoragePlan(plan, noteCapture(), { adapter });

  assert.equal(adapter.calls.appended.length, 1, 'links the note once the write succeeded');
  assert.equal(adapter.calls.appended[0].line, '- [[Package naming decision]]');
  assert.ok(result.journalEntry);
  assert.ok(!result.noteLinkSkipped);
});

test('applyStoragePlan still writes non-note journal lines (idea/flagged) unconditionally', () => {
  const plan = {
    date: undefined,
    ignored: false,
    createNote: false,
    journalSection: '## 💡 Ideas',
    journalLine: '- a plain captured idea',
  };
  const adapter = recordingAdapter(null);
  const result = applyStoragePlan(plan, {}, { adapter });

  assert.equal(adapter.calls.appended.length, 1);
  assert.equal(adapter.calls.appended[0].line, '- a plain captured idea');
  assert.ok(result.journalEntry);
  assert.ok(!result.noteLinkSkipped);
});
