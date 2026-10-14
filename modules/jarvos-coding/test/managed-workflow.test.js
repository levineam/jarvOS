'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  IMPLEMENTATION_PACKET_VERSION,
  createManagedCodingWorkflow,
  createMemoryWorkRunStore,
  validateImplementationPacket,
} = require('../src');

const baseManifest = require('../providers/compound-engineering.json');

test('the managed workflow loads its published provider manifest when none is injected', () => {
  const workflow = createManagedCodingWorkflow({ workRunStore: createMemoryWorkRunStore() });
  assert.equal(workflow.manifest.id, baseManifest.id);
  assert.equal(workflow.manifest.version, baseManifest.version);
  assert.equal(workflow.manifest.source.contentDigest, baseManifest.source.contentDigest);
});

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
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5000',
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
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5001',
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
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5006',
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
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5002',
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
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5007',
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
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5003',
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
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5005',
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
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerSnapshot: currentProvider,
    providerTimeoutMs: 5,
    providerAdapter: { work: async () => new Promise((resolve) => { settleProvider = resolve; }) },
    nativeAdapter: {
      reconcileWork: async () => ({ safe: true }),
      work: async () => { nativeWorkCalls += 1; return { artifact: 'native-work' }; },
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
  const recovered = await workflow.work(input);
  assert.equal(recovered.route, 'native-fallback');
  const replay = await workflow.work(input);
  assert.equal(replay.deduped, true);
  assert.equal(nativeWorkCalls, 1);
});

// SUP-3816: factory owner/root are authoritative; caller values are same-valued assertions only.
const AUTHORITY_ERROR = /owner|worktree|bootstrap|canonical/i;
const FACTORY_OWNER = 'agent:codex';

