const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyJournalHealth,
  contractSignature,
  authoredContentPreserved,
  loadConfig,
  normalizeSections,
  renderJournal,
} = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

const TEST_DATE = '2026-01-02';

function fakeOwnedMutation({ filePath, expectedContent, nextContent }) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') !== expectedContent) return { status: 'conflict' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return { status: 'committed' };
}

function ownedMutationOptions(options = {}) {
  return { applyMarkdownMutation: fakeOwnedMutation, createMarkdownFile: fakeOwnedMutation, ...options };
}

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

function render(original, {
  fetchers = stubFetchers,
  date = TEST_DATE,
  projectsActivityReader,
  timeZone,
} = {}) {
  const config = loadConfig();
  const normalized = normalizeSections(original, date, config, {
    fetchers,
    projectsActivityReader,
    timeZone,
  });
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

test('activity-backed projection renders a touched Outcome as its canonical parent', () => {
  const output = render('', {
    fetchers: {},
    timeZone: 'America/New_York',
    projectsActivityReader: ({ profile, date, timeZone }) => {
      assert.equal(profile, 'recent-activity');
      assert.equal(date, TEST_DATE);
      assert.equal(timeZone, 'America/New_York');
      return {
        status: 'ok',
        coverageWatermark: 'activity:7',
        projects: [
          { id: 'prj_000001', kind: 'project', title: 'jarvOS', lifecycle: 'active' },
          { id: 'out_000001', kind: 'outcome', title: 'v1.0.0 release', parentId: 'prj_000001', lifecycle: 'active' },
          { id: 'prj_000002', kind: 'project', title: 'Untouched', lifecycle: 'active' },
        ],
        noteMappings: { prj_000001: { target: 'Projects/jarvOS' } },
        activities: [{ canonicalId: 'out_000001', canonicalAtAdmission: { rootProjectId: 'prj_000001' }, occurredAt: '2026-01-02T15:00:00.000Z', trust: 'verified' }],
      };
    },
  });
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- [[Projects/jarvOS]]');
  assert.doesNotMatch(output, /v1\.0\.0 release/);
  assert.doesNotMatch(output, /Untouched/);
});

test('healthy-empty activity evidence clears stale navigation while degraded evidence preserves it', () => {
  const entry = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🚀 Projects',
    '- [[jarvOS]]',
    '',
    '## 📝 Notes',
    '- [[Note]]',
    '',
  ].join('\n');

  const empty = render(entry, {
    fetchers: {},
    projectsActivityReader: () => ({ status: 'ok', activityProviderState: 'healthy-empty', projects: [], activities: [] }),
  });
  assert.equal(sectionBody(empty, '## 🚀 Projects'), '- No projects touched today');

  const degraded = render(entry, {
    fetchers: {},
    projectsActivityReader: () => ({ status: 'partial', activityProviderState: 'partial', projects: [], activities: [] }),
  });
  assert.equal(sectionBody(degraded, '## 🚀 Projects'), '- [[jarvOS]]');
});

test('activity projection can repair a backfilled date from that date\'s evidence', () => {
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

  const output = render(older, {
    date: '2025-12-01',
    fetchers: {},
    projectsActivityReader: ({ date }) => ({
      status: 'ok',
      projects: [{ id: 'prj_000001', kind: 'project', title: 'Historical', lifecycle: 'active' }],
      noteMappings: { prj_000001: { target: 'Projects/Historical' } },
      activities: [{ canonicalId: 'prj_000001', canonicalAtAdmission: { rootProjectId: 'prj_000001' }, occurredAt: `${date}T11:00:00.000Z`, trust: 'verified' }],
    }),
  });
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- [[Projects/Historical]]');
});

