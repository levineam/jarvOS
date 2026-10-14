'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeJournalNotes,
} = require('../bridge/provenance/src/notes-section-normalizer');

test('normalizer refuses to replace journal prose with a link when note persistence failed', () => {
  const journalContent = '## 📝 Notes\n- A durable thought\n\n## 💡 Ideas\n- keep me\n';
  assert.throws(() => normalizeJournalNotes({
    journalContent,
    date: '2026-08-06',
    noteExists: () => false,
    writeNote: () => ({ created: true, written: false, savedLocally: false, receipt: { status: 'unavailable' } }),
  }), /not persisted/);
});

test('normalizer accepts a locally durable pending note and preserves other journal sections', () => {
  const journalContent = '## 📝 Notes\n- A durable thought\n\n## 💡 Ideas\n- keep me\n';
  const result = normalizeJournalNotes({
    journalContent,
    date: '2026-08-06',
    noteExists: () => false,
    writeNote: () => ({ created: true, written: false, savedLocally: true, path: '/vault/Notes/A durable thought.md', receipt: { status: 'saved_locally_sync_pending' } }),
  });
  assert.match(result.normalizedContent, /## 📝 Notes\n- \[\[A durable thought\]\]/);
  assert.match(result.normalizedContent, /## 💡 Ideas\n- keep me/);
});

test('normalizer production source has no direct Markdown overwrite', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../bridge/provenance/src/notes-section-normalizer.js'), 'utf8');
  assert.doesNotMatch(source, /writeFileSync\s*\(\s*journalPath/);
});
