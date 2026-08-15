'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  IMPLEMENTATION_PACKET_VERSION,
  createManagedCodingWorkflow,
  createMemoryWorkRunStore,
  deriveLearningSignal,
  validateImplementationPacket,
  runTakeIssueToDone,
} = require('../src');

const baseManifest = require('../providers/compound-engineering.json');

function manifest() {
  return {
    ...baseManifest,
    harnesses: {
      ...baseManifest.harnesses,
      codex: { ...baseManifest.harnesses.codex, status: 'supported' },
    },
  };
}

function provider(currentManifest) {
  return {
    id: currentManifest.id,
    version: currentManifest.version,
    pinDigest: currentManifest.source.contentDigest,
    harness: 'codex',
    adapterVersion: 'codex-ce-adapter.v1',
    status: 'verified',
  };
}

function receipt(invocation, operation, acceptedPlanDigest = null) {
  const plan = operation === 'plan';
  return {
    version: 'jarvos-workflow-provider-receipt/v1',
    operation,
    status: 'succeeded',
    workRunId: invocation.workRunId,
    operationNonce: invocation.operationNonce,
    idempotencyKey: invocation.idempotencyKey,
    provider: invocation.provider,
    artifact: {
      kind: operation,
      reference: `artifact:${operation}123456`,
      path: `/private/jarvos/${operation}.json`,
      digest: plan ? 'a'.repeat(64) : 'd'.repeat(64),
    },
    planRevisionDigest: plan ? 'a'.repeat(64) : null,
    acceptedPlanDigest: plan ? null : acceptedPlanDigest,
    publicLabel: `CE ${operation} artifact`,
    diagnostics: [],
  };
}

function packet(planDigest) {
  return {
    version: IMPLEMENTATION_PACKET_VERSION,
    planDigest,
    summary: 'bounded implementation packet',
    steps: [{ id: 'step-01', description: 'Update the reviewed implementation packet', files: ['src/index.js'] }],
  };
}

function terminalAdapters() {
  return {
    reviewEngine: {
      sliceReview: async () => ({ status: 'passed', ok: true }),
      holisticReview: async () => ({ status: 'passed', ok: true }),
    },
    tracker: {
      claimIssue: async () => ({ status: 'claimed', ok: true, workReference: { authority: 'fixture', itemId: 'SUP-5020' } }),
      verifyAndClose: async () => ({ status: 'closed', ok: true, liveConfirmed: true }),
    },
    git: { createBranch: async ({ branch }) => ({ status: 'created', branch, ok: true }) },
    fixer: { fixAndRerun: async () => ({ status: 'passed', ok: true, git: { clean: true }, tests: [{ command: 'fixture', status: 'passed' }] }) },
    pullRequest: { openPullRequest: async () => ({ status: 'created', merged: true, ok: true, liveConfirmed: true, url: 'https://example.test/pr/1' }) },
    postMerge: { sweep: async () => ({ status: 'completed', ok: true }) },
  };
}

test('implementation packets are provider-independent and reject shell/traversal input', () => {
  assert.equal(validateImplementationPacket(packet('a'.repeat(64)), 'a'.repeat(64)).ok, true);
  assert.equal(validateImplementationPacket({ ...packet('a'.repeat(64)), steps: [{ id: 'step-01', description: 'run; rm -rf /' }] }, 'a'.repeat(64)).ok, false);
  assert.equal(validateImplementationPacket({ ...packet('a'.repeat(64)), steps: [{ id: 'step-01', description: 'bad path', files: ['../escape'] }] }, 'a'.repeat(64)).ok, false);
});