/**
 * `projects.js` documented this contract -- "the journal treats [the unavailable
 * marker] as a degraded source and will not write over existing content" -- and
 * the journal never implemented it. `'- (projects unavailable)'` is a truthy
 * string, so it won the `fetched || existingContent` chain and replaced the
 * real list. One unmounted volume or permissions blip would rewrite a populated
 * Projects section down to a single placeholder line on every date in the run.
 */
test('a degraded projects read does not overwrite an existing project list', () => {
  const entry = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🚀 Projects',
    '- [[AAF Observatory]]',
    '- [[Proof of Value]]',
    '',
    '## 📝 Notes',
    '- [[Existing Note]]',
    '',
  ].join('\n');

  const output = render(entry, { fetchers: { projects: () => '- (projects unavailable)' } });
  assert.equal(
    sectionBody(output, '## 🚀 Projects'),
    '- [[AAF Observatory]]\n- [[Proof of Value]]',
    'a marker meaning "could not read" must not replace real evidence',
  );
});

test('a degraded projects read still renders the marker when there is nothing to protect', () => {
  // The other half: the marker is diagnostic and must stay visible on an entry
  // whose Projects section is genuinely empty, rather than silently rendering
  // a bare '-'.
  const output = render(legacyEntry(), { fetchers: { projects: () => '- (projects unavailable)' } });
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- (projects unavailable)');
});

test('a positive empty-state claim still replaces a stale list', () => {
  // `- No ongoing projects` is an observation, not a read failure, so it is
  // allowed to overwrite -- otherwise closing your last project could never
  // clear the section.
  const entry = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🚀 Projects',
    '- [[Finished Project]]',
    '',
  ].join('\n');

  const output = render(entry, { fetchers: { projects: () => '- No ongoing projects' } });
  assert.equal(sectionBody(output, '## 🚀 Projects'), '- No ongoing projects');
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
    config,
  });
  assert.equal(health.status, 'stale');
});

test('authoredContentPreserved distinguishes a migration from real damage', () => {
  const config = loadConfig();
  const prior = [
    '---', 'journal: Journal', '---', '',
    "## 📅 Today's Calendar", '- 9:00 AM Standup', '',
    '## 📝 Notes', '- [[A note the user wrote]]', '',
    '## 📓 Journal Entry', 'Evening reflection.', '',
  ].join('\n');

  // Migration: machine sections dropped, authored lines intact -> preserved.
  const migrated = [
    '---', 'journal: Journal', '---', '',
    '## 🚀 Projects', '- [[Alpha]]', '',
    '## 📝 Notes', '- [[A note the user wrote]]', '',
    '## 📓 Journal Entry', 'Evening reflection.', '',
  ].join('\n');
  assert.equal(authoredContentPreserved(migrated, prior, config), true);

  // Damage: the user's Notes and Journal Entry are gone -> NOT preserved.
  const gutted = [
    '---', 'journal: Journal', '---', '',
    '## 🚀 Projects', '- [[Alpha]]', '',
    '## 📝 Notes', '-', '',
    '## 📓 Journal Entry', '-', '',
  ].join('\n');
  assert.equal(authoredContentPreserved(gutted, prior, config), false);
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
  const previousStateDir = process.env.JARVOS_JOURNAL_STATE_DIR;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  process.env.JARVOS_PROJECTS_DIR = path.join(tmp, 'Vault', 'Projects');
  process.env.JARVOS_JOURNAL_STATE_DIR = path.join(tmp, 'local-state');

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
    const stateDir = process.env.JARVOS_JOURNAL_STATE_DIR;
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

    syncOneDate(date, config, ownedMutationOptions({ dryRun: false, fetchers: { projects: () => '- [[Alpha]]' } }));

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
    if (previousStateDir === undefined) delete process.env.JARVOS_JOURNAL_STATE_DIR;
    else process.env.JARVOS_JOURNAL_STATE_DIR = previousStateDir;
  }
});

