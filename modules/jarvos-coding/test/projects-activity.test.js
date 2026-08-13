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
  return { authority, store };
}

test('coding milestones become verified, idempotent Projects activity', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({
    authority,
    activityStore: store,
    now: () => '2026-08-12T12:00:00.000Z',
  });
  const input = {
    stage: 'claim',
    canonicalId: 'out_000001',
    runId: 'run-1',
    workReference: { authority: 'beads', itemId: 'bd-1' },
    result: { status: 'claimed', ok: true },
  };
  const first = await emitter.recordMilestone(input);
  const retry = await emitter.recordMilestone(input);
  assert.equal(first.status, 'admitted');
  assert.equal(retry.status, 'deduped');
  const read = store.query({ projectIds: ['out_000001'], from: '2026-08-12T00:00:00.000Z', to: '2026-08-13T00:00:00.000Z' });
  assert.equal(read.activities.length, 1);
  assert.equal(read.activities[0].receipt.trust, 'verified');
  assert.deepEqual(read.activities[0].receipt.evidenceRefs, ['beads:bd-1', 'coding:coding:run-1:claim']);
});

test('coding activity cannot claim a project without an explicit canonical link', async () => {
  const { authority, store } = fixture();
  let calls = 0;
  const emitter = createProjectsActivityEmitter({
    authority: { admitVerifiedReceipt: () => { calls += 1; } },
    activityStore: store,
  });
  const result = await emitter.recordMilestone({ stage: 'branch', runId: 'run-2', result: { status: 'created', ok: true } });
  assert.deepEqual(result, { status: 'unavailable', reason: 'canonical-project-link-required', stage: 'branch' });
  assert.equal(calls, 0);
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

test('coding activity requires a run-scoped identity instead of guessing from a work item', async () => {
  const { authority, store } = fixture();
  const emitter = createProjectsActivityEmitter({ authority, activityStore: store });
  const result = await emitter.recordMilestone({
    stage: 'claim', canonicalId: 'out_000001', workReference: { authority: 'beads', itemId: 'bd-1' }, result: { status: 'claimed', ok: true },
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'activity-run-identity-required', stage: 'claim' });
  assert.equal(store.query({}).activities.length, 0);
});

test('the coding orchestrator emits activity only after each durable stage', async () => {
  const { authority, store } = fixture();
  const activity = createProjectsActivityEmitter({ authority, activityStore: store });
  const adapters = {
    activity,
    reviewEngine: createClawpatchAutoreviewAdapter({ runner: async () => ({ status: 'passed' }) }),
    tracker: {
      claimIssue: async () => ({ status: 'claimed', ok: true, workReference: { authority: 'beads', itemId: 'bd-4' } }),
      verifyAndClose: async () => ({ status: 'closed', ok: true }),
    },
    git: { createBranch: async ({ branch }) => ({ status: 'created', branch, ok: true }) },
    fixer: { fixAndRerun: async () => ({ status: 'passed', ok: true }) },
    pullRequest: { openPullRequest: async () => ({ status: 'created', url: 'https://example.test/pr/4', ok: true }) },
    postMerge: { sweep: async () => ({ status: 'completed', ok: true }) },
  };
  const result = await runTakeIssueToDone({ canonicalId: 'out_000001', runId: 'run-4', workReference: { authority: 'beads', itemId: 'bd-4' } }, adapters);
  assert.equal(result.status, 'completed');
  assert.equal(result.activityEvents.length, 8);
  assert.equal(store.query({}).activities.length, 8);
  assert.ok(result.activityEvents.every((event) => event.status === 'admitted'));
});