test('healthy CE plan and work share one canonical run and the approved provider pin', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const store = createMemoryWorkRunStore();
  const invocations = [];
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerAdapter: {
      plan: async (invocation) => { invocations.push(invocation); return receipt(invocation, 'plan'); },
      work: async (invocation) => { invocations.push(invocation); return receipt(invocation, 'work', 'a'.repeat(64)); },
    },
  });
  const plan = await workflow.plan({
    subjectKey: 'levineam/jarvOS:SUP-5000',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5000',
    provider: { ...currentProvider, pinDigest: 'f'.repeat(64) },
    operationNonce: 'nonce-plan-01',
    idempotencyKey: 'idem-plan-01',
  });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.route, 'compound-engineering');
  assert.equal(invocations[0].canonicalWorktree, '/private/jarvos/worktrees/SUP-5000');
  assert.deepEqual(invocations[0].args, ['plan', invocations[0].workRunId, 'nonce-plan-01']);
  assert.equal(invocations[0].executable, undefined);
  assert.equal(invocations[0].cwd, undefined);
  assert.equal(invocations[0].pluginId, undefined);

  const accepted = await workflow.acceptPlan({
    subjectKey: 'levineam/jarvOS:SUP-5000',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5000',
    provider: currentProvider,
    planDigest: 'a'.repeat(64),
    packet: packet('a'.repeat(64)),
    artifact: { reference: 'artifact:plan123456', digest: 'a'.repeat(64) },
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const work = await workflow.work({
    subjectKey: 'levineam/jarvOS:SUP-5000',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5000',
    provider: { ...currentProvider, version: 'forged-version' },
    planDigest: 'a'.repeat(64),
    packet: packet('a'.repeat(64)),
    operationNonce: 'nonce-work-01',
    idempotencyKey: 'idem-work-01',
  });
  assert.equal(work.ok, true, JSON.stringify(work));
  assert.equal(work.route, 'compound-engineering');
  assert.equal(work.workRunId, plan.workRunId);
  assert.equal(invocations[1].implementationPacket.planDigest, 'a'.repeat(64));
  assert.equal(invocations[0].provider.pinDigest, currentProvider.pinDigest);
  assert.equal(invocations[1].provider.version, currentProvider.version);
});

test('changed accepted plans stop before any provider process boundary', async () => {
  const currentManifest = manifest();
  let calls = 0;
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: createMemoryWorkRunStore(),
    ownerId: 'agent:codex',
    providerSnapshot: provider(currentManifest),
    providerAdapter: { work: async () => { calls += 1; throw new Error('must not run'); } },
  });
  const result = await workflow.work({
    subjectKey: 'levineam/jarvOS:SUP-5001',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5001',
    provider: provider(currentManifest),
    planDigest: 'b'.repeat(64),
    packet: packet('b'.repeat(64)),
    operationNonce: 'nonce-work-02',
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'accepted_plan_mismatch');
  assert.equal(calls, 0);
});

test('changed accepted packets stop before any provider process boundary', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  let calls = 0;
  const store = createMemoryWorkRunStore();
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerAdapter: { work: async () => { calls += 1; throw new Error('must not run'); } },
  });
  const subjectKey = 'levineam/jarvOS:SUP-5006';
  await workflow.acceptPlan({
    subjectKey,
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5006',
    planDigest: 'c'.repeat(64),
    packet: packet('c'.repeat(64)),
    artifact: { reference: 'artifact:plan123456', digest: 'c'.repeat(64) },
  });
  const changed = { ...packet('c'.repeat(64)), steps: [{ id: 'step-02', description: 'Use a different accepted step', files: ['src/other.js'] }] };
  const result = await workflow.work({
    subjectKey,
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5006',
    planDigest: 'c'.repeat(64),
    packet: changed,
    operationNonce: 'nonce-work-06',
  });
  assert.equal(result.reasonCode, 'accepted_plan_mismatch');
  assert.equal(calls, 0);
});

