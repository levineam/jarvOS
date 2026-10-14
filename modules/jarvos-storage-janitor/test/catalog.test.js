'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  validateCandidate,
  isEligibleCandidate,
  validateCandidateSet,
  computeCandidateSetDigest,
} = require('../src/catalog');

function candidate(overrides = {}) {
  return {
    version: 'jarvos-storage-janitor.candidate.v1',
    candidateId: 'candidate:archive-001',
    kind: 'opaque-resource-kind',
    estimatedBytes: 500000000,
    protected: false,
    unknown: false,
    active: false,
    dirty: false,
    transitionNeeded: false,
    ...overrides,
  };
}

test('accepts a well-formed, eligible candidate', () => {
  const c = candidate();
  const result = validateCandidate(c);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(isEligibleCandidate(c), true);
});

test('rejects a missing candidate', () => {
  assert.equal(validateCandidate(undefined).ok, false);
});

test('rejects a non-opaque candidateId', () => {
  const result = validateCandidate(candidate({ candidateId: '/resource/example-001' }));
  assert.equal(result.ok, false);
});

test('protected candidates are structurally valid but ineligible', () => {
  const c = candidate({ protected: true });
  assert.equal(validateCandidate(c).ok, true);
  assert.equal(isEligibleCandidate(c), false);
});

test('unknown candidates are ineligible', () => {
  assert.equal(isEligibleCandidate(candidate({ unknown: true })), false);
});

test('active candidates are ineligible', () => {
  assert.equal(isEligibleCandidate(candidate({ active: true })), false);
});

test('dirty candidates are ineligible', () => {
  assert.equal(isEligibleCandidate(candidate({ dirty: true })), false);
});

test('transition-needed candidates are ineligible', () => {
  assert.equal(isEligibleCandidate(candidate({ transitionNeeded: true })), false);
});

test('rejects negative estimatedBytes', () => {
  const result = validateCandidate(candidate({ estimatedBytes: -1 }));
  assert.equal(result.ok, false);
});

test('validateCandidateSet rejects a set containing an ineligible candidate', () => {
  const set = [candidate(), candidate({ candidateId: 'candidate:protected-001', protected: true })];
  const result = validateCandidateSet(set);
  assert.equal(result.ok, false);
});

test('validateCandidateSet accepts an all-eligible set', () => {
  const set = [candidate(), candidate({ candidateId: 'candidate:archive-002' })];
  const result = validateCandidateSet(set);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('computeCandidateSetDigest is deterministic and order-independent', () => {
  const a = [candidate(), candidate({ candidateId: 'candidate:archive-002' })];
  const b = [a[1], a[0]];
  assert.equal(computeCandidateSetDigest(a), computeCandidateSetDigest(b));
});

test('computeCandidateSetDigest changes when the candidate set changes', () => {
  const a = [candidate()];
  const b = [candidate({ candidateId: 'candidate:archive-002' })];
  assert.notEqual(computeCandidateSetDigest(a), computeCandidateSetDigest(b));
});

test('rejects a candidate carrying an unrecognized extra field', () => {
  const result = validateCandidate(candidate({ unexpectedField: 'x' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unexpectedField/.test(e)));
});

test('validateCandidate fails closed on a cyclic candidate rather than crashing', () => {
  const cyclic = candidate();
  cyclic.self = cyclic;
  const result = validateCandidate(cyclic);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /circular/i.test(e)));
});

test('validateCandidateSet fails closed on a too-deep candidate rather than crashing', () => {
  let deep = {};
  let cursor = deep;
  for (let i = 0; i < 1000; i += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  const set = [candidate({ nested: deep })];
  const result = validateCandidateSet(set);
  assert.equal(result.ok, false);
});
