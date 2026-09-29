'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  DURABLE_WORK_EVENT_CONTRACT,
  EVENT_KINDS,
  RECEIPT_KINDS,
  createDurableWorkEvent,
  durableWorkCausalKey,
  invocationReference,
  projectDurableWorkEvent,
  validateDurableWorkEvent,
} = require('../src/durable-work-event');
const { createHostAdmission, validateActivityReceipt } = require('../src/provider-contracts');

const NOW = '2026-09-23T12:00:00.000Z';
const hex = (seed) => crypto.createHash('sha256').update(seed).digest('hex');
const OID = 'c'.repeat(40);

function input(overrides = {}) {
  return {
    eventKind: 'commit',
    harness: 'claude',
    sessionDigest: hex('session'),
    repositoryDigest: hex('repository'),
    worktreeDigest: null,
    branchDigest: hex('branch'),
    pullRequest: null,
    commitOid: OID,
    subjectRef: null,
    evidenceRefs: [`git-commit:${OID}`],
    occurredAt: NOW,
    observedAt: NOW,
    invocationRef: invocationReference('test-invocation-nonce-000001'),
    ...overrides,
  };
}

const KIND_INPUTS = {
  commit: {},
  merged_pr: { eventKind: 'merged_pr', pullRequest: 4, evidenceRefs: ['github-pr:4', `git-commit:${OID}`] },
  migration_applied: { eventKind: 'migration_applied', commitOid: null, subjectRef: '202609220001', evidenceRefs: ['marker:mig-202609220001'] },
  deployment_ready: { eventKind: 'deployment_ready', commitOid: null, subjectRef: 'dpl_fixture0001', evidenceRefs: ['marker:dpl-fixture0001'] },
  production_verified: { eventKind: 'production_verified', commitOid: null, subjectRef: 'verify-fixture-0001', evidenceRefs: ['marker:verify-fixture-0001'] },
};

test('accepts exactly the five durable event kinds as normalized metadata-only envelopes', () => {
  assert.deepEqual([...EVENT_KINDS].sort(), Object.keys(KIND_INPUTS).sort());
  for (const [kind, overrides] of Object.entries(KIND_INPUTS)) {
    const event = createDurableWorkEvent(input(overrides));
    assert.equal(event.contract, DURABLE_WORK_EVENT_CONTRACT);
    assert.equal(event.eventKind, kind);
    assert.match(event.causalKey, /^dwe_[a-f0-9]{32}$/);
    assert.deepEqual(validateDurableWorkEvent(event), { ok: true, event });
  }
  assert.throws(() => createDurableWorkEvent(input({ eventKind: 'push' })), /eventKind/);
});

test('causal key is deterministic over the fact and ignores session, harness, worktree, branch, and times', () => {
  const claude = createDurableWorkEvent(input());
  const codex = createDurableWorkEvent(input({
    harness: 'codex', sessionDigest: hex('other-session'), worktreeDigest: hex('linked'), branchDigest: null,
    observedAt: '2026-09-23T12:05:00.000Z', invocationRef: invocationReference('test-invocation-nonce-000002'),
  }));
  assert.equal(claude.causalKey, codex.causalKey);
  assert.equal(claude.causalKey, durableWorkCausalKey({ eventKind: 'commit', repositoryDigest: hex('repository'), commitOid: OID }));
  assert.notEqual(createDurableWorkEvent(input({ commitOid: 'd'.repeat(40) })).causalKey, claude.causalKey);
  assert.notEqual(createDurableWorkEvent(input({ repositoryDigest: hex('fork') })).causalKey, claude.causalKey);
});

