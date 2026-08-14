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
  runMaintenance,
  stripLeadingRecoveryScaffold,
  syncOneDate: rawSyncOneDate,
} = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
const { renderJournalOriginMarker } = require('../bridge/provenance/src/content-origin-contract');

const TEST_DATE = '2026-01-02';

test('ordinary maintenance removes legacy signatures without adding a replacement and preserves hidden markers', () => {
  const marker = renderJournalOriginMarker({
    cleanText: 'assistant thought',
    content_origin: 'assistant',
    content_origin_basis: 'assistant_generated',
    source_ref: 'capture:codex:maintenance',
  });
  const original = [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 📝 Notes',
    '-',
    '',
    '## 💡 Ideas',
    '- assistant thought',
    marker,
    '',
    '## 📓 Journal Entry',
    '-',
    '',
    '— Edited by Jarvis',
    '',
  ].join('\n');

  const config = loadConfig();
  const normalized = normalizeSections(original, TEST_DATE, config, { fetchers: { projects: () => '-' } });
  const output = renderJournal(TEST_DATE, config, normalized);
  assert.doesNotMatch(output, /Written by Jarvis|Edited by Jarvis/);
  assert.match(output, /- assistant thought\n<!-- jarvos-content-origin\/v1 /);
});

function fakeOwnedMutation({ filePath, expectedContent, nextContent }) {
  const exists = fs.existsSync(filePath);
  if (exists && fs.readFileSync(filePath, 'utf8') !== expectedContent) return { status: 'conflict' };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, nextContent, 'utf8');
  return { status: 'committed' };
}

function syncOneDate(date, config, options = {}) {
  return rawSyncOneDate(date, config, {
    applyMarkdownMutation: fakeOwnedMutation,
    createMarkdownFile: fakeOwnedMutation,
    ...options,
  });
}

