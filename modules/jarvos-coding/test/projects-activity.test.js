'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createHostAdmission,
  createInferenceHostAuthority,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/provider-contracts');
const inferenceContracts = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/project-inference-contracts');
const {
  ActivityStore,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/activity-store');
const {
  createMemoryExecutionLinkStore,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/execution-link-store');
const {
  createClawpatchAutoreviewAdapter,
  createProjectsActivityEmitter,
  runTakeIssueToDone,
} = require('../src/index');

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coding-activity-'));
  const authority = createHostAdmission({
    producerId: 'jarvos-coding',
    secret: 'coding-activity-secret',
    allowedKinds: ['coding-milestone'],
  });
  const store = new ActivityStore({ stateDir, admission: authority, now: () => '2026-08-12T12:00:00.000Z' });
  return { authority, store, executionLinks: createMemoryExecutionLinkStore() };
}

function inferenceFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coding-inference-'));
  const authority = createHostAdmission({
    producerId: 'jarvos-coding',
    secret: 'coding-activity-secret',
    allowedKinds: ['coding-milestone'],
  });
  const inferenceAuthority = createInferenceHostAuthority({
    producerId: 'jarvos-coding',
    secret: 'coding-inference-secret',
    allowedSourceClasses: ['execution'],
  });
  const store = new ActivityStore({
    stateDir,
    admission: authority,
    inferenceVerifier: inferenceAuthority,
    now: () => '2026-08-12T12:00:00.000Z',
  });
  return { authority, inferenceAuthority, store, executionLinks: createMemoryExecutionLinkStore() };
}

function executionReference({ itemId = 'bd-1', itemRevision = '3', canonicalId = 'out_000001', canonicalKind = 'outcome', canonicalRevision = 2, workspaceId = 'ws_main' } = {}) {
  return {
    contract: 'jarvos.execution-reference/v1', authority: 'beads', provider: 'beads', workspaceId, itemId, itemRevision,
    status: 'in_progress', canonical: { contract: 'jarvos.canonical-reference/v1', kind: canonicalKind, id: canonicalId, revision: canonicalRevision, breadcrumb: 'jarvOS › coding' },
    capturedAt: '2026-08-12T12:00:00.000Z', sourceRevision: itemRevision,
  };
}

function inferenceDecision({
  disposition = 'established',
  candidateId = 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  canonicalId = 'prj_000001',
  kind = 'project',
  revision = 1,
} = {}) {
  return inferenceContracts.createInferenceDecision({
    candidateId,
    policyRevision: 'policy-v1',
    disposition,
    canonical: canonicalId
      ? { recordId: canonicalId, kind, revision, parentId: kind === 'outcome' ? 'prj_000001' : null, refDigest: null }
      : null,
    reasonCodes: ['policy-qualified'],
    suppressionKey: null,
    supersededBy: null,
    lineage: [],
  });
}

test('coding milestones become verified, idempotent Projects activity', async () => {
  const { authority, store, executionLinks } = fixture();
  const link = executionReference();
  await executionLinks.write(link);
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    executionLinks,
    now: () => '2026-08-12T12:00:00.000Z',
  });
  const input = {
    stage: 'claim',
    runId: 'run-1',
    workReference: { authority: 'beads', itemId: 'bd-1' },
    executionReference: link,
    result: { status: 'claimed', ok: true },
  };
  const first = await emitter.recordMilestone(input);
  const retry = await emitter.recordMilestone(input);
  assert.equal(first.status, 'admitted');
  assert.equal(retry.status, 'deduped');
  const read = store.query({ projectIds: ['out_000001'], from: '2026-08-12T00:00:00.000Z', to: '2026-08-13T00:00:00.000Z' });
  assert.equal(read.activities.length, 1);
  assert.equal(read.activities[0].receipt.trust, 'verified');
  assert.deepEqual(read.activities[0].receipt.evidenceRefs, ['beads:ws_main:bd-1:3', 'coding:coding:run-1:ws_main:bd-1:claim']);
});

test('coding activity requires an exact protected Beads execution link', async () => {
  const { authority, store } = fixture();
  let calls = 0;
  const emitter = createProjectsActivityEmitter({
    authority: { admitVerifiedReceipt: () => { calls += 1; } },
    activityStore: store,
  });
  const result = await emitter.recordMilestone({ stage: 'branch', runId: 'run-2', result: { status: 'created', ok: true } });
  assert.deepEqual(result, { status: 'unavailable', reason: 'exact-beads-execution-link-required', stage: 'branch' });
  assert.equal(calls, 0);
});

