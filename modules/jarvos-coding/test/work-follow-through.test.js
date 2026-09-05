'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createFileWorkRunStore,
  createMemoryWorkRunStore,
  createWorkFollowThrough,
} = require('../src');

function claimed(store, { workRunId = 'run_sup3905', ownerId = 'agent:codex' } = {}) {
  const result = store.claimWorkRun({
    subjectKey: 'levineam/jarvOS:SUP-3905',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-3905',
    workRunId,
    ownerId,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function binding(claim, overrides = {}) {
  return {
    outcomeId: 'out_390500',
    executorOwnerId: claim.ownerId,
    harnessWorkspaceId: 'workspace_sup3905',
    workRunId: claim.workRunId,
    todoId: 'bd_sup3905_next',
    triggerId: 'session_sup3905_resume',
    ownerId: claim.ownerId,
    fence: claim.fence,
    ...overrides,
  };
}

function nativeReceipt(claim, overrides = {}) {
  return {
    type: 'jarvos.native-invocation-receipt/v1',
    receiptType: 'native-invocation',
    executionPath: 'native',
    workRunId: claim.workRunId,
    executorOwnerId: claim.ownerId,
    harnessWorkspaceId: 'workspace_sup3905',
    fence: claim.fence,
    invocationId: 'native_sup3905_001',
    routingDecision: {
      type: 'jarvos.native-routing-decision/v1',
      decisionId: 'route_sup3905_001',
      workRunId: claim.workRunId,
      executorOwnerId: claim.ownerId,
      harnessWorkspaceId: 'workspace_sup3905',
      fence: claim.fence,
    },
    ...overrides,
  };
}

function unsupportedAdmission(claim, overrides = {}) {
  return {
    type: 'jarvos.managed-runtime-admission/v1',
    admissionId: 'admission_sup3905_001',
    workRunId: claim.workRunId,
    executorOwnerId: claim.ownerId,
    harnessWorkspaceId: 'workspace_sup3905',
    fence: claim.fence,
    disposition: 'unsupported',
    accepted: true,
    ...overrides,
  };
}

test('one outcome is durably bound to exactly one fenced coding run', () => {
  const store = createMemoryWorkRunStore();
  const first = claimed(store);
  const admitted = store.bindFollowThrough(binding(first));
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.deduped, false);

  const duplicate = store.bindFollowThrough(binding(first));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.deduped, true);

  const second = claimed(store, { workRunId: 'run_sup3905_other', ownerId: 'agent:other' });
  const conflict = store.bindFollowThrough(binding(second));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'outcome_binding_conflict');

  assert.equal(store.releaseWorkRun({ workRunId: first.workRunId, ownerId: first.ownerId, fence: first.fence }).ok, true);
  const renewed = claimed(store);
  assert.equal(renewed.fence > first.fence, true);
  const stale = store.bindFollowThrough(binding(first));
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_fence');
  assert.throws(() => store.getFollowThrough('__proto__'), /Projects outcome identifier/);
  assert.throws(() => store.bindFollowThrough(binding(renewed, { outcomeId: 'SUP-3905' })), /outcomeId must be an opaque identifier/);
});

test('assignee-only binding stays not-dispatched and never trusts caller evidence', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  assert.equal(store.bindFollowThrough(binding(claim)).ok, true);
  const followThrough = createWorkFollowThrough({ workRunStore: store });

  const summary = await followThrough.summarize({ outcomeId: 'out_390500', evidence: nativeReceipt(claim) });
  assert.equal(summary.status, 'not-dispatched');
  assert.equal(summary.disposition, 'not-dispatched');
});

test('only a resolver-captured exact native receipt can advance a bound run', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));

  const directHook = createWorkFollowThrough({
    workRunStore: store,
    hostReceiptResolver: async () => ({ ...nativeReceipt(claim), receiptType: 'direct-hook', executionPath: 'hook' }),
  });
  assert.equal((await directHook.summarize({ outcomeId: 'out_390500' })).status, 'unavailable');

  const native = createWorkFollowThrough({
    workRunStore: store,
    hostReceiptResolver: async () => nativeReceipt(claim),
  });
  assert.equal((await native.summarize({ outcomeId: 'out_390500' })).status, 'running');
});

test('interruption remains resumption-pending with its original action and trigger', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  assert.equal(store.setRecoveryState({
    workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence,
    state: 'blocked', reasonCode: 'provider_timeout_recovery',
  }).ok, true);
  const summary = await createWorkFollowThrough({ workRunStore: store }).summarize({ outcomeId: 'out_390500' });
  assert.equal(summary.status, 'resumption-pending');
  assert.equal(summary.execution.todoId, 'bd_sup3905_next');
  assert.equal(summary.execution.triggerId, 'session_sup3905_resume');
});

