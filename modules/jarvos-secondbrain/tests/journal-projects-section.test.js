const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyJournalHealth,
  contractSignature,
  structureMatchesContract,
  loadConfig,
  normalizeSections,
  renderJournal,
} = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

const TEST_DATE = '2026-01-02';

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `${escaped}\\n([\\s\\S]*?)(?=\\n## |\\n— Edited by Jarvis|$)`;
  const match = markdown.match(new RegExp(pattern));
  return match ? match[1].trim() : '';
}

/** A journal entry in the old shape, with real content in the removed sections. */
function legacyEntry() {
  return [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    "## 📅 Today's Calendar",
    '- 9:00 AM Standup',
    '',
    '## 📝 Notes',
    '- [[Existing Note]]',
    '',
    '## 💡 Ideas',
    '- an idea worth keeping',
    '',
    '## 📓 Journal Entry',
    'Today I did things.',
    '',
    '## 🔔 Apple Reminders',
    '- Schedule teeth cleaning — 10:00 AM',
    '',
    '## 📎 Paperclip Inbox',
    '- (Paperclip API unavailable)',
    '',
  ].join('\n');
}

const stubFetchers = { projects: () => '- [[Alpha]]\n- [[Beta]]' };

function render(original, { fetchers = stubFetchers, date = TEST_DATE } = {}) {
  const config = loadConfig();
  const normalized = normalizeSections(original, date, config, { fetchers });
  return renderJournal(date, config, normalized);
}

test('the shipped contract is the simplified journal: Projects, Notes, Ideas, Journal Entry', () => {
  const config = loadConfig();
  assert.deepEqual(
    config.sections.required.map((section) => section.id),
    ['projects', 'notes', 'ideas', 'journal-entry'],
  );
  assert.deepEqual(config.sections.optional, []);
});

test('the removed sections are declared as dropped, not migrated', () => {
  const legacy = loadConfig().migration.legacySections;
  for (const id of ['todays-calendar', 'apple-reminders', 'paperclip-inbox']) {
    assert.equal(legacy[id].action, 'drop', `${id} should be dropped`);
    assert.equal(legacy[id].migrateContentTo, undefined, `${id} must not migrate content`);
  }
});

test('Calendar, Reminders, and Paperclip Inbox are gone from a maintained entry', () => {
  const output = render(legacyEntry());
  assert.ok(!output.includes("## 📅 Today's Calendar"));
  assert.ok(!output.includes('## 🔔 Apple Reminders'));
  assert.ok(!output.includes('## 📎 Paperclip Inbox'));
});

test('dropped content is discarded rather than folded into Notes', () => {
  const notes = sectionBody(render(legacyEntry()), '## 📝 Notes');

  // The user's own note survives untouched.
  assert.match(notes, /\[\[Existing Note\]\]/);

  // None of the dropped snapshots leak in, under any label.
  assert.ok(!notes.includes('Standup'));
  assert.ok(!notes.includes('teeth cleaning'));
  assert.ok(!notes.includes('Paperclip API unavailable'));
  assert.ok(!notes.includes('migrated'));
});

test('content the user actually wrote is preserved', () => {
  const output = render(legacyEntry());
  assert.match(sectionBody(output, '## 💡 Ideas'), /an idea worth keeping/);
  assert.match(sectionBody(output, '## 📓 Journal Entry'), /Today I did things\./);
});

