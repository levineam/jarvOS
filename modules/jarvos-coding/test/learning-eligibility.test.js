'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createManagedCodingWorkflow,
  createMemoryWorkRunStore,
  evaluateLearningEligibility,
  screenLearningReceipt,
} = require('../src');

const baseManifest = require('../providers/compound-engineering.json');

function supportedManifest() {
  return {
    ...baseManifest,
    harnesses: {
      ...baseManifest.harnesses,
      codex: { ...baseManifest.harnesses.codex, status: 'supported' },
    },
  };
}

function provider(manifest, status = 'verified') {
  return {
    id: manifest.id,
    version: manifest.version,
    pinDigest: manifest.source.contentDigest,
    harness: 'codex',
    adapterVersion: 'codex-ce-adapter.v1',
    status,
  };
}

function verification(status = 'completed') {
  const stages = ['claim', 'branch', 'sliceReview', 'holisticReview', 'fixRerun', 'pullRequest', 'postMergeSweep', 'verifyClose'];
  return {
    status,
    events: stages.map((stage) => ({
      stage,
      status: stage === 'verifyClose' ? 'closed' : 'completed',
      result: { status: stage === 'verifyClose' ? 'closed' : 'completed', ok: true },
    })),
  };
}

function receipt(invocation, status = 'succeeded', diagnostics = []) {
  return {
    version: 'jarvos-workflow-provider-receipt/v1',
    operation: 'compound',
    status,
    workRunId: invocation.workRunId,
    operationNonce: invocation.operationNonce,
    idempotencyKey: invocation.idempotencyKey,
    provider: invocation.provider,
    artifact: {
      kind: 'compound',
      reference: 'artifact:compound123456',
      path: '/private/jarvos/compound.md',
      digest: 'c'.repeat(64),
    },
    planRevisionDigest: null,
    acceptedPlanDigest: 'a'.repeat(64),
    publicLabel: 'CE reusable learning artifact',
    diagnostics,
  };
}

test('eligibility requires independent verification and a reusable signal', () => {
  const eligible = evaluateLearningEligibility({
    verification: verification(),
    signals: { category: 'architecture-constraint', summary: 'The adapter must preserve one canonical work run.' },
  });
  assert.equal(eligible.status, 'eligible');
  assert.equal(eligible.learning.category, 'architecture-constraint');

  const incomplete = evaluateLearningEligibility({
    verification: verification('incomplete'),
    signals: { category: 'architecture-constraint', summary: 'The adapter must preserve one canonical work run.' },
  });
  assert.equal(incomplete.status, 'not-eligible');
  assert.equal(incomplete.reasonCode, 'coding_outcome_not_verified');
});

test('routine work is visible but not eligible, and multiple learnings defer after one', () => {
  const routine = evaluateLearningEligibility({ verification: verification(), signals: { category: 'cosmetic', summary: 'Adjust the spacing in the status badge.' } });
  assert.equal(routine.status, 'not-eligible');
  assert.equal(routine.reasonCode, 'routine_or_cosmetic_change');

  const multiple = evaluateLearningEligibility({
    verification: verification(),
    signals: [
      { category: 'root-cause', summary: 'The stale fence was caused by a retry crossing a process boundary.' },
      { category: 'project-vocabulary', summary: 'Use provider snapshot for the observed managed pin.' },
    ],
  });
  assert.equal(multiple.status, 'eligible');
  assert.equal(multiple.deferredCount, 1);
});

test('unsafe learning input and provider content fail closed without publication', () => {
  const unsafe = evaluateLearningEligibility({
    verification: verification(),
    signals: { category: 'root-cause', summary: 'Read /Users/andrew/.env and use token=secret-value.' },
  });
  assert.equal(unsafe.status, 'failed');
  assert.equal(unsafe.reasonCode, 'unsafe_learning_signal');
  assert.equal(screenLearningReceipt({
    artifact: { reference: 'artifact:compound123456', digest: 'c'.repeat(64) },
    publicLabel: 'safe label',
    diagnostics: ['private path /Users/andrew/repo/secret.md'],
  }).ok, false);
});

test('compound captures one eligible learning without changing coding completion', async () => {
  const manifest = supportedManifest();
  const providerSnapshot = provider(manifest);
  const store = createMemoryWorkRunStore();
  const claim = store.claimWorkRun({
    subjectKey: 'levineam/jarvOS:SUP-6000',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-6000',
    ownerId: 'agent:codex',
  });
  assert.equal(store.acceptPlan({
    workRunId: claim.workRunId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    planDigest: 'a'.repeat(64),
    artifact: { reference: 'artifact:plan123456', digest: 'a'.repeat(64) },
  }).ok, true);
  let calls = 0;
  const workflow = createManagedCodingWorkflow({
    manifest,
    workRunStore: store,
    ownerId: 'agent:codex',
    providerAdapter: {
      compound: async (invocation) => {
        calls += 1;
        assert.equal(invocation.learning.category, 'architecture-constraint');
        return receipt(invocation);
      },
    },
  });
  const input = {
    subjectKey: 'levineam/jarvOS:SUP-6000',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-6000',
    provider: providerSnapshot,
    planDigest: 'a'.repeat(64),
    verification: verification(),
    learning: { category: 'architecture-constraint', summary: 'One run owns the provider route and completion evidence.' },
  };
  const captured = await workflow.compound(input);
  assert.equal(captured.status, 'succeeded');
  assert.equal(captured.learningStatus, 'captured');
  assert.equal(calls, 1);

  const second = await workflow.compound({ ...input, learning: { category: 'root-cause', summary: 'A second lesson must be deferred.' } });
  assert.equal(second.reasonCode, 'one_learning_per_work_run');
  assert.equal(calls, 1);
  assert.equal(store.getWorkRun(claim.workRunId).events.filter((event) => event.operation === 'compound').length, 1);
});

test('unavailable compounding is non-terminal and leaves the verified result untouched', async () => {
  const manifest = supportedManifest();
  const store = createMemoryWorkRunStore();
  const claim = store.claimWorkRun({ subjectKey: 'levineam/jarvOS:SUP-6001', canonicalWorktree: '/private/jarvos/worktrees/SUP-6001', ownerId: 'agent:codex' });
  store.acceptPlan({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, planDigest: 'a'.repeat(64), artifact: { reference: 'artifact:plan123456', digest: 'a'.repeat(64) } });
  const workflow = createManagedCodingWorkflow({ manifest, workRunStore: store, ownerId: 'agent:codex' });
  const result = await workflow.compound({
    subjectKey: 'levineam/jarvOS:SUP-6001',
    canonicalWorktree: '/private/jarvos/worktrees/SUP-6001',
    provider: provider(manifest, 'unsupported'),
    planDigest: 'a'.repeat(64),
    verification: verification(),
    learning: { category: 'operational-lesson', summary: 'Native fallback remains authoritative when CE is unavailable.' },
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.ok, true);
  assert.equal(store.getWorkRun(claim.workRunId).state, 'active');
});
