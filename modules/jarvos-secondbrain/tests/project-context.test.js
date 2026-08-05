'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const context = require('../packages/jarvos-secondbrain-projects/src/project-context.js');

const input = {
  findingId: 'finding-42',
  executionReference: 'execution-42',
  releaseReference: 'release-42',
  visibility: 'private',
};

function issue(overrides = {}) {
  return context.issueProjectContext({
    input,
    authorization: { allowed: true },
    destinationSelectors: ['projects:stewardship'],
    capabilityRevision: 'projects-r1',
    issuedAt: '2026-08-05T12:00:00.000Z',
    expiresAt: '2026-08-05T13:00:00.000Z',
    sign: (payload) => `sig_${payload.contextKey}`,
    ...overrides,
  });
}

test('issues a portable fixed-field project context capability', () => {
  const receipt = issue();
  assert.equal(receipt.type, 'jarvos.project-context/v1');
  assert.equal(receipt.purpose, 'managed-software-stewardship');
  assert.equal(receipt.audience, 'jarvos-projects');
  assert.equal(receipt.contextKey, context.deriveContextKey(input));
  assert.deepEqual(receipt.destinationSelectors, ['projects:stewardship']);
  assert.equal(receipt.visibility, 'private');
  assert.deepEqual(Object.keys(receipt).sort(), [
    'audience', 'capabilityRevision', 'contextKey', 'destinationSelectors', 'expiresAt',
    'issuedAt', 'purpose', 'signature', 'type', 'visibility',
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /finding-42|execution-42|release-42/);
});

test('rejects wrong capability version or purpose at the public verifier boundary', () => {
  const receipt = issue();
  for (const changed of [{ type: 'jarvos.project-context/v2' }, { purpose: 'other' }]) {
    const result = context.verifyProjectContext({ ...receipt, ...changed }, {
      now: '2026-08-05T12:30:00.000Z',
      verify: () => true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid-contract');
  }
});

test('denies without revealing whether a destination exists', () => {
  const denied = issue({ authorization: { allowed: false } });
  assert.deepEqual(denied, { status: 'denied' });
});

test('rejects private path selectors and signer output that cannot stay portable', () => {
  assert.throws(() => issue({ destinationSelectors: ['/private/Projects'] }), /local paths/);
  assert.throws(() => issue({ sign: () => ({ source: 'finding-42' }) }), /portable encoded signature/);
});

test('public verifier rejects expired, revoked, and forged receipts', () => {
  const receipt = issue();
  const base = { now: '2026-08-05T12:30:00.000Z', verify: () => true };
  assert.deepEqual(context.verifyProjectContext(receipt, { ...base, now: '2026-08-05T13:00:00.000Z' }), { ok: false, reason: 'expired' });
  assert.deepEqual(context.verifyProjectContext(receipt, { ...base, isRevoked: () => true }), { ok: false, reason: 'revoked' });
  assert.deepEqual(context.verifyProjectContext(receipt, { ...base, verify: () => false }), { ok: false, reason: 'forged' });
});

test('projection port makes an idempotent context-only outcome', () => {
  const receipt = issue();
  assert.deepEqual(
    context.projectContextProjection(receipt, { project: () => ({ status: 'projected' }) }),
    { status: 'projected', contextKey: receipt.contextKey },
  );
  assert.deepEqual(
    context.projectContextProjection(receipt, { project: () => ({ status: 'deduped' }) }),
    { status: 'deduped', contextKey: receipt.contextKey },
  );
});