function digestOf(value) {
  return require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function recordingAdapters({ providerPlanFails = false } = {}) {
  const calls = { provider: [], native: [] };
  const providerAdapter = {
    plan: async (invocation) => {
      calls.provider.push({ operation: 'plan', invocation });
      if (providerPlanFails) throw new Error('CE unavailable');
      return receipt(invocation, 'plan');
    },
    work: async (invocation) => {
      calls.provider.push({ operation: 'work', invocation });
      return receipt(invocation, 'work', invocation.implementationPacket?.planDigest || null);
    },
    compound: async (invocation) => { calls.provider.push({ operation: 'compound', invocation }); return {}; },
  };
  const nativeAdapter = {
    plan: async (invocation) => { calls.native.push({ operation: 'plan', invocation }); return { artifact: 'native-plan' }; },
    work: async (invocation) => { calls.native.push({ operation: 'work', invocation }); return { artifact: 'native-work' }; },
    reconcileWork: async (invocation) => { calls.native.push({ operation: 'reconcileWork', invocation }); return { safe: true }; },
  };
  return { calls, providerAdapter, nativeAdapter };
}

async function outcomeOf(operation) {
  try {
    return { result: await operation() };
  } catch (error) {
    return { error };
  }
}

function assertAuthorityRefused(outcome, label) {
  if (outcome.error) {
    assert.match(String(outcome.error.message), AUTHORITY_ERROR, `${label}: ${outcome.error.message}`);
    return;
  }
  const { result } = outcome;
  assert.notEqual(result?.ok, true, `${label} must refuse: ${JSON.stringify(result)}`);
  const reason = JSON.stringify({ reasonCode: result?.reasonCode, reason: result?.reason, detail: result?.detail, errors: result?.errors });
  assert.match(reason, AUTHORITY_ERROR, `${label}: ${reason}`);
}

function durableAuthority(store, workRunId) {
  const run = store.getWorkRun(workRunId, { public: false });
  return run && {
    canonicalWorktree: run.canonicalWorktree,
    ownerId: run.ownerId,
    fence: run.fence,
    acceptedPlan: run.acceptedPlan,
    events: run.events,
    recovery: run.recovery,
  };
}

test('caller owner and worktree assertions cannot retarget, adopt or create a durable run', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const rootA = '/private/jarvos/worktrees/SUP-6001-a';
  const rootB = '/private/jarvos/worktrees/SUP-6001-b';
  const store = createMemoryWorkRunStore();
  const { calls, providerAdapter, nativeAdapter } = recordingAdapters();
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: FACTORY_OWNER,
    canonicalWorktree: rootA,
    providerSnapshot: currentProvider,
    providerAdapter,
    nativeAdapter,
  });

  const ownedSubject = 'levineam/jarvOS:SUP-6001';
  const ownedRunId = 'run-sup-6001-owned';
  assert.equal(store.claimWorkRun({ subjectKey: ownedSubject, canonicalWorktree: rootA, workRunId: ownedRunId, ownerId: FACTORY_OWNER }).ok, true);
  const ownedBefore = durableAuthority(store, ownedRunId);
  const foreignSubject = 'levineam/jarvOS:SUP-6002';
  const foreignRunId = 'run-sup-6002-foreign';
  assert.equal(store.claimWorkRun({ subjectKey: foreignSubject, canonicalWorktree: rootA, workRunId: foreignRunId, ownerId: 'agent:other' }).ok, true);
  const foreignBefore = durableAuthority(store, foreignRunId);

  const durableAttempts = [
    ['durable root A with caller root B', { subjectKey: ownedSubject, workRunId: ownedRunId, canonicalWorktree: rootB }],
    ['foreign caller owner', { subjectKey: ownedSubject, workRunId: ownedRunId, ownerId: 'agent:intruder' }],
    ['factory owner adopting a foreign preclaimed run', { subjectKey: foreignSubject, workRunId: foreignRunId, ownerId: FACTORY_OWNER }],
    ['caller impersonating the foreign preclaimed owner', { subjectKey: foreignSubject, workRunId: foreignRunId, ownerId: 'agent:other' }],
  ];
  for (const [label, input] of durableAttempts) {
    assertAuthorityRefused(await outcomeOf(() => workflow.plan({ ...input, operationNonce: 'nonce-authority-01' })), label);
  }
  assert.deepEqual(calls, { provider: [], native: [] });
  assert.deepEqual(durableAuthority(store, ownedRunId), ownedBefore);
  assert.deepEqual(durableAuthority(store, foreignRunId), foreignBefore);
  assert.equal(store.getWorkRun(ownedRunId, { public: false }).canonicalWorktree, rootA);
  assert.equal(store.getWorkRun(ownedRunId, { public: false }).ownerId, FACTORY_OWNER);
  assert.equal(store.getWorkRun(foreignRunId, { public: false }).canonicalWorktree, rootA);
  assert.equal(store.getWorkRun(foreignRunId, { public: false }).ownerId, 'agent:other');

  const invalidNewRunAssertions = [
    ['conflicting new-run root', { canonicalWorktree: rootB }],
    ['relative new-run root', { canonicalWorktree: 'worktrees/SUP-6003' }],
    ['foreign new-run owner', { ownerId: 'agent:intruder' }],
    ['malformed new-run owner', { ownerId: 'not an owner!' }],
  ];
  for (const [index, [label, assertion]] of invalidNewRunAssertions.entries()) {
    const workRunId = `run-sup-6003-new-${index}`;
    const outcome = await outcomeOf(() => workflow.plan({
      subjectKey: `levineam/jarvOS:SUP-6003-${index}`,
      workRunId,
      operationNonce: 'nonce-authority-02',
      ...assertion,
    }));
    assertAuthorityRefused(outcome, label);
    assert.equal(store.getWorkRun(workRunId), null, `${label} must not create a run`);
  }
  assert.deepEqual(calls, { provider: [], native: [] });
});

