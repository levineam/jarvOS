'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const contract = require('../src/promotion-receipt');
const exported = require('../src');

const DIGEST = `sha256:${'a'.repeat(64)}`;

function makeReceipt(overrides = {}) {
  return {
    schemaVersion: 'jarvos.promotion-receipt.v1',
    receiptId: 'jarvos:receipt:foundation:r-0001',
    operation: 'promotion',
    outcome: 'committed',
    candidateIds: ['jarvos:candidate:foundation:c-0001'],
    policyId: 'jarvos:policy:foundation:promotion-v1',
    authorization: { mode: 'user-reviewed' },
    destination: {
      surface: 'memory',
      artifactId: 'jarvos:artifact:foundation:a-0001',
      revisionBefore: null,
      revisionAfter: 'rev-0001',
      reversalMode: 'supersession',
    },
    recordedAt: '2026-08-31T12:00:00Z',
    evidence: [{ type: 'verification', ref: 'verification:memory:0001', digest: DIGEST }],
    ...overrides,
  };
}

test('exports a stable schema and frozen enums through the package', () => {
  assert.equal(contract.PROMOTION_RECEIPT_SCHEMA_VERSION, 'jarvos.promotion-receipt.v1');
  for (const value of [
    contract.PROMOTION_RECEIPT_OPERATIONS,
    contract.PROMOTION_RECEIPT_OUTCOMES,
    contract.PROMOTION_AUTHORIZATION_MODES,
    contract.PROMOTION_DESTINATION_SURFACES,
    contract.PROMOTION_REVERSAL_MODES,
    contract.PROMOTION_EVIDENCE_TYPES,
  ]) assert.ok(Object.isFrozen(value));
  assert.equal(exported.validatePromotionReceipt, contract.validatePromotionReceipt);
});

test('accepts committed promotions on every destination surface', () => {
  for (const surface of contract.PROMOTION_DESTINATION_SURFACES) {
    const receipt = makeReceipt({ destination: { ...makeReceipt().destination, surface } });
    assert.deepEqual(contract.validatePromotionReceipt(receipt), [], surface);
    assert.equal(contract.assertPromotionReceipt(receipt), receipt);
  }
});

test('committed destination state may explicitly have no future reversal mode', () => {
  const receipt = makeReceipt({
    destination: { ...makeReceipt().destination, reversalMode: 'none' },
  });
  assert.deepEqual(contract.validatePromotionReceipt(receipt), []);
});

test('non-committed outcomes report no mutation or reversal claim', () => {
  for (const outcome of ['already_satisfied', 'deferred', 'conflict', 'failed']) {
    const receipt = makeReceipt({
      outcome,
      destination: { ...makeReceipt().destination, revisionAfter: null, reversalMode: 'none' },
    });
    assert.deepEqual(contract.validatePromotionReceipt(receipt), [], outcome);
    assert.ok(contract.validatePromotionReceipt({
      ...receipt,
      destination: { ...receipt.destination, revisionAfter: 'invented' },
    }).length > 0);
    assert.ok(contract.validatePromotionReceipt({
      ...receipt,
      destination: { ...receipt.destination, reversalMode: 'rollback' },
    }).length > 0);
  }
});

test('promotion requires candidates and forbids a predecessor', () => {
  assert.ok(contract.validatePromotionReceipt(makeReceipt({ candidateIds: [] })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({
    predecessorReceiptId: 'jarvos:receipt:foundation:r-0000',
  })).length > 0);
});

test('non-promotion operations require a receipt predecessor', () => {
  for (const operation of ['supersession', 'retraction', 'rollback', 'correction']) {
    assert.ok(contract.validatePromotionReceipt(makeReceipt({ operation })).length > 0, operation);
    const receipt = makeReceipt({
      operation,
      candidateIds: [],
      predecessorReceiptId: 'jarvos:receipt:foundation:r-0000',
    });
    assert.deepEqual(contract.validatePromotionReceipt(receipt), [], operation);
  }
});

test('identity kinds are enforced for all identity-bearing fields', () => {
  assert.ok(contract.validatePromotionReceipt(makeReceipt({ receiptId: 'jarvos:candidate:foundation:r-0001' })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({ candidateIds: ['jarvos:artifact:foundation:c-0001'] })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({ policyId: 'jarvos:receipt:foundation:p-0001' })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({
    destination: { ...makeReceipt().destination, artifactId: 'jarvos:project:foundation:a-0001' },
  })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({
    operation: 'rollback', predecessorReceiptId: 'jarvos:policy:foundation:r-0000',
  })).length > 0);
});

test('unknown fields and enums fail closed at every nesting level', () => {
  assert.ok(contract.validatePromotionReceipt(makeReceipt({ rawContent: 'no' })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({ authorization: { mode: 'user-reviewed', actor: 'x' } })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({
    destination: { ...makeReceipt().destination, path: '/private/note.md' },
  })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({
    evidence: [{ ...makeReceipt().evidence[0], raw: 'content' }],
  })).length > 0);
  for (const overrides of [
    { operation: 'write' },
    { outcome: 'success' },
    { authorization: { mode: 'implicit' } },
    { destination: { ...makeReceipt().destination, surface: 'transcripts' } },
    { destination: { ...makeReceipt().destination, reversalMode: 'delete' } },
    { evidence: [{ type: 'raw-content', ref: 'evidence:one', digest: DIGEST }] },
  ]) assert.ok(contract.validatePromotionReceipt(makeReceipt(overrides)).length > 0);
});

test('evidence is non-empty, bounded, path-free with sha256 digests', () => {
  assert.ok(contract.validatePromotionReceipt(makeReceipt({ evidence: [] })).length > 0);
  for (const ref of ['/tmp/evidence', '../evidence', 'file://evidence', 'file:evidence', 'evidence one', 'Evidence:one']) {
    assert.ok(contract.validatePromotionReceipt(makeReceipt({
      evidence: [{ type: 'verification', ref, digest: DIGEST }],
    })).length > 0, ref);
  }
  assert.ok(contract.validatePromotionReceipt(makeReceipt({
    evidence: [{ type: 'verification', ref: 'evidence:one', digest: 'md5:short' }],
  })).length > 0);
  assert.ok(contract.validatePromotionReceipt(makeReceipt({
    destination: { ...makeReceipt().destination, revisionAfter: '/tmp/revision' },
  })).length > 0);
});

test('timestamps must be real ISO UTC instants', () => {
  for (const recordedAt of [
    '2026-08-31',
    '2026-08-31T12:00:00+01:00',
    '2026-13-01T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-08-31T24:00:00Z',
  ]) assert.ok(contract.validatePromotionReceipt(makeReceipt({ recordedAt })).length > 0, recordedAt);
});

test('non-object input fails closed and assertion throws', () => {
  for (const value of [null, undefined, 'receipt', 42, []]) {
    assert.ok(contract.validatePromotionReceipt(value).length > 0);
  }
  assert.throws(() => contract.assertPromotionReceipt(makeReceipt({ outcome: 'success' })), /promotion receipt/);
});
