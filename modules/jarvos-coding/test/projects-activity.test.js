'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createHostAdmission,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/provider-contracts');
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

function executionReference({ itemId = 'bd-1', itemRevision = '3', canonicalId = 'out_000001', canonicalRevision = 2, workspaceId = 'ws_main' } = {}) {
  return {
    contract: 'jarvos.execution-reference/v1', authority: 'beads', provider: 'beads', workspaceId, itemId, itemRevision,
    status: 'in_progress', canonical: { contract: 'jarvos.canonical-reference/v1', kind: 'outcome', id: canonicalId, revision: canonicalRevision, breadcrumb: 'jarvOS › coding' },
    capturedAt: '2026-08-12T12:00:00.000Z', sourceRevision: itemRevision,
  };
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