test('only a trusted factory worktree root can bootstrap a new run', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const trustedRoot = '/private/jarvos/worktrees/SUP-6010';
  {
    const store = createMemoryWorkRunStore();
    const { calls, providerAdapter, nativeAdapter } = recordingAdapters();
    const workflow = createManagedCodingWorkflow({
      manifest: currentManifest,
      workRunStore: store,
      ownerId: FACTORY_OWNER,
      canonicalWorktree: trustedRoot,
      providerSnapshot: currentProvider,
      providerAdapter,
      nativeAdapter,
    });
    const planned = await workflow.plan({ subjectKey: 'levineam/jarvOS:SUP-6010', workRunId: 'run-sup-6010', operationNonce: 'nonce-bootstrap-01' });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(planned.route, 'compound-engineering');
    const stored = store.getWorkRun('run-sup-6010', { public: false });
    assert.equal(stored.canonicalWorktree, trustedRoot);
    assert.equal(stored.ownerId, FACTORY_OWNER);
    assert.equal(calls.provider.length, 1);
    assert.equal(calls.provider[0].invocation.canonicalWorktree, trustedRoot);
    assert.equal(calls.native.length, 0);
  }

  const untrustedFactoryRoots = [
    ['missing', undefined],
    ['non-string', 42],
    ['empty', ''],
    ['relative', 'worktrees/SUP-6011'],
    ['control character', '/private/jarvos/worktrees/SUP-6011\u0007'],
    ['NUL', '/private/jarvos/worktrees/SUP-6011\0'],
  ];
  for (const [index, [label, factoryRoot]] of untrustedFactoryRoots.entries()) {
    const store = createMemoryWorkRunStore();
    const { calls, providerAdapter, nativeAdapter } = recordingAdapters();
    const factoryOptions = { manifest: currentManifest, workRunStore: store, ownerId: FACTORY_OWNER, providerSnapshot: currentProvider, providerAdapter, nativeAdapter };
    if (factoryRoot !== undefined) factoryOptions.canonicalWorktree = factoryRoot;
    const workRunId = `run-sup-6011-${index}`;
    // A malformed factory root may refuse at construction or at the first operation.
    const outcome = await outcomeOf(async () => createManagedCodingWorkflow(factoryOptions).plan({
      subjectKey: `levineam/jarvOS:SUP-6011-${index}`,
      workRunId,
      canonicalWorktree: '/private/jarvos/worktrees/SUP-6011',
      operationNonce: 'nonce-bootstrap-02',
    }));
    assertAuthorityRefused(outcome, `${label} factory root`);
    assert.equal(store.getWorkRun(workRunId), null, `${label} factory root must not create a run`);
    assert.deepEqual(calls, { provider: [], native: [] }, `${label} factory root must not invoke adapters`);
  }
});

test('preclaimed private-shaped runs re-enter on the stored root in every route', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const rootA = '/private/jarvos/worktrees/SUP-6020-a';
  const rootB = '/private/jarvos/worktrees/SUP-6020-b';
  const modes = [
    { mode: 'healthy provider', snapshot: true, providerPlanFails: false, route: 'compound-engineering', invoked: 'provider' },
    { mode: 'native only', snapshot: false, providerPlanFails: false, route: 'native-fallback', invoked: 'native' },
    { mode: 'unhealthy provider fallback', snapshot: true, providerPlanFails: true, route: 'native-fallback', invoked: 'native' },
  ];
  const variants = [
    { label: 'no factory root, omitted assertions', factoryRoot: undefined, assertion: {} },
    { label: 'no factory root, matching assertions', factoryRoot: undefined, assertion: { canonicalWorktree: rootA, ownerId: FACTORY_OWNER } },
    { label: 'factory root A, omitted assertions', factoryRoot: rootA, assertion: {} },
    { label: 'factory root A, matching assertions', factoryRoot: rootA, assertion: { canonicalWorktree: rootA, ownerId: FACTORY_OWNER } },
  ];
  let sequence = 0;
  function setup(entry, factoryRoot) {
    sequence += 1;
    const subjectKey = `levineam/jarvOS:SUP-6020-${sequence}`;
    const workRunId = `run-sup-6020-${sequence}`;
    const store = createMemoryWorkRunStore();
    assert.equal(store.claimWorkRun({ subjectKey, canonicalWorktree: rootA, workRunId, ownerId: FACTORY_OWNER }).ok, true);
    const adapters = recordingAdapters({ providerPlanFails: entry.providerPlanFails });
    const factoryOptions = { manifest: currentManifest, workRunStore: store, ownerId: FACTORY_OWNER, providerAdapter: adapters.providerAdapter, nativeAdapter: adapters.nativeAdapter };
    if (entry.snapshot) factoryOptions.providerSnapshot = currentProvider;
    if (factoryRoot !== undefined) factoryOptions.canonicalWorktree = factoryRoot;
    return { subjectKey, workRunId, store, calls: adapters.calls, factoryOptions };
  }

  for (const entry of modes) {
    for (const variant of variants) {
      const label = `${entry.mode} / ${variant.label}`;
      const context = setup(entry, variant.factoryRoot);
      const workflow = createManagedCodingWorkflow(context.factoryOptions);
      const planned = await workflow.plan({ subjectKey: context.subjectKey, workRunId: context.workRunId, operationNonce: 'nonce-reentry-01', ...variant.assertion });
      assert.equal(planned.ok, true, `${label}: ${JSON.stringify(planned)}`);
      assert.equal(planned.route, entry.route, label);
      assert.equal(planned.workRunId, context.workRunId, label);
      assert.equal(context.calls[entry.invoked].length, 1, label);
      assert.equal(context.calls[entry.invoked][0].invocation.canonicalWorktree, rootA, label);
      for (const call of [...context.calls.provider, ...context.calls.native]) assert.equal(call.invocation.canonicalWorktree, rootA, label);
      const stored = context.store.getWorkRun(context.workRunId, { public: false });
      assert.equal(stored.canonicalWorktree, rootA, label);
      assert.equal(stored.ownerId, FACTORY_OWNER, label);
    }

    const conflicting = setup(entry, rootB);
    const before = durableAuthority(conflicting.store, conflicting.workRunId);
    const outcome = await outcomeOf(async () => createManagedCodingWorkflow(conflicting.factoryOptions).plan({
      subjectKey: conflicting.subjectKey,
      workRunId: conflicting.workRunId,
      operationNonce: 'nonce-reentry-02',
    }));
    assertAuthorityRefused(outcome, `${entry.mode} / factory root B over stored root A`);
    assert.deepEqual(conflicting.calls, { provider: [], native: [] }, entry.mode);
    assert.deepEqual(durableAuthority(conflicting.store, conflicting.workRunId), before, entry.mode);
  }
});

