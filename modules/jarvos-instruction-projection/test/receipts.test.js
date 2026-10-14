'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { HARNESSES, normalizeRedactedRoleReceipt } = require('../src/contracts');
const {
  LOCAL_RECEIPT_SCHEMA_VERSION,
  normalizeRelativeTarget,
  normalizeLocalReceipt,
  serializeLocalReceipt,
  receiptRelativePath,
  redactLocalReceipt,
} = require('../src/receipts');

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const DIGEST_D = 'd'.repeat(64);
const TARGET_DIGEST = 'e'.repeat(64);

function validLocalReceipt() {
  return {
    schemaVersion: LOCAL_RECEIPT_SCHEMA_VERSION,
    id: 'sample-receipt',
    harness: 'claude',
    relativeTarget: 'projects/sample/CLAUDE.md',
    catalogGeneration: DIGEST_A,
    generationDigest: DIGEST_B,
    renderedDigest: DIGEST_C,
    outputDigest: DIGEST_D,
  };
}

function validMetadata(extra = {}) {
  return {
    adapterVersion: '1.0.0',
    harnessVersion: '1.2.3',
    targetIdentityDigest: TARGET_DIGEST,
    checkedAt: '2026-08-25T00:00:00.000Z',
    ...extra,
  };
}

test('normalizeRelativeTarget accepts a clean POSIX relative path', () => {
  assert.equal(normalizeRelativeTarget('a/b/c.md'), 'a/b/c.md');
});

test('normalizeRelativeTarget rejects absolute POSIX paths', () => {
  assert.throws(() => normalizeRelativeTarget('/a/b.md'));
});

test('normalizeRelativeTarget rejects absolute Windows paths', () => {
  assert.throws(() => normalizeRelativeTarget('C:/a/b.md'));
});

test('normalizeRelativeTarget rejects backslashes', () => {
  assert.throws(() => normalizeRelativeTarget('a\\b.md'));
});

test('normalizeRelativeTarget rejects dot and empty forms', () => {
  assert.throws(() => normalizeRelativeTarget('.'));
  assert.throws(() => normalizeRelativeTarget(''));
  assert.throws(() => normalizeRelativeTarget('a//b.md'));
  assert.throws(() => normalizeRelativeTarget('./a.md'));
});

test('normalizeRelativeTarget rejects traversal', () => {
  assert.throws(() => normalizeRelativeTarget('a/../b.md'));
  assert.throws(() => normalizeRelativeTarget('../a.md'));
});

test('normalizeRelativeTarget rejects paths whose normalized form differs from input', () => {
  assert.throws(() => normalizeRelativeTarget('a/b/'));
});

test('normalizeLocalReceipt accepts the happy path and returns a fresh object', () => {
  const input = validLocalReceipt();
  const normalized = normalizeLocalReceipt(input);
  assert.notEqual(normalized, input);
  assert.deepEqual(normalized, input);
});

test('normalizeLocalReceipt rejects unknown fields', () => {
  const receipt = { ...validLocalReceipt(), extra: 'nope' };
  assert.throws(() => normalizeLocalReceipt(receipt));
});

test('normalizeLocalReceipt rejects missing fields', () => {
  const receipt = validLocalReceipt();
  delete receipt.outputDigest;
  assert.throws(() => normalizeLocalReceipt(receipt));
});

test('normalizeLocalReceipt rejects unsupported schemaVersion', () => {
  const receipt = { ...validLocalReceipt(), schemaVersion: 'wrong/v1' };
  assert.throws(() => normalizeLocalReceipt(receipt));
});

test('normalizeLocalReceipt rejects a non-canonical id', () => {
  for (const badId of ['Sample-Receipt', 'sample_receipt', '-sample', '', '1sample']) {
    assert.throws(() => normalizeLocalReceipt({ ...validLocalReceipt(), id: badId }), `id ${badId} should be rejected`);
  }
});

test('normalizeLocalReceipt rejects a harness outside the U1 harness set', () => {
  assert.throws(() => normalizeLocalReceipt({ ...validLocalReceipt(), harness: 'unknown-harness' }));
});

test('normalizeLocalReceipt accepts every U1 harness', () => {
  for (const harness of HARNESSES) {
    assert.doesNotThrow(() => normalizeLocalReceipt({ ...validLocalReceipt(), harness }));
  }
});

test('normalizeLocalReceipt rejects an invalid relativeTarget', () => {
  assert.throws(() => normalizeLocalReceipt({ ...validLocalReceipt(), relativeTarget: '/abs/path.md' }));
});

test('normalizeLocalReceipt rejects malformed digests', () => {
  for (const field of ['catalogGeneration', 'generationDigest', 'renderedDigest', 'outputDigest']) {
    assert.throws(() => normalizeLocalReceipt({ ...validLocalReceipt(), [field]: 'not-a-digest' }), `${field} should be rejected`);
    assert.throws(() => normalizeLocalReceipt({ ...validLocalReceipt(), [field]: DIGEST_A.toUpperCase() }), `${field} should reject uppercase`);
    assert.throws(() => normalizeLocalReceipt({ ...validLocalReceipt(), [field]: DIGEST_A.slice(0, 63) }), `${field} should reject short digest`);
  }
});

