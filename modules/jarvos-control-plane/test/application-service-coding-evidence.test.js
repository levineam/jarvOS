'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createApplicationService, createMemoryApplicationStore } = require('../src');

function fixture() {
  const store = createMemoryApplicationStore();
  const service = createApplicationService({
    store,
    policy: () => ({ outcome: 'allow' }),
    canRead: () => true,
    resolveCredential: (credential) => credential === 'writer'
      ? { id: 'principal:writer', capabilities: ['control-plane.read', 'control-plane.mutate'] }
      : null,
    authorizeCodingEvidence: () => true,
  });
  return { service, store };
}

function evidence(eventId = 'event_123456') {
  return {
    version: 'jarvos-coding-work-run-event/v1',
    eventId,
    workRunId: 'run_SUP-5000_01',
    type: 'provider',
    operation: 'plan',
    status: 'succeeded',
    operationNonce: 'nonce-01',
    provider: {
      id: 'compound-engineering',
      version: '3.21.4',
      pinDigest: 'b'.repeat(64),
      harness: 'codex',
      adapterVersion: 'codex-ce-adapter.v1',
      status: 'verified',
    },
    artifact: { kind: 'plan', reference: 'artifact:plan123456', digest: 'a'.repeat(64), path: '/private/plan.md' },
    detail: ['private path /private/plan.md'],
  };
}

test('coding work-run evidence is append-only, idempotent, and public-safe', () => {
  const { service, store } = fixture();
  const first = service.execute('recordEvidence', { credential: 'writer', evidence: evidence() });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  assert.equal(first.evidence.artifact.path, undefined);
  assert.equal(first.evidence.detail[0], 'private path [private-path]');

  const retry = service.execute('recordEvidence', { credential: 'writer', evidence: evidence() });
  assert.equal(retry.deduped, true);
  assert.equal(store.load().codingEvidence.length, 1);
  const listed = service.execute('listEvidence', { credential: 'writer', workRunId: 'run_SUP-5000_01' });
  assert.equal(listed.evidence.length, 1);
  assert.equal(listed.evidence[0].artifact.path, undefined);
});

test('coding evidence cannot smuggle authority-shaped fields into the control plane', () => {
  const { service } = fixture();
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence(), branch: 'main' },
  }), /authority-shaped|not allowed/);
});

test('coding evidence request bindings cannot diverge from the event work run', () => {
  const { service } = fixture();
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    workRunId: 'run_OTHER_01',
    evidence: evidence('event_654321'),
  }), /must match the request binding/);
});

test('coding evidence requires an explicit work-run authorization decision', () => {
  const store = createMemoryApplicationStore();
  const service = createApplicationService({
    store,
    policy: () => ({ outcome: 'allow' }),
    canRead: () => true,
    resolveCredential: () => ({ id: 'principal:writer', capabilities: ['control-plane.mutate'] }),
    authorizeCodingEvidence: () => false,
  });
  assert.throws(() => service.execute('recordEvidence', { credential: 'writer', evidence: evidence('event_999999') }), /not authorized/);
  assert.equal(store.load().codingEvidence.length, 0);
});

test('coding evidence rejects forged public contract fields', () => {
  const { service } = fixture();
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence('event_888888'), operation: 'delete-all' },
  }), /operation is invalid/);
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence('event_777777'), provider: { ...evidence().provider, status: 'made-up' } },
  }), /provider is invalid/);
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence('event_666666'), at: 'not-a-date' },
  }), /at is invalid/);
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence('event_444444'), at: '2026-02-30T00:00:00.000Z' },
  }), /at is invalid/);
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence('event_333333'), provider: { ...evidence().provider, observedAt: '2026-02-30T00:00:00.000Z' } },
  }), /observedAt is invalid/);
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence('event_222222'), provider: { ...evidence().provider, observedAt: '2026-01-01T00:00:00Z' } },
  }), /observedAt is invalid/);
  assert.throws(() => service.execute('recordEvidence', {
    credential: 'writer',
    evidence: { ...evidence('event_555555'), provider: { ...evidence().provider, version: 'secret=leak' } },
  }), /provider is invalid/);
});
