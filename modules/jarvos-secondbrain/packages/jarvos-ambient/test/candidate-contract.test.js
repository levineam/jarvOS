'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../src/intent/candidate-contract');
const intent = require('../src/intent');
const ambient = require('../src');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function makeCandidate(overrides = {}) {
  return {
    schemaVersion: 'jarvos.candidate.v1',
    candidateId: 'jarvos:candidate:ambient:c-0001',
    candidateType: 'memory-unit',
    authority: 'non-authoritative',
    sources: [
      { sourceEventId: 'jarvos:source-event:ambient:e-0001', evidenceDigest: DIGEST_A },
    ],
    privacyTier: 'local-private',
    sourceTrust: 'user-authored',
    construction: {
      extractorId: 'salience-detector',
      extractorVersion: '2.0.0',
      eligibilityPolicyId: 'jarvos:policy:ambient:eligibility-v1',
    },
    dedupeKey: 'memory-unit:local-private:0001',
    createdAt: '2026-08-31T12:00:00Z',
    expiresAt: '2026-09-30T12:00:00Z',
    proposal: {
      title: 'Prefer pure contracts before consumers',
      summary: 'The author decided to land validators and fixtures before any store or writer.',
    },
    ...overrides,
  };
}

test('exposes a stable schema version, literal authority, and frozen enums', () => {
  assert.equal(contract.CANDIDATE_SCHEMA_VERSION, 'jarvos.candidate.v1');
  assert.equal(contract.CANDIDATE_AUTHORITY, 'non-authoritative');
  assert.ok(Object.isFrozen(contract.CANDIDATE_TYPES));
  assert.ok(Object.isFrozen(contract.CANDIDATE_PRIVACY_TIERS));
  assert.ok(Object.isFrozen(contract.CANDIDATE_SOURCE_TRUST));
});

test('the contract is reachable through the intent namespace and package subpath', () => {
  assert.equal(intent.validateCandidate, contract.validateCandidate);
  assert.equal(intent.assertCandidate, contract.assertCandidate);
  assert.equal(ambient.validateCandidate, contract.validateCandidate);
});

test('the module exposes no recall, completion, write, store, or promotion function', () => {
  assert.deepEqual(Object.keys(contract).sort(), [
    'CANDIDATE_AUTHORITY',
    'CANDIDATE_PRIVACY_TIERS',
    'CANDIDATE_SCHEMA_VERSION',
    'CANDIDATE_SOURCE_TRUST',
    'CANDIDATE_TYPES',
    'assertCandidate',
    'validateCandidate',
  ]);
});

test('valid candidate types assert as immutable copies without mutation powers', () => {
  for (const candidateType of contract.CANDIDATE_TYPES) {
    const candidate = makeCandidate({ candidateType });
    assert.deepEqual(contract.validateCandidate(candidate), [], candidateType);
    const asserted = contract.assertCandidate(candidate);
    assert.notEqual(asserted, candidate);
    assert.deepEqual(asserted, candidate);
    assert.ok(Object.isFrozen(asserted));
    assert.ok(Object.isFrozen(asserted.sources));
    assert.ok(Object.isFrozen(asserted.sources[0]));
    assert.ok(Object.isFrozen(asserted.proposal));
    candidate.proposal.title = 'mutable input';
    assert.notEqual(asserted.proposal.title, candidate.proposal.title);
    assert.throws(() => { asserted.proposal.title = 'cannot mutate'; }, TypeError);
  }
});

test('project signals cannot attach or mint a Project identity', () => {
  assert.ok(contract.validateCandidate(makeCandidate({
    candidateType: 'project-signal',
    projectId: 'jarvos:project:ambient:p-0001',
  })).length > 0);
});

test('unknown version, type, authority, and mutable or authoritative fields fail closed', () => {
  assert.ok(contract.validateCandidate(makeCandidate({ schemaVersion: 'jarvos.candidate.v2' })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ candidateType: 'authoritative-memory' })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ authority: 'authoritative' })).length > 0);
  for (const extra of ['authoritative', 'verified', 'completed', 'status', 'destination', 'recallText', 'text', 'content', 'transcript']) {
    assert.ok(contract.validateCandidate(makeCandidate({ [extra]: 'x' })).length > 0, extra);
  }
});

