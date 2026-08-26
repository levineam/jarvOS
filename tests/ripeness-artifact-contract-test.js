'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  RIPENESS_ARTIFACT_SCHEMA_VERSION,
  computeRipenessArtifactDigest,
  localDateFor,
  validateRipenessArtifact,
} = require('../modules/jarvos-secondbrain/bridge/provenance/src/ripeness-artifact-contract');

function artifact(overrides = {}) {
  const value = {
    schemaVersion: RIPENESS_ARTIFACT_SCHEMA_VERSION,
    asOf: '2026-08-10',
    effectiveAt: '2026-08-10T05:00:00.000Z',
    timeZone: 'America/New_York',
    producer: {
      engine: 'ripeness-nudge',
      version: 'test-engine-v1',
      runId: 'run_test_123',
      configDigest: crypto.createHash('sha256').update('config').digest('hex'),
    },
    publication: { state: 'published' },
    themes: [{
      days: 3,
      spanDays: 14,
      firstSeen: '2026-07-27',
      lastSeen: '2026-08-09',
      qualifyingHumanDays: 2,
      originCounts: { human: 2, assistant: 1, mixed: 0, unknown: 0 },
      fragments: [{
        date: '2026-08-09',
        text: 'Synthetic recurring thought.',
        content_origin: 'human',
        content_origin_basis: 'verbatim_user',
        human_evidence_eligible: true,
      }],
      qualifyingHumanSupport: [{
        id: 'human-support-1',
        date: '2026-08-09',
        content_origin: 'human',
        content_origin_basis: 'verbatim_user',
        human_evidence_eligible: true,
      }],
      contextSupport: [{
        id: 'assistant-support-1',
        date: '2026-08-08',
        content_origin: 'assistant',
        content_origin_basis: 'assistant_generated',
        human_evidence_eligible: false,
      }],
      support: ['Synthetic support'],
    }],
    ...overrides,
  };
  value.outputDigest = computeRipenessArtifactDigest(value);
  return value;
}

const now = new Date('2026-08-10T12:00:00.000Z');

test('validates a fresh, published artifact and accepts fresh empty output', () => {
  assert.equal(localDateFor(now, 'America/New_York'), '2026-08-10');
  assert.deepEqual(validateRipenessArtifact(artifact(), { now }), { ok: true, status: 'fresh', artifact: artifact() });
  assert.equal(validateRipenessArtifact(artifact({ themes: [] }), { now }).status, 'fresh_empty');
});

test('fails closed on future, stale, unknown schema, digest, provenance, and bounded-row defects', () => {
  assert.equal(validateRipenessArtifact(artifact({ asOf: '2026-08-11' }), { now }).ok, false);
  assert.equal(validateRipenessArtifact(artifact({ asOf: '2026-08-09' }), { now }).ok, false);
  assert.equal(validateRipenessArtifact(artifact({ schemaVersion: 'unknown/v9' }), { now }).ok, false);
  const digestMismatch = artifact(); digestMismatch.outputDigest = '0'.repeat(64);
  assert.equal(validateRipenessArtifact(digestMismatch, { now }).ok, false);
  const noRun = artifact(); delete noRun.producer.runId; noRun.outputDigest = computeRipenessArtifactDigest(noRun);
  assert.equal(validateRipenessArtifact(noRun, { now }).ok, false);
  assert.equal(validateRipenessArtifact(artifact({ themes: Array.from({ length: 4 }, () => artifact().themes[0]) }), { now }).ok, false);
});

test('assistant-only themes cannot validate and legacy artifacts are explicitly non-qualifying', () => {
  const assistantOnly = artifact({
    themes: [{
      ...artifact().themes[0],
      originCounts: { human: 0, assistant: 3, mixed: 0, unknown: 0 },
      qualifyingHumanDays: 0,
      qualifyingHumanSupport: [],
      fragments: [],
      contextSupport: [{
        id: 'assistant-only',
        date: '2026-08-09',
        content_origin: 'assistant',
        content_origin_basis: 'assistant_generated',
        human_evidence_eligible: false,
      }],
    }],
  });
  assert.equal(validateRipenessArtifact(assistantOnly, { now }).ok, false);

  const legacy = artifact({ schemaVersion: 'jarvos-ripeness-artifact/v1' });
  assert.deepEqual(validateRipenessArtifact(legacy, { now }), {
    ok: false,
    status: 'legacy_non_qualifying',
    artifact: null,
    legacy: true,
  });
});

test('artifact digest covers origin composition and eligibility fields', () => {
  const changed = artifact();
  changed.themes[0].contextSupport[0].content_origin = 'mixed';
  changed.themes[0].contextSupport[0].content_origin_basis = 'mixed_composition';
  changed.outputDigest = computeRipenessArtifactDigest(changed);
  assert.equal(validateRipenessArtifact(changed, { now }).ok, true);

  changed.themes[0].qualifyingHumanSupport[0].human_evidence_eligible = false;
  assert.equal(validateRipenessArtifact(changed, { now }).ok, false);
});