test('acceptPlan, work and compound share the caller authority boundary', async () => {
  const currentManifest = manifest();
  const rootA = '/private/jarvos/worktrees/SUP-6030-a';
  const rootB = '/private/jarvos/worktrees/SUP-6030-b';
  const planDigest = '3'.repeat(64);
  const verbs = [
    { verb: 'acceptPlan', accepted: false, input: { planDigest, packet: packet(planDigest), artifact: { reference: 'artifact:plan123456', digest: planDigest } } },
    { verb: 'work', accepted: true, input: { planDigest, packet: packet(planDigest) } },
    { verb: 'compound', accepted: true, input: { planDigest } },
  ];
  const assertions = [
    ['conflicting caller root', { canonicalWorktree: rootB }],
    ['foreign caller owner', { ownerId: 'agent:intruder' }],
  ];
  let sequence = 0;
  for (const { verb, accepted, input } of verbs) {
    for (const [label, assertion] of assertions) {
      sequence += 1;
      const subjectKey = `levineam/jarvOS:SUP-6030-${sequence}`;
      const workRunId = `run-sup-6030-${sequence}`;
      const store = createMemoryWorkRunStore();
      const claimed = store.claimWorkRun({ subjectKey, canonicalWorktree: rootA, workRunId, ownerId: FACTORY_OWNER });
      if (accepted) {
        assert.equal(store.acceptPlan({
          workRunId,
          ownerId: claimed.ownerId,
          fence: claimed.fence,
          planDigest,
          packetDigest: digestOf(packet(planDigest)),
          artifact: { reference: 'artifact:plan123456', digest: planDigest },
        }).ok, true);
      }
      const before = durableAuthority(store, workRunId);
      const { calls, providerAdapter, nativeAdapter } = recordingAdapters();
      const workflow = createManagedCodingWorkflow({
        manifest: currentManifest,
        workRunStore: store,
        ownerId: FACTORY_OWNER,
        canonicalWorktree: rootA,
        providerAdapter,
        nativeAdapter,
      });
      const outcome = await outcomeOf(() => workflow[verb]({ subjectKey, workRunId, operationNonce: `nonce-verb-${sequence}`, ...input, ...assertion }));
      assertAuthorityRefused(outcome, `${verb} / ${label}`);
      assert.deepEqual(calls, { provider: [], native: [] }, `${verb} / ${label}`);
      assert.deepEqual(durableAuthority(store, workRunId), before, `${verb} / ${label}`);
    }
  }
});

