'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../packages/jarvos-secondbrain-journal/src/journal-lifecycle.js');

function tempVault() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-lifecycle-'));
  return { vault, journalDir: path.join(vault, 'Journal') };
}

test('journal lifecycle fails closed without explicit configuration', () => {
  const { vault } = tempVault();
  try {
    const result = lifecycle.ensureTodayJournal({
      config: {},
      env: {},
      configPath: path.join(vault, 'missing.json'),
      homeDir: vault,
      now: new Date('2026-08-03T12:00:00.000Z'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'invalid-configuration');
    assert.equal(fs.existsSync(path.join(vault, 'Journal')), false);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('direct lifecycle overrides require an absolute directory and paired timezone', () => {
  const { vault } = tempVault();
  try {
    for (const options of [
      { journalDir: 'relative-journal', timeZone: 'UTC' },
      { journalDir: path.join(vault, 'Journal') },
      { timeZone: 'UTC' },
    ]) {
      const result = lifecycle.ensureTodayJournal({
        ...options,
        now: new Date('2026-08-03T12:00:00.000Z'),
        env: {},
        configPath: path.join(vault, 'missing.json'),
        homeDir: vault,
      });
      assert.equal(result.ok, false);
      assert.equal(result.outcome, 'invalid-configuration');
    }
    assert.equal(fs.existsSync(path.join(vault, 'Journal')), false);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('journal lifecycle uses generic caller provenance without host defaults', () => {
  const { vault, journalDir } = tempVault();
  try {
    const result = lifecycle.ensureTodayJournal({
      config: { paths: { journal: journalDir }, user: { timezone: 'UTC' } },
      env: {},
      now: new Date('2026-08-03T12:00:00.000Z'),
      provenance: { source: 'test-source', runtime: 'test-runtime', runId: 'run-1' },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.provenance, { source: 'test-source', runtime: 'test-runtime', runId: 'run-1' });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('blank explicit provenance falls back to scheduler environment values', () => {
  assert.deepEqual(
    lifecycle.resolveProvenance({
      provenance: { trigger: ' ', source: '\t' },
      env: {
        OPENCLAW_EXTERNAL_CRON_EXECUTION_PROVENANCE: ' scheduled ',
        OPENCLAW_SOURCE_REVISION: 'source-1',
      },
    }),
    { source: 'source-1', trigger: 'scheduled' },
  );
});

test('scheduled provenance is recorded and forced checks cannot replace scheduled proof', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  const now = new Date('2026-08-03T12:00:00.000Z');
  const scheduledEnv = {
    JARVOS_SOURCE_REVISION: 'source-1',
    JARVOS_RUNTIME_REVISION: 'runtime-1',
    OPENCLAW_EXTERNAL_CRON_RUN_ID: 'journal-maintenance:2026-08-03:primary',
    OPENCLAW_EXTERNAL_CRON_EXECUTION_PROVENANCE: 'scheduled',
  };
  try {
    const scheduled = lifecycle.ensureTodayJournal({ config, env: scheduledEnv, now });
    assert.equal(scheduled.outcome, 'created');
    assert.deepEqual(scheduled.provenance, {
      source: 'source-1',
      runtime: 'runtime-1',
      runId: 'journal-maintenance:2026-08-03:primary',
      trigger: 'scheduled',
    });

    const sentinelPath = path.join(vault, '.jarvos', 'journal-maintenance', 'receipts', '2026-08-03.receipt');
    assert.equal(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')).trigger, 'scheduled');

    const untaggedManual = lifecycle.ensureTodayJournal({ config, env: {}, now });
    assert.equal(untaggedManual.outcome, 'healthy-existing');
    assert.equal(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')).trigger, 'scheduled');

    const forced = lifecycle.ensureTodayJournal({
      config,
      env: { ...scheduledEnv, OPENCLAW_EXTERNAL_CRON_EXECUTION_PROVENANCE: 'forced' },
      now,
    });
    assert.equal(forced.outcome, 'healthy-existing');
    assert.equal(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')).trigger, 'scheduled');
    assert.equal(
      fs.readdirSync(path.dirname(sentinelPath)).filter((name) => name.endsWith('.json')).length,
      2,
      'explicit forced checks retain an immutable audit receipt without replacing scheduled proof',
    );
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('creation is exclusive, re-read verified, and existing authored files stay untouched', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'Pacific/Auckland' } };
  const now = new Date('2026-08-03T12:30:00.000Z');
  try {
    const created = lifecycle.ensureTodayJournal({ config, env: { TZ: 'UTC' }, now });
    assert.equal(created.outcome, 'created');
    assert.equal(created.date, '2026-08-04');
    const journalPath = path.join(journalDir, '2026-08-04.md');
    const authored = '# authored\n\n## 📝 Notes\nkeep this\n';
    fs.writeFileSync(journalPath, authored, 'utf8');
    const before = fs.statSync(journalPath);
    const existing = lifecycle.ensureTodayJournal({ config, env: { TZ: 'UTC' }, now });
    const after = fs.statSync(journalPath);
    assert.equal(existing.outcome, 'healthy-existing');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), authored);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('creation race classifies a healthy or invalid winner without overwriting it', () => {
  for (const winner of ['healthy', 'invalid']) {
    const { vault, journalDir } = tempVault();
    const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
    const now = new Date('2026-08-03T12:00:00.000Z');
    const journalPath = path.join(journalDir, '2026-08-03.md');
    const winnerContent = winner === 'healthy'
      ? '---\njournal-date: 2026-08-03\n---\n\n## 📝 Notes\n-\n'
      : '# invalid winner\n';
    let simulated = false;
    const racingFs = {
      ...fs,
      writeFileSync(target, data, options) {
        if (path.resolve(target) === path.resolve(journalPath) && options?.flag === 'wx' && !simulated) {
          simulated = true;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, winnerContent, 'utf8');
          const error = new Error('winner created the file first');
          error.code = 'EEXIST';
          throw error;
        }
        return fs.writeFileSync(target, data, options);
      },
    };
    try {
      const result = lifecycle.ensureTodayJournal({ config, now, fs: racingFs });
      assert.equal(result.outcome, winner === 'healthy' ? 'created-concurrently' : 'invalid-existing');
      assert.equal(fs.readFileSync(journalPath, 'utf8'), winnerContent);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }
});

test('receipt interruption is visible and retry never creates a second journal', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  const now = new Date('2026-08-03T12:00:00.000Z');
  try {
    const failed = lifecycle.ensureTodayJournal({ config, now, beforeReceipt: () => { throw new Error('receipt interruption'); } });
    assert.equal(failed.ok, false);
    assert.equal(failed.outcome, 'receipt-failed');
    assert.equal(fs.readdirSync(journalDir).filter((name) => name.endsWith('.md')).length, 1);
    const retried = lifecycle.ensureTodayJournal({ config, now });
    assert.equal(retried.outcome, 'recovered-after-unrecorded-create');
    assert.equal(fs.readdirSync(journalDir).filter((name) => name.endsWith('.md')).length, 1);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('template configuration failures return a lifecycle result instead of exiting the host process', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  const maintenance = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
  const original = maintenance.readConfig;
  try {
    maintenance.readConfig = () => { throw new Error('malformed template config'); };
    const result = lifecycle.ensureTodayJournal({ config, now: new Date('2026-08-03T12:00:00.000Z') });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason, /malformed template config/);
    assert.equal(fs.existsSync(path.join(journalDir, '2026-08-03.md')), false);
  } finally {
    maintenance.readConfig = original;
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('existing-journal receipt lookup is date-addressable instead of scanning audit history', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  try {
    for (let offset = 0; offset < 30; offset += 1) {
      lifecycle.ensureTodayJournal({
        config,
        now: new Date(Date.UTC(2026, 7, 3 - offset, 12)),
      });
    }

    const receiptDir = path.join(vault, '.jarvos', 'journal-maintenance', 'receipts');
    let receiptReads = 0;
    let receiptListings = 0;
    const countedFs = {
      ...fs,
      readdirSync(target, ...args) {
        if (path.resolve(target) === path.resolve(receiptDir)) receiptListings += 1;
        return fs.readdirSync(target, ...args);
      },
      readFileSync(target, ...args) {
        if (path.resolve(target).startsWith(path.resolve(receiptDir) + path.sep)) receiptReads += 1;
        return fs.readFileSync(target, ...args);
      },
    };
    const historyBefore = fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json')).length;
    const result = lifecycle.ensureTodayJournal({
      config,
      now: new Date('2026-08-03T12:00:00.000Z'),
      fs: countedFs,
    });

    assert.equal(result.outcome, 'healthy-existing');
    assert.equal(receiptListings, 0);
    assert.equal(receiptReads, 1, 'existing-file checks read only the date-addressable sentinel, not audit history');
    assert.equal(
      fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json')).length,
      historyBefore,
      'idempotent confirmations must not create unbounded history files',
    );
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('writer guard blocks overlapping Daily Notes but permits a separate folder', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  const obsidianDir = path.join(vault, '.obsidian');
  try {
    fs.mkdirSync(obsidianDir, { recursive: true });
    fs.writeFileSync(path.join(obsidianDir, 'core-plugins.json'), JSON.stringify({ 'daily-notes': true }));
    const dailyNotesPath = path.join(obsidianDir, 'daily-notes.json');
    fs.writeFileSync(dailyNotesPath, JSON.stringify({ folder: 'Daily' }));

    const separate = lifecycle.ensureTodayJournal({ config, now: new Date('2026-08-03T12:00:00.000Z') });
    assert.equal(separate.outcome, 'created');

    fs.writeFileSync(dailyNotesPath, JSON.stringify({ folder: 'Journal' }));
    const conflict = lifecycle.ensureTodayJournal({ config, now: new Date('2026-08-04T12:00:00.000Z') });
    assert.equal(conflict.outcome, 'blocked-writer-conflict');
    assert.equal(fs.existsSync(path.join(journalDir, '2026-08-04.md')), false);

    fs.writeFileSync(path.join(obsidianDir, 'core-plugins.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(obsidianDir, 'community-plugins.json'), JSON.stringify(['journals']));
    const journalsConflict = lifecycle.ensureTodayJournal({ config, now: new Date('2026-08-05T12:00:00.000Z') });
    assert.equal(journalsConflict.outcome, 'blocked-writer-conflict');

    fs.writeFileSync(path.join(obsidianDir, 'community-plugins.json'), JSON.stringify(['periodic-notes']));
    fs.mkdirSync(path.join(obsidianDir, 'plugins', 'periodic-notes'), { recursive: true });
    fs.writeFileSync(
      path.join(obsidianDir, 'plugins', 'periodic-notes', 'data.json'),
      JSON.stringify({ daily: { enabled: true, folder: 'Journal' } }),
    );
    const periodicConflict = lifecycle.ensureTodayJournal({ config, now: new Date('2026-08-06T12:00:00.000Z') });
    assert.equal(periodicConflict.outcome, 'blocked-writer-conflict');

    fs.writeFileSync(path.join(obsidianDir, 'core-plugins.json'), '{ malformed');
    const unreadable = lifecycle.ensureTodayJournal({ config, now: new Date('2026-08-07T12:00:00.000Z') });
    assert.equal(unreadable.outcome, 'blocked-writer-conflict');
    assert.equal(fs.existsSync(path.join(journalDir, '2026-08-07.md')), false);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('writer guard finds a vault root above a nested journal directory', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-nested-vault-'));
  const journalDir = path.join(vault, 'Notes', 'Journal');
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  try {
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify({ 'daily-notes': true }));
    fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Notes/Journal' }));
    const result = lifecycle.ensureTodayJournal({ config, now: new Date('2026-08-03T12:00:00.000Z') });
    assert.equal(result.outcome, 'blocked-writer-conflict');
    assert.equal(fs.existsSync(path.join(journalDir, '2026-08-03.md')), false);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('health keeps canonical and derived index state separate without repair', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  const now = new Date('2026-08-03T12:00:00.000Z');
  try {
    lifecycle.ensureTodayJournal({ config, now });
    const indexPath = path.join(journalDir, 'Journaling.md');
    fs.writeFileSync(indexPath, '- [[Journal/2026-07-01]]\n', 'utf8');
    const before = fs.readFileSync(indexPath, 'utf8');
    const health = lifecycle.healthToday({ config, now });
    assert.equal(health.canonical.status, 'healthy');
    assert.equal(health.derivedIndex.status, 'unmanaged-derived');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('derived index writer adds today without touching authored journal files', () => {
  const { vault, journalDir } = tempVault();
  const now = new Date('2026-08-08T12:00:00.000Z');
  const config = {
    paths: { journal: journalDir },
    user: { timezone: 'UTC' },
    derivedIndex: { enabled: true, fileName: 'Journaling.md' },
  };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, '2026-08-07.md'), '## 📝 Notes\n- keep me\n', 'utf8');
    fs.writeFileSync(path.join(journalDir, '2026-08-08.md'), '## 📝 Notes\n- today\n', 'utf8');
    const indexPath = path.join(journalDir, 'Journaling.md');
    fs.writeFileSync(indexPath, '![[Journal/2026-08-07.md]]\n', 'utf8');
    const old = new Date(now.getTime() - (10 * 60 * 1000));
    fs.utimesSync(indexPath, old, old);

    const result = lifecycle.ensureIndexEntry({ config, date: '2026-08-08', now, observedMtimeMs: old.getTime() });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'index-updated');
    assert.match(fs.readFileSync(indexPath, 'utf8'), /^!\[\[Journal\/2026-08-08\.md\]\]/);
    assert.match(fs.readFileSync(indexPath, 'utf8'), /!\[\[Journal\/2026-08-07\.md\]\]/);
    const backupDir = path.join(vault, '.jarvos', 'journal-maintenance', 'index-backups');
    assert.equal(fs.readdirSync(backupDir).length, 1);
    assert.deepEqual(
      fs.readdirSync(journalDir).filter((name) => /(?:\.bak|\.tmp|\.partial)$/.test(name)),
      [],
      'generated index staging must remain outside the authored Journal folder',
    );
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('derived index follows the configured journal folder and backfills missed dates', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-derived-folder-'));
  const journalDir = path.join(vault, 'Daily');
  const now = new Date('2026-08-08T12:00:00.000Z');
  const config = {
    paths: { vault, journal: journalDir },
    user: { timezone: 'UTC' },
    derivedIndex: { enabled: true, fileName: 'Journaling.md' },
  };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    for (const date of ['2026-08-06', '2026-08-07', '2026-08-08']) {
      fs.writeFileSync(path.join(journalDir, `${date}.md`), '## 📝 Notes\n- entry\n', 'utf8');
    }
    const indexPath = path.join(journalDir, 'Journaling.md');
    fs.writeFileSync(indexPath, '![[Daily/2026-08-07.md]]\n', 'utf8');
    const old = new Date(now.getTime() - (10 * 60 * 1000));
    fs.utimesSync(indexPath, old, old);

    const result = lifecycle.ensureIndexEntry({ config, date: '2026-08-08', now, observedMtimeMs: old.getTime() });

    assert.equal(result.outcome, 'index-updated');
    assert.deepEqual(
      fs.readFileSync(indexPath, 'utf8').trim().split('\n'),
      [
        '![[Daily/2026-08-08.md]]',
        '',
        '![[Daily/2026-08-07.md]]',
        '',
        '![[Daily/2026-08-06.md]]',
      ],
    );
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('derived index conflict preserves an edit seen before publish', () => {
  const { vault, journalDir } = tempVault();
  const now = new Date('2026-08-08T12:00:00.000Z');
  const config = {
    paths: { journal: journalDir },
    user: { timezone: 'UTC' },
    derivedIndex: { enabled: true, fileName: 'Journaling.md' },
  };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, '2026-08-08.md'), '## 📝 Notes\n- today\n', 'utf8');
    const indexPath = path.join(journalDir, 'Journaling.md');
    const original = '![[Journal/2026-08-07.md]]\n';
    const edited = '![[Journal/2026-08-07.md]]\n![[Journal/2026-08-06.md]]\n';
    fs.writeFileSync(indexPath, original, 'utf8');
    const old = new Date(now.getTime() - (10 * 60 * 1000));
    fs.utimesSync(indexPath, old, old);
    let reads = 0;
    const racingFs = {
      ...fs,
      readFileSync(target, ...args) {
        if (path.resolve(target) === path.resolve(indexPath)) {
          reads += 1;
          if (reads === 2) fs.writeFileSync(indexPath, edited, 'utf8');
        }
        return fs.readFileSync(target, ...args);
      },
    };

    const result = lifecycle.ensureIndexEntry({ config, date: '2026-08-08', now, observedMtimeMs: old.getTime(), fs: racingFs });

    assert.equal(result.outcome, 'index-conflict');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), edited);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('derived index writer refuses missing or human-authored indexes and defers active edits', () => {
  const { vault, journalDir } = tempVault();
  const now = new Date('2026-08-08T12:00:00.000Z');
  const config = {
    paths: { journal: journalDir },
    user: { timezone: 'UTC' },
    derivedIndex: { enabled: true, fileName: 'Journaling.md' },
  };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, '2026-08-08.md'), '## 📝 Notes\n- today\n', 'utf8');
    assert.equal(lifecycle.ensureIndexEntry({ config, date: '2026-08-08', now }).outcome, 'index-unmanaged');

    const indexPath = path.join(journalDir, 'Journaling.md');
    const prose = '# My Journal Index\n\nThis is authored content.\n';
    fs.writeFileSync(indexPath, prose, 'utf8');
    assert.equal(lifecycle.ensureIndexEntry({ config, date: '2026-08-08', now }).outcome, 'index-unmanaged');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), prose);

    fs.writeFileSync(indexPath, '![[Journal/2026-08-07.md]]\n', 'utf8');
    const fresh = lifecycle.ensureIndexEntry({ config, date: '2026-08-08', now });
    assert.equal(fresh.outcome, 'index-deferred');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), '![[Journal/2026-08-07.md]]\n');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('derived index shape accepts nested Journal embeds and treats a listed date as a no-op', () => {
  const { vault, journalDir } = tempVault();
  const config = {
    paths: { journal: journalDir },
    user: { timezone: 'UTC' },
    derivedIndex: { enabled: true, fileName: 'Journaling.md' },
  };
  try {
    fs.mkdirSync(path.join(journalDir, 'Daily notes'), { recursive: true });
    fs.writeFileSync(path.join(journalDir, '2026-08-08.md'), '## 📝 Notes\n- today\n', 'utf8');
    const indexPath = path.join(journalDir, 'Journaling.md');
    fs.writeFileSync(indexPath, '![[Journal/Daily notes/2026-08-08.md]]\n', 'utf8');
    const result = lifecycle.ensureIndexEntry({ config, date: '2026-08-08', now: new Date('2026-08-08T12:00:00.000Z') });
    assert.equal(result.outcome, 'index-healthy');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), '![[Journal/Daily notes/2026-08-08.md]]\n');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('creation maintenance repairs visibility in the same scheduled pass', () => {
  const { vault, journalDir } = tempVault();
  const now = new Date('2026-08-08T12:00:00.000Z');
  const config = {
    paths: { journal: journalDir },
    user: { timezone: 'UTC' },
    derivedIndex: { enabled: true, fileName: 'Journaling.md' },
  };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    const indexPath = path.join(journalDir, 'Journaling.md');
    fs.writeFileSync(indexPath, '![[Journal/2026-08-07.md]]\n', 'utf8');
    const old = new Date(now.getTime() - (10 * 60 * 1000));
    fs.utimesSync(indexPath, old, old);
    const report = lifecycle.runCreationMaintenance(
      { dateSpecs: ['today'] },
      {
        config,
        now,
        mutationExecutor(operation) {
          const target = path.join(vault, operation.vaultRelativePath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, operation.content, { encoding: 'utf8', flag: 'wx' });
          return { status: 'committed' };
        },
      },
    );
    assert.equal(report.status, 'ok');
    assert.equal(report.results[0].outcome, 'created');
    assert.equal(report.indexResults[0].outcome, 'index-updated');
    assert.match(fs.readFileSync(indexPath, 'utf8'), /!\[\[Journal\/2026-08-08\.md\]\]/);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('failed receipt sentinel does not suppress a later recovery receipt', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  const now = new Date('2026-08-08T12:00:00.000Z');
  const journalPath = path.join(journalDir, '2026-08-08.md');
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(journalPath, '# invalid\n', 'utf8');
    assert.equal(lifecycle.ensureTodayJournal({ config, now }).outcome, 'invalid-existing');
    fs.writeFileSync(journalPath, '## 📝 Notes\n- repaired\n', 'utf8');
    const recovered = lifecycle.ensureTodayJournal({ config, now });
    assert.equal(recovered.outcome, 'recovered-after-unrecorded-create');
    const sentinelPath = path.join(vault, '.jarvos', 'journal-maintenance', 'receipts', '2026-08-08.receipt');
    assert.equal(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')).outcome, 'recovered-after-unrecorded-create');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('creation maintenance fails when derived index publication fails', () => {
  const { vault, journalDir } = tempVault();
  const now = new Date('2026-08-08T12:00:00.000Z');
  const config = {
    paths: { journal: journalDir },
    user: { timezone: 'UTC' },
    derivedIndex: { enabled: true, fileName: 'Journaling.md' },
  };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    const indexPath = path.join(journalDir, 'Journaling.md');
    fs.writeFileSync(indexPath, '![[Journal/2026-08-07.md]]\n', 'utf8');
    const old = new Date(now.getTime() - (10 * 60 * 1000));
    fs.utimesSync(indexPath, old, old);
    const failingFs = {
      ...fs,
      renameSync(source, target) {
        if (path.resolve(target) === path.resolve(indexPath)) {
          const error = new Error('index unavailable');
          error.code = 'EIO';
          throw error;
        }
        return fs.renameSync(source, target);
      },
    };
    const report = lifecycle.runCreationMaintenance({ dateSpecs: ['today'] }, { config, now, fs: failingFs });
    assert.equal(report.status, 'failed');
    assert.equal(report.indexResults[0].outcome, 'index-failed');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('filesystem mutation lock preserves compare-before-write semantics', () => {
  const { vault, journalDir } = tempVault();
  const journalPath = path.join(journalDir, '2026-08-03.md');
  const original = '## 📝 Notes\n- original\n';
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(journalPath, original, 'utf8');
    assert.deepEqual(
      lifecycle.mutateExistingJournal({ journalPath, expectedContent: original, nextContent: '## 📝 Notes\n- next\n' }),
      { changed: true },
    );
    assert.equal(fs.existsSync(`${journalPath}.lock`), false);
    assert.throws(
      () => lifecycle.mutateExistingJournal({ journalPath, expectedContent: original, nextContent: '## 📝 Notes\n- stale\n' }),
      /changed before mutation/,
    );
    assert.equal(fs.readFileSync(journalPath, 'utf8'), '## 📝 Notes\n- next\n');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('stale mutation lock is reclaimed only after its owner is gone', () => {
  const { vault, journalDir } = tempVault();
  const journalPath = path.join(journalDir, '2026-08-03.md');
  const lockPath = `${journalPath}.lock`;
  const original = '## 📝 Notes\n- original\n';
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(journalPath, original, 'utf8');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'dead-owner' }), 'utf8');
    const stale = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(lockPath, stale, stale);

    assert.deepEqual(
      lifecycle.mutateExistingJournal({ journalPath, expectedContent: original, nextContent: '## 📝 Notes\n- recovered\n' }),
      { changed: true },
    );
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), '## 📝 Notes\n- recovered\n');
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('stale-lock reclaim never removes a replacement lock installed during takeover', () => {
  const { vault, journalDir } = tempVault();
  const journalPath = path.join(journalDir, '2026-08-03.md');
  const lockPath = `${journalPath}.lock`;
  const original = '## 📝 Notes\n- original\n';
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(journalPath, original, 'utf8');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, token: 'dead-owner' }), 'utf8');
    const stale = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(lockPath, stale, stale);
    let interleaved = false;
    const racingFs = {
      ...fs,
      renameSync(source, target, ...args) {
        const claimedStaleLock = path.resolve(source) === path.resolve(lockPath)
          && path.basename(target).includes('.stale.');
        const result = fs.renameSync(source, target, ...args);
        if (claimedStaleLock && !interleaved) {
          interleaved = true;
          fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement-owner' }), 'utf8');
        }
        return result;
      },
    };

    assert.throws(
      () => lifecycle.mutateExistingJournal({ journalPath, expectedContent: original, nextContent: '## 📝 Notes\n- lost\n', fsImpl: racingFs }),
      /Timed out locking canonical journal mutation/,
    );
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'replacement-owner');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), original);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('writer conflicts and filesystem failures remain visible without a journal write', () => {
  const { vault, journalDir } = tempVault();
  const config = { paths: { journal: journalDir }, user: { timezone: 'UTC' } };
  const now = new Date('2026-08-03T12:00:00.000Z');
  try {
    const conflict = lifecycle.ensureTodayJournal({ config, now, writerGuard: { ok: false } });
    assert.equal(conflict.outcome, 'blocked-writer-conflict');
    assert.equal(conflict.ok, false);
    assert.equal(fs.existsSync(journalDir), false);

    const failingFs = { ...fs, writeFileSync() { const error = new Error('disk unavailable'); error.code = 'EIO'; throw error; } };
    const failure = lifecycle.ensureTodayJournal({ config, now, fs: failingFs });
    assert.equal(failure.outcome, 'failed');
    assert.equal(failure.ok, false);
    assert.equal(fs.existsSync(path.join(journalDir, '2026-08-03.md')), false);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
