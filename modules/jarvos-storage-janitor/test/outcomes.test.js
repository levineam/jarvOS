'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { TERMINAL_OUTCOMES, createCapacityPreflightReceipt, authorizeReclaimReservation } = require('../src/outcomes');
const { DISPOSITIONS, computeCapacityPreflight } = require('../src/preflight');
const { computeCandidateSetDigest } = require('../src/catalog');
const { createMemoryReservationStore } = require('../src/reservation-store');
const { digestOf } = require('../src/primitives');

// A synthetic incident begins near 598 MiB available.
const INCIDENT_BYTES_AVAILABLE = 627048448; // ~598 MiB
const NOW_INCIDENT = '2026-09-03T12:00:00.000Z';
const NOW_REMEASURED = '2026-09-03T12:10:00.000Z';
const CANDIDATE_BYTES = 700000000;
const POOL_ID = 'pool:incident-001';
const POOL_CAPACITY_BYTES = 4000000000;

const POLICY = {
  version: 'jarvos-storage-janitor.policy.v1',
  policyId: 'policy:incident-001',
  requiredBytes: 1073741824,
  safetyMarginBytes: 104857600,
};
const POLICY_DIGEST = digestOf(POLICY);
const POLICY_REQUIRED_TOTAL = POLICY.requiredBytes + POLICY.safetyMarginBytes;

function observation(overrides = {}) {
  return {
    version: 'jarvos-storage-janitor.observation.v1',
    candidateSetId: null,
    observedAt: NOW_INCIDENT,
    freshUntil: '2026-09-03T12:05:00.000Z',
    bytesAvailable: INCIDENT_BYTES_AVAILABLE,
    bytesTotal: 1000000000000,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    version: 'jarvos-storage-janitor.candidate.v1',
    candidateId: 'candidate:archive-001',
    kind: 'opaque-resource-kind',
    estimatedBytes: CANDIDATE_BYTES,
    protected: false,
    unknown: false,
    active: false,
    dirty: false,
    transitionNeeded: false,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    version: 'jarvos-storage-janitor.reclaim-receipt.v1',
    runId: 'run:incident-001',
    policyDigest: POLICY_DIGEST,
    candidateSetDigest: null,
    fence: 1,
    dryRun: true,
    outcome: 'verified',
    bytesReclaimed: 0,
    observedAt: NOW_INCIDENT,
    ...overrides,
  };
}

function buildIncident() {
  const candidates = [candidate()];
  const preflight = computeCapacityPreflight({ observation: observation(), policy: POLICY, now: NOW_INCIDENT, candidates });
  assert.equal(preflight.disposition, 'recommend_external_reclaim');
  const candidateSetDigest = computeCandidateSetDigest(candidates);
  const expected = { runId: 'run:incident-001', policyDigest: POLICY_DIGEST, candidateSetDigest, fence: 1, maxCreditableBytes: CANDIDATE_BYTES };
  const evidence = {
    dryRunReceipt: receipt({ dryRun: true, outcome: 'verified', bytesReclaimed: CANDIDATE_BYTES, candidateSetDigest, observedAt: '2026-09-03T12:06:00.000Z' }),
    terminalReceipt: receipt({ dryRun: false, outcome: 'verified', bytesReclaimed: CANDIDATE_BYTES, candidateSetDigest, observedAt: '2026-09-03T12:07:00.000Z' }),
  };
  const remeasurement = observation({
    bytesAvailable: INCIDENT_BYTES_AVAILABLE + CANDIDATE_BYTES,
    observedAt: NOW_REMEASURED,
    freshUntil: '2026-09-03T12:15:00.000Z',
  });
  return { candidates, preflight, candidateSetDigest, expected, evidence, remeasurement };
}

function authorizeArgs(overrides = {}) {
  const { expected, evidence, remeasurement } = buildIncident();
  return {
    evidence,
    expected,
    remeasurement,
    policy: POLICY,
    now: NOW_REMEASURED,
    expiresAt: '2026-09-03T13:00:00.000Z',
    poolId: POOL_ID,
    capacityLimitBytes: POOL_CAPACITY_BYTES,
    reservationStore: createMemoryReservationStore(),
    ...overrides,
  };
}

test('preflight receipt is typed and carries the disposition as its outcome', () => {
  const { preflight } = buildIncident();
  const result = createCapacityPreflightReceipt(preflight);
  assert.ok(TERMINAL_OUTCOMES.includes(result.outcome));
  assert.equal(result.outcome, 'recommend_external_reclaim');
});

