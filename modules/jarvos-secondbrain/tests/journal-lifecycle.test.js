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
