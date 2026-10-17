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
    allowedVisibilities: ['private', 'internal', 'mixed'],
    capabilityRevision: 'projects-r1',
    issuedAt: '2026-08-05T12:00:00.000Z',
    expiresAt: '2026-08-05T13:00:00.000Z',
    ...overrides,
  });
}

test('issues a caller-authorized, unsigned bounded project context capability', () => {
  const capability = issue();
  assert.equal(capability.type, 'jarvos.project-context/v1');
  assert.equal(capability.purpose, 'managed-software-stewardship');
  assert.equal(capability.audience, 'jarvos-projects');
  assert.deepEqual(capability.destinationSelectors, ['projects:stewardship']);
  assert.deepEqual(capability.allowedVisibilities, ['internal', 'mixed', 'private']);
  assert.deepEqual(Object.keys(capability).sort(), [
    'allowedVisibilities', 'audience', 'capabilityRevision', 'contextKey', 'destinationSelectors',
    'expiresAt', 'issuedAt', 'purpose', 'type',
  ]);
  assert.equal(capability.contextKey, context.deriveContextKey(input));
  assert.doesNotMatch(JSON.stringify(capability), /signature|activation|finding-42|execution-42|release-42/i);
});

test('denies an absent or denied caller authorization without enumerating policy', () => {
  assert.deepEqual(issue({ authorization: undefined }), { status: 'denied' });
  assert.deepEqual(issue({ authorization: { allowed: false } }), { status: 'denied' });
});

test('rejects public or external destinations as publication', () => {
  for (const selector of ['projects:public', 'projects:external', 'public', 'external:projects']) {
    assert.throws(() => issue({ destinationSelectors: [selector] }), /private\/internal/);
  }
});

test('rejects wrong versions, widened visibility, and expired capability state', () => {
  const capability = issue();
  const base = { now: '2026-08-05T12:30:00.000Z' };
  for (const changed of [
    { type: 'jarvos.project-context/v2' },
    { purpose: 'other' },
    { allowedVisibilities: ['private', 'public'] },
    { destinationSelectors: ['projects:public'] },
  ]) assert.deepEqual(context.verifyProjectContext({ ...capability, ...changed }, base), { ok: false, reason: 'invalid-contract' });
  assert.deepEqual(context.verifyProjectContext(capability, { now: '2026-08-05T13:00:00.000Z' }), { ok: false, reason: 'expired' });
  assert.deepEqual(context.verifyProjectContext(capability, { now: '2026-08-05T11:59:59.000Z' }), { ok: false, reason: 'not-yet-valid' });
});

test('projection only uses a current private/internal capability and preserves opaque identity', () => {
  const capability = issue();
  const request = { capability, context: { contextKey: context.deriveContextKey(input), visibility: input.visibility } };
  assert.deepEqual(
    context.projectContextProjection(capability, input, {
      now: '2026-08-05T12:30:00.000Z',
      project: (value) => { assert.deepEqual(value, request); return { status: 'projected' }; },
    }),
    { status: 'projected', contextKey: context.deriveContextKey(input) },
  );
  assert.deepEqual(
    context.projectContextProjection(capability, input, {
      now: '2026-08-05T12:30:00.000Z', project: () => ({ status: 'deduped' }),
    }),
    { status: 'deduped', contextKey: context.deriveContextKey(input) },
  );
});

test('a mixed candidate visibility remains delivery-disabled at a private/internal destination', () => {
  const mixedInput = { ...input, visibility: 'mixed' };
  const capability = issue({ input: mixedInput, allowedVisibilities: ['mixed'] });
  assert.deepEqual(
    context.projectContextProjection(capability, mixedInput, {
      now: '2026-08-05T12:30:00.000Z', project: () => ({ status: 'projected' }),
    }),
    { status: 'projected', contextKey: context.deriveContextKey(mixedInput) },
  );
});

test('projection denies a different activity under the same capability', () => {
  const capability = issue();
  const unrelatedInput = { ...input, findingId: 'finding-99' };
  let projected = false;
  assert.deepEqual(
    context.projectContextProjection(capability, unrelatedInput, {
      now: '2026-08-05T12:30:00.000Z',
      project: () => { projected = true; return { status: 'projected' }; },
    }),
    { status: 'denied' },
  );
  assert.equal(projected, false);
});

test('projection fails closed for invalid or out-of-scope capability state', () => {
  const capability = issue();
  assert.deepEqual(
    context.projectContextProjection({ ...capability, destinationSelectors: ['projects:public'] }, input, {
      now: '2026-08-05T12:30:00.000Z', project: () => ({ status: 'projected' }),
    }),
    { status: 'unavailable' },
  );
  assert.deepEqual(
    context.projectContextProjection(issue({ allowedVisibilities: ['internal'] }), input, {
      now: '2026-08-05T12:30:00.000Z', project: () => ({ status: 'projected' }),
    }),
    { status: 'denied' },
  );
});
