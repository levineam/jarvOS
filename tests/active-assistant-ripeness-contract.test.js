'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('../scripts/lib/active-assistant-ripeness-contract');

const NOW = new Date('2026-07-27T16:00:00.000Z');

function artifact(themes = []) {
  const doc = {
    schemaVersion: contract.ACTIVE_ASSISTANT_RIPENESS_CONTRACT_VERSION,
    asOf: '2026-07-27',
    effectiveAt: '2026-07-27T08:00:00-04:00',
    timezone: 'America/New_York',
    producerRunId: 'run-20260727-080000',
    engine: { name: 'ripeness', version: '1.0.0' },
    configDigest: 'a'.repeat(64),
    outputDigest: '0'.repeat(64),
    provenance: { publicationState: 'published', producerArtifactDigest: '0'.repeat(64) },
    themes,
  };
  const digest = contract.artifactDigest(doc);
  doc.outputDigest = digest;
  doc.provenance.producerArtifactDigest = digest;
  return doc;
}

test('accepts a current empty artifact and exposes a stable digest contract', () => {
  const doc = artifact();
  const result = contract.validateRipenessArtifact(doc, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.value.outputDigest, contract.artifactDigest(doc));
});

test('accepts a bounded theme row without inspecting its meaning', () => {
  const doc = artifact([{
    days: 2,
    spanDays: 8,
    firstSeen: '2026-07-19',
    lastSeen: '2026-07-26',
    fragments: [{ date: '2026-07-26', text: 'opaque synthetic fragment' }],
    support: ['Synthetic Note'],
  }]);
  assert.equal(contract.validateRipenessArtifact(doc, { now: NOW }).ok, true);
});

for (const [label, mutate, reasonCode] of [
  ['rejects a future date', (doc) => { doc.asOf = '2026-07-28'; }, 'as_of_not_current_local_date'],
  ['rejects an unknown schema', (doc) => { doc.schemaVersion = 'ripeness-themes/v0'; }, 'unsupported_schema_version'],
  ['rejects missing provenance', (doc) => { delete doc.provenance; }, 'malformed_envelope'],
  ['rejects a digest mismatch', (doc) => { doc.outputDigest = 'b'.repeat(64); }, 'digest_mismatch'],
  ['rejects an unbounded row', (doc) => { doc.themes = Array.from({ length: 13 }, () => []); }, 'unbounded_or_malformed_themes'],
]) {
  test(label, () => {
    const doc = artifact();
    mutate(doc);
    assert.equal(contract.validateRipenessArtifact(doc, { now: NOW }).reasonCode, reasonCode);
  });
}

test('does not accept unknown envelope fields', () => {
  const doc = artifact();
  doc.personalContent = 'must not become part of the public contract';
  assert.equal(contract.validateRipenessArtifact(doc, { now: NOW }).reasonCode, 'malformed_envelope');
});
