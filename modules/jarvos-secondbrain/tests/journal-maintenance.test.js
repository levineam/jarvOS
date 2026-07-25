const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applySectionTransforms,
  classifyJournalHealth,
  isCatastrophicJournalShrink,
  loadConfig,
  normalizeSections,
  renderJournal,
  stripLeadingRecoveryScaffold,
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

test('catastrophic shrink restores blank templates but not meaningful short edits', () => {
  const knownGood = { size: 4000, sectionCount: 6 };
  assert.equal(isCatastrophicJournalShrink(
    { size: 400, sectionCount: 6, meaningfulBodyChars: 0 },
    knownGood,
  ), true);
  assert.equal(isCatastrophicJournalShrink(
    { size: 400, sectionCount: 2, meaningfulBodyChars: 20 },
    knownGood,
  ), false);
});

test('generated blank-template placeholders are recoverable', () => {
  const config = loadConfig();
  const blank = renderJournal(TEST_DATE, config, normalizeSections('', TEST_DATE, config));
  const populated = `${blank}\n${'Prior journal content. '.repeat(150)}`;
  const health = classifyJournalHealth({
    existed: true,
    markdown: blank,
    knownGood: {
      size: Buffer.byteLength(populated, 'utf8'),
      hash: 'known-good-hash',
      sectionCount: 6,
    },
  });

  assert.equal(health.status, 'stale');
  assert.equal(health.metrics.meaningfulBodyChars, 0);
  assert.equal(isCatastrophicJournalShrink(health.metrics, {
    size: Buffer.byteLength(populated, 'utf8'),
    sectionCount: 6,
  }), true);
});

/**
 * Generated sections are current-state, and Projects renders on backfilled
 * dates by design, so closing a project shrinks every past entry.
 * `classifyJournalHealth` reads any shrink as `stale`, and the snapshot refresh
 * used to require `healthy` (or a contract-signature change). Once the
 * signature matched, a shrunken past entry could never refresh its snapshot:
 * every later pass made the same comparison, reported `stale` forever, and left
 * a genuine truncation able to restore the stale snapshot over anything
 * authored since.
 */
test('generated-section churn does not freeze the known-good snapshot', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-churn-'));
  const journalDir = path.join(tmp, 'Vault', 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });

  const PAST_DATE = '2025-12-01';
  const manyProjects = { projects: () => '- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]' };
  const oneProject = { projects: () => '- [[Alpha]]' };

  const previousJournalDir = process.env.JARVOS_JOURNAL_DIR;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  try {
    const config = loadConfig();
    const journalPath = path.join(journalDir, `${PAST_DATE}.md`);

    const first = syncOneDate(PAST_DATE, config, { dryRun: false, fetchers: manyProjects });
    assert.equal(first.healthAfter.status, 'healthy');

    // Author a line -- this is what the snapshot exists to protect.
    const before = fs.readFileSync(journalPath, 'utf8');
    const authored = before.replace('## 💡 Ideas\n-', '## 💡 Ideas\n- an idea I typed myself');
    assert.notEqual(authored, before, 'test fixture must actually author a line');
    fs.writeFileSync(journalPath, authored, 'utf8');
    syncOneDate(PAST_DATE, config, { dryRun: false, fetchers: manyProjects });

    // Two projects close. The entry shrinks -- churn, not damage.
    syncOneDate(PAST_DATE, config, { dryRun: false, fetchers: oneProject });
    assert.match(
      fs.readFileSync(journalPath, 'utf8'),
      /an idea I typed myself/,
      'authored content must survive the churn',
    );

    // The freeze is only visible on the NEXT pass: with a refreshed snapshot the
    // entry reads healthy; with a frozen one it is compared against the larger
    // old snapshot and reports stale in perpetuity.
    const settled = syncOneDate(PAST_DATE, config, { dryRun: false, fetchers: oneProject });
    assert.equal(
      settled.healthBefore.status,
      'healthy',
      'the snapshot must have refreshed after generated-section churn',
    );
  } finally {
    if (previousJournalDir === undefined) delete process.env.JARVOS_JOURNAL_DIR;
    else process.env.JARVOS_JOURNAL_DIR = previousJournalDir;
  }
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