test('provider failure falls back inside the same run and preserves the normalized packet', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const store = createMemoryWorkRunStore();
  const nativePackets = [];
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerAdapter: { plan: async () => { throw new Error('CE unavailable'); } },
    nativeAdapter: { plan: async (invocation) => { nativePackets.push(invocation); return { artifact: 'native-plan' }; } },
  });
  const result = await workflow.plan({
    subjectKey: 'levineam/jarvOS:SUP-5002',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5002',
    provider: currentProvider,
    operationNonce: 'nonce-plan-02',
  });
  assert.equal(result.route, 'native-fallback');
  assert.equal(result.workRunId, nativePackets[0].workRunId);
  assert.equal(nativePackets[0].canonicalWorktree, '/private/jarvos/worktrees/SUP-5002');
  assert.equal(store.getWorkRun(result.workRunId).events.length, 1);
});

test('native fallback can accept and execute a plan without a CE provider snapshot', async () => {
  const currentManifest = manifest();
  const store = createMemoryWorkRunStore();
  let nativeWorkCalls = 0;
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    nativeAdapter: {
      plan: async () => ({ artifact: 'native-plan' }),
      work: async () => { nativeWorkCalls += 1; return { artifact: 'native-work' }; },
    },
  });
  const input = { subjectKey: 'levineam/jarvOS:SUP-5007', canonicalWorktree: '/private/jarvos/worktrees/SUP-5007', operationNonce: 'nonce-native-07' };
  const planned = await workflow.plan(input);
  assert.equal(planned.route, 'native-fallback');
  const accepted = await workflow.acceptPlan({ ...input, planDigest: 'd'.repeat(64), packet: packet('d'.repeat(64)), artifact: { reference: 'artifact:plan123456', digest: 'd'.repeat(64) } });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const worked = await workflow.work({ ...input, planDigest: 'd'.repeat(64), packet: packet('d'.repeat(64)) });
  assert.equal(worked.route, 'native-fallback');
  const replay = await workflow.work({ ...input, planDigest: 'd'.repeat(64), packet: packet('d'.repeat(64)) });
  assert.equal(replay.deduped, true);
  assert.equal(nativeWorkCalls, 1);
});

test('native fallback failure to record recovery blocks retries before edits repeat', async () => {
  const currentManifest = manifest();
  const store = createMemoryWorkRunStore();
  let nativeWorkCalls = 0;
  const originalAppendEvent = store.appendEvent;
  store.appendEvent = (input) => input.type === 'recovery' ? { ok: false, reason: 'evidence_backend_unavailable' } : originalAppendEvent(input);
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    nativeAdapter: { work: async () => { nativeWorkCalls += 1; return { artifact: 'native-work' }; } },
  });
  const subjectKey = 'levineam/jarvOS:SUP-5009';
  const input = { subjectKey, canonicalWorktree: '/private/jarvos/worktrees/SUP-5009', planDigest: 'f'.repeat(64), packet: packet('f'.repeat(64)), operationNonce: 'nonce-native-09' };
  const claim = store.claimWorkRun({ subjectKey, canonicalWorktree: input.canonicalWorktree, ownerId: 'agent:codex' });
  store.acceptPlan({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, planDigest: input.planDigest, packetDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(input.packet)).digest('hex'), artifact: { reference: 'artifact:plan123456', digest: input.planDigest } });
  const first = await workflow.work(input);
  assert.equal(first.reasonCode, 'recovery_event_not_recorded');
  const second = await workflow.work(input);
  assert.equal(second.reasonCode, 'recovery_event_not_recorded');
  assert.equal(nativeWorkCalls, 1);
});