test('the Projects section renders ongoing projects as wiki-links', () => {
  const output = render(legacyEntry());
  assert.match(output, /## 🚀 Projects/);
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- [[Alpha]]\n- [[Beta]]');
});

test('Projects renders first, ahead of Notes', () => {
  const output = render(legacyEntry());
  assert.ok(output.indexOf('## 🚀 Projects') < output.indexOf('## 📝 Notes'));
});

test('Projects is refreshed on a backfilled date, unlike day-scoped sources', () => {
  const older = [
    '---',
    'journal: Journal',
    'journal-date: 2025-12-01',
    '---',
    '',
    '## 🚀 Projects',
    '- [[Stale Project]]',
    '',
    '## 📝 Notes',
    '- [[Note]]',
    '',
  ].join('\n');

  const output = render(older, { date: '2025-12-01' });
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- [[Alpha]]\n- [[Beta]]');
});

test('a failing projects source degrades visibly instead of emptying the section', () => {
  const output = render(legacyEntry(), {
    fetchers: {
      projects: () => {
        throw new Error('vault unavailable');
      },
    },
  });
  // The fetcher itself swallows errors; a thrown fetcher must not take the
  // whole entry down, and the section must still exist.
  assert.match(output, /## 🚀 Projects/);
});

test('the empty-projects line does not read as real content to the blank-journal guard', () => {
  // classifyJournalHealth uses meaningfulBodyChars to spot a wiped journal.
  // A section that always emits text would mask that, so the Projects
  // empty/unavailable lines must be recognised as generated placeholders.
  const config = loadConfig();
  for (const line of ['- No ongoing projects', '- (projects unavailable)']) {
    const rendered = renderJournal(TEST_DATE, config, normalizeSections('', TEST_DATE, config, {
      fetchers: { projects: () => line },
    }));
    const health = classifyJournalHealth({ existed: true, markdown: rendered, knownGood: null });
    assert.equal(health.metrics.meaningfulBodyChars, 0, `${line} should not count as content`);
  }
});

test('a populated Projects list does not disguise a wiped journal', () => {
  // Projects is machine-rendered every pass, so it is never evidence that the
  // user's own writing survived. If it counted, a journal whose Notes, Ideas,
  // and Journal Entry had been gutted would still look populated and the
  // known-good restore would not fire — the exact loss this guard exists for.
  const config = loadConfig();
  const wiped = renderJournal(TEST_DATE, config, normalizeSections('', TEST_DATE, config, {
    fetchers: { projects: () => '- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]' },
  }));

  const health = classifyJournalHealth({ existed: true, markdown: wiped, knownGood: null });
  assert.equal(health.metrics.meaningfulBodyChars, 0);
});

test('the user\'s own writing still counts as content', () => {
  const config = loadConfig();
  const written = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🚀 Projects',
    '- [[Alpha]]',
    '',
    '## 📝 Notes',
    '- [[A real note I wrote]]',
    '',
    '## 💡 Ideas',
    '-',
    '',
    '## 📓 Journal Entry',
    '-',
    '',
  ].join('\n');

  const health = classifyJournalHealth({ existed: true, markdown: written, knownGood: null });
  assert.ok(health.metrics.meaningfulBodyChars > 0);
});

test('an entry already in the new shape is left alone', () => {
  const current = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🚀 Projects',
    '- [[Alpha]]',
    '- [[Beta]]',
    '',
    '## 📝 Notes',
    '- [[Note]]',
    '',
    '## 💡 Ideas',
    '- idea',
    '',
    '## 📓 Journal Entry',
    'entry',
    '',
  ].join('\n');

  const output = render(current);
  assert.match(sectionBody(output, '## 📝 Notes'), /\[\[Note\]\]/);
  assert.equal(sectionBody(output, '## 💡 Ideas'), '- idea');
  assert.ok(!output.includes('migrated'));
});

test('classifyJournalHealth is unchanged by the migration fix', () => {
  // The wedge is fixed in the snapshot-refresh decision, NOT here. Health
  // classification must keep flagging a shrink, or the restore path loses its
  // trigger. An earlier attempt relaxed this and broke exactly that.
  const config = loadConfig();
  const current = renderJournal(TEST_DATE, config, normalizeSections('', TEST_DATE, config, {
    fetchers: stubFetchers,
  }));
  const shrunkAgainst = {
    size: Buffer.byteLength(current, 'utf8') * 3,
    sectionCount: 6,
    hash: 'old-hash',
  };
  const health = classifyJournalHealth({
    existed: true,
    markdown: current,
    knownGood: shrunkAgainst,
    contract: contractSignature(config),
    config,
  });
  assert.equal(health.status, 'stale');
});

test('structureMatchesContract separates a contract change from real damage', () => {
  const config = loadConfig();
  const desired = config.sections.required.map((section) => section.heading);

  // Exactly the configured contract -> a shrink is explained by the migration.
  assert.equal(structureMatchesContract(desired, config), true);
  // Missing a configured section -> real loss, must not be excused.
  assert.equal(structureMatchesContract(desired.slice(1), config), false);
  // Extra section, or wrong order -> not the current contract.
  assert.equal(structureMatchesContract([...desired, '## Extra'], config), false);
  assert.equal(structureMatchesContract([desired[1], desired[0], ...desired.slice(2)], config), false);
});