test('createCapacityPreflightReceipt rejects a disposition of reserved', () => {
  const result = createCapacityPreflightReceipt({ ok: true, disposition: 'reserved', errors: [], pressure: null, candidateSetDigest: null });
  assert.equal(result.ok, false);
  assert.ok(!('outcome' in result) || result.outcome === undefined);
  assert.ok(result.errors.length > 0);
});

test('createCapacityPreflightReceipt only accepts an actual preflight disposition', () => {
  for (const disposition of DISPOSITIONS) {
    const result = createCapacityPreflightReceipt({ ok: true, disposition, errors: [], pressure: null, candidateSetDigest: null });
    assert.notEqual(result.errors, undefined);
  }
});

test('createCapacityPreflightReceipt binds the decision to policy digest, observation time, and run/fence when supplied', () => {
  const { preflight } = buildIncident();
  const result = createCapacityPreflightReceipt(preflight, { policy: POLICY, observedAt: NOW_INCIDENT, runId: 'run:incident-001', fence: 1 });
  assert.equal(result.policyDigest, POLICY_DIGEST);
  assert.equal(result.observedAt, NOW_INCIDENT);
  assert.equal(result.runId, 'run:incident-001');
  assert.equal(result.fence, 1);
});

test('createCapacityPreflightReceipt leaves binding fields null when no context is supplied', () => {
  const { preflight } = buildIncident();
  const result = createCapacityPreflightReceipt(preflight);
  assert.equal(result.policyDigest, null);
  assert.equal(result.observedAt, null);
  assert.equal(result.runId, null);
  assert.equal(result.fence, null);
});

test('matched evidence and a fresh sufficient remeasurement yield exactly one reservation covering the full required total', async () => {
  const result = await authorizeReclaimReservation(authorizeArgs());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outcome, 'reserved');
  assert.equal(result.reservation.status, 'active');
  assert.equal(result.reservation.amountBytes, POLICY_REQUIRED_TOTAL);
});

test('two authorization attempts against the same evidence yield exactly one reservation', async () => {
  const { expected, evidence, remeasurement } = buildIncident();
  const reservationStore = createMemoryReservationStore();
  const args = { evidence, expected, remeasurement, policy: POLICY, now: NOW_REMEASURED, expiresAt: '2026-09-03T13:00:00.000Z', poolId: POOL_ID, capacityLimitBytes: POOL_CAPACITY_BYTES, reservationStore };
  const [a, b] = await Promise.all([authorizeReclaimReservation(args), authorizeReclaimReservation(args)]);
  assert.equal(a.reservation.reservationId, b.reservation.reservationId);
});