test('native fallback in progress blocks concurrent work retries', async () => {
  const currentManifest = manifest();
  const store = createMemoryWorkRunStore();
  let nativeWorkCalls = 0;
  let releaseNative;
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    nativeAdapter: {
      work: async () => {
        nativeWorkCalls += 1;
        await new Promise((resolve) => { releaseNative = resolve; });
        return { artifact: 'native-work' };
      },
    },
  });
  const subjectKey = 'levineam/jarvOS:SUP-5010';
  const input = { subjectKey, canonicalWorktree: '/private/jarvos/worktrees/SUP-5010', planDigest: '1'.repeat(64), packet: packet('1'.repeat(64)), operationNonce: 'nonce-native-10' };
  const claim = store.claimWorkRun({ subjectKey, canonicalWorktree: input.canonicalWorktree, ownerId: 'agent:codex' });
  store.acceptPlan({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, planDigest: input.planDigest, packetDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(input.packet)).digest('hex'), artifact: { reference: 'artifact:plan123456', digest: input.planDigest } });
  const first = workflow.work(input);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await workflow.work(input);
  assert.equal(second.reasonCode, 'native_fallback_in_progress');
  assert.equal(nativeWorkCalls, 1);
  releaseNative();
  const completed = await first;
  assert.equal(completed.ok, true);
});

test('native fallback reservation is compare-and-set safe for stale concurrent claims', () => {
  const store = createMemoryWorkRunStore();
  const subjectKey = 'levineam/jarvOS:SUP-5011';
  const canonicalWorktree = '/private/jarvos/worktrees/SUP-5011';
  const first = store.claimWorkRun({ subjectKey, canonicalWorktree, ownerId: 'agent:codex' });
  const stale = store.claimWorkRun({ subjectKey, canonicalWorktree, ownerId: 'agent:codex' });
  const firstReservation = store.setRecoveryState({
    workRunId: first.workRunId,
    ownerId: first.ownerId,
    fence: first.fence,
    state: 'blocked',
    reasonCode: 'native_fallback_in_progress',
  });
  const staleReservation = store.setRecoveryState({
    workRunId: stale.workRunId,
    ownerId: stale.ownerId,
    fence: stale.fence,
    state: 'blocked',
    reasonCode: 'native_fallback_in_progress',
  });
  assert.equal(firstReservation.ok, true);
  assert.equal(staleReservation.ok, false);
  assert.equal(staleReservation.reason, 'recovery_in_progress');
});

test('native fallback adapter failure records a failed recovery and blocks retries', async () => {
  const currentManifest = manifest();
  const store = createMemoryWorkRunStore();
  let nativeWorkCalls = 0;
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    nativeAdapter: {
      work: async () => {
        nativeWorkCalls += 1;
        throw new Error('native adapter failed');
      },
    },
  });
  const input = {
    subjectKey: 'levineam/jarvOS:SUP-5012',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5012',
    planDigest: '2'.repeat(64),
    packet: packet('2'.repeat(64)),
    operationNonce: 'nonce-native-12',
  };
  const claim = store.claimWorkRun({ ...input, ownerId: 'agent:codex' });
  store.acceptPlan({
    workRunId: claim.workRunId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    planDigest: input.planDigest,
    packetDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(input.packet)).digest('hex'),
    artifact: { reference: 'artifact:plan123456', digest: input.planDigest },
  });
  const first = await workflow.work(input);
  const second = await workflow.work(input);
  assert.equal(first.reasonCode, 'native_fallback_failed');
  assert.equal(second.reasonCode, 'native_fallback_failed');
  assert.equal(nativeWorkCalls, 1);
  assert.equal(store.getWorkRun(claim.workRunId, { public: false }).recovery.state, 'failed');
});

test('failed provider receipts use a distinct route nonce and native plan fallback', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const store = createMemoryWorkRunStore();
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerAdapter: {
      plan: async (invocation) => ({ ...receipt(invocation, 'plan'), status: 'failed' }),
    },
    nativeAdapter: { plan: async () => ({ artifact: 'native-plan' }) },
  });
  const result = await workflow.plan({
    subjectKey: 'levineam/jarvOS:SUP-5003',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5003',
    operationNonce: 'nonce-plan-03',
  });
  assert.equal(result.route, 'native-fallback');
  const events = store.getWorkRun(result.workRunId, { public: false }).events;
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'provider');
  assert.equal(events[1].type, 'route');
  assert.notEqual(events[0].operationNonce, events[1].operationNonce);
});

