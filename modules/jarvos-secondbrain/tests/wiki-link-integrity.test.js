const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  findDanglingLinks,
  linkSectionContent,
  listNoteTitles,
  auditVault,
} = require('../bridge/provenance/src/wiki-link-integrity');

const JOURNAL = [
  '## 📝 Notes',
  '- [[Real Note]]',
  '- [[Phantom Note]]',
  '',
  '## 💡 Ideas',
  '- a thought that mentions [[Not A Real Note]] in prose',
].join('\n');

test('findDanglingLinks flags only link-section targets with no backing note', () => {
  const dangling = findDanglingLinks(JOURNAL, new Set(['Real Note']));
  assert.deepEqual(dangling, ['Phantom Note']);
});

test('linkSectionContent ignores links outside the note/decision sections', () => {
  const scoped = linkSectionContent(JOURNAL);
  assert.ok(scoped.includes('[[Real Note]]'));
  assert.ok(!scoped.includes('Not A Real Note'), 'Ideas-section prose links are not audited');
});

test('findDanglingLinks de-dupes and handles alias/heading syntax', () => {
  const md = '## 📝 Notes\n- [[A|alias]]\n- [[A]]\n- [[B#section]]';
  assert.deepEqual(findDanglingLinks(md, new Set(['A'])), ['B']);
});

test('auditVault reports dangling links across the vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-vault-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'Real Note.md'), '# Real Note');
  fs.writeFileSync(path.join(journalDir, '2026-05-20.md'), JOURNAL);

  assert.equal(listNoteTitles(notesDir).has('Real Note'), true);

  const report = auditVault({ notesDir, journalDir });
  assert.equal(report.ok, false);
  assert.equal(report.journalsChecked, 1);
  assert.deepEqual(report.dangling, [{ journal: '2026-05-20.md', links: ['Phantom Note'] }]);
});

test('auditVault is clean when every link resolves', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-vault-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'Real Note.md'), '# Real Note');
  fs.writeFileSync(path.join(journalDir, '2026-05-20.md'), '## 📝 Notes\n- [[Real Note]]');

  const report = auditVault({ notesDir, journalDir });
  assert.equal(report.ok, true);
  assert.deepEqual(report.dangling, []);
});