test('a candidate-set mismatch remains blocked', async () => {
  const { expected } = buildIncident();
  const badExpected = { ...expected, candidateSetDigest: 'f'.repeat(64) };
  const result = await authorizeReclaimReservation(authorizeArgs({ expected: badExpected }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a policy digest mismatch remains blocked', async () => {
  const { expected } = buildIncident();
  const badExpected = { ...expected, policyDigest: 'e'.repeat(64) };
  const result = await authorizeReclaimReservation(authorizeArgs({ expected: badExpected }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a run mismatch remains blocked', async () => {
  const { expected } = buildIncident();
  const badExpected = { ...expected, runId: 'run:other' };
  const result = await authorizeReclaimReservation(authorizeArgs({ expected: badExpected }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a stale fence remains blocked', async () => {
  const { expected } = buildIncident();
  const badExpected = { ...expected, fence: 0 };
  const result = await authorizeReclaimReservation(authorizeArgs({ expected: badExpected }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a verified no-effect receipt credits zero bytes and stays blocked', async () => {
  const { candidateSetDigest } = buildIncident();
  const expected = { runId: 'run:incident-002', policyDigest: POLICY_DIGEST, candidateSetDigest, fence: 1, maxCreditableBytes: CANDIDATE_BYTES };
  const evidence = {
    dryRunReceipt: receipt({ runId: 'run:incident-002', dryRun: true, outcome: 'verified', bytesReclaimed: CANDIDATE_BYTES, candidateSetDigest, observedAt: '2026-09-03T12:06:00.000Z' }),
    terminalReceipt: receipt({ runId: 'run:incident-002', dryRun: false, outcome: 'no-effect', bytesReclaimed: 0, candidateSetDigest, observedAt: '2026-09-03T12:07:00.000Z' }),
  };
  const remeasurement = observation({ bytesAvailable: INCIDENT_BYTES_AVAILABLE, observedAt: NOW_REMEASURED, freshUntil: '2026-09-03T12:15:00.000Z' });
  const result = await authorizeReclaimReservation(authorizeArgs({ expected, evidence, remeasurement }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a failed dry run remains blocked even with an otherwise-matched terminal receipt', async () => {
  const { expected, remeasurement, candidateSetDigest } = buildIncident();
  const evidence = {
    dryRunReceipt: receipt({ dryRun: true, outcome: 'failed', bytesReclaimed: 0, candidateSetDigest, observedAt: '2026-09-03T12:06:00.000Z' }),
    terminalReceipt: receipt({ dryRun: false, outcome: 'verified', bytesReclaimed: CANDIDATE_BYTES, candidateSetDigest, observedAt: '2026-09-03T12:07:00.000Z' }),
  };
  const result = await authorizeReclaimReservation(authorizeArgs({ expected, evidence, remeasurement }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('an insufficient remeasurement remains blocked even with valid evidence', async () => {
  const { expected, evidence } = buildIncident();
  const insufficientRemeasurement = observation({ bytesAvailable: INCIDENT_BYTES_AVAILABLE, observedAt: NOW_REMEASURED, freshUntil: '2026-09-03T12:15:00.000Z' });
  const result = await authorizeReclaimReservation(authorizeArgs({ expected, evidence, remeasurement: insufficientRemeasurement }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a missing now fails closed to blocked without touching the reservation store', async () => {
  const args = authorizeArgs({ now: undefined });
  const result = await authorizeReclaimReservation(args);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a missing poolId or capacityLimitBytes fails closed to blocked', async () => {
  const result = await authorizeReclaimReservation(authorizeArgs({ poolId: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('an off-contract reservation port that throws is caught and fails closed to blocked', async () => {
  const throwingStore = {
    reserve() { throw new Error('adapter exploded'); },
    consume() {},
    reap() {},
    get() {},
  };
  const result = await authorizeReclaimReservation(authorizeArgs({ reservationStore: throwingStore }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a changed maxCreditableBytes for identical run/policy/candidate-set/fence identity reuses the same reservation rather than forking a second one', async () => {
  const { expected, evidence, remeasurement } = buildIncident();
  const reservationStore = createMemoryReservationStore();
  const args = authorizeArgs({ expected, evidence, remeasurement, reservationStore });
  const first = await authorizeReclaimReservation(args);
  assert.equal(first.ok, true, JSON.stringify(first));

  const changedExpected = { ...expected, maxCreditableBytes: expected.maxCreditableBytes + 1 };
  const second = await authorizeReclaimReservation({ ...args, expected: changedExpected });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.reservation.reservationId, first.reservation.reservationId);
});

test('an expected identity with an unrecognized extra field is rejected', async () => {
  const { expected } = buildIncident();
  const badExpected = { ...expected, unexpectedField: 'x' };
  const result = await authorizeReclaimReservation(authorizeArgs({ expected: badExpected }));
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'blocked');
});

test('a distinct concurrent reservation for a different run cannot overcommit the same pool and fence', async () => {
  const reservationStore = createMemoryReservationStore();
  const first = await authorizeReclaimReservation(authorizeArgs({ reservationStore, capacityLimitBytes: POLICY_REQUIRED_TOTAL }));
  assert.equal(first.ok, true, JSON.stringify(first));

  const { candidateSetDigest } = buildIncident();
  const secondExpected = { runId: 'run:incident-002', policyDigest: POLICY_DIGEST, candidateSetDigest, fence: 1, maxCreditableBytes: CANDIDATE_BYTES };
  const secondEvidence = {
    dryRunReceipt: receipt({ runId: 'run:incident-002', dryRun: true, outcome: 'verified', bytesReclaimed: CANDIDATE_BYTES, candidateSetDigest, observedAt: '2026-09-03T12:06:00.000Z' }),
    terminalReceipt: receipt({ runId: 'run:incident-002', dryRun: false, outcome: 'verified', bytesReclaimed: CANDIDATE_BYTES, candidateSetDigest, observedAt: '2026-09-03T12:07:00.000Z' }),
  };
  const remeasurement = observation({ bytesAvailable: INCIDENT_BYTES_AVAILABLE + CANDIDATE_BYTES, observedAt: NOW_REMEASURED, freshUntil: '2026-09-03T12:15:00.000Z' });
  const second = await authorizeReclaimReservation(authorizeArgs({
    reservationStore,
    capacityLimitBytes: POLICY_REQUIRED_TOTAL,
    expected: secondExpected,
    evidence: secondEvidence,
    remeasurement,
  }));
  assert.equal(second.ok, false);
  assert.equal(second.outcome, 'blocked');
});