test('a damaged entry must not overwrite a good pre-migration snapshot', () => {
  // The failure mode of the previous attempt at this fix: the migration gate was
  // vacuously true on every write path, so the first pass after deploy replaced a
  // good snapshot with whatever was on disk — including a gutted entry — and the
  // intact copy the restore path needed was gone.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { syncOneDate, today } = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-damage-guard-'));
  const journalDir = path.join(tmp, 'Vault', 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });

  const prevJournal = process.env.JARVOS_JOURNAL_DIR;
  const prevProjects = process.env.JARVOS_PROJECTS_DIR;
  const prevState = process.env.JARVOS_JOURNAL_STATE_DIR;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  process.env.JARVOS_PROJECTS_DIR = path.join(tmp, 'Vault', 'Projects');
  process.env.JARVOS_JOURNAL_STATE_DIR = path.join(tmp, 'local-state');

  try {
    const config = loadConfig();
    const date = today();

    // The intact copy: real user content under the old contract.
    const intact = [
      '---', 'journal: Journal', `journal-date: ${date}`, '---', '',
      "## 📅 Today's Calendar", '- 9:00 AM Standup', '',
      '## 📝 Notes', '- [[Note one]]', '- [[Note two]]', '- [[Note three]]', '',
      '## 💡 Ideas', '- an idea worth keeping', '',
      '## 📓 Journal Entry', 'A long evening reflection that must not be lost.', '',
      '## 🔔 Apple Reminders', '- Buy milk', '',
      '## 📎 Paperclip Inbox', '- SUP-1: something', '',
    ].join('\n');

    // What is actually on disk now: a bad sync gutted Notes and Journal Entry but
    // left an Ideas bullet, so it is not a stub and not a catastrophic shrink.
    const gutted = [
      '---', 'journal: Journal', `journal-date: ${date}`, '---', '',
      "## 📅 Today's Calendar", '- 9:00 AM Standup', '',
      '## 📝 Notes', '-', '',
      '## 💡 Ideas', '- an idea worth keeping', '',
      '## 📓 Journal Entry', '-', '',
      '## 🔔 Apple Reminders', '- Buy milk', '',
      '## 📎 Paperclip Inbox', '- SUP-1: something', '',
    ].join('\n');
    fs.writeFileSync(path.join(journalDir, `${date}.md`), gutted, 'utf8');

    const stateDir = process.env.JARVOS_JOURNAL_STATE_DIR;
    const kgPath = path.join(stateDir, 'known-good', `${date}.md`);
    fs.mkdirSync(path.dirname(kgPath), { recursive: true });
    fs.writeFileSync(kgPath, intact, 'utf8');
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({
      version: 1,
      dates: {
        [date]: {
          date,
          size: Buffer.byteLength(intact, 'utf8'),
          hash: 'pre-migration-hash',
          sectionCount: 6,
          knownGoodPath: kgPath,
          // no contractSignature — written before the field existed
        },
      },
    }, null, 2), 'utf8');

    syncOneDate(date, config, ownedMutationOptions({ dryRun: false, fetchers: { projects: () => '- [[Alpha]]' } }));

    const snapshot = fs.readFileSync(kgPath, 'utf8');
    assert.match(snapshot, /Note one/, 'the intact snapshot must survive a damaged entry');
    assert.match(snapshot, /A long evening reflection/, 'the evening entry must still be recoverable');

    const after = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    assert.equal(after.dates[date].hash, 'pre-migration-hash', 'state must not be re-stamped from a damaged entry');
  } finally {
    if (prevJournal === undefined) delete process.env.JARVOS_JOURNAL_DIR; else process.env.JARVOS_JOURNAL_DIR = prevJournal;
    if (prevProjects === undefined) delete process.env.JARVOS_PROJECTS_DIR; else process.env.JARVOS_PROJECTS_DIR = prevProjects;
    if (prevState === undefined) delete process.env.JARVOS_JOURNAL_STATE_DIR; else process.env.JARVOS_JOURNAL_STATE_DIR = prevState;
  }
});