test('work fallback blocks before native edits when reconciliation is unsafe', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const store = createMemoryWorkRunStore();
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerAdapter: {
      work: async () => { throw new Error('CE disconnected after edits began'); },
    },
    nativeAdapter: {
      reconcileWork: async () => ({ safe: false }),
      work: async () => { throw new Error('must not edit'); },
    },
  });
  const subjectKey = 'levineam/jarvOS:SUP-5004';
  const claim = store.claimWorkRun({ subjectKey, canonicalWorktree: '/private/jarvos/worktrees/SUP-5004', ownerId: 'agent:codex', providerSnapshot: currentProvider });
  store.acceptPlan({
    workRunId: claim.workRunId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    planDigest: 'a'.repeat(64),
    packetDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(packet('a'.repeat(64)))).digest('hex'),
    artifact: { reference: 'artifact:plan123456', digest: 'a'.repeat(64) },
  });
  const result = await workflow.work({ subjectKey, canonicalWorktree: '/private/jarvos/worktrees/SUP-5004', planDigest: 'a'.repeat(64), packet: packet('a'.repeat(64)), operationNonce: 'nonce-work-04' });
  assert.equal(result.status, 'blocked');
  assert.equal(store.getWorkRun(claim.workRunId, { public: false }).recovery.state, 'blocked');
});

test('provider timeout blocks plan instead of racing a second native plan', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: createMemoryWorkRunStore(),
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerTimeoutMs: 5,
    providerAdapter: { plan: async () => new Promise(() => {}) },
    nativeAdapter: { plan: async () => ({ artifact: 'native-plan' }) },
  });
  const result = await workflow.plan({ subjectKey: 'levineam/jarvOS:SUP-5005', canonicalWorktree: '/private/jarvos/worktrees/SUP-5005' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reasonCode, 'provider_timeout');
});

test('timed-out work waits for provider settlement, then reconciles once and replays durably', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const store = createMemoryWorkRunStore();
  let settleProvider;
  let nativeWorkCalls = 0;
  let releaseNative;
  let signalNativeStarted;
  const nativeStarted = new Promise((resolve) => { signalNativeStarted = resolve; });
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerTimeoutMs: 5,
    providerAdapter: { work: async () => new Promise((resolve) => { settleProvider = resolve; }) },
    nativeAdapter: {
      reconcileWork: async () => ({ safe: true }),
      work: async () => {
        nativeWorkCalls += 1;
        signalNativeStarted();
        await new Promise((resolve) => { releaseNative = resolve; });
        return { artifact: 'native-work' };
      },
    },
  });
  const subjectKey = 'levineam/jarvOS:SUP-5008';
  const input = { subjectKey, canonicalWorktree: '/private/jarvos/worktrees/SUP-5008', planDigest: 'e'.repeat(64), packet: packet('e'.repeat(64)), operationNonce: 'nonce-work-08' };
  const claim = store.claimWorkRun({ ...input, ownerId: 'agent:codex', providerSnapshot: currentProvider });
  store.acceptPlan({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, planDigest: input.planDigest, packetDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(input.packet)).digest('hex'), providerPinDigest: currentProvider.pinDigest, artifact: { reference: 'artifact:plan123456', digest: input.planDigest } });
  const timedOut = await workflow.work(input);
  assert.equal(timedOut.reasonCode, 'provider_timeout');
  const pending = await workflow.work(input);
  assert.equal(pending.reasonCode, 'provider_pending');
  settleProvider({});
  await new Promise((resolve) => setImmediate(resolve));
  const recovering = workflow.work(input);
  await nativeStarted;
  const concurrent = await workflow.work(input);
  assert.equal(concurrent.reasonCode, 'native_fallback_in_progress');
  releaseNative();
  const recovered = await recovering;
  assert.equal(recovered.route, 'native-fallback');
  const replay = await workflow.work(input);
  assert.equal(replay.deduped, true);
  assert.equal(nativeWorkCalls, 1);
});