test('established inference resolves the existing canonical execution link for coding activity', async () => {
  const { authority, store, executionLinks } = fixture();
  const link = executionReference({ itemId: 'bd-inferred', canonicalId: 'prj_000001', canonicalKind: 'project', canonicalRevision: 3 });
  await executionLinks.write(link);
  const decision = inferenceDecision({ canonicalId: 'prj_000001', revision: 3 });
  const calls = [];
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    executionLinks,
    executionLinkResolver: async (request) => {
      calls.push(request);
      return executionLinks.read('ws_main', 'bd-inferred');
    },
  });

  const result = await emitter.recordMilestone({
    stage: 'claim',
    runId: 'run-inferred-project',
    workReference: { authority: 'beads', itemId: 'bd-inferred' },
    inferenceDecision: decision,
    result: { status: 'claimed', ok: true },
  });

  assert.equal(result.status, 'admitted');
  assert.equal(result.canonicalId, 'prj_000001');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].decision.decisionId, decision.decisionId);
  assert.equal(calls[0].canonical.recordId, 'prj_000001');
  assert.equal(store.query({}).activities.length, 1);
});

test('associated inference supports Outcome links through the same generic resolver', async () => {
  const { authority, store, executionLinks } = fixture();
  const link = executionReference({ itemId: 'bd-inferred-outcome', canonicalId: 'out_000001', canonicalRevision: 4 });
  await executionLinks.write(link);
  const decision = inferenceDecision({
    disposition: 'associated',
    canonicalId: 'out_000001',
    kind: 'outcome',
    revision: 4,
  });
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    executionLinks,
    executionLinkResolver: async ({ canonical }) => {
      assert.equal(canonical.kind, 'outcome');
      return link;
    },
  });

  const result = await emitter.recordMilestone({
    stage: 'branch',
    runId: 'run-inferred-outcome',
    workReference: { authority: 'beads', itemId: 'bd-inferred-outcome' },
    inferenceDecision: decision,
    result: { status: 'created', ok: true },
  });

  assert.equal(result.status, 'admitted');
  assert.equal(result.canonicalId, 'out_000001');
  assert.equal(store.query({}).activities[0].receipt.canonicalId, 'out_000001');
});

test('provisional, quarantined, and unresolved inference never resolve or create executable work', async () => {
  for (const disposition of ['provisional', 'quarantined']) {
    const { authority, inferenceAuthority, store, executionLinks } = inferenceFixture();
    let resolverCalls = 0;
    const emitter = createProjectsActivityEmitter({
      authority,
      activityStore: store,
      executionLinks,
      inferenceAuthority,
      inferenceEvidenceStore: store,
      executionLinkResolver: async () => { resolverCalls += 1; throw new Error('must not resolve'); },
    });
    const decision = inferenceDecision({ disposition, canonicalId: null });
    const result = await emitter.recordMilestone({
      stage: 'claim',
      runId: `run-${disposition}`,
      occurredAt: '2026-08-12T12:00:00.000Z',
      workReference: { authority: 'beads', itemId: `bd-${disposition}` },
      inferenceDecision: decision,
      result: { status: 'claimed', ok: true },
    });

    assert.equal(result.status, 'admitted');
    assert.equal(resolverCalls, 0);
    assert.equal(store.query({}).activities.length, 0);
    assert.equal((await executionLinks.list()).length, 0);
    const [unattributed] = store.listUnattributed();
    assert.equal(unattributed.candidateId, decision.candidateId);
    assert.equal(unattributed.decisionId, decision.decisionId);
  }
});

test('inference link resolution fails closed when the resolver returns a different canonical tuple', async () => {
  const { authority, store, executionLinks } = fixture();
  const wrongLink = executionReference({ itemId: 'bd-mismatch', canonicalId: 'prj_000002', canonicalKind: 'project', canonicalRevision: 1 });
  await executionLinks.write(wrongLink);
  const decision = inferenceDecision({ canonicalId: 'prj_000001', revision: 1 });
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    executionLinks,
    executionLinkResolver: async () => wrongLink,
  });

  const result = await emitter.recordMilestone({
    stage: 'claim',
    runId: 'run-mismatched-inference-link',
    workReference: { authority: 'beads', itemId: 'bd-mismatch' },
    inferenceDecision: decision,
    result: { status: 'claimed', ok: true },
  });

  assert.deepEqual(result, { status: 'unavailable', reason: 'inference-canonical-link-mismatch', stage: 'claim' });
  assert.equal(store.query({}).activities.length, 0);
});

