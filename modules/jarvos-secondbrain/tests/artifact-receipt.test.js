'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const receipt = require('../src/artifact-receipt');

test('artifact records validate kinds, canonical paths, and outcomes', () => {
  assert.deepEqual(receipt.createArtifactRecord({
    kind: 'note',
    vaultRelativePath: 'Notes/Über.md',
    outcome: 'committed',
  }), {
    schemaVersion: receipt.ARTIFACT_RECEIPT_SCHEMA_VERSION,
    kind: 'note',
    vaultRelativePath: 'Notes/Über.md',
    outcome: 'committed',
  });
  assert.equal(receipt.outcomeFromMutationResult({ savedLocally: true }), 'saved_locally_sync_pending');
  assert.equal(receipt.outcomeFromMutationResult({ deferred: true }), 'deferred');
  assert.throws(() => receipt.createArtifactRecord({ kind: 'note', vaultRelativePath: 'Notes/a.md', outcome: 'committed', extra: true }), /unknown field/);
  assert.throws(() => receipt.createArtifactRecord({ kind: 'image', vaultRelativePath: 'Notes/a.md', outcome: 'committed' }), /kind/);
  assert.throws(() => receipt.createArtifactRecord({ kind: 'note', vaultRelativePath: 'Notes/a.txt', outcome: 'committed' }), /Markdown/);
});

test('NFD paths normalize to one NFC artifact and unsafe path forms fail closed', () => {
  const nfd = 'Notes/Cafe\u0301.md';
  const nfc = 'Notes/Café.md';
  const normalized = receipt.createArtifactRecord({ kind: 'note', vaultRelativePath: nfd, outcome: 'committed' });
  assert.equal(normalized.vaultRelativePath, nfc);
  const aggregate = receipt.aggregateArtifactRecords([
    { record: { kind: 'note', vaultRelativePath: nfd, outcome: 'committed' }, intent: 'user_requested' },
    { record: { kind: 'note', vaultRelativePath: nfc, outcome: 'deferred' }, intent: 'auxiliary' },
  ]);
  assert.equal(aggregate.length, 1);
  assert.equal(aggregate[0].outcome, 'committed');

  for (const candidate of [
    '../outside.md',
    '/tmp/outside.md',
    'Notes/../outside.md',
    'Notes\\outside.md',
    'Notes/a%2Fb.md',
    'Notes/a#b.md',
    'Notes/a\n b.md',
  ]) {
    assert.throws(() => receipt.createArtifactRecord({ kind: 'note', vaultRelativePath: candidate, outcome: 'committed' }), /canonical|traversal|segments/);
  }
});

test('user-requested outcome takes precedence over auxiliary backlink evidence', () => {
  const records = receipt.aggregateArtifactRecords([
    { record: { kind: 'journal', vaultRelativePath: 'Journal/2026-08-10.md', outcome: 'already_satisfied' }, intent: 'auxiliary' },
    { record: { kind: 'journal', vaultRelativePath: 'Journal/2026-08-10.md', outcome: 'committed' }, intent: 'user_requested' },
    { record: { kind: 'journal', vaultRelativePath: 'Journal/2026-08-10.md', outcome: 'deferred' }, intent: 'auxiliary' },
  ]);
  assert.deepEqual(records, [{
    schemaVersion: receipt.ARTIFACT_RECEIPT_SCHEMA_VERSION,
    kind: 'journal',
    vaultRelativePath: 'Journal/2026-08-10.md',
    outcome: 'committed',
  }]);
});

test('receipt validation rejects unknown schema and duplicate normalized paths', () => {
  assert.throws(() => receipt.validateArtifactReceipt({ schemaVersion: 'wrong', artifacts: [] }), /schemaVersion/);
  assert.throws(() => receipt.validateArtifactReceipt({
    schemaVersion: receipt.ARTIFACT_RECEIPT_SCHEMA_VERSION,
    artifacts: [
      { kind: 'note', vaultRelativePath: 'Notes/Café.md', outcome: 'committed' },
      { kind: 'note', vaultRelativePath: 'Notes/Cafe\u0301.md', outcome: 'committed' },
    ],
  }), /duplicate/);
});

test('artifact kind is constrained to its public vault directory', () => {
  assert.throws(() => receipt.createArtifactRecord({ kind: 'note', vaultRelativePath: 'Journal/wrong-kind.md', outcome: 'committed' }), /Notes/);
  assert.throws(() => receipt.createArtifactRecord({ kind: 'journal', vaultRelativePath: 'Notes/wrong-kind.md', outcome: 'committed' }), /Journal/);
  assert.equal(receipt.receiptIsAcknowledged({
    schemaVersion: receipt.ARTIFACT_RECEIPT_SCHEMA_VERSION,
    artifacts: [{ kind: 'note', vaultRelativePath: 'Notes/ok.md', outcome: 'already_satisfied' }],
  }), true);
  assert.equal(receipt.receiptIsAcknowledged({
    schemaVersion: receipt.ARTIFACT_RECEIPT_SCHEMA_VERSION,
    artifacts: [{ kind: 'note', vaultRelativePath: 'Notes/pending.md', outcome: 'saved_locally_sync_pending' }],
  }), false);
});