test('only accepted managed-runtime unsupported dispositions are visible and non-success', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  const rejected = createWorkFollowThrough({
    workRunStore: store,
    admissionResolver: async () => unsupportedAdmission(claim, { accepted: false }),
  });
  assert.equal((await rejected.summarize({ outcomeId: 'out_390500' })).status, 'unavailable');

  const accepted = createWorkFollowThrough({
    workRunStore: store,
    admissionResolver: async () => unsupportedAdmission(claim),
  });
  const summary = await accepted.summarize({ outcomeId: 'out_390500' });
  assert.equal(summary.status, 'unsupported');
  assert.equal(summary.success, false);
});

test('completion needs an exact native receipt plus accepted existing terminal evidence', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  store.setTerminalEvidence({
    workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence,
    evidence: { reference: 'source_merged_sup3905', status: 'source-merged' },
  });
  const native = createWorkFollowThrough({ workRunStore: store, hostReceiptResolver: async () => nativeReceipt(claim) });
  assert.equal((await native.summarize({ outcomeId: 'out_390500' })).status, 'unavailable');

  store.setTerminalEvidence({
    workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence,
    evidence: { reference: 'terminal_sup3905', status: 'accepted' },
  });
  const directHook = createWorkFollowThrough({
    workRunStore: store,
    hostReceiptResolver: async () => ({ ...nativeReceipt(claim), receiptType: 'direct-hook' }),
  });
  assert.equal((await directHook.summarize({ outcomeId: 'out_390500' })).status, 'unavailable');

  assert.equal((await native.summarize({ outcomeId: 'out_390500' })).status, 'accepted');
});

test('file-store restart preserves bindings and provider projection is path and secret free', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-follow-through-'));
  const store = createFileWorkRunStore(root);
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  const restarted = createFileWorkRunStore(root);
  const followThrough = createWorkFollowThrough({ workRunStore: restarted });
  const summary = await followThrough.summarize({ outcomeId: 'out_390500' });
  const projected = await followThrough.toProjectsSummary({ outcomeId: 'out_390500', canonicalId: 'out_390500', observedAt: '2026-09-05T00:00:00.000Z' });
  assert.equal(summary.execution.workRunId, claim.workRunId);
  assert.equal(projected.category, 'execution');
  assert.equal(projected.status, 'not-dispatched');
  assert.match(projected.title, /not-dispatched.*bd_sup3905_next/);
  assert.deepEqual(projected.evidenceRefs, ['agent:codex', 'workspace_sup3905', 'run_sup3905', 'bd_sup3905_next', 'session_sup3905_resume']);
  await assert.rejects(() => followThrough.toProjectsSummary({ outcomeId: 'out_390500', canonicalId: 'out_999999', observedAt: '2026-09-05T00:00:00.000Z' }), /must match outcomeId/);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /private\/jarvos|canonicalWorktree|ownerId|secret|token/i);
});

test('failed or blocked work runs cannot become running or accepted from a native receipt', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  const followThrough = createWorkFollowThrough({ workRunStore: store, hostReceiptResolver: async () => nativeReceipt(claim) });
  assert.equal(store.setTerminalEvidence({
    workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence,
    evidence: { reference: 'terminal_sup3905', status: 'accepted' },
  }).ok, true);
  assert.equal(store.setRecoveryState({
    workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence,
    state: 'failed', reasonCode: 'native_receipt_failed',
  }).ok, true);
  assert.equal((await followThrough.summarize({ outcomeId: 'out_390500' })).status, 'failed');
  const failedProjection = await followThrough.toProjectsSummary({
    outcomeId: 'out_390500', canonicalId: 'out_390500', observedAt: '2026-09-05T00:00:00.000Z',
  });
  assert.equal(failedProjection.category, 'attention');
  assert.equal(failedProjection.status, 'failed');
  assert.match(failedProjection.title, /failed/);

  const blockedStore = createMemoryWorkRunStore();
  const blockedClaim = claimed(blockedStore);
  blockedStore.bindFollowThrough(binding(blockedClaim));
  blockedStore.setRecoveryState({
    workRunId: blockedClaim.workRunId, ownerId: blockedClaim.ownerId, fence: blockedClaim.fence,
    state: 'blocked', reasonCode: 'provider_timeout_recovery',
  });
  const blocked = await createWorkFollowThrough({ workRunStore: blockedStore, hostReceiptResolver: async () => nativeReceipt(blockedClaim) }).summarize({ outcomeId: 'out_390500' });
  assert.equal(blocked.status, 'resumption-pending');
  assert.equal(blocked.success, false);
});

test('provider projection resolves trusted store state instead of a fabricated completion', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  const followThrough = createWorkFollowThrough({ workRunStore: store });
  const projected = await followThrough.toProjectsSummary({
    outcomeId: 'out_390500', canonicalId: 'out_390500', observedAt: '2026-09-05T00:00:00.000Z',
  }, { status: 'accepted', execution: binding(claim) });
  assert.equal(projected.status, 'not-dispatched');
  assert.match(projected.title, /not-dispatched/);
});