test('secret privacy and ineligible trust values are not representable', () => {
  assert.ok(contract.validateCandidate(makeCandidate({ privacyTier: 'secret' })).length > 0);
  for (const sourceTrust of ['untrusted', 'tool', 'unknown', 'tool-output']) {
    assert.ok(contract.validateCandidate(makeCandidate({ sourceTrust })).length > 0, sourceTrust);
  }
  assert.deepEqual(contract.validateCandidate(makeCandidate({ sourceTrust: 'assistant-derived' })), []);
});

test('sources must be unique evidence pointers with source-event identities and sha256 digests', () => {
  assert.ok(contract.validateCandidate(makeCandidate({ sources: [] })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({
    sources: [
      { sourceEventId: 'jarvos:source-event:ambient:e-0001', evidenceDigest: DIGEST_A },
      { sourceEventId: 'jarvos:source-event:ambient:e-0001', evidenceDigest: DIGEST_B },
    ],
  })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({
    sources: [{ sourceEventId: 'jarvos:candidate:ambient:e-0001', evidenceDigest: DIGEST_A }],
  })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({
    sources: [{ sourceEventId: 'jarvos:source-event:ambient:e-0001', evidenceDigest: 'md5:short' }],
  })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({
    sources: [{ sourceEventId: 'jarvos:source-event:ambient:e-0001', evidenceDigest: DIGEST_A, recallText: 'x' }],
  })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ sources: new Array(1) })).length > 0);
});

test('construction rejects the wrong identity kind and unknown nested fields', () => {
  assert.ok(contract.validateCandidate(makeCandidate({
    construction: { extractorId: 'x', extractorVersion: '1.0.0', eligibilityPolicyId: 'jarvos:candidate:ambient:not-a-policy' },
  })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({
    construction: {
      extractorId: 'x', extractorVersion: '1.0.0',
      eligibilityPolicyId: 'jarvos:policy:ambient:eligibility-v1', recallText: 'x',
    },
  })).length > 0);
});

test('proposal is bounded to title and summary', () => {
  assert.ok(contract.validateCandidate(makeCandidate({
    proposal: { title: 'ok', summary: 'ok', text: 'raw' },
  })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ proposal: { title: 'only title' } })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ proposal: { title: '', summary: 'x' } })).length > 0);
});

test('timestamps must be real ISO instants with expiry after creation', () => {
  assert.ok(contract.validateCandidate(makeCandidate({ createdAt: '2026-08-31' })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ createdAt: '2026-13-31T00:00:00Z' })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ createdAt: '2026-02-30T00:00:00Z' })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({ expiresAt: undefined })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({
    createdAt: '2026-08-31T12:00:00Z', expiresAt: '2026-08-31T12:00:00Z',
  })).length > 0);
  assert.ok(contract.validateCandidate(makeCandidate({
    createdAt: '2026-09-30T12:00:00Z', expiresAt: '2026-08-31T12:00:00Z',
  })).length > 0);
  assert.deepEqual(contract.validateCandidate(makeCandidate({
    createdAt: '0000-02-29T00:00:00Z', expiresAt: '0000-03-01T00:00:00Z',
  })), []);
  for (const createdAt of ['2026-08-31T12:00:00+14:01', '2026-08-31T12:00:00-14:01', '2026-08-31T12:00:00+23:59']) {
    assert.ok(contract.validateCandidate(makeCandidate({ createdAt })).length > 0, createdAt);
  }
});

test('non-object input fails closed and assertion throws on invalid input', () => {
  for (const value of [null, undefined, 'candidate', 42, []]) {
    assert.ok(contract.validateCandidate(value).length > 0);
  }
  assert.throws(() => contract.assertCandidate(makeCandidate({ authority: 'authoritative' })), /candidate/);
});