test('inference cannot create a link when the generic resolver is absent', async () => {
  const { authority, inferenceAuthority, store, executionLinks } = inferenceFixture();
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    executionLinks,
    inferenceAuthority,
    inferenceEvidenceStore: store,
  });
  const result = await emitter.recordMilestone({
    stage: 'claim',
    runId: 'run-no-link-resolver',
    occurredAt: '2026-08-12T12:00:00.000Z',
    workReference: { authority: 'beads', itemId: 'bd-no-link-resolver' },
    inferenceDecision: inferenceDecision({ canonicalId: 'prj_000001', revision: 1 }),
    result: { status: 'claimed', ok: true },
  });

  assert.equal(result.status, 'admitted');
  assert.equal(result.canonicalId, null);
  assert.equal(result.reason, 'canonical-execution-link-resolver-unavailable');
  assert.equal(store.query({}).activities.length, 0);
  assert.equal((await executionLinks.list()).length, 0);
});

test('coding without a resolved canonical link enters the admitted unresolved lane only with explicit inference dependencies', async () => {
  const { authority, inferenceAuthority, store } = inferenceFixture();
  let nowTick = 0;
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    inferenceAuthority,
    inferenceEvidenceStore: store,
    now: () => `2026-08-12T12:00:${String(nowTick++).padStart(2, '0')}.000Z`,
  });
  const input = {
    stage: 'claim',
    runId: 'run-unresolved',
    occurredAt: '2026-08-12T12:00:00.000Z',
    workReference: { authority: 'beads', itemId: 'bd-unresolved' },
    result: { status: 'claimed', ok: true },
  };
  const first = await emitter.recordMilestone(input);
  const retry = await emitter.recordMilestone(input);
  assert.equal(first.status, 'admitted');
  assert.equal(first.canonicalId, null);
  assert.equal(first.reason, 'exact-beads-execution-link-required');
  assert.equal(retry.status, 'deduped');
  assert.equal(retry.evidenceId, first.evidenceId);
  assert.equal(store.query({}).activities.length, 0);
  const [row] = store.listUnattributed();
  assert.equal(row.sourceClass, 'execution');
  assert.equal(row.trust, 'admitted-inference');
  assert.equal(row.candidateId, null);
  assert.equal(row.decisionId, null);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'canonicalId'), false);
});

test('unresolved coding evidence fails closed when no stable event timestamp is supplied', async () => {
  const { authority, inferenceAuthority, store } = inferenceFixture();
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    inferenceAuthority,
    inferenceEvidenceStore: store,
    now: () => '2026-08-12T12:00:00.000Z',
  });
  const result = await emitter.recordMilestone({
    stage: 'claim',
    runId: 'run-missing-time',
    workReference: { authority: 'beads', itemId: 'bd-missing-time' },
    result: { status: 'claimed', ok: true },
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'inference-event-time-required', stage: 'claim' });
  assert.equal(store.query({}).activities.length, 0);
  assert.equal(store.listUnattributed().length, 0);
});

test('invalid explicitly injected inference dependencies fail closed', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    inferenceAuthority: {},
    inferenceEvidenceStore: store,
  });
  const result = await emitter.recordMilestone({
    stage: 'branch',
    runId: 'run-invalid-inference-deps',
    workReference: { authority: 'beads', itemId: 'bd-invalid' },
    result: { status: 'created', ok: true },
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'inference-admission-unavailable', stage: 'branch' });
  assert.equal(store.query({}).activities.length, 0);
  assert.equal(store.listUnattributed().length, 0);
});

test('unresolved coding evidence is metadata-only even when source metadata resembles a private path or prompt', async () => {
  const { authority, inferenceAuthority, store } = inferenceFixture();
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    inferenceAuthority,
    inferenceEvidenceStore: store,
    now: () => '2026-08-12T12:00:00.000Z',
  });
  const result = await emitter.recordMilestone({
    stage: 'branch',
    runId: '/Users/andrew/private prompt text',
    occurredAt: '2026-08-12T12:00:00.000Z',
    workReference: { authority: 'beads', itemId: 'bd-privacy' },
    result: { status: 'created', ok: true, prompt: 'do not persist this' },
  });
  assert.equal(result.status, 'admitted');
  const serialized = JSON.stringify(store.listUnattributed());
  assert.equal(serialized.includes('/Users/andrew/private prompt text'), false);
  assert.equal(serialized.includes('do not persist this'), false);
  assert.equal(serialized.includes('bd-privacy'), false);
});

