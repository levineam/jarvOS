'use strict';

// SUP-2270: journal single-writer guard + stub regression detection + repair.
// Covers the SUP-2269 incident class: an external Obsidian daily-note writer
// replaces a populated Journal/YYYY-MM-DD.md with a frontmatter-only stub and
// sync propagates the bad file. The maintenance run must detect the stub,
// restore known-good content, write an audit backup first, and never delete
// user-authored text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PATHS_MODULE = path.resolve(__dirname, '../bridge/config/jarvos-paths.js');
const JOURNAL_MODULE = path.resolve(
  __dirname,
  '../packages/jarvos-secondbrain-journal/src/journal-maintenance.js'
);

// A date that is never "today" so source fetchers (calendar/reminders/Paperclip)
// stay inert and tests are deterministic.
const DATE = '2024-01-15';

const TEST_CONFIG = {
  frontmatter: {
    journal: 'Journal',
    'journal-date': '{{YYYY-MM-DD}}',
  },
  sections: {
    required: [
      { id: 'notes', heading: '## 📝 Notes', source: 'manual' },
      { id: 'journal-entry', heading: '## 📓 Journal Entry', source: 'manual' },
    ],
    optional: [],
  },
};

function withEnv(vars, fn) {
  const saved = {};
  const { resetConfigCache } = require(PATHS_MODULE);

  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  }
}

function journalModule() {
  delete require.cache[require.resolve(JOURNAL_MODULE)];
  return require(JOURNAL_MODULE);
}

function makeVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stub-guard-'));
  const journalDir = path.join(vault, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  return { vault, journalDir };
}

function inVault(journalDir, fn) {
  return withEnv(
    {
      JARVOS_JOURNAL_DIR: journalDir,
      JOURNAL_DIR: undefined,
      JARVOS_VAULT_DIR: undefined,
      JARVOS_CONFIG_PATH: undefined,
    },
    fn
  );
}

const STUB = '---\njournal: Journal\njournal-date: 2024-01-15\n---\n';

function populatedJournal() {
  return [
    '---',
    'journal: Journal',
    'journal-date: 2024-01-15',
    '---',
    '',
    '## 📝 Notes',
    '- user-authored note that must survive',
    '',
    '## 📓 Journal Entry',
    '- reflections written by Andrew',
    '',
    '— Edited by Jarvis',
    '',
  ].join('\n');
}

test('classifyJournalHealth distinguishes missing / stub / stale / healthy', () => {
  const { classifyJournalHealth, journalMetrics } = journalModule();

  assert.equal(classifyJournalHealth({ existed: false, markdown: '' }).status, 'missing');
  assert.equal(classifyJournalHealth({ existed: true, markdown: STUB }).status, 'stub');
  assert.equal(classifyJournalHealth({ existed: true, markdown: STUB }).degraded, true);

  const healthy = classifyJournalHealth({ existed: true, markdown: populatedJournal() });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.degraded, false);

  const good = journalMetrics(populatedJournal());
  const shrunk = classifyJournalHealth({
    existed: true,
    markdown: '---\njournal: Journal\n---\n\n## 📝 Notes\n-\n',
    knownGood: { size: good.size, hash: good.hash, sectionCount: good.sectionCount },
  });
  assert.equal(shrunk.status, 'stale');
  assert.equal(shrunk.degraded, true);
});