test('controller acceptance requires owner evidence under the public human-evidence policy', async () => {
  const currentManifest = manifest();
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: createMemoryWorkRunStore(),
    ownerId: 'agent:codex',
    acceptancePolicy: { mode: 'human-evidence-required' },
  });
  const input = { subjectKey: 'levineam/jarvOS:SUP-5013', canonicalWorktree: '/private/jarvos/worktrees/SUP-5013', planDigest: '3'.repeat(64), packet: packet('3'.repeat(64)), artifact: { reference: 'artifact:plan123456', digest: '3'.repeat(64) } };
  const blocked = await workflow.acceptPlan(input);
  assert.equal(blocked.status, 'awaiting-plan-acceptance');
  const accepted = await workflow.acceptPlan({ ...input, acceptanceEvidence: { source: 'owner-cli', planDigest: input.planDigest, packetDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(input.packet)).digest('hex') } });
  assert.equal(accepted.ok, true);
});

test('native terminal work is durably reused by finish instead of running external stages twice', async () => {
  const store = createMemoryWorkRunStore();
  let nativeCalls = 0;
  const workflow = createManagedCodingWorkflow({
    manifest: manifest(),
    workRunStore: store,
    ownerId: 'agent:codex',
    nativeAdapter: {
      work: async (invocation) => {
        nativeCalls += 1;
        return runTakeIssueToDone({ ...invocation.input, issueIdentifier: invocation.issueIdentifier, canonicalWorktree: invocation.canonicalWorktree }, terminalAdapters());
      },
    },
    finishAdapters: {
      tracker: { verifyAndClose: async () => { throw new Error('finish must reuse native completion'); } },
    },
  });
  const planDigest = '9'.repeat(64);
  const input = { subjectKey: 'levineam/jarvOS:SUP-5020', issueIdentifier: 'SUP-5020', canonicalWorktree: '/private/jarvos/worktrees/SUP-5020', planDigest, packet: packet(planDigest) };
  const accepted = await workflow.acceptPlan({ ...input, artifact: { reference: 'artifact:plan123456', digest: planDigest } });
  assert.equal(accepted.ok, true);
  const worked = await workflow.work(input);
  assert.equal(worked.ok, true);
  const finished = await workflow.finish({ ...input, nonRoutine: true });
  assert.equal(finished.primaryCompletion, 'completed');
  assert.equal(finished.learning.status, 'unavailable');
  assert.equal(nativeCalls, 1);
  assert.ok(store.getWorkRun(worked.workRunId, { public: false }).nativeCompletion);
});

test('legacy complete is fail-closed before accepted plan evidence and never trusts caller learning', async () => {
  const workflow = createManagedCodingWorkflow({ manifest: manifest(), workRunStore: createMemoryWorkRunStore(), ownerId: 'agent:codex' });
  const result = await workflow.complete({
    subjectKey: 'levineam/jarvOS:SUP-5014',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5014',
    planDigest: '4'.repeat(64),
    learning: { category: 'root-cause', summary: 'caller supplied learning must not publish' },
  });
  assert.equal(result.status, 'awaiting-plan-acceptance');
});

test('durable learning-tail reservation survives a restart shape and allows only one finalizer attempt', () => {
  const store = createMemoryWorkRunStore();
  const claim = store.claimWorkRun({ subjectKey: 'levineam/jarvOS:SUP-5016', canonicalWorktree: '/private/jarvos/worktrees/SUP-5016', ownerId: 'agent:codex' });
  store.setLearningTail({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, status: 'eligible', signal: { category: 'operational-lesson', summary: 'Preserve verified evidence', evidenceDigest: '6'.repeat(64) } });
  const first = store.reserveLearningFinalizer({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence });
  const replay = store.reserveLearningFinalizer({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence });
  assert.equal(first.ok, true);
  assert.equal(replay.reason, 'learning_finalizer_in_progress');
  assert.equal(store.getWorkRun(claim.workRunId, { public: false }).learningTail.attempts, 1);
});