test('a renamed generated heading is still excluded from authored content', () => {
  // Headings are a configurable contract, so the exclusion cannot key on
  // literals alone — a renamed Projects section would otherwise let a populated
  // project list mask a wiped journal.
  const base = loadConfig();
  const renamed = JSON.parse(JSON.stringify(base));
  renamed.sections.required = renamed.sections.required.map((section) => (
    section.id === 'projects' ? { ...section, heading: '## 🚀 Active Projects' } : section
  ));

  const rendered = renderJournal(TEST_DATE, renamed, normalizeSections('', TEST_DATE, renamed, {
    fetchers: { projects: () => '- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]' },
  }));
  assert.match(rendered, /## 🚀 Active Projects/);

  const health = classifyJournalHealth({
    existed: true,
    markdown: rendered,
    knownGood: null,
    config: renamed,
  });
  assert.equal(health.metrics.meaningfulBodyChars, 0);
});

test('the known-good snapshot refreshes across a contract migration', () => {
  // The real regression test for the wedge: seed a pre-migration snapshot the way
  // main's code would have written it (more sections, no signature), run a real
  // maintenance pass, and assert the snapshot moved forward instead of freezing.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { syncOneDate, today } = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-contract-migration-'));
  const journalDir = path.join(tmp, 'Vault', 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });

  const previousJournalDir = process.env.JARVOS_JOURNAL_DIR;
  const previousProjectsDir = process.env.JARVOS_PROJECTS_DIR;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  process.env.JARVOS_PROJECTS_DIR = path.join(tmp, 'Vault', 'Projects');

  try {
    const config = loadConfig();
    const date = today();

    const preMigration = [
      '---', 'journal: Journal', `journal-date: ${date}`, '---', '',
      "## 📅 Today's Calendar", '- 9:00 AM Standup', '',
      '## 📝 Notes', '- [[A note the user wrote]]', '',
      '## 💡 Ideas', '- an idea', '',
      '## 📓 Journal Entry', 'Evening reflection.', '',
      '## 🔔 Apple Reminders', '- Buy milk', '',
      '## 📎 Paperclip Inbox', '- SUP-1: something', '',
    ].join('\n');
    fs.writeFileSync(path.join(journalDir, `${date}.md`), preMigration, 'utf8');

    // A snapshot exactly as the previous contract would have recorded it.
    const stateDir = path.join(tmp, 'Vault', '.jarvos', 'journal-maintenance');
    fs.mkdirSync(path.join(stateDir, 'known-good'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'known-good', `${date}.md`), preMigration, 'utf8');
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
      version: 1,
      dates: {
        [date]: {
          date,
          size: Buffer.byteLength(preMigration, 'utf8'),
          hash: 'pre-migration-hash',
          sectionCount: 6,
          sections: ["## 📅 Today's Calendar", '## 📝 Notes', '## 💡 Ideas', '## 📓 Journal Entry', '## 🔔 Apple Reminders', '## 📎 Paperclip Inbox'],
          knownGoodPath: path.join(stateDir, 'known-good', `${date}.md`),
          // no contractSignature — main's code never wrote one
        },
      },
    }, null, 2), 'utf8');

    syncOneDate(date, config, { dryRun: false, fetchers: { projects: () => '- [[Alpha]]' } });

    const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    const entry = after.dates[date];
    assert.equal(entry.sectionCount, 4, 'snapshot must move to the new contract, not stay frozen at 6');
    assert.ok(entry.contractSignature, 'snapshot must now carry a contract signature');

    const snapshot = fs.readFileSync(path.join(stateDir, 'known-good', `${date}.md`), 'utf8');
    assert.ok(!snapshot.includes('Apple Reminders'), 'snapshot must not still hold pre-migration sections');
    assert.match(snapshot, /A note the user wrote/, 'the user\'s own content must survive into the snapshot');
  } finally {
    if (previousJournalDir === undefined) delete process.env.JARVOS_JOURNAL_DIR;
    else process.env.JARVOS_JOURNAL_DIR = previousJournalDir;
    if (previousProjectsDir === undefined) delete process.env.JARVOS_PROJECTS_DIR;
    else process.env.JARVOS_PROJECTS_DIR = previousProjectsDir;
  }
});
