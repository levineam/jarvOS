'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HANDOFF_CONTRACT,
  createHandoffReceipt,
  handoffDigest,
  validateHandoffReceipt,
} = require('../src/projects-context-handoff.js');

const INPUT = {
  publicContract: 'jarvos.projects-context/v1',
  publicRevision: 'projects-context-public-1',
  packageDigest: 'a'.repeat(64),
  providerContract: 'jarvos.private-projects-provider/v1',
  providerRevision: 'private-provider-1',
  consumer: 'active-assistant',
  capabilityReceiptId: 'cap_' + 'b'.repeat(32),
  capabilityDigest: 'c'.repeat(64),
  profileRevision: 'profiles-1',
  generatedAt: '2026-08-13T02:00:00.000Z',
};

test('creates a redacted handoff receipt without paths or payloads', () => {
  const receipt = createHandoffReceipt(INPUT);
  assert.equal(receipt.contract, HANDOFF_CONTRACT);
  assert.match(receipt.handoffId, /^handoff_[a-f0-9]{32}$/);
  assert.equal(handoffDigest(receipt).length, 64);
  assert.equal(Object.values(receipt).some((value) => String(value).includes('/Users/')), false);
  assert.equal(Object.keys(receipt).some((key) => /secret|path|payload|prompt/i.test(key)), false);
  assert.deepEqual(validateHandoffReceipt(receipt), { ok: true, receipt });
});

test('blocks ready receipts without capability metadata and blocks unsupported fields', () => {
  assert.throws(() => createHandoffReceipt({ ...INPUT, capabilityDigest: null }), /capability receipt metadata/);
  const receipt = createHandoffReceipt(INPUT);
  assert.equal(validateHandoffReceipt({ ...receipt, privatePath: '/tmp/private' }).ok, false);
  assert.equal(validateHandoffReceipt({ ...receipt, status: 'blocked', blockerCode: 'private-handoff-unavailable' }).ok, false, 'handoff id no longer matches changed content and is rejected by the exact schema');
});

test('represents an unavailable private dependency without enumerating it', () => {
  const receipt = createHandoffReceipt({
    ...INPUT,
    capabilityReceiptId: null,
    capabilityDigest: null,
    status: 'blocked',
    blockerCode: 'private-handoff-unavailable',
  });
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.blockerCode, 'private-handoff-unavailable');
  assert.equal(validateHandoffReceipt(receipt).ok, true);
});
