'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const context = require('../src/project-context');

const issuedAt = '2026-08-08T12:00:00.000Z';
const expiresAt = '2026-08-08T13:00:00.000Z';
const input = {
  findingId: 'finding-1',
  executionReference: 'beads:exec-1',
  releaseReference: 'release:v1.0.0',
  visibility: 'private',
};

function capability(overrides = {}) {
  return context.issueProjectContext({
    input,
    authorization: { allowed: true },
    destinationSelectors: ['jarvOS-private'],
    allowedVisibilities: ['private', 'internal'],
    capabilityRevision: 'cap-1',
    issuedAt,
    expiresAt,
    ...overrides,
  });
}

test('legacy stewardship context contract remains exact-key and opaque', () => {
  const key = context.deriveContextKey(input);
  assert.match(key, /^pcx_[A-Za-z0-9_-]+$/);
  assert.equal(context.deriveContextKey({ ...input }), key);
  assert.throws(() => context.deriveContextKey({ ...input, extra: 'nope' }), /unsupported fields/);

  const issued = capability();
  assert.deepEqual(context.verifyProjectContext(issued, { now: '2026-08-08T12:30:00.000Z' }), { ok: true, capability: issued });
  assert.deepEqual(context.verifyProjectContext({ ...issued, extra: true }, { now: '2026-08-08T12:30:00.000Z' }), { ok: false, reason: 'invalid-contract' });
  assert.deepEqual(context.verifyProjectContext(issued, { now: expiresAt }), { ok: false, reason: 'expired' });
});

test('legacy projection preserves visibility and projection outcomes', () => {
  const issued = capability();
  const projected = context.projectContextProjection(issued, input, {
    now: '2026-08-08T12:30:00.000Z',
    project: ({ context: value }) => ({ status: 'projected', value }),
  });
  assert.equal(projected.status, 'projected');
  assert.match(projected.contextKey, /^pcx_/);
  assert.deepEqual(context.projectContextProjection(issued, { ...input, visibility: 'mixed' }, {
    now: '2026-08-08T12:30:00.000Z',
    project: () => ({ status: 'projected' }),
  }), { status: 'denied' });
  assert.deepEqual(context.projectContextProjection(issued, input, {
    now: '2026-08-08T12:30:00.000Z',
    project: () => ({ status: 'deduped' }),
  }).status, 'deduped');
});