test('journal maintenance fails closed without composition and withholds success on conflict', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-owned-'));
  const journalDir = path.join(root, 'Journal');
  const journalPath = path.join(journalDir, `${TEST_DATE}.md`);
  const previous = process.env.JARVOS_JOURNAL_DIR;
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(journalPath, '## 📝 Notes\n- keep me\n', 'utf8');
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  try {
    const config = loadConfig();
    assert.throws(() => rawSyncOneDate(TEST_DATE, config, {}), /Canonical vault mutation composition/);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), '## 📝 Notes\n- keep me\n');
    const result = rawSyncOneDate(TEST_DATE, config, {
      applyMarkdownMutation: () => ({ status: 'conflict' }),
    });
    assert.equal(result.written, false);
    assert.equal(result.writeStatus, 'conflict');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), '## 📝 Notes\n- keep me\n');
  } finally {
    if (previous === undefined) delete process.env.JARVOS_JOURNAL_DIR;
    else process.env.JARVOS_JOURNAL_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activity-backed Journal maintenance carries a separate projection receipt into the owned mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-activity-projection-'));
  const journalDir = path.join(root, 'Journal');
  const journalPath = path.join(journalDir, `${TEST_DATE}.md`);
  const previous = process.env.JARVOS_JOURNAL_DIR;
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(journalPath, [
    '---',
    'journal: Journal',
    `journal-date: ${TEST_DATE}`,
    '---',
    '',
    '## 🚀 Projects',
    '- [[old]]',
    '',
    '## 📝 Notes',
    '- [[Note]]',
    '',
  ].join('\n'), 'utf8');
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  let projectionReceipt = null;
  try {
    const config = loadConfig();
    const result = rawSyncOneDate(TEST_DATE, config, {
      projectsActivityReader: () => ({
        status: 'ok',
        coverageWatermark: 'activity:9',
        projects: [{ id: 'prj_000001', kind: 'project', title: 'jarvOS', lifecycle: 'active' }],
        activities: [{ canonicalId: 'prj_000001', occurredAt: '2026-01-02T15:00:00.000Z', trust: 'verified' }],
      }),
      applyMarkdownMutation(input) {
        projectionReceipt = input.projectionReceipt;
        return fakeOwnedMutation(input);
      },
    });
    assert.equal(result.projectProjection.coverageWatermark, 'activity:9');
    assert.equal(projectionReceipt.inputDigest, result.projectProjection.inputDigest);
    assert.equal(projectionReceipt.status, 'fresh');
    assert.equal(sectionBody(fs.readFileSync(journalPath, 'utf8'), '## 🚀 Projects'), '- [[jarvOS]]');
  } finally {
    if (previous === undefined) delete process.env.JARVOS_JOURNAL_DIR;
    else process.env.JARVOS_JOURNAL_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Sync-pending local journal bytes never advance the known-good recovery snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-pending-known-good-'));
  const journalDir = path.join(root, 'Vault', 'Journal');
  const previous = process.env.JARVOS_JOURNAL_DIR;
  fs.mkdirSync(journalDir, { recursive: true });
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  try {
    const config = loadConfig();
    const result = rawSyncOneDate(TEST_DATE, config, {
      createMarkdownFile({ filePath, nextContent }) {
        fs.writeFileSync(filePath, nextContent, 'utf8');
        return { status: 'saved_locally_sync_pending' };
      },
    });
    assert.equal(result.writeStatus, 'saved_locally_sync_pending');
    assert.equal(result.written, false);
    assert.equal(fs.existsSync(path.join(root, 'Vault', '.jarvos', 'journal-maintenance', 'known-good', `${TEST_DATE}.md`)), false);
    assert.equal(fs.existsSync(path.join(root, 'Vault', '.jarvos', 'journal-maintenance', 'state.json')), false);
  } finally {
    if (previous === undefined) delete process.env.JARVOS_JOURNAL_DIR; else process.env.JARVOS_JOURNAL_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function unchangedSync(date, journalPath = '/tmp/test-vault/Journal/2026-01-02.md') {
  return {
    date,
    journalPath,
    changed: false,
    healthBefore: { status: 'healthy', degraded: false },
    healthAfter: { status: 'healthy', degraded: false },
  };
}

test('maintenance flushes deferred backlinks after journal sync and exposes JSON status', () => {
  const calls = [];
  const report = runMaintenance([`--date=${TEST_DATE}`, '--json'], {
    loadConfig: () => ({}),
    syncOneDate: (date) => {
      calls.push(`sync:${date}`);
      return unchangedSync(date);
    },
    flushDeferredBacklinks: (options) => {
      calls.push('flush');
      assert.deepEqual(options, {
        journalDir: '/tmp/test-vault/Journal',
        vaultRoot: '/tmp/test-vault',
        notesDir: '/tmp/test-vault/Notes',
        dryRun: false,
      });
      return {
        lastFlushAt: '2026-01-02T00:00:00.000Z',
        checked: 2,
        linked: 0,
        pending: 1,
        unresolved: 1,
        superseded: 0,
        entries: [{ key: 'retry', status: 'pending', error: 'Obsidian unavailable' }],
      };
    },
  });

  assert.deepEqual(calls, [`sync:${TEST_DATE}`, 'flush']);
  assert.equal(report.lastFlushAt, '2026-01-02T00:00:00.000Z');
  assert.equal(report.summary.pending, 1);
  assert.equal(report.summary.unresolved, 1);
  assert.equal(report.summary.failed, 1);
  assert.notEqual(report.output, 'NO_REPLY');
  assert.deepEqual(JSON.parse(report.output).summary, report.summary);
});

test('maintenance dry-run classifies deferred backlinks without mutating them', () => {
  let flushOptions;
  const report = runMaintenance([`--date=${TEST_DATE}`, '--dry-run', '--json'], {
    loadConfig: () => ({}),
    syncOneDate: (date) => unchangedSync(date),
    flushDeferredBacklinks: (options) => {
      flushOptions = options;
      return {
        lastFlushAt: '2026-01-01T00:00:00.000Z',
        checked: 1,
        linked: 0,
        pending: 1,
        unresolved: 0,
        superseded: 0,
        entries: [{ key: 'retry', status: 'pending', proposed: 'retry' }],
        dryRun: true,
      };
    },
  });

  assert.equal(flushOptions.dryRun, true);
  assert.equal(report.summary.pending, 1);
  assert.equal(report.output === 'NO_REPLY', false);
});

test('maintenance does not collapse deferred backlog states to NO_REPLY', () => {
  for (const [field, lastFlushAt] of [
    ['pending', '2026-01-02T00:00:00.000Z'],
    ['unresolved', '2026-01-02T00:01:00.000Z'],
    ['superseded', '2026-01-02T00:02:00.000Z'],
    ['failed', '2026-01-02T00:03:00.000Z'],
  ]) {
    const report = runMaintenance([`--date=${TEST_DATE}`], {
      loadConfig: () => ({}),
      syncOneDate: (date) => unchangedSync(date),
      flushDeferredBacklinks: () => ({
        lastFlushAt,
        checked: 1,
        linked: 0,
        pending: field === 'pending' || field === 'failed' ? 1 : 0,
        unresolved: field === 'unresolved' ? 1 : 0,
        superseded: field === 'superseded' ? 1 : 0,
        failed: field === 'failed' ? 1 : 0,
        entries: [],
      }),
    });

    assert.notEqual(report.output, 'NO_REPLY', `${field} must be reported`);
    assert.match(report.output, /Deferred backlinks/);
  }
});

test('maintenance reports terminal deferred records that predate this flush', () => {
  const report = runMaintenance([`--date=${TEST_DATE}`], {
    loadConfig: () => ({}),
    syncOneDate: (date) => unchangedSync(date),
    flushDeferredBacklinks: () => ({
      checked: 0,
      linked: 0,
      pending: 0,
      unresolved: 0,
      superseded: 0,
      entries: [],
    }),
    readDeferredBacklinkFlushMetadata: () => ({
      lastFlushAt: '2026-01-02T01:00:00.000Z',
      summary: null,
      entries: [{ key: 'moved', status: 'superseded' }],
    }),
  });

  assert.equal(report.summary.superseded, 1);
  assert.notEqual(report.output, 'NO_REPLY');
});

test('creation-only maintenance reports deferred backlog without flushing authored journals', () => {
  let flushCalls = 0;
  const report = runMaintenance(['--create-if-missing', '--json'], {
    runCreationMaintenance: () => ({
      status: 'ok',
      results: [{ ok: true, outcome: 'healthy-existing', date: TEST_DATE, journalPath: '/tmp/test-vault/Journal/2026-01-02.md' }],
      output: 'HEALTHY-EXISTING',
    }),
    flushDeferredBacklinks: () => {
      flushCalls += 1;
      return {};
    },
    readDeferredBacklinkFlushMetadata: () => ({
      lastFlushAt: '2026-01-02T00:00:00.000Z',
      summary: null,
      entries: [{ key: 'retry', status: 'pending', lastError: 'Obsidian unavailable' }],
    }),
  });

  assert.equal(flushCalls, 0);
  assert.equal(report.status, 'failed');
  assert.equal(report.summary.pending, 1);
  assert.equal(report.deferredBacklinks.pending, 1);
  assert.equal(JSON.parse(report.output).status, 'failed');
  assert.deepEqual(JSON.parse(report.output).deferredBacklinks, report.summary);
});

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

test('create-if-missing dispatches to the creation-only lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-create-only-'));
  try {
    const report = runMaintenance(['--create-if-missing', '--json'], {
      config: {
        paths: { journal: path.join(root, 'Journal') },
        user: { timezone: 'UTC' },
        derivedIndex: { enabled: false },
      },
      now: new Date('2026-08-03T12:00:00.000Z'),
      mutationContext: { vaultId: 'test-vault', vaultRoot: root },
      mutationExecutor(operation) {
        const filePath = path.join(root, operation.vaultRelativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, operation.content, 'utf8');
        return { status: 'committed' };
      },
    });
    assert.equal(report.status, 'ok');
    assert.equal(report.results[0].outcome, 'created');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('create-if-missing dry-run reports a missing journal without writing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-create-only-dry-run-'));
  const journalDir = path.join(root, 'Journal');
  try {
    const report = runMaintenance(['--create-if-missing', '--dry-run', '--json'], {
      config: { paths: { journal: journalDir }, user: { timezone: 'UTC' } },
      now: new Date('2026-08-03T12:00:00.000Z'),
    });
    assert.equal(report.status, 'ok');
    assert.equal(report.results[0].outcome, 'would-create');
    assert.equal(fs.existsSync(path.join(journalDir, '2026-08-03.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.jarvos')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
