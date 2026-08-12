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
    providerAdapter: {
      plan: async (invocation) => { invocations.push(invocation); return receipt(invocation, 'plan'); },
      work: async (invocation) => { invocations.push(invocation); return receipt(invocation, 'work', 'a'.repeat(64)); },
    },
  });
  const plan = await workflow.plan({
    subjectKey: 'levineam/jarvOS:SUP-5000',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-5000',
    provider: currentProvider,
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
    provider: currentProvider,
    planDigest: 'a'.repeat(64),
    packet: packet('a'.repeat(64)),
    operationNonce: 'nonce-work-01',
    idempotencyKey: 'idem-work-01',
  });
  assert.equal(work.ok, true, JSON.stringify(work));
  assert.equal(work.route, 'compound-engineering');
  assert.equal(work.workRunId, plan.workRunId);
  assert.equal(invocations[1].implementationPacket.planDigest, 'a'.repeat(64));
});

test('changed accepted plans stop before any provider process boundary', async () => {
  const currentManifest = manifest();
  let calls = 0;
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: createMemoryWorkRunStore(),
    ownerId: 'agent:codex',
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

test('provider failure falls back inside the same run and preserves the normalized packet', async () => {
  const currentManifest = manifest();
  const currentProvider = provider(currentManifest);
  const store = createMemoryWorkRunStore();
  const nativePackets = [];
  const workflow = createManagedCodingWorkflow({
    manifest: currentManifest,
    workRunStore: store,
    ownerId: 'agent:codex',
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
