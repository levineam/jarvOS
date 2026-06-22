const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dispatchCapture,
} = require('../bridge/dispatch/src/capture-dispatcher.js');

function makeMockAdapter() {
  const calls = [];
  return {
    calls,
    adapter: {
      appendLineToJournalSection({ heading, line, date }) {
        calls.push(['appendLineToJournalSection', heading, line, date]);
        return { heading, line, date, alreadyPresent: false };
      },
      writeNote({ title, content, frontmatter }) {
        calls.push(['writeNote', title, content, frontmatter]);
        return { title, content, frontmatter, path: `/tmp/${title}.md` };
      },
      ensureJournal({ date }) {
        calls.push(['ensureJournal', date]);
        return { journalPath: `/tmp/${date}.md`, existed: true };
      },
    },
  };
}

test('dispatcher invokes journal-entry skill for natural-language ideas', () => {
  const mock = makeMockAdapter();
  const result = dispatchCapture(
    {
      text: 'I have an idea: capture chips',
      date: '2026-01-02',
      classification: { salienceClass: 'idea', confidence: 0.7 },
    },
    { adapter: mock.adapter },
  );

  assert.equal(result.captured, true);
  assert.equal(result.skillId, 'journal-entry');
  assert.equal(result.trigger, 'idea');
  assert.deepEqual(result.destinations, ['journal']);
  assert.deepEqual(mock.calls[0], [
    'appendLineToJournalSection',
    '## 💡 Ideas',
    '- capture chips',
    '2026-01-02',
  ]);
});

test('dispatcher creates notes for substantive natural-language ideas', () => {
  const mock = makeMockAdapter();
  const result = dispatchCapture(
    {
      title: 'Routing dispatch skills',
      text: 'I have an idea about routing dispatch invoking capture skills because every agent should call one jarvOS entrypoint.',
      date: '2026-01-02',
      classification: { salienceClass: 'idea', confidence: 0.7 },
    },
    { adapter: mock.adapter },
  );

  assert.equal(result.captured, true);
  assert.equal(result.skillId, 'note-creation');
  assert.equal(result.trigger, 'idea');
  assert.deepEqual(result.destinations, ['journal', 'notes']);
  assert.equal(mock.calls[0][0], 'writeNote');
  assert.equal(mock.calls[0][1], 'Routing dispatch skills');
  assert.deepEqual(mock.calls[1], [
    'appendLineToJournalSection',
    '## 💡 Ideas',
    '- [[Routing dispatch skills]] — routing dispatch invoking capture skills because every agent should call one jarvOS entrypoint.',
    '2026-01-02',
  ]);
});

test('dispatcher invokes note-creation skill for natural-language note requests', () => {
  const mock = makeMockAdapter();
  const result = dispatchCapture(
    {
      text: 'Make a note about routing dispatch invoking capture skills',
      date: '2026-01-02',
      classification: { salienceClass: 'nothing', confidence: 0.6 },
    },
    { adapter: mock.adapter },
  );

  assert.equal(result.captured, true);
  assert.equal(result.skillId, 'note-creation');
  assert.equal(result.trigger, 'note');
  assert.equal(result.title, 'routing dispatch invoking capture skills');
  assert.equal(mock.calls[0][0], 'writeNote');
  assert.equal(mock.calls[0][1], 'routing dispatch invoking capture skills');
  assert.deepEqual(mock.calls[1], [
    'appendLineToJournalSection',
    '## 📝 Notes',
    '- [[routing dispatch invoking capture skills]]',
    '2026-01-02',
  ]);
});

test('dispatcher invokes flagged-review skill for medium-confidence salience', () => {
  const mock = makeMockAdapter();
  const result = dispatchCapture(
    {
      text: 'I like using TypeScript for new projects.',
      date: '2026-01-02',
      classification: { salienceClass: 'preference', confidence: 0.7 },
    },
    { adapter: mock.adapter },
  );

  assert.equal(result.captured, true);
  assert.equal(result.skillId, 'flagged-review');
  assert.equal(result.path, 'salience_medium_flagged');
  assert.deepEqual(result.destinations, ['journal']);
  assert.deepEqual(mock.calls[0], [
    'appendLineToJournalSection',
    '## 📌 Flagged',
    '- (preference, 70%) I like using TypeScript for new projects.',
    '2026-01-02',
  ]);
});
