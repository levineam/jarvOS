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
    assert.equal(health.derivedIndex.status, 'stale-derived');
    assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
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
