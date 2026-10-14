'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const workspace = require('../src');

const observation = {
  version: 'jarvos-workspace-manager.v1',
  repositoryId: 'repo-1', checkoutId: 'checkout-1', worktreeId: 'worktree-1', branchId: 'branch-1',
  candidateId: 'candidate-1', subjectIdentity: 'subject-1', observedAt: '2026-08-12T12:00:00Z',
  freshUntil: '2099-08-12T13:00:00Z', state: { clean: true, complete: true, dirty: false, conflicts: false, nestedRepository: false, detached: false, missing: false, unknownOwnership: false, duplicateIdentity: false, protected: false, divergedRefs: false, uniqueCommits: false, incomplete: false },
};
const evidence = {
  version: 'jarvos-workspace-manager.v1', sourceVersion: 'lifecycle.v1', subjectIdentity: 'subject-1',
  digest: 'a'.repeat(64), observedAt: '2026-08-12T12:01:00Z', freshUntil: '2099-08-12T13:00:00Z', outcome: 'landed',
};
const releaseClearance = {
  version: 'jarvos-workspace-manager.release-clearance.v1', sourceVersion: 'release.v1', subjectIdentity: 'subject-1',
  digest: 'b'.repeat(64), observedAt: '2026-08-12T12:01:30Z', freshUntil: '2099-08-12T13:00:00Z', outcome: 'satisfied',
  generation: 4, receiptId: 'receipt-1', currentPointerId: 'pointer-1',
};
const approval = { status: 'approved', principal: { kind: 'human', id: 'principal:andrew' }, approvedAt: '2026-08-12T12:02:00Z', expiresAt: '2099-08-12T13:00:00Z', candidateId: 'candidate-1', subjectIdentity: 'subject-1', evidenceDigest: evidence.digest, releaseClearanceDigest: releaseClearance.digest, releaseClearanceGeneration: releaseClearance.generation, releaseClearanceReceiptId: releaseClearance.receiptId, releaseClearanceCurrentPointerId: releaseClearance.currentPointerId, targetFenceKey: 'target:machine:default:candidate-1', targetFenceGeneration: 3, preconditionFingerprint: 'fingerprint-1' };
const releaseClearancePort = { resolve: async () => releaseClearance };

function request(overrides = {}) {
  return workspace.createWorktreeRemovalRequest({ observation, lifecycleEvidence: evidence, releaseClearance, approval, approvalVerifier: () => true, actor: { kind: 'human' }, targetFence: { key: 'target:machine:default:candidate-1', generation: 3 }, preconditionFingerprint: 'fingerprint-1', ...overrides });
}

test('cleanup request binds exact human approval, evidence, precondition, and target generation', () => {
  const result = request();
  assert.equal(result.ok, true);
  assert.equal(result.request.mutationClass, 'workspace.worktree-remove');
  assert.equal(result.request.type, 'request');
  assert.equal(result.request.contractVersion, '1.0.0');
  assert.equal(result.request.commandSpec.operation, 'remove-worktree');
  assert.ok(result.request.id);
  assert.equal(result.request.targetFence.generation, 3);
  assert.equal(result.request.targetFence.preconditionFingerprint, 'fingerprint-1');
  assert.equal(result.request.approval.principal.id, 'principal:andrew');
  assert.equal(result.request.approval.evidenceDigest, evidence.digest);
  assert.equal(result.request.releaseClearanceDigest, releaseClearance.digest);
  assert.equal(result.request.releaseClearanceGeneration, releaseClearance.generation);
  assert.equal(result.request.releaseClearanceCurrentPointerId, releaseClearance.currentPointerId);
  assert.equal(result.request.targetFence.releaseClearanceGeneration, releaseClearance.generation);
});

test('cleanup fails closed for agents, missing evidence, stale approval, and unsupported mutations', async () => {
  assert.equal(request({ actor: { kind: 'agent' } }).status, 'denied');
  assert.equal(request({ releaseClearance: undefined }).status, 'deferred');
  assert.equal(request({ releaseClearance: { ...releaseClearance, outcome: 'pending' } }).status, 'deferred');
  assert.equal(request({ lifecycleEvidence: { ...evidence, digest: 'bad' } }).status, 'deferred');
  assert.equal(request({ approval: { ...approval, revoked: true } }).status, 'denied');
  await assert.rejects(() => workspace.createWorktreeCleanupPort({ executor: { execute() {} }, verifier: { verify() {} } }).executeFenced({ mutationClass: 'workspace.branch-delete', commandSpec: { operation: 'delete-branch' } }), /unsupported workspace mutation/);
});

test('worktree cleanup port invokes only the injected executor and independent verifier', async () => {
  const calls = [];
  const port = workspace.createWorktreeCleanupPort({ releaseClearancePort,
    executor: { execute: async (input) => { calls.push(['execute', input]); return { accepted: true }; } },
    verifier: { verify: async (input) => { calls.push(['verify', input]); return { outcome: 'satisfied', verifier: 'git-independent', postcondition: { absent: true } }; } },
  });
  const result = request();
  const command = { resource: result.request.resource, subjectIdentity: result.request.subjectIdentity, releaseClearanceDigest: result.request.releaseClearanceDigest, releaseClearanceGeneration: result.request.releaseClearanceGeneration, releaseClearanceCurrentPointerId: result.request.releaseClearanceCurrentPointerId, mutationClass: result.request.mutationClass, targetFence: result.request.targetFence, commandSpec: { operation: 'remove-worktree', constraints: { preconditionFingerprint: 'fingerprint-1' } } };
  await port.executeFenced(command, { fence: 4, assertCurrentFence: () => true });
  const verification = await port.verify(command, { request: result.request });
  assert.equal(verification.outcome, 'satisfied');
  assert.deepEqual(calls.map(([kind]) => kind), ['execute', 'verify']);
  assert.equal(calls[0][1].targetFence.preconditionFingerprint, 'fingerprint-1');
});

test('cleanup revalidation blocks a superseded release pointer before executor dispatch', async () => {
  let executed = false;
  const port = workspace.createWorktreeCleanupPort({
    releaseClearancePort: { resolve: async () => ({ ...releaseClearance, digest: 'c'.repeat(64), generation: 5, currentPointerId: 'pointer-2' }) },
    executor: { execute: async () => { executed = true; } },
    verifier: { verify: async () => ({ outcome: 'satisfied' }) },
  });
  const result = request();
  const command = { resource: result.request.resource, subjectIdentity: result.request.subjectIdentity, releaseClearanceDigest: result.request.releaseClearanceDigest, releaseClearanceGeneration: result.request.releaseClearanceGeneration, releaseClearanceCurrentPointerId: result.request.releaseClearanceCurrentPointerId, mutationClass: result.request.mutationClass, targetFence: result.request.targetFence, commandSpec: { operation: 'remove-worktree', constraints: { preconditionFingerprint: 'fingerprint-1' } } };
  await assert.rejects(() => port.executeFenced(command), /release clearance has changed/);
  assert.equal(executed, false);
});

test('cleanup request rejects stale observations, missing trusted approval, and mismatched bindings', () => {
  assert.equal(request({ approvalVerifier: undefined }).status, 'approval_required');
  assert.equal(request({ observation: { ...observation, freshUntil: '2026-08-12T12:05:00Z' }, now: '2026-08-12T12:10:00Z' }).status, 'deferred');
  assert.equal(request({ approval: { ...approval, candidateId: 'candidate-other' } }).status, 'denied');
  assert.equal(request({ targetFence: { key: 'target:machine:default:candidate-other', generation: 3 } }).status, 'deferred');
});