test('unsupported coding milestones do not create Projects activity', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({ authority, activityStore: store });
  const result = await emitter.recordMilestone({ stage: 'implementation', runId: 'run-unsupported', result: { status: 'completed', ok: true } });
  assert.deepEqual(result, { status: 'skipped', reason: 'unsupported-stage', stage: 'implementation' });
  assert.equal(store.query({}).activities.length, 0);
});

test('failed coding stages do not produce verified activity', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({ authority, activityStore: store });
  const result = await emitter.recordMilestone({
    stage: 'fixRerun', canonicalId: 'out_000001', runId: 'run-3', result: { status: 'failed', ok: false },
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'stage-not-durable', stage: 'fixRerun' });
  assert.equal(store.query({}).activities.length, 0);
});

test('deferred coding stages do not become durable Projects activity', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({ authority, activityStore: store });
  const result = await emitter.recordMilestone({
    stage: 'verifyClose', canonicalId: 'out_000001', runId: 'run-deferred', result: { status: 'deferred', ok: true },
  });
  assert.deepEqual(result, { status: 'skipped', reason: 'stage-not-durable', stage: 'verifyClose' });
  assert.equal(store.query({}).activities.length, 0);
});

test('pending and indeterminate milestones do not become durable Projects activity', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({ authority, activityStore: store });
  for (const status of ['pending', 'indeterminate']) {
    const result = await emitter.recordMilestone({
      stage: 'verifyClose', runId: `run-${status}`, result: { status, ok: true },
    });
    assert.deepEqual(result, { status: 'skipped', reason: 'stage-not-durable', stage: 'verifyClose' });
  }
  assert.equal(store.query({}).activities.length, 0);
});

test('coding activity requires a run-scoped identity instead of guessing from a work item', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({ authority, activityStore: store });
  const result = await emitter.recordMilestone({
    stage: 'claim', canonicalId: 'out_000001', workReference: { authority: 'beads', itemId: 'bd-1' }, result: { status: 'claimed', ok: true },
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'activity-run-identity-required', stage: 'claim' });
  assert.equal(store.query({}).activities.length, 0);
});

test('mismatched execution tuples and unadmitted producers cannot create activity', async () => {
  const { authority, store, executionLinks } = fixture();
  const link = executionReference();
  await executionLinks.write(link);
  const emitter = createProjectsActivityEmitter({ authority, activityStore: store, executionLinks });
  const stale = await emitter.recordMilestone({
    stage: 'branch', runId: 'run-5', executionReference: { ...link, itemRevision: '2', sourceRevision: '2' }, result: { status: 'created', ok: true },
  });
  assert.deepEqual(stale, { status: 'unavailable', reason: 'stale-or-mismatched-execution-link', stage: 'branch' });
  const unadmitted = createProjectsActivityEmitter({ authority, activityStore: store, executionLinks, producerId: 'foreign-coding' });
  const producer = await unadmitted.recordMilestone({ stage: 'branch', runId: 'run-5', executionReference: link, result: { status: 'created', ok: true } });
  assert.deepEqual(producer, { status: 'unavailable', reason: 'activity-producer-not-admitted', stage: 'branch' });
  assert.equal(store.query({}).activities.length, 0);
});

test('the coding orchestrator emits activity only after each durable stage', async () => {
  const { authority, store, executionLinks } = fixture();
  const link = executionReference({ itemId: 'bd-4' });
  await executionLinks.write(link);
  const activity = createProjectsActivityEmitter({ authority, activityStore: store, executionLinks });
  const adapters = {
    activity,
    reviewEngine: createClawpatchAutoreviewAdapter({ runner: async () => ({ status: 'passed' }) }),
    tracker: {
      claimIssue: async () => ({ status: 'claimed', ok: true, workReference: { authority: 'beads', itemId: 'bd-4' }, executionLink: link }),
      verifyAndClose: async () => ({ status: 'closed', ok: true }),
    },
    git: { createBranch: async ({ branch }) => ({ status: 'created', branch, ok: true }) },
    fixer: { fixAndRerun: async () => ({ status: 'passed', ok: true }) },
    pullRequest: { openPullRequest: async () => ({ status: 'created', url: 'https://example.test/pr/4', ok: true }) },
    postMerge: { sweep: async () => ({ status: 'completed', ok: true }) },
  };
  const result = await runTakeIssueToDone({ runId: 'run-4', workReference: { authority: 'beads', itemId: 'bd-4' }, executionReference: link }, adapters);
  assert.equal(result.status, 'completed');
  assert.equal(result.activityEvents.length, 8);
  assert.equal(store.query({}).activities.length, 8);
  assert.ok(result.activityEvents.every((event) => event.status === 'admitted'));
});
