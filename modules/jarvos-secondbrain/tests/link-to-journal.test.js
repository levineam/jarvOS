const test = require('node:test');
const assert = require('node:assert/strict');

const { linkNoteInSection, normalizeSectionName } = require('../bridge/provenance/src/link-to-journal.js');

test('linkNoteInSection adds durable note link under canonical Notes section and is idempotent', () => {
  const original = [
    '---',
    'journal: Journal',
    'journal-date: 2026-05-14',
    '---',
    '',
    '## 📝 Notes',
    '-',
    '',
    '## 💡 Ideas',
    '-',
    '',
  ].join('\n');

  const first = linkNoteInSection(original, 'Child Education - Daily Capsule - 2026-05-14');
  const second = linkNoteInSection(first.content, 'Child Education - Daily Capsule - 2026-05-14');

  assert.equal(first.alreadyPresent, false);
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.content, first.content);
  assert.match(first.content, /## 📝 Notes\n- \[\[Child Education - Daily Capsule - 2026-05-14\]\]/);
  assert.doesNotMatch(first.content, /## 📝 Notes\n-\n/);
});

test('linkNoteInSection canonicalizes deprecated Notes Created section requests', () => {
  const original = [
    '## 📝 Notes',
    '-',
    '',
    '## 🗂️ Notes Created',
    '- [[Old Note]]',
    '',
  ].join('\n');

  const { content } = linkNoteInSection(original, 'Updated Durable Note', '🗂️ Notes Created');

  assert.equal(normalizeSectionName('🗂️ Notes Created'), '📝 Notes');
  assert.match(content, /## 📝 Notes\n- \[\[Updated Durable Note\]\]/);
  assert.doesNotMatch(content, /## 🗂️ Notes Created\n- \[\[Updated Durable Note\]\]/);
});

test('linkNoteInSection keeps exactly one bullet link when duplicates exist', () => {
  const original = [
    '## 📝 Notes',
    '- [[Duplicate Note]]',
    '- [[Duplicate Note]]',
    '',
    '## 🗂️ Notes Created',
    '- [[Duplicate Note]]',
    '',
  ].join('\n');

  const { content, alreadyPresent } = linkNoteInSection(original, 'Duplicate Note');
  const matches = content.match(/- \[\[Duplicate Note\]\]/g) || [];

  assert.equal(alreadyPresent, true);
  assert.equal(matches.length, 1);
  assert.match(content, /## 📝 Notes\n- \[\[Duplicate Note\]\]/);
});

test('linkNoteInSection creates canonical Notes section and removes duplicate legacy bullet', () => {
  const original = [
    '## 🗂️ Notes Created',
    '- [[Legacy Duplicate]]',
    '',
  ].join('\n');

  const { content } = linkNoteInSection(original, 'Legacy Duplicate');
  const matches = content.match(/- \[\[Legacy Duplicate\]\]/g) || [];

  assert.equal(matches.length, 1);
  assert.match(content, /## 📝 Notes\n- \[\[Legacy Duplicate\]\]/);
  assert.doesNotMatch(content, /## 🗂️ Notes Created\n- \[\[Legacy Duplicate\]\]/);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { linkNoteToJournal } = require('../bridge/provenance/src/link-to-journal.js');

test('linkNoteToJournal creates a missing journal from the configured template and links the note once', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-link-to-journal-'));
  const journalPath = path.join(tmpDir, '2030-02-03.md');

  try {
    const first = linkNoteToJournal({ noteTitle: 'Fresh Durable Note', journalPath });
    const second = linkNoteToJournal({ noteTitle: 'Fresh Durable Note', journalPath });
    const content = fs.readFileSync(journalPath, 'utf8');
    const matches = content.match(/- \[\[Fresh Durable Note\]\]/g) || [];

    assert.equal(first.alreadyPresent, false);
    assert.equal(second.alreadyPresent, true);
    assert.equal(matches.length, 1);
    assert.match(content, /journal-date: 2030-02-03/);
    assert.match(content, /## 📝 Notes\n- \[\[Fresh Durable Note\]\]/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