test('status reconciles an interrupted finalizer reservation into the same durable retry tail', async () => {
  const store = createMemoryWorkRunStore();
  const workflow = createManagedCodingWorkflow({ manifest: manifest(), workRunStore: store, ownerId: 'agent:codex' });
  const subjectKey = 'levineam/jarvOS:SUP-5017';
  const claim = store.claimWorkRun({ subjectKey, canonicalWorktree: '/private/jarvos/worktrees/SUP-5017', ownerId: 'agent:codex' });
  store.acceptPlan({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, planDigest: '7'.repeat(64), packetDigest: '8'.repeat(64), artifact: { reference: 'artifact:plan123456', digest: '7'.repeat(64) } });
  store.setTerminalEvidence({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, evidence: { reference: 'terminal_123456', digest: '9'.repeat(64), status: 'completed' } });
  store.setLearningTail({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, status: 'eligible', signal: { category: 'operational-lesson', summary: 'Preserve verified evidence', evidenceDigest: 'a'.repeat(64) } });
  store.reserveLearningFinalizer({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence });
  const resumed = await workflow.status({ subjectKey, canonicalWorktree: '/private/jarvos/worktrees/SUP-5017', planDigest: '7'.repeat(64) });
  assert.equal(resumed.status, 'verified');
  assert.equal(store.getWorkRun(claim.workRunId, { public: false }).learningTail.status, 'retryable-unavailable');
});

test('persisted learning retries reuse one provider operation identity and artifact', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const store = createMemoryWorkRunStore();
  const invocations = [];
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerAdapter: {
      compound: async (invocation) => {
        invocations.push(invocation);
        return receipt(invocation, 'compound', 'b'.repeat(64));
      },
    },
  });
  const input = {
    subjectKey: 'levineam/jarvOS:SUP-5018',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5018',
    planDigest: 'b'.repeat(64),
  };
  const claim = store.claimWorkRun({ ...input, ownerId: 'agent:codex', providerSnapshot: currentProvider });
  store.acceptPlan({
    workRunId: claim.workRunId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    planDigest: input.planDigest,
    packetDigest: 'c'.repeat(64),
    providerPinDigest: currentProvider.pinDigest,
    artifact: { reference: 'artifact:plan123456', digest: input.planDigest },
  });
  store.setLearningTail({
    workRunId: claim.workRunId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    status: 'eligible',
    signal: { category: 'operational-lesson', summary: 'Preserve the verified operation identity', evidenceDigest: 'd'.repeat(64) },
  });
  const first = await workflow.compound({ ...input, learning: store.getWorkRun(claim.workRunId, { public: false }).learningTail.signal, persistLearningSignal: true });
  const second = await workflow.compound({ ...input, learning: store.getWorkRun(claim.workRunId, { public: false }).learningTail.signal, persistLearningSignal: true });
  assert.equal(first.learningStatus, 'captured');
  assert.equal(second.reasonCode, 'one_learning_per_work_run');
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].idempotencyKey, `compound:${claim.workRunId}`);
});

test('a verified non-routine authoritative result derives a learning candidate without caller signals', () => {
  const verification = { status: 'completed', submissionGate: { ready: true, nonRoutine: true }, events: ['claim', 'branch', 'sliceReview', 'holisticReview', 'fixRerun', 'pullRequest', 'postMergeSweep', 'verifyClose'].map((stage) => ({ stage, result: stage === 'verifyClose' ? { status: 'closed' } : { status: 'completed' } })) };
  const derived = deriveLearningSignal(verification);
  assert.equal(derived.ok, true);
  assert.equal(derived.signal.category, 'operational-lesson');
});
