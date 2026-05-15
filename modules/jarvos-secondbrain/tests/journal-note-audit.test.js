const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  NOTES_HEADING,
  NOTES_CREATED_HEADING,
  extractTrackedSection,
  findMissingLinks,
  injectNoteLinks,
} = require('../bridge/provenance/src/journal-note-audit.js');

function withFreshAuditModule(env, fn) {
  const keys = ['JARVOS_NOTES_DIR', 'JARVOS_JOURNAL_DIR', 'VAULT_NOTES_DIR', 'JOURNAL_DIR'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const pathsModule = require('../bridge/config/jarvos-paths.js');
  const auditPath = require.resolve('../bridge/provenance/src/journal-note-audit.js');

  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  pathsModule.resetConfigCache();
  delete require.cache[auditPath];

  try {
    return fn(require('../bridge/provenance/src/journal-note-audit.js'));
  } finally {
    delete require.cache[auditPath];
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    pathsModule.resetConfigCache();
  }
}

test('journal-note-audit prefers canonical Notes section over deprecated Notes Created', () => {
  const journal = [
    '## 📝 Notes',
    '- [[Canonical Note]]',
    '',
    '## 🗂️ Notes Created',
    '- [[Legacy Note]]',
    '',
  ].join('\n');

  const parsed = extractTrackedSection(journal);

  assert.equal(parsed.heading, NOTES_HEADING);
  assert.match(parsed.sectionContent, /\[\[Canonical Note\]\]/);
  assert.doesNotMatch(parsed.sectionContent, /\[\[Legacy Note\]\]/);
});

test('journal-note-audit can disable legacy Notes Created fallback for post-migration dates', () => {
  const journal = [
    '## 🗂️ Notes Created',
    '- [[Legacy Only]]',
    '',
  ].join('\n');

  assert.equal(extractTrackedSection(journal, { allowLegacy: true }).heading, NOTES_CREATED_HEADING);
  assert.equal(extractTrackedSection(journal, { allowLegacy: false }).found, false);
});

test('injectNoteLinks patches canonical Notes section instead of deprecated section', () => {
  const journal = [
    '## 📝 Notes',
    '-',
    '',
    '## 🗂️ Notes Created',
    '- [[Old Note]]',
    '',
  ].join('\n');
  const updated = injectNoteLinks(journal, [{ title: 'Updated Note' }]);

  assert.match(updated, /## 📝 Notes\n- \[\[Updated Note\]\]/);
  assert.doesNotMatch(updated, /## 🗂️ Notes Created\n- \[\[Updated Note\]\]/);
});

test('findMissingLinks checks only the tracked journal section', () => {
  const notes = [{ title: 'Side Mention' }];
  const journal = [
    '## 📝 Notes',
    '-',
    '',
    '## 💡 Ideas',
    '- [[Side Mention]]',
    '',
  ].join('\n');

  assert.deepEqual(findMissingLinks(notes, journal).map((note) => note.title), ['Side Mention']);
});

test('findMissingLinks accepts basename links only when note basename is unique', () => {
  const notes = [{ title: 'Projects/Brief' }];
  const allUnique = [{ title: 'Projects/Brief' }];
  const allDuplicate = [{ title: 'Projects/Brief' }, { title: 'Archive/Brief' }];
  const journal = [
    '## 📝 Notes',
    '- [[Brief]]',
    '',
  ].join('\n');

  assert.deepEqual(findMissingLinks(notes, journal, allUnique), []);
  assert.deepEqual(findMissingLinks(notes, journal, allDuplicate).map((note) => note.title), ['Projects/Brief']);
  assert.equal(path.posix.basename(notes[0].title), 'Brief');
});

test('findNotesForDate includes notes updated on the audited date', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-note-audit-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  const notePath = path.join(notesDir, 'Updated Note.md');
  fs.writeFileSync(notePath, 'updated content\n', 'utf8');
  const updatedAt = new Date('2026-01-02T16:00:00Z');
  fs.utimesSync(notePath, updatedAt, updatedAt);

  try {
    withFreshAuditModule(
      { JARVOS_NOTES_DIR: notesDir, JARVOS_JOURNAL_DIR: journalDir, JARVOS_TIMEZONE: 'UTC' },
      (audit) => {
        assert.deepEqual(audit.findNotesForDate('2026-01-02').map((note) => note.title), ['Updated Note']);
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
