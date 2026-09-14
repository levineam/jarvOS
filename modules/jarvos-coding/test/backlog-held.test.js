'use strict';

const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileExecutionLinkStore } = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/execution-link-store');
const { createBeadsWorkActionService, createFileOperationStore, createLiveBeadsTracker } = require('../src/index.js');

function authorization({ action, workspaceId, operationId, itemId, canonical, requestFingerprint }) {
  return {
    contract: 'jarvos.work-action-authorization/v1', authorized: true, authority: 'coding-run', fence: 1,
    actions: [action], workspaceId, operationId, itemId, canonical, requestFingerprint,
  };
}

test('host-enabled backlog holds, admits, and completes one fixture without a second claim', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-held-backlog-workspace-'));
  const trackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-held-backlog-tracker-'));
  const actionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-held-backlog-actions-'));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-held-backlog-links-'));
  t.after(() => [workspaceRoot, trackerRoot, actionRoot, linkRoot].forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
  const item = { id: 'bd-held', revision: '1', status: 'deferred' };
  let creates = 0;
  let claims = 0;
  let transitions = 0;
  const tracker = {
    authority: 'beads', workspaceRoot,
    operationStoreRoot: trackerRoot, operationStoreContract: 'jarvos-coding-operation-store/v1', operationStoreStorage: 'file',
    async createWorkItem(input) {
      creates += 1;
      Object.assign(item, { description: input.description, external_ref: input.externalReference, status: input.status });
      return { state: 'committed', result: { ...item } };
    },
    async showWorkItem() { return { state: 'committed', result: { ...item } }; },
    async claimIssue() {
      claims += 1;
      item.status = 'in_progress'; item.revision = String(Number(item.revision) + 1);
      return { state: 'committed', result: { ...item } };
    },
    async transition(input) {
      transitions += 1;
      item.status = input.status; item.revision = String(Number(item.revision) + 1);
      return { state: 'committed', result: { ...item } };
    },
  };
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const options = {
    mode: 'live', tracker, workspaceId: 'workspace-held', approvedWorkspaceIds: ['workspace-held'],
    operationStore: createFileOperationStore({ root: actionRoot }), executionLinks: createFileExecutionLinkStore({ root: linkRoot }),
    authorizeMutation: authorization, backlogEnabled: true, clock: () => '2030-01-01T00:00:00.000Z',
    registeredEvidenceProducers: ['fixture'],
    resolveCompletionReceipt: async ({ operationId, itemId }) => ({
      contract: 'jarvos.work-action-evidence-receipt/v1', immutable: true, kind: 'execution-verified', producer: 'fixture', operationId, itemId, canonical,
    }),
  };
  const service = createBeadsWorkActionService(options);
  const disabled = createBeadsWorkActionService({ ...options, backlogEnabled: false });
  await assert.rejects(
    () => disabled.captureBacklog({ title: 'disabled', operationId: 'held-disabled', canonical, sourceIntent: 'Keep this', sourceRef: 'message-0', notBefore: '2030-01-01T00:00:00.000Z' }),
    /disabled by host configuration/,
  );
  const unbound = createBeadsWorkActionService({ ...options, authorizeMutation: undefined });
  await assert.rejects(
    () => unbound.captureBacklog({ title: 'unbound', operationId: 'held-unbound', canonical, sourceIntent: 'Keep this', sourceRef: 'message-0', notBefore: '2030-01-01T00:00:00.000Z' }),
    /host mutation authorization/,
  );
  const revoked = createBeadsWorkActionService({ ...options, authorizeMutation: async (request) => ({ ...authorization(request), authorized: false }) });
  await assert.rejects(
    () => revoked.captureBacklog({ title: 'revoked', operationId: 'held-revoked', canonical, sourceIntent: 'Keep this', sourceRef: 'message-0', notBefore: '2030-01-01T00:00:00.000Z' }),
    /host mutation authorization is required/,
  );
  assert.equal(creates, 0);

  const capture = await service.captureBacklog({
    title: 'Fixture research', description: 'bounded fixture', operationId: 'held-capture-1', canonical,
    sourceIntent: 'Research the existing fixture only.', sourceRef: 'message-1', notBefore: '2030-01-02T00:00:00.000Z',
  });
  const replay = await service.captureBacklog({
    title: 'Fixture research', description: 'bounded fixture', operationId: 'held-capture-1', canonical,
    sourceIntent: 'Research the existing fixture only.', sourceRef: 'message-1', notBefore: '2030-01-02T00:00:00.000Z',
  });
  assert.equal(capture.workReference.itemId, 'bd-held');
  assert.equal(replay.workReference.itemId, 'bd-held');
  assert.equal(creates, 1);
  assert.match(item.description, /Research the existing fixture only\./);
  assert.match(item.description, /2030-01-02T00:00:00.000Z/);
  await assert.rejects(
    () => service.captureBacklog({ title: 'changed', operationId: 'held-capture-1', canonical, sourceIntent: 'changed', sourceRef: 'message-1', notBefore: '2030-01-02T00:00:00.000Z' }),
    /operation identity conflict/,
  );
  await assert.rejects(() => disabled.claim({ itemId: 'bd-held', operationId: 'held-bypass-1', expectedRevision: '1' }), /explicit admission/);
  await assert.rejects(() => disabled.transition({ itemId: 'bd-held', operationId: 'held-bypass-transition', expectedRevision: '1', status: 'open' }), /explicit admission/);
  await assert.rejects(() => disabled.reopen({ itemId: 'bd-held', operationId: 'held-bypass-reopen', expectedRevision: '1' }), /explicit admission/);
  assert.equal(claims, 0);
  await assert.rejects(() => service.admitBacklog({ itemId: 'bd-held', operationId: 'held-admit-early', expectedRevision: '1' }), /not due/);
  assert.equal(transitions, 0);

  options.clock = () => '2030-01-02T00:00:00.000Z';
  const dueService = createBeadsWorkActionService(options);
  item.revision = '9';
  await assert.rejects(() => dueService.admitBacklog({ itemId: 'bd-held', operationId: 'held-admit-stale-native', expectedRevision: '1' }), /fresh deferred revision/);
  item.revision = '1';
  const originalDescription = item.description;
  item.description = '[jarvos-backlog/v1] not-json';
  await assert.rejects(() => disabled.claim({ itemId: 'bd-held', operationId: 'held-malformed', expectedRevision: '1' }), /metadata is invalid/);
  item.description = originalDescription;
  const admitted = await dueService.admitBacklog({ itemId: 'bd-held', operationId: 'held-admit-due', expectedRevision: '1' });
  assert.equal(admitted.status, 'open');
  await assert.rejects(() => dueService.transition({ itemId: 'bd-held', operationId: 'claim-via-transition', expectedRevision: '2', status: 'in_progress' }), /backlog transition/);
  await assert.rejects(() => dueService.admitBacklog({ itemId: 'bd-held', operationId: 'held-admit-again', expectedRevision: '1' }), /stale expected/);
  await assert.rejects(() => dueService.reopen({ itemId: 'bd-held', operationId: 'held-reopen-admitted', expectedRevision: '2' }), /cannot be reopened/);

  const fixtureExecutor = async () => {
    const claimed = await dueService.claim({ itemId: 'bd-held', operationId: 'held-fixture-claim', expectedRevision: '2' });
    await assert.rejects(() => dueService.claim({ itemId: 'bd-held', operationId: 'held-fixture-claim-again-current' }), /not claimable/);
    return dueService.completeFromHost({ itemId: 'bd-held', operationId: 'held-fixture-complete', expectedRevision: claimed.workReference.revision });
  };
  const completed = await fixtureExecutor();
  assert.equal(completed.status, 'done');
  assert.deepEqual(completed.completionEvidence, { kind: 'execution-verified', producer: 'fixture' });
  assert.equal(claims, 1);
  await assert.rejects(() => dueService.claim({ itemId: 'bd-held', operationId: 'held-fixture-claim-again', expectedRevision: '2' }), /stale expected/);
  const readback = await dueService.show({ itemId: 'bd-held' });
  assert.equal(readback.status, 'done');
  assert.equal(readback.workReference.revision, '4');
  assert.deepEqual(readback.backlog, {
    notBefore: '2030-01-02T00:00:00.000Z', sourceIntent: 'Research the existing fixture only.', sourceRef: 'message-1',
  });
  const afterRollback = createBeadsWorkActionService({ ...options, backlogEnabled: false });
  await assert.rejects(() => afterRollback.reopen({ itemId: 'bd-held', operationId: 'rollback-reopen', expectedRevision: '4' }), /cannot be reopened/);
  await assert.rejects(() => afterRollback.claim({ itemId: 'bd-held', operationId: 'rollback-claim', expectedRevision: '4' }), /not claimable/);
  for (const status of ['open', 'in_progress', 'blocked', 'review']) {
    await assert.rejects(() => afterRollback.transition({ itemId: 'bd-held', operationId: `rollback-transition-${status}`, expectedRevision: '4', status }), /backlog transition/);
  }
  assert.equal(item.status, 'done');
  assert.equal(claims, 1);
});

test('Beads accepts only deferred or open create status', async (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-held-backlog-status-'));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  let calls = 0;
  const tracker = createLiveBeadsTracker({ workspaceRoot, run() { calls += 1; return { status: 0, stdout: '{}' }; } });
  await assert.rejects(() => tracker.createWorkItem({ title: 'terminal bypass', operationId: 'held-terminal', status: 'closed' }), /create status is unsupported/);
  assert.equal(calls, 0);
});
