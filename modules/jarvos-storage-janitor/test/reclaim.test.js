'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { validateExternalReclaimEvidence, RECLAIM_OUTCOMES } = require('../src/reclaim');

const EXPECTED = {
  runId: 'run:incident-001',
  policyDigest: 'a'.repeat(64),
  candidateSetDigest: 'b'.repeat(64),
  fence: 3,
  maxCreditableBytes: 1000000000,
};

function receipt(overrides = {}) {
  return {
    version: 'jarvos-storage-janitor.reclaim-receipt.v1',
    runId: EXPECTED.runId,
    policyDigest: EXPECTED.policyDigest,
    candidateSetDigest: EXPECTED.candidateSetDigest,
    fence: EXPECTED.fence,
    dryRun: true,
    outcome: 'verified',
    bytesReclaimed: 0,
    observedAt: '2026-09-03T12:02:00.000Z',
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    dryRunReceipt: receipt({ dryRun: true, outcome: 'verified', bytesReclaimed: 1000000000, observedAt: '2026-09-03T12:02:00.000Z' }),
    terminalReceipt: receipt({ dryRun: false, outcome: 'verified', bytesReclaimed: 900000000, observedAt: '2026-09-03T12:03:00.000Z' }),
    ...overrides,
  };
}

test('accepts matched dry-run-first evidence and credits reclaimed bytes', () => {
  const result = validateExternalReclaimEvidence(evidence(), EXPECTED);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.creditedBytes, 900000000);
});

test('a verified no-effect terminal receipt credits zero bytes', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'no-effect', bytesReclaimed: 0, observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.creditedBytes, 0);
});

test('a no-effect receipt reporting bytes is still credited zero', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'no-effect', bytesReclaimed: 123, observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, true);
  assert.equal(result.creditedBytes, 0);
});

test('rejects a terminal receipt with no matching dry run (dry-run-first)', () => {
  const e = evidence();
  delete e.dryRunReceipt;
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});

test('rejects a terminal receipt observed before its dry run', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'verified', bytesReclaimed: 900000000, observedAt: '2026-09-03T12:01:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});

test('rejects a run mismatch', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'verified', runId: 'run:other', observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});

test('rejects a policy digest mismatch', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'verified', policyDigest: 'c'.repeat(64), observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});

test('rejects a candidate-set digest mismatch', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'verified', candidateSetDigest: 'd'.repeat(64), observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});

test('rejects a fence mismatch against the expected fence', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'verified', fence: 99, observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});

test('rejects a stale fence lower than the expected fence', () => {
  const e = evidence({
    dryRunReceipt: receipt({ dryRun: true, outcome: 'verified', fence: 1, observedAt: '2026-09-03T12:02:00.000Z' }),
    terminalReceipt: receipt({ dryRun: false, outcome: 'verified', fence: 1, observedAt: '2026-09-03T12:03:00.000Z' }),
  });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => /stale|fence/i.test(err)));
});

test('rejects a dry run receipt that is not actually flagged dryRun', () => {
  const e = evidence({ dryRunReceipt: receipt({ dryRun: false, outcome: 'verified', observedAt: '2026-09-03T12:02:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});

test('rejects an unknown outcome', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'mystery', observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
  assert.ok(RECLAIM_OUTCOMES.length > 0);
});

test('rejects a failed dry run: nothing was actually previewed', () => {
  const e = evidence({ dryRunReceipt: receipt({ dryRun: true, outcome: 'failed', bytesReclaimed: 0, observedAt: '2026-09-03T12:02:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
  assert.equal(result.creditedBytes, 0);
  assert.ok(result.errors.some((err) => /dryRunReceipt.*failed/i.test(err)));
});

test('rejects a failed terminal receipt', () => {
  const e = evidence({ terminalReceipt: receipt({ dryRun: false, outcome: 'failed', bytesReclaimed: 0, observedAt: '2026-09-03T12:03:00.000Z' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
  assert.equal(result.creditedBytes, 0);
});

test('bounds credited bytes by the dry run preview even when the terminal receipt reports more', () => {
  const e = evidence({
    dryRunReceipt: receipt({ dryRun: true, outcome: 'verified', bytesReclaimed: 500000000, observedAt: '2026-09-03T12:02:00.000Z' }),
    terminalReceipt: receipt({ dryRun: false, outcome: 'verified', bytesReclaimed: 900000000, observedAt: '2026-09-03T12:03:00.000Z' }),
  });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.creditedBytes, 500000000);
});

test('bounds credited bytes by the caller-supplied maximum tied to the exact candidate set', () => {
  const e = evidence({
    dryRunReceipt: receipt({ dryRun: true, outcome: 'verified', bytesReclaimed: 900000000, observedAt: '2026-09-03T12:02:00.000Z' }),
    terminalReceipt: receipt({ dryRun: false, outcome: 'verified', bytesReclaimed: 900000000, observedAt: '2026-09-03T12:03:00.000Z' }),
  });
  const result = validateExternalReclaimEvidence(e, { ...EXPECTED, maxCreditableBytes: 300000000 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.creditedBytes, 300000000);
});

test('rejects evidence missing an expected maxCreditableBytes', () => {
  const { maxCreditableBytes, ...expectedWithoutMax } = EXPECTED;
  const result = validateExternalReclaimEvidence(evidence(), expectedWithoutMax);
  assert.equal(result.ok, false);
});

test('rejects a receipt carrying an unrecognized extra field', () => {
  const e = evidence({ dryRunReceipt: receipt({ unexpectedField: 'x' }) });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => /unexpectedField/.test(err)));
});

test('rejects an expected identity carrying an unrecognized extra field', () => {
  const result = validateExternalReclaimEvidence(evidence(), { ...EXPECTED, unexpectedField: 'x' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => /unexpectedField/.test(err)));
});

test('fails closed on a cyclic receipt rather than crashing', () => {
  const cyclicReceipt = receipt();
  cyclicReceipt.self = cyclicReceipt;
  const e = evidence({ dryRunReceipt: cyclicReceipt });
  const result = validateExternalReclaimEvidence(e, EXPECTED);
  assert.equal(result.ok, false);
});
