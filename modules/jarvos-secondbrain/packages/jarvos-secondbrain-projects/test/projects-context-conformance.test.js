'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONFORMANCE_CONTRACT,
  conformanceDigest,
  createConformanceReceipt,
  validateConformanceReceipt,
} = require('../src/projects-context-conformance');

const BASE = {
  sourceRevision: 'public-main-42',
  packageDigest: 'a'.repeat(64),
  providerContract: 'jarvos.private-projects-provider/v1',
  providerRevision: 'provider-7',
  selectorRevision: 'selector-3',
  configDigest: 'b'.repeat(64),
  registryGeneration: 12,
  capabilityReceiptId: 'cap_' + 'c'.repeat(32),
  capabilityDigest: 'd'.repeat(64),
  profile: 'orientation',
  profileRevision: 'projects-profiles-1',
  providerSnapshotDigests: { beads: 'e'.repeat(64), release: 'f'.repeat(64) },
  consumers: {
    library: { status: 'ready', fingerprint: '1'.repeat(64) },
    mcp: { status: 'ready', fingerprint: '1'.repeat(64) },
    hydrate: { status: 'ready', fingerprint: '1'.repeat(64) },
    'active-assistant': { status: 'ready', fingerprint: '1'.repeat(64) },
  },
  generatedAt: '2026-08-12T16:00:00.000Z',
};

test('consumer parity receipt is metadata-only and deterministic', () => {
  const receipt = createConformanceReceipt(BASE);
  assert.equal(receipt.contract, CONFORMANCE_CONTRACT);
  assert.equal(receipt.status, 'ready');
  assert.match(receipt.receiptId, /^conformance_[a-f0-9]{32}$/);
  assert.equal(conformanceDigest(receipt).length, 64);
  assert.deepEqual(validateConformanceReceipt(receipt), { ok: true, receipt });
  assert.equal(JSON.stringify(receipt).includes('/Users/'), false);
  assert.equal(Object.keys(receipt).some((key) => /path|secret|payload|prompt/i.test(key)), false);
});
test('fingerprint drift blocks cutover without storing packets', () => {
  const receipt = createConformanceReceipt({
    ...BASE,
    consumers: {
      ...BASE.consumers,
      mcp: { status: 'ready', fingerprint: '2'.repeat(64) },
    },
  });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.blockerCode, 'consumer-fingerprint-mismatch');
  assert.equal(receipt.capabilityDigest, BASE.capabilityDigest);
});

test('unavailable consumer and malformed private-shaped fields fail closed', () => {
  const receipt = createConformanceReceipt({
    ...BASE,
    consumers: {
      ...BASE.consumers,
      hydrate: { status: 'unavailable', fingerprint: null },
    },
  });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.blockerCode, 'consumer-unavailable');
  assert.equal(validateConformanceReceipt({ ...receipt, privatePath: '/tmp/secret' }).ok, false);
  assert.equal(validateConformanceReceipt({ ...receipt, consumers: { ...receipt.consumers, library: { status: 'ready', fingerprint: null } } }).ok, false);
});
