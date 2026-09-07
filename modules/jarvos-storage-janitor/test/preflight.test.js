'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeCapacityPreflight, DISPOSITIONS } = require('../src/preflight');

const NOW = '2026-09-03T12:01:00.000Z';

function policy(overrides = {}) {
  return {
    version: 'jarvos-storage-janitor.policy.v1',
    policyId: 'policy:default',
    requiredBytes: 1073741824,
    safetyMarginBytes: 104857600,
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    version: 'jarvos-storage-janitor.observation.v1',
    candidateSetId: null,
    observedAt: '2026-09-03T12:00:00.000Z',
    freshUntil: '2026-09-03T12:05:00.000Z',
    bytesAvailable: 2147483648,
    bytesTotal: 1000000000000,
    ...overrides,
  };
}

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

test('fresh sufficient capacity proceeds', () => {
  const result = computeCapacityPreflight({ observation: observation(), policy: policy(), now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.disposition, 'proceed');
  assert.ok(DISPOSITIONS.includes(result.disposition));
});

test('insufficient capacity without candidates is blocked', () => {
  const result = computeCapacityPreflight({
    observation: observation({ bytesAvailable: 627048448 }),
    policy: policy(),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'blocked');
});

test('insufficient capacity with bounded exact candidates recommends external reclaim', () => {
  const result = computeCapacityPreflight({
    observation: observation({ bytesAvailable: 627048448 }),
    policy: policy(),
    now: NOW,
    candidates: [candidate(), candidate({ candidateId: 'candidate:archive-002' })],
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'recommend_external_reclaim');
  assert.ok(typeof result.candidateSetDigest === 'string' && result.candidateSetDigest.length === 64);
});

test('candidates that cannot bridge the gap still block rather than recommend', () => {
  const result = computeCapacityPreflight({
    observation: observation({ bytesAvailable: 100 }),
    policy: policy({ requiredBytes: 1000000000000 }),
    now: NOW,
    candidates: [candidate({ estimatedBytes: 10 })],
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'blocked');
});

test('an ineligible candidate set cannot be credited toward reclaim, and its errors are preserved', () => {
  const result = computeCapacityPreflight({
    observation: observation({ bytesAvailable: 627048448 }),
    policy: policy(),
    now: NOW,
    candidates: [candidate({ protected: true })],
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'blocked');
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => /not eligible/i.test(e)));
});

test('invalid observation fails closed', () => {
  const result = computeCapacityPreflight({ observation: observation({ bytesAvailable: -1 }), policy: policy(), now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'blocked');
  assert.ok(result.errors.length > 0);
});

test('invalid policy fails closed', () => {
  const result = computeCapacityPreflight({ observation: observation(), policy: policy({ requiredBytes: -1 }), now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'blocked');
});

test('stale observation fails closed even with sufficient bytes', () => {
  const result = computeCapacityPreflight({ observation: observation(), policy: policy(), now: '2026-09-03T12:10:00.000Z' });
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'blocked');
});

test('a missing now fails closed to blocked', () => {
  const result = computeCapacityPreflight({ observation: observation(), policy: policy() });
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'blocked');
  assert.ok(result.errors.some((e) => /now/i.test(e)));
});

test('a malformed (zoneless) now fails closed to blocked', () => {
  const result = computeCapacityPreflight({ observation: observation(), policy: policy(), now: '2026-09-03T12:01:00' });
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'blocked');
});

test('a required-total byte-sum overflow fails closed to blocked', () => {
  const result = computeCapacityPreflight({
    observation: observation({ bytesAvailable: Number.MAX_SAFE_INTEGER, bytesTotal: Number.MAX_SAFE_INTEGER }),
    policy: policy({ requiredBytes: Number.MAX_SAFE_INTEGER - 5, safetyMarginBytes: 10 }),
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'blocked');
  assert.ok(result.errors.some((e) => /overflow/i.test(e)));
});

test('a candidate-set byte-sum overflow fails closed to blocked', () => {
  const result = computeCapacityPreflight({
    observation: observation({ bytesAvailable: 0, bytesTotal: Number.MAX_SAFE_INTEGER }),
    policy: policy({ requiredBytes: Number.MAX_SAFE_INTEGER - 1, safetyMarginBytes: 0 }),
    now: NOW,
    candidates: [
      candidate({ candidateId: 'candidate:one', estimatedBytes: Number.MAX_SAFE_INTEGER - 1 }),
      candidate({ candidateId: 'candidate:two', estimatedBytes: Number.MAX_SAFE_INTEGER - 1 }),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'blocked');
  assert.ok(result.errors.some((e) => /overflow/i.test(e)));
});

test('preflight fails closed on a cyclic observation rather than crashing', () => {
  const cyclicObservation = observation();
  cyclicObservation.self = cyclicObservation;
  const result = computeCapacityPreflight({ observation: cyclicObservation, policy: policy(), now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'blocked');
});
