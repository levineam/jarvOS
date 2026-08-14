'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createFileWorkRunStore,
  createMemoryWorkRunStore,
} = require('../src');

function claim(store, ownerId = 'agent:one') {
  const result = store.claimWorkRun({
    subjectKey: 'levineam/jarvOS:SUP-5000',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5000',
    ownerId,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

test('human and agent starts resolve one durable work run across a process restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-run-'));
  const first = createFileWorkRunStore(root);
  const human = first.resolveWorkRun({ subjectKey: 'levineam/jarvOS:SUP-5000' });
  const restarted = createFileWorkRunStore(root);
  const agent = restarted.resolveWorkRun({ subjectKey: 'levineam/jarvOS:SUP-5000' });

  assert.equal(human.created, true);
  assert.equal(agent.created, false);
  assert.equal(agent.workRun.workRunId, human.workRun.workRunId);
});

test('plan acceptance is compare-and-set and exposes the authoritative winner', () => {
  const store = createMemoryWorkRunStore();
  const owner = claim(store);
  const accepted = store.acceptPlan({
    workRunId: owner.workRunId,
    ownerId: owner.ownerId,
    fence: owner.fence,
    expectedPlanDigest: null,
    planDigest: 'a'.repeat(64),
    providerPinDigest: 'b'.repeat(64),
    artifact: { reference: 'artifact:plan123456', digest: 'a'.repeat(64) },
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const competing = store.acceptPlan({
    workRunId: owner.workRunId,
    ownerId: owner.ownerId,
    fence: owner.fence,
    expectedPlanDigest: null,
    planDigest: 'c'.repeat(64),
    artifact: { reference: 'artifact:plan654321', digest: 'c'.repeat(64) },
  });
  assert.equal(competing.ok, false);
  assert.equal(competing.reason, 'plan_compare_and_set_conflict');
  assert.equal(competing.authoritativePlanDigest, 'a'.repeat(64));
});

test('stale provider retries are idempotent and cannot replace a newer fenced route', () => {
  const store = createMemoryWorkRunStore();
  const first = claim(store, 'agent:one');
  const event = {
    workRunId: first.workRunId,
    ownerId: first.ownerId,
    fence: first.fence,
    type: 'route',
    operation: 'plan',
    status: 'started',
    operationNonce: 'nonce-plan-01',
    detail: 'route selected',
  };
  assert.equal(store.appendEvent(event).ok, true);
  const retry = store.appendEvent(event);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);

  assert.equal(store.releaseWorkRun({ workRunId: first.workRunId, ownerId: first.ownerId, fence: first.fence }).ok, true);
  const second = claim(store, 'agent:two');
  assert.equal(second.fence > first.fence, true);
  const stale = store.appendEvent({ ...event, detail: 'late retry' });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_fence');
  assert.equal(store.getWorkRun(first.workRunId).events.length, 1);
});

test('provider evidence bridges scalar diagnostics to the control-plane event shape', () => {
  const bridged = [];
  const store = createMemoryWorkRunStore({ evidencePort: { append: (input) => bridged.push(input) } });
  const owner = claim(store);
  const result = store.appendEvent({
    workRunId: owner.workRunId,
    ownerId: owner.ownerId,
    fence: owner.fence,
    type: 'route',
    operation: 'plan',
    operationNonce: 'nonce-bridge-01',
    detail: 'one bounded diagnostic',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(bridged[0].event.detail, ['one bounded diagnostic']);
});

test('no-op conflicts do not advance the durable work-run revision', () => {
  const store = createMemoryWorkRunStore();
  const owner = claim(store);
  const before = store.getWorkRun(owner.workRunId, { public: false });
  const conflict = store.appendEvent({
    workRunId: owner.workRunId,
    ownerId: 'agent:stale',
    fence: owner.fence,
    type: 'route',
    operationNonce: 'nonce-stale-01',
  });
  assert.equal(conflict.reason, 'stale_fence');
  const after = store.getWorkRun(owner.workRunId, { public: false });
  assert.equal(after.updatedAt, before.updatedAt);
});

test('public work-run projection exposes references and digests but no private paths or authority claims', () => {
  const store = createMemoryWorkRunStore();
  const owner = claim(store);
  const result = store.appendEvent({
    workRunId: owner.workRunId,
    ownerId: owner.ownerId,
    fence: owner.fence,
    type: 'artifact',
    operation: 'plan',
    status: 'succeeded',
    operationNonce: 'nonce-artifact-01',
    artifact: { kind: 'plan', reference: 'artifact:plan123456', path: '/private/jarvos/plan.md', digest: 'a'.repeat(64) },
    detail: 'private path /private/jarvos/plan.md',
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const serialized = JSON.stringify(result.public);
  assert.match(serialized, /artifact:plan123456/);
  assert.match(serialized, /[a-f]{64}/);
  assert.doesNotMatch(serialized, /private\/jarvos|plan\.md/);
  assert.doesNotMatch(serialized, /ownerId|canonicalWorktree|operationNonce/);
});

test('corrupt or incomplete durable state fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-run-corrupt-'));
  fs.writeFileSync(path.join(root, 'work-runs.json'), JSON.stringify({ schemaVersion: 'wrong', revision: 0, workRuns: {} }));
  const store = createFileWorkRunStore(root);
  assert.throws(() => store.getWorkRun('run_bad'), /invalid work-run state/);
});

test('a contending file-store writer cannot remove the active lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-run-lock-'));
  const store = createFileWorkRunStore(root);
  fs.writeFileSync(store.paths.lockPath, 'active writer');
  try {
    assert.throws(() => store.claimWorkRun({
      subjectKey: 'levineam/jarvOS:SUP-5001',
      canonicalWorktree: '/private/jarvos/worktrees/SUP-5001',
      ownerId: 'agent:one',
    }), /work-run store is busy/);
    assert.equal(fs.existsSync(store.paths.lockPath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