test('rejects paths, URLs, commands, credentials, oversize values, unknown keys, and self-asserted identity', () => {
  const rejects = [
    { subjectRef: '/Users/example/migrations/1.sql', eventKind: 'migration_applied', commitOid: null },
    { subjectRef: '~/deploys/1', eventKind: 'deployment_ready', commitOid: null },
    { subjectRef: 'npm run deploy', eventKind: 'deployment_ready', commitOid: null },
    { evidenceRefs: ['https://github.invalid/o/r/pull/4'] },
    { evidenceRefs: [['marker:', 'sk', '-', 'a'.repeat(20)].join('')] },
    { evidenceRefs: ['secret:abcdef'] },
    { evidenceRefs: Array.from({ length: 17 }, (_, index) => `marker:m${index}`) },
    { evidenceRefs: [] },
    { subjectRef: 'x'.repeat(97), eventKind: 'production_verified', commitOid: null },
    { sessionDigest: 'not-a-digest' },
    { invocationRef: 'raw-nonce-value' },
    { commitOid: 'HEAD' },
    { pullRequest: 0, eventKind: 'merged_pr' },
    { occurredAt: '2026-09-24T12:00:00.000Z' },
    { prompt: 'please commit this' },
    { stdout: '[main abc123] fix' },
    { commitSubject: 'fix: secret' },
  ];
  for (const patch of rejects) assert.throws(() => createDurableWorkEvent(input(patch)), undefined, JSON.stringify(patch));
  assert.throws(() => createDurableWorkEvent({ ...input(), contract: DURABLE_WORK_EVENT_CONTRACT }), /must not assert/);
  assert.throws(() => createDurableWorkEvent({ ...input(), causalKey: `dwe_${'0'.repeat(32)}` }), /must not assert/);
});

test('validation rejects a causal-key mismatch, unknown keys, and unnormalized envelopes', () => {
  const event = createDurableWorkEvent(input());
  assert.equal(validateDurableWorkEvent({ ...event, causalKey: `dwe_${'0'.repeat(32)}` }).ok, false);
  assert.equal(validateDurableWorkEvent({ ...event, path: '/tmp/x' }).ok, false);
  assert.equal(validateDurableWorkEvent({ ...event, evidenceRefs: ['marker:z', ...event.evidenceRefs] }).ok, false);
  assert.equal(validateDurableWorkEvent({ ...event, contract: 'jarvos.durable-work-event/v2' }).ok, false);
});

test('projects into the unchanged verified-activity receipt and signs through host admission', () => {
  const event = createDurableWorkEvent(input());
  const base = projectDurableWorkEvent(event, { canonicalId: 'prj_000042', producerId: 'clawd.durable-work-collector' });
  assert.deepEqual(validateActivityReceipt(base), base);
  assert.equal(base.eventId, event.causalKey);
  assert.equal(base.dedupeKey, event.causalKey);
  assert.equal(base.kind, 'durable_work_commit');
  assert.ok(RECEIPT_KINDS.includes(base.kind));
  assert.deepEqual(base.evidenceRefs, [`git-commit:${OID}`, 'harness:claude']);
  const serialized = JSON.stringify(base);
  assert.equal(serialized.includes(event.sessionDigest), false);
  assert.equal(serialized.includes(event.invocationRef), false);
  const admission = createHostAdmission({ producerId: 'clawd.durable-work-collector', secret: 'test-secret', allowedKinds: RECEIPT_KINDS });
  const signed = admission.admitVerifiedReceipt(base);
  assert.equal(admission.verifyVerifiedReceipt(signed).ok, true);
  assert.throws(() => projectDurableWorkEvent({ ...event, causalKey: `dwe_${'0'.repeat(32)}` }, { canonicalId: 'prj_000042', producerId: 'p' }), /invalid/);
  assert.throws(() => projectDurableWorkEvent(event, { canonicalId: 'not-canonical', producerId: 'p' }), /canonicalId/);
});

test('invocation references are one-way digests of the dispatcher nonce', () => {
  const nonce = 'dispatcher-nonce-abcdef0123456789';
  const ref = invocationReference(nonce);
  assert.match(ref, /^inv_[a-f0-9]{32}$/);
  assert.equal(ref.includes(nonce), false);
  assert.equal(invocationReference(nonce), ref);
  assert.throws(() => invocationReference('short'), /nonce/);
});