test('syncOneDate restores a deleted journal from known-good content', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-deleted-'));
  const journalDir = path.join(tmp, 'Vault', 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const previousJournalDir = process.env.JARVOS_JOURNAL_DIR;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  try {
    const config = loadConfig();
    syncOneDate(TEST_DATE, config, { dryRun: false });
    const journalPath = path.join(journalDir, `${TEST_DATE}.md`);
    const before = fs.readFileSync(journalPath, 'utf8');
    fs.rmSync(journalPath);

    const repaired = syncOneDate(TEST_DATE, config, { dryRun: false });

    assert.equal(repaired.healthBefore.status, 'missing');
    assert.equal(repaired.restoredKnownGood, true);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), before);
  } finally {
    if (previousJournalDir === undefined) delete process.env.JARVOS_JOURNAL_DIR;
    else process.env.JARVOS_JOURNAL_DIR = previousJournalDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('stripLeadingRecoveryScaffold removes only the incident scaffold', () => {
  const bulletA = '- Created the **AAF Management Module** — first standalone AAF module';
  const bulletB = '- Kicked off the **AAF Cycle Monitor Module** — second standalone module';
  const withScaffold = [
    '**Recovered content**',
    `# ${TEST_DATE}`,
    '',
    bulletA,
    bulletB,
    '### Still legitimate',
  ].join('\n');

  const cleaned = stripLeadingRecoveryScaffold(withScaffold, TEST_DATE);
  assert.doesNotMatch(cleaned, /\*\*Recovered content\*\*/);
  assert.doesNotMatch(cleaned, new RegExp(`^# ${TEST_DATE}$`, 'm'));
  assert.match(cleaned, /AAF Management Module/);
  assert.match(cleaned, /### Still legitimate/);
});

test('applySectionTransforms is opt-in and section-scoped', () => {
  const normalized = {
    frontmatter: '---\njournal: Journal\n---',
    sections: [
      { id: 'notes', heading: '## 📝 Notes', content: '**Recovered content**\n# x\n- keep' },
      { id: 'ideas', heading: '## 💡 Ideas', content: '- idea stays' },
    ],
  };
  assert.equal(applySectionTransforms(normalized, null), normalized);
  const transformed = applySectionTransforms(normalized, [
    {
      sectionId: 'notes',
      transform: (content) => content.replace('**Recovered content**\n# x\n', ''),
    },
  ], { date: TEST_DATE });
  assert.equal(transformed.sections[0].content, '- keep');
  assert.equal(transformed.sections[1].content, '- idea stays');
});

test('syncOneDate sectionTransforms strip recovery scaffold via maintenance write path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-scaffold-'));
  const journalDir = path.join(tmp, 'Vault', 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const previousJournalDir = process.env.JARVOS_JOURNAL_DIR;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  try {
    const config = loadConfig();
    const bulletA = '- Created the **AAF Management Module** — first standalone AAF module';
    const bulletB = '- Kicked off the **AAF Cycle Monitor Module** — second standalone module';
    const original = renderJournal(TEST_DATE, config, normalizeSections([
      '## 📝 Notes',
      '**Recovered content**',
      `# ${TEST_DATE}`,
      bulletA,
      bulletB,
      '### Keep this heading',
    ].join('\n'), TEST_DATE, config, {
      fetchers: { calendar: () => '-', reminders: () => '-', paperclip: () => '-' },
    }));
    const journalPath = path.join(journalDir, `${TEST_DATE}.md`);
    fs.writeFileSync(journalPath, original, 'utf8');

    const result = syncOneDate(TEST_DATE, config, {
      dryRun: false,
      fetchers: { calendar: () => '-', reminders: () => '-', paperclip: () => '-' },
      sectionTransforms: [
        {
          sectionId: 'notes',
          transform: (content, ctx) => stripLeadingRecoveryScaffold(content, ctx.date),
        },
      ],
    });
    const notes = sectionBody(fs.readFileSync(journalPath, 'utf8'), '## 📝 Notes');

    assert.equal(result.written, true);
    assert.ok(result.backupPath);
    assert.match(fs.readFileSync(result.backupPath, 'utf8'), /\*\*Recovered content\*\*/);
    assert.doesNotMatch(notes, /\*\*Recovered content\*\*/);
    assert.match(notes, /AAF Management Module/);
    assert.match(notes, /### Keep this heading/);
    assert.equal(result.healthAfter.status, 'healthy');
  } finally {
    if (previousJournalDir === undefined) delete process.env.JARVOS_JOURNAL_DIR;
    else process.env.JARVOS_JOURNAL_DIR = previousJournalDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
