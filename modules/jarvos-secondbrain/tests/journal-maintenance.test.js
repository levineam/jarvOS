const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  classifyJournalHealth,
  loadConfig,
  normalizeSections,
  renderJournal,
  syncOneDate,
} = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

const TEST_DATE = '2026-01-02';

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `${escaped}\\n([\\s\\S]*?)(?=\\n## |\\n— Edited by Jarvis|$)`;
  const match = markdown.match(new RegExp(pattern));
  return match ? match[1].trim() : '';
}

test('normalizeSections folds legacy Notes Created into canonical Notes', () => {
  const original = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🎯 Current Focus',
    '-',
    '',
    "## 📅 Today's Calendar",
    '- existing calendar line',
    '',
    '## 📝 Notes',
    '- [[Existing Note]]',
    '',
    '## 💡 Ideas',
    '-',
    '',
    '## 📓 Journal Entry',
    '-',
    '',
    '## 🗂️ Notes Created',
    '- [[Created During Legacy Drift]]',
    '- No notes created on 2026-01-02',
    '',
    '— Edited by Jarvis',
    '',
  ].join('\n');

  const config = loadConfig();
  const normalized = normalizeSections(original, TEST_DATE, config);
  const rendered = renderJournal(TEST_DATE, config, normalized);
  const notes = sectionBody(rendered, '## 📝 Notes');

  assert.doesNotMatch(rendered, /## 🎯 Current Focus/);
  assert.match(notes, /\[\[Existing Note\]\]/);
  assert.match(notes, /\[\[Created During Legacy Drift\]\]/);
  assert.doesNotMatch(notes, /No notes created/);
  assert.doesNotMatch(rendered, /## 🗂️ Notes Created/);
});

test('normalizeSections moves legacy idea salience out of Notes and drops non-note salience', () => {
  const original = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🎯 Current Focus',
    '-',
    '',
    "## 📅 Today's Calendar",
    '-',
    '',
    '## 📝 Notes',
    '- [[Canonical Note]]',
    '- 📌 *(idea, 70%)* I think you should help me resolve this in real time',
    '- 📌 *(preference, 70%)* I want status updates in a separate lane',
    '',
    '## 💡 Ideas',
    '-',
    '',
    '## 📓 Journal Entry',
    '-',
    '',
    '— Edited by Jarvis',
    '',
  ].join('\n');

  const config = loadConfig();
  const normalized = normalizeSections(original, TEST_DATE, config);
  const rendered = renderJournal(TEST_DATE, config, normalized);
  const notes = sectionBody(rendered, '## 📝 Notes');
  const ideas = sectionBody(rendered, '## 💡 Ideas');

  assert.doesNotMatch(rendered, /## 🎯 Current Focus/);
  assert.match(notes, /\[\[Canonical Note\]\]/);
  assert.doesNotMatch(notes, /📌/);
  assert.doesNotMatch(notes, /status updates in a separate lane/);
  assert.match(ideas, /- I think you should help me resolve this in real time/);
});

test('classifyJournalHealth distinguishes frontmatter-only stubs from healthy journals', () => {
  const stub = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
  ].join('\n');
  const healthy = renderJournal(TEST_DATE, loadConfig(), normalizeSections('', TEST_DATE, loadConfig()));

  assert.equal(classifyJournalHealth({ existed: false, markdown: '', knownGood: null }).status, 'missing');
  assert.equal(classifyJournalHealth({ existed: true, markdown: stub, knownGood: null }).status, 'stub');
  assert.equal(classifyJournalHealth({ existed: true, markdown: healthy, knownGood: null }).status, 'healthy');
});

test('classifyJournalHealth flags a shrink against known-good journal state as stale', () => {
  const config = loadConfig();
  const populated = renderJournal(TEST_DATE, config, normalizeSections([
    '## 📝 Notes',
    '- [[Kept note]]',
    '',
    '## 📓 Journal Entry',
    'A real entry that should not disappear silently.',
  ].join('\n'), TEST_DATE, config));
  const shrunken = renderJournal(TEST_DATE, config, normalizeSections([
    '## 📝 Notes',
    '- [[Kept note]]',
  ].join('\n'), TEST_DATE, config));
  const knownGood = {
    size: Buffer.byteLength(populated, 'utf8'),
    hash: 'known-good-hash',
    sectionCount: 7,
  };

  assert.equal(classifyJournalHealth({ existed: true, markdown: shrunken, knownGood }).status, 'stale');
});

test('syncOneDate restores a frontmatter-only stub from known-good content and writes an audit backup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-stub-'));
  const journalDir = path.join(tmp, 'Vault', 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });

  const previousJournalDir = process.env.JARVOS_JOURNAL_DIR;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  try {
    const config = loadConfig();
    const initial = syncOneDate(TEST_DATE, config, { dryRun: false });
    assert.equal(initial.healthBefore.status, 'missing');
    assert.equal(initial.healthAfter.status, 'healthy');

    const journalPath = path.join(journalDir, `${TEST_DATE}.md`);
    const populated = fs.readFileSync(journalPath, 'utf8');
    assert.match(populated, /## 📝 Notes/);

    fs.writeFileSync(
      journalPath,
      [
        '---',
        'journal: Journal',
        `journal-date: ${TEST_DATE}`,
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    const repaired = syncOneDate(TEST_DATE, config, { dryRun: false });
    const repairedBody = fs.readFileSync(journalPath, 'utf8');

    assert.equal(repaired.healthBefore.status, 'stub');
    assert.equal(repaired.restoredKnownGood, true);
    assert.equal(repaired.healthAfter.status, 'healthy');
    assert.match(repairedBody, /## 📝 Notes/);
    assert.ok(repaired.backupPath);
    assert.equal(fs.existsSync(repaired.backupPath), true);
    assert.match(fs.readFileSync(repaired.backupPath, 'utf8'), /journal-date: 2026-01-02/);
  } finally {
    if (previousJournalDir === undefined) delete process.env.JARVOS_JOURNAL_DIR;
    else process.env.JARVOS_JOURNAL_DIR = previousJournalDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