test('same-owner lease renewal advances only the fence and stale terminal evidence cannot close it', async () => {
  const store = createMemoryWorkRunStore();
  const first = claimed(store);
  store.bindFollowThrough(binding(first));
  store.setTerminalEvidence({
    workRunId: first.workRunId, ownerId: first.ownerId, fence: first.fence,
    evidence: { reference: 'terminal_sup3905', status: 'accepted' },
  });
  assert.equal(store.releaseWorkRun({ workRunId: first.workRunId, ownerId: first.ownerId, fence: first.fence }).ok, true);
  const renewed = claimed(store);
  const rebind = store.bindFollowThrough(binding(renewed));
  assert.equal(rebind.ok, true);
  assert.equal(rebind.renewed, true);
  assert.equal(rebind.binding.fence, renewed.fence);
  assert.equal(rebind.binding.leaseHistory.length, 2);

  const followThrough = createWorkFollowThrough({ workRunStore: store, hostReceiptResolver: async () => nativeReceipt(renewed) });
  assert.equal((await followThrough.summarize({ outcomeId: 'out_390500' })).status, 'unavailable');
  assert.equal(store.setRecoveryState({
    workRunId: renewed.workRunId, ownerId: renewed.ownerId, fence: renewed.fence,
    state: 'blocked', reasonCode: 'provider_timeout_recovery',
  }).ok, true);
  const resumed = await followThrough.summarize({ outcomeId: 'out_390500' });
  assert.equal(resumed.status, 'resumption-pending');
  assert.equal(resumed.execution.fence, renewed.fence);
});

test('unsupported disposition must match the current admitted lease', async () => {
  const store = createMemoryWorkRunStore();
  const first = claimed(store);
  store.bindFollowThrough(binding(first));
  assert.equal(store.releaseWorkRun({ workRunId: first.workRunId, ownerId: first.ownerId, fence: first.fence }).ok, true);
  const renewed = claimed(store);
  store.bindFollowThrough(binding(renewed));
  const stale = await createWorkFollowThrough({
    workRunStore: store,
    admissionResolver: async () => unsupportedAdmission(first),
  }).summarize({ outcomeId: 'out_390500' });
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.reason, 'unsupported_disposition_unaccepted');
});

test('released completed work remains accepted only at its original fence', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  store.setTerminalEvidence({
    workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence,
    evidence: { reference: 'terminal_sup3905', status: 'accepted' },
  });
  const followThrough = createWorkFollowThrough({ workRunStore: store, hostReceiptResolver: async () => nativeReceipt(claim) });
  assert.equal(store.releaseWorkRun({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence }).ok, true);
  assert.equal((await followThrough.summarize({ outcomeId: 'out_390500' })).status, 'accepted');

  const reclaimed = claimed(store);
  assert.equal(reclaimed.fence > claim.fence, true);
  const stale = await followThrough.summarize({ outcomeId: 'out_390500' });
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.reason, 'binding_owner_fence_conflict');
});

test('resolver-side run mutation invalidates the one-shot summary snapshot', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  const followThrough = createWorkFollowThrough({
    workRunStore: store,
    hostReceiptResolver: async () => {
      store.setRecoveryState({
        workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence,
        state: 'failed', reasonCode: 'native_receipt_failed',
      });
      return nativeReceipt(claim);
    },
  });
  const result = await followThrough.summarize({ outcomeId: 'out_390500' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'follow_through_state_changed');
});

test('owner or fence drift and incomplete receipt correlation are visible conflicts', async () => {
  const store = createMemoryWorkRunStore();
  const claim = claimed(store);
  store.bindFollowThrough(binding(claim));
  assert.equal(store.releaseWorkRun({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence }).ok, true);
  const replacement = claimed(store, { ownerId: 'agent:replacement' });
  const drifted = await createWorkFollowThrough({ workRunStore: store, hostReceiptResolver: async () => nativeReceipt(claim) }).summarize({ outcomeId: 'out_390500' });
  assert.equal(replacement.fence > claim.fence, true);
  assert.equal(drifted.status, 'unavailable');
  assert.equal(drifted.reason, 'binding_owner_fence_conflict');

  const cleanStore = createMemoryWorkRunStore();
  const cleanClaim = claimed(cleanStore);
  cleanStore.bindFollowThrough(binding(cleanClaim));
  const incomplete = await createWorkFollowThrough({
    workRunStore: cleanStore,
    hostReceiptResolver: async () => nativeReceipt(cleanClaim, { routingDecision: null }),
  }).summarize({ outcomeId: 'out_390500' });
  assert.equal(incomplete.status, 'unavailable');
  assert.equal(incomplete.reason, 'native_receipt_correlation_unavailable');
});