test('frontmatter-only stub overwrite after a populated journal is restored from known-good', () => {
  const { journalDir, vault } = makeVault();
  try {
    inVault(journalDir, () => {
      const { syncOneDate } = journalModule();
      const journalPath = path.join(journalDir, `${DATE}.md`);

      // Establish a populated journal and its known-good snapshot.
      fs.writeFileSync(journalPath, populatedJournal(), 'utf8');
      const first = syncOneDate(DATE, TEST_CONFIG, {});
      assert.equal(first.healthAfter.status, 'healthy');
      const knownGoodFile = path.join(vault, '.jarvos/journal-maintenance/known-good', `${DATE}.md`);
      assert.ok(fs.existsSync(knownGoodFile), 'known-good snapshot is recorded');

      // External writer clobbers the populated journal with a stub.
      fs.writeFileSync(journalPath, STUB, 'utf8');

      const repaired = syncOneDate(DATE, TEST_CONFIG, {});
      assert.equal(repaired.healthBefore.status, 'stub');
      assert.equal(repaired.restoredKnownGood, true);
      assert.equal(repaired.healthAfter.status, 'healthy');

      const restored = fs.readFileSync(journalPath, 'utf8');
      assert.match(restored, /user-authored note that must survive/);
      assert.match(restored, /reflections written by Andrew/);

      // Audit backup preserves the pre-repair on-disk content (the stub).
      assert.ok(repaired.backupPath, 'repair records an audit backup path');
      assert.ok(repaired.backupPath.includes('stub-restore'));
      assert.equal(fs.readFileSync(repaired.backupPath, 'utf8'), STUB);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('stub with no known-good snapshot is re-scaffolded, not left degraded', () => {
  const { journalDir, vault } = makeVault();
  try {
    inVault(journalDir, () => {
      const { syncOneDate } = journalModule();
      const journalPath = path.join(journalDir, `${DATE}.md`);
      fs.writeFileSync(journalPath, STUB, 'utf8');

      const result = syncOneDate(DATE, TEST_CONFIG, {});
      assert.equal(result.healthBefore.status, 'stub');
      assert.equal(result.restoredKnownGood, false);
      assert.equal(result.healthAfter.status, 'healthy');
      assert.match(fs.readFileSync(journalPath, 'utf8'), /## 📝 Notes/);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('repair writes an audit backup before any rewrite and never deletes user-authored text', () => {
  const { journalDir, vault } = makeVault();
  try {
    inVault(journalDir, () => {
      const { syncOneDate } = journalModule();
      const journalPath = path.join(journalDir, `${DATE}.md`);

      // Drifted journal: user text under an unknown heading plus stray text.
      const drifted = [
        '---',
        'journal: Journal',
        'journal-date: 2024-01-15',
        '---',
        '',
        'stray user line outside any section',
        '',
        '## Custom Heading',
        '- precious user content',
        '',
      ].join('\n');
      fs.writeFileSync(journalPath, drifted, 'utf8');

      const result = syncOneDate(DATE, TEST_CONFIG, {});
      assert.equal(result.changed, true);
      assert.ok(result.backupPath, 'rewrite of an existing journal records an audit backup');
      assert.equal(fs.readFileSync(result.backupPath, 'utf8'), drifted);

      const updated = fs.readFileSync(journalPath, 'utf8');
      assert.match(updated, /stray user line outside any section/);
      assert.match(updated, /precious user content/);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('dry run reports the stub without writing anything', () => {
  const { journalDir, vault } = makeVault();
  try {
    inVault(journalDir, () => {
      const { syncOneDate } = journalModule();
      const journalPath = path.join(journalDir, `${DATE}.md`);
      fs.writeFileSync(journalPath, STUB, 'utf8');

      const result = syncOneDate(DATE, TEST_CONFIG, { dryRun: true });
      assert.equal(result.healthBefore.status, 'stub');
      assert.equal(result.changed, true);
      assert.equal(result.backupPath, null);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), STUB, 'dry run leaves the stub untouched');
      assert.ok(
        !fs.existsSync(path.join(vault, '.jarvos')),
        'dry run writes no state'
      );
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('detectConflictingJournalWriters flags the journals plugin and overlapping daily-note writers', () => {
  const { journalDir, vault } = makeVault();
  try {
    const { detectConflictingJournalWriters } = journalModule();
    const obsidianDir = path.join(vault, '.obsidian');
    fs.mkdirSync(obsidianDir, { recursive: true });

    // No conflicting config → sole writer.
    assert.deepEqual(detectConflictingJournalWriters(journalDir), []);

    // The "journals" community plugin (the SUP-2269 stub writer) is always a conflict.
    fs.writeFileSync(path.join(obsidianDir, 'community-plugins.json'), JSON.stringify(['journals']), 'utf8');
    let conflicts = detectConflictingJournalWriters(journalDir);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0], /"journals" is enabled/);

    // Core daily-notes pointing at the journal folder conflicts; elsewhere does not.
    fs.writeFileSync(path.join(obsidianDir, 'community-plugins.json'), JSON.stringify([]), 'utf8');
    fs.writeFileSync(path.join(obsidianDir, 'core-plugins.json'), JSON.stringify({ 'daily-notes': true }), 'utf8');
    fs.writeFileSync(path.join(obsidianDir, 'daily-notes.json'), JSON.stringify({ folder: 'Journal' }), 'utf8');
    conflicts = detectConflictingJournalWriters(journalDir);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0], /daily-notes/);

    fs.writeFileSync(path.join(obsidianDir, 'daily-notes.json'), JSON.stringify({ folder: 'Daily' }), 'utf8');
    assert.deepEqual(detectConflictingJournalWriters(journalDir), []);

    // Periodic Notes daily section overlapping the journal folder conflicts.
    fs.writeFileSync(path.join(obsidianDir, 'core-plugins.json'), JSON.stringify({}), 'utf8');
    fs.writeFileSync(path.join(obsidianDir, 'community-plugins.json'), JSON.stringify(['periodic-notes']), 'utf8');
    const pnDir = path.join(obsidianDir, 'plugins', 'periodic-notes');
    fs.mkdirSync(pnDir, { recursive: true });
    fs.writeFileSync(path.join(pnDir, 'data.json'), JSON.stringify({ daily: { enabled: true, folder: 'Journal' } }), 'utf8');
    conflicts = detectConflictingJournalWriters(journalDir);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0], /periodic-notes/);

    fs.writeFileSync(path.join(pnDir, 'data.json'), JSON.stringify({ daily: { enabled: false, folder: 'Journal' } }), 'utf8');
    assert.deepEqual(detectConflictingJournalWriters(journalDir), []);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('partial clobber (stale) is detected and does not poison the known-good snapshot', () => {
  const { journalDir, vault } = makeVault();
  try {
    inVault(journalDir, () => {
      const { syncOneDate } = journalModule();
      const journalPath = path.join(journalDir, `${DATE}.md`);

      // Establish the rich journal as known-good.
      fs.writeFileSync(journalPath, populatedJournal(), 'utf8');
      const first = syncOneDate(DATE, TEST_CONFIG, {});
      assert.equal(first.healthAfter.status, 'healthy');
      const knownGoodFile = path.join(vault, '.jarvos/journal-maintenance/known-good', `${DATE}.md`);
      const goodSnapshot = fs.readFileSync(knownGoodFile, 'utf8');
      const statePath = path.join(vault, '.jarvos/journal-maintenance/state.json');
      const goodState = fs.readFileSync(statePath, 'utf8');

      // External writer clobbers it with a partial file: still has a section
      // heading (so NOT a frontmatter-only stub), but the user text is gone.
      const partial = [
        '---',
        'journal: Journal',
        'journal-date: 2024-01-15',
        '---',
        '',
        '## 📝 Notes',
        '-',
        '',
      ].join('\n');
      fs.writeFileSync(journalPath, partial, 'utf8');

      const result = syncOneDate(DATE, TEST_CONFIG, {});
      assert.equal(result.healthBefore.status, 'stale');
      assert.ok(result.backupPath, 'stale rewrite records an audit backup');
      assert.equal(fs.readFileSync(result.backupPath, 'utf8'), partial);

      // The richer snapshot must survive the degraded run untouched.
      assert.equal(fs.readFileSync(knownGoodFile, 'utf8'), goodSnapshot);
      assert.equal(fs.readFileSync(statePath, 'utf8'), goodState);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('healthy journal refresh keeps known-good state in sync', () => {
  const { journalDir, vault } = makeVault();
  try {
    inVault(journalDir, () => {
      const { syncOneDate, journalMetrics } = journalModule();
      const journalPath = path.join(journalDir, `${DATE}.md`);
      fs.writeFileSync(journalPath, populatedJournal(), 'utf8');

      syncOneDate(DATE, TEST_CONFIG, {});
      const statePath = path.join(vault, '.jarvos/journal-maintenance/state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const entry = state.dates[DATE];
      const onDisk = fs.readFileSync(journalPath, 'utf8');
      assert.equal(entry.hash, journalMetrics(onDisk).hash);
      assert.equal(entry.sectionCount, 2);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