test('serializeLocalReceipt produces stable, exact, normalized, indented JSON with a trailing newline', () => {
  const receipt = validLocalReceipt();
  const serialized = serializeLocalReceipt(receipt);
  assert.ok(serialized.endsWith('\n'));
  assert.equal(serialized, `${serialized.trimEnd()}\n`);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(Object.keys(parsed), [
    'schemaVersion', 'id', 'harness', 'relativeTarget',
    'catalogGeneration', 'generationDigest', 'renderedDigest', 'outputDigest',
  ]);
  assert.deepEqual(parsed, normalizeLocalReceipt(receipt));
  assert.equal(serialized.includes('\n  "'), true);
});

test('serializeLocalReceipt is deterministic regardless of input key order', () => {
  const receipt = validLocalReceipt();
  const reordered = Object.fromEntries(Object.keys(receipt).reverse().map((key) => [key, receipt[key]]));
  assert.equal(serializeLocalReceipt(receipt), serializeLocalReceipt(reordered));
});

test('receiptRelativePath returns the POSIX relative receipt path for a valid id', () => {
  assert.equal(receiptRelativePath('sample-receipt'), '.jarvos-instruction-projection/receipts/sample-receipt.json');
});

test('receiptRelativePath rejects an invalid id', () => {
  assert.throws(() => receiptRelativePath('Not Valid'));
  assert.throws(() => receiptRelativePath('../escape'));
});

test('redactLocalReceipt produces a value accepted by the U1 redacted receipt normalizer', () => {
  const local = validLocalReceipt();
  const redacted = redactLocalReceipt(local, validMetadata());
  assert.doesNotThrow(() => normalizeRedactedRoleReceipt(redacted));
  assert.equal(redacted.catalogGeneration, local.catalogGeneration);
  assert.equal(redacted.renderedDigest, local.renderedDigest);
  assert.equal(redacted.targetIdentity.digest, TARGET_DIGEST);
  assert.equal(redacted.states.desired, local.generationDigest);
  assert.equal(redacted.states.projected, local.generationDigest);
  assert.equal(redacted.states.installed, local.generationDigest);
  assert.equal(redacted.projectionStatus, 'clean');
});

test('redactLocalReceipt defaults to load_pending load status and pending parity/precedence', () => {
  const redacted = redactLocalReceipt(validLocalReceipt(), validMetadata());
  assert.equal(redacted.loadStatus, 'load_pending');
  assert.equal(redacted.parityStatus, 'pending');
  assert.deepEqual(redacted.observedPrecedence, { status: 'pending', digest: null });
  assert.equal(redacted.states.loaded, null);
  assert.equal(redacted.states.parity, null);
});

test('redactLocalReceipt allows an explicit not_evaluable precedence', () => {
  const redacted = redactLocalReceipt(
    validLocalReceipt(),
    validMetadata({ observedPrecedence: { status: 'not_evaluable', digest: null } }),
  );
  assert.deepEqual(redacted.observedPrecedence, { status: 'not_evaluable', digest: null });
});

test('redactLocalReceipt allows an explicit pending precedence', () => {
  const redacted = redactLocalReceipt(
    validLocalReceipt(),
    validMetadata({ observedPrecedence: { status: 'pending', digest: null } }),
  );
  assert.deepEqual(redacted.observedPrecedence, { status: 'pending', digest: null });
});

test('redactLocalReceipt rejects a proved precedence', () => {
  assert.throws(() => redactLocalReceipt(
    validLocalReceipt(),
    validMetadata({ observedPrecedence: { status: 'proved', digest: DIGEST_A } }),
  ));
});

test('redactLocalReceipt rejects an observedPrecedence carrying a non-null digest', () => {
  assert.throws(() => redactLocalReceipt(
    validLocalReceipt(),
    validMetadata({ observedPrecedence: { status: 'pending', digest: DIGEST_A } }),
  ));
});

test('redactLocalReceipt rejects unsupported metadata fields', () => {
  assert.throws(() => redactLocalReceipt(validLocalReceipt(), validMetadata({ localPath: '/tmp/x' })));
});

test('redactLocalReceipt rejects missing required metadata fields', () => {
  const metadata = validMetadata();
  delete metadata.checkedAt;
  assert.throws(() => redactLocalReceipt(validLocalReceipt(), metadata));
});

test('redacted receipt bytes contain no local-only or sensitive content', () => {
  const local = validLocalReceipt();
  const redacted = redactLocalReceipt(local, validMetadata());
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(local.relativeTarget), false);
  assert.equal(serialized.includes(local.outputDigest), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.toLowerCase().includes('credential'), false);
  assert.equal(serialized.includes('"loaded":"'), false);
  assert.equal(/"parityStatus":"equivalent"/.test(serialized), false);
});