test('windows and UNC worktree roots must be normalized and complete', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const malformedRoots = [
    ['drive traversal', 'C:\\worktrees\\..\\outside'],
    ['drive dot segment', 'C:\\worktrees\\.\\a'],
    ['drive doubled separator', 'C:\\worktrees\\\\a'],
    ['bare UNC prefix', '\\\\'],
    ['UNC without share', '\\\\server'],
    ['UNC with empty share', '\\\\server\\'],
    ['UNC traversal', '\\\\server\\share\\..\\x'],
    ['UNC device namespace', '\\\\?\\C:\\x'],
  ];
  let sequence = 0;
  for (const [label, root] of malformedRoots) {
    sequence += 1;
    const store = createMemoryWorkRunStore();
    const { calls, providerAdapter, nativeAdapter } = recordingAdapters();
    const workRunId = `run-sup-7000-factory-${sequence}`;
    const outcome = await outcomeOf(async () => createManagedCodingWorkflow({
      manifest: currentManifest, workRunStore: store, ownerId: FACTORY_OWNER, canonicalWorktree: root, providerSnapshot: currentProvider, providerAdapter, nativeAdapter,
    }).plan({ subjectKey: `levineam/jarvOS:SUP-7000-f${sequence}`, workRunId, operationNonce: 'nonce-win-root-01' }));
    assertAuthorityRefused(outcome, `${label} factory root`);
    assert.equal(store.getWorkRun(workRunId), null, `${label} factory root must not create a run`);
    assert.deepEqual(calls, { provider: [], native: [] }, `${label} factory root`);

    // Stored roots: the store only checks the absolute prefix, so it may accept these.
    const storedRunId = `run-sup-7000-stored-${sequence}`;
    const subjectKey = `levineam/jarvOS:SUP-7000-s${sequence}`;
    const storedStore = createMemoryWorkRunStore();
    const claimed = await outcomeOf(async () => storedStore.claimWorkRun({ subjectKey, canonicalWorktree: root, workRunId: storedRunId, ownerId: FACTORY_OWNER }));
    if (claimed.error || claimed.result?.ok !== true) continue;
    const before = durableAuthority(storedStore, storedRunId);
    const stored = recordingAdapters();
    const storedOutcome = await outcomeOf(() => createManagedCodingWorkflow({
      manifest: currentManifest, workRunStore: storedStore, ownerId: FACTORY_OWNER, providerSnapshot: currentProvider, providerAdapter: stored.providerAdapter, nativeAdapter: stored.nativeAdapter,
    }).plan({ subjectKey, workRunId: storedRunId, operationNonce: 'nonce-win-root-02' }));
    assertAuthorityRefused(storedOutcome, `${label} stored root`);
    assert.deepEqual(stored.calls, { provider: [], native: [] }, `${label} stored root`);
    assert.deepEqual(durableAuthority(storedStore, storedRunId), before, `${label} stored root`);
  }

  {
    const store = createMemoryWorkRunStore();
    const { calls, providerAdapter, nativeAdapter } = recordingAdapters();
    const workflow = createManagedCodingWorkflow({ manifest: currentManifest, workRunStore: store, ownerId: FACTORY_OWNER, canonicalWorktree: 'C:\\b', providerSnapshot: currentProvider, providerAdapter, nativeAdapter });
    const outcome = await outcomeOf(() => workflow.plan({ subjectKey: 'levineam/jarvOS:SUP-7000-caller', workRunId: 'run-sup-7000-caller', canonicalWorktree: 'C:\\a\\..\\b', operationNonce: 'nonce-win-root-03' }));
    assertAuthorityRefused(outcome, 'malformed caller drive root');
    assert.equal(store.getWorkRun('run-sup-7000-caller'), null);
    assert.deepEqual(calls, { provider: [], native: [] });
  }

  for (const [index, root] of ['C:\\worktrees\\SUP-7001', '\\\\server\\share\\SUP-7002'].entries()) {
    const store = createMemoryWorkRunStore();
    const { calls, providerAdapter, nativeAdapter } = recordingAdapters();
    const workRunId = `run-sup-700${index + 1}`;
    const workflow = createManagedCodingWorkflow({ manifest: currentManifest, workRunStore: store, ownerId: FACTORY_OWNER, canonicalWorktree: root, providerSnapshot: currentProvider, providerAdapter, nativeAdapter });
    const planned = await workflow.plan({ subjectKey: `levineam/jarvOS:SUP-700${index + 1}`, workRunId, operationNonce: 'nonce-win-root-04' });
    assert.equal(planned.ok, true, `${root}: ${JSON.stringify(planned)}`);
    assert.equal(store.getWorkRun(workRunId, { public: false }).canonicalWorktree, root);
    const invoked = [...calls.provider, ...calls.native];
    assert.ok(invoked.length >= 1, root);
    for (const call of invoked) assert.equal(call.invocation.canonicalWorktree, root);
  }
});
