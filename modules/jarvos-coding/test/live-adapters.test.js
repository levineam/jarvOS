'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  buildLiveCodingAdapters,
  createLiveBeadsTracker,
  createLiveFixer,
  createLivePaperclipTracker,
  createLivePostMergeSweep,
  createLivePullRequest,
} = require('../src/index.js');

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createFileExecutionLinkStore,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/execution-link-store');

function hostAuthorization({ action, workspaceId, operationId, itemId, canonical, requestFingerprint }) {
  return {
    contract: 'jarvos.work-action-authorization/v1',
    authorized: true,
    authority: 'coding-run',
    fence: 1,
    actions: [action],
    workspaceId,
    operationId,
    itemId,
    canonical,
    requestFingerprint,
  };
}

test('file operation ledger atomically preserves immutable operations across restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-operation-ledger-'));
  const { createFileOperationStore } = require('../src/index.js');
  const store = createFileOperationStore({ root, maxRecords: 2 });
  await store.write({ operationId: 'op-1', fingerprint: 'one', state: 'prepared' });
  assert.equal((await store.read('op-1')).state, 'prepared');
  await assert.rejects(() => store.write({ operationId: 'op-1', fingerprint: 'two', state: 'prepared' }), /identity conflict/);
  await store.write({ operationId: 'op-1', fingerprint: 'one', state: 'committed' });
  const restarted = createFileOperationStore({ root, maxRecords: 2 });
  assert.equal((await restarted.read('op-1')).state, 'committed');
});

test('live Beads tracker selects the durable operation ledger when the host supplies its state root', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-durable-workspace-'));
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-durable-ledger-'));
  const run = (command, args) => {
    if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19' };
    if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }) };
    if (args[0] === 'schema') return { status: 0, stdout: '{}' };
    if (args[0] === 'where') return { status: 0, stdout: workspaceRoot };
    return { status: 0, stdout: JSON.stringify({ id: 'bd-durable', revision: '1' }) };
  };
  await createLiveBeadsTracker({ workspaceRoot, operationStoreRoot: ledgerRoot, run }).createWorkItem({ title: 'durable', operationId: 'durable-op' });
  assert.ok(fs.readdirSync(ledgerRoot).some((name) => name.endsWith('.json')));
});

test('live Todo composition refuses memory, missing, and aliased durable roots while test mode can be explicit memory', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-roots-'));
  assert.throws(() => createLiveBeadsTracker({ workspaceRoot, mode: 'live' }), /durable tracker operation ledger/);

  const { createBeadsWorkActionService, createMemoryExecutionLinkStore, createFileOperationStore } = require('../src/index.js');
  const memoryTracker = { authority: 'beads', workspaceRoot, async createWorkItem() { return null; } };
  assert.doesNotThrow(() => createBeadsWorkActionService({ mode: 'test', tracker: memoryTracker, executionLinks: createMemoryExecutionLinkStore() }));

  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-aliased-'));
  const tracker = {
    authority: 'beads', workspaceRoot,
    operationStoreRoot: sharedRoot,
    operationStoreContract: 'jarvos-coding-operation-store/v1',
    operationStoreStorage: 'file',
    async createWorkItem() { return null; },
  };
  assert.throws(() => createBeadsWorkActionService({
    mode: 'live', tracker,
    operationStore: createFileOperationStore({ root: sharedRoot }),
    executionLinks: createFileExecutionLinkStore({ root: sharedRoot }),
  }), /roots must be distinct/);

  const nestedRoot = path.join(sharedRoot, 'nested-actions');
  const nestedLinks = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-nested-links-'));
  fs.mkdirSync(nestedRoot, { mode: 0o700 });
  assert.throws(() => createBeadsWorkActionService({
    mode: 'live', tracker,
    operationStore: createFileOperationStore({ root: nestedRoot }),
    executionLinks: createFileExecutionLinkStore({ root: nestedLinks }),
  }), /non-overlapping/);
});

test('Beads Todo action facade requires host authority, exact linkage, and Andrew for human attestation', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-action-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  const links = createMemoryExecutionLinkStore();
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem(input) { return { state: 'committed', result: { id: 'bd-action', revision: '7', status: 'open' }, operationId: input.operationId }; },
    async claimIssue(input) { return { state: 'committed', result: { id: input.itemId, revision: '8', status: 'in_progress' } }; },
    async transition(input) { return { state: 'committed', result: { id: input.itemId, revision: '9', status: input.status } }; },
    async reconcile() { return { state: 'not-committed' }; },
  };
  const canonical = { contract: 'jarvos.canonical-reference/v1', kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const service = createBeadsWorkActionService({ tracker, executionLinks: links, approvedWorkspaceIds: [workspaceRoot], authorizeMutation: hostAuthorization });
  await assert.rejects(() => service.create({ title: 'missing link', operationId: 'action-1', actor: { kind: 'human', id: 'andrew' } }), /canonical/);
  const created = await service.create({ title: 'linked work', operationId: 'action-2', actor: { kind: 'human', id: 'andrew' }, canonical });
  assert.equal(created.workReference.authority, 'beads');
  await assert.rejects(() => service.claim({ itemId: 'bd-action', operationId: 'action-stale', expectedRevision: '6', actor: { kind: 'human', id: 'andrew' } }), /stale expected/);
  await assert.rejects(() => service.completeWithEvidence({ itemId: 'bd-action', operationId: 'action-3', evidence: { kind: 'human-attested' }, actor: { kind: 'agent', id: 'codex' } }), /Andrew/);
  const completed = await service.completeWithEvidence({ itemId: 'bd-action', operationId: 'action-4', evidence: { kind: 'human-attested' }, actor: { kind: 'human', id: 'andrew' } });
  assert.equal(completed.status, 'done');

  const unbound = createBeadsWorkActionService({ tracker, approvedWorkspaceIds: [workspaceRoot], executionLinks: links });
  await assert.rejects(() => unbound.create({ title: 'not authorized', operationId: 'action-5', canonical }), /host mutation authorization/);
  await assert.rejects(() => unbound.claim({ itemId: 'bd-action', operationId: 'action-6' }), /host mutation authorization/);
  await assert.rejects(() => unbound.transition({ itemId: 'bd-action', operationId: 'action-7', status: 'review' }), /host mutation authorization/);
  await assert.rejects(() => unbound.completeWithEvidence({ itemId: 'bd-action', operationId: 'action-8', evidence: { kind: 'human-attested' }, actor: { kind: 'human', id: 'andrew' } }), /host mutation authorization/);
  await assert.rejects(() => unbound.reopen({ itemId: 'bd-action', operationId: 'action-9' }), /host mutation authorization/);
});

test('Beads Todo authorization is bound to the complete mutation request', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-auth-fingerprint-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  let dispatches = 0;
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem() { dispatches += 1; return { state: 'committed', result: { id: 'bd-auth', revision: '1', status: 'open' } }; },
  };
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const service = createBeadsWorkActionService({
    tracker,
    executionLinks: createMemoryExecutionLinkStore(),
    approvedWorkspaceIds: [workspaceRoot],
    authorizeMutation: async (request) => ({ ...hostAuthorization(request), requestFingerprint: 'substituted-request' }),
  });
  await assert.rejects(
    () => service.create({ title: 'must stay bound', operationId: 'auth-fingerprint-1', canonical }),
    /not bound to this request/,
  );
  assert.equal(dispatches, 0);
});

test('Beads Todo distinguishes resuming blocked work from reopening closed work', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-resume-reopen-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  const transitions = [];
  let revision = 1;
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem() { return { state: 'committed', result: { id: 'bd-resume', revision: String(revision), status: 'open' } }; },
    async transition(input) {
      transitions.push(input);
      revision += 1;
      return { state: 'committed', result: { id: input.itemId, revision: String(revision), status: input.status } };
    },
  };
  const canonical = { contract: 'jarvos.canonical-reference/v1', kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const service = createBeadsWorkActionService({ tracker, executionLinks: createMemoryExecutionLinkStore(), approvedWorkspaceIds: [workspaceRoot], authorizeMutation: hostAuthorization });
  await service.create({ title: 'Resume semantics', operationId: 'resume-create', canonical, actor: { kind: 'human', id: 'andrew' } });
  await service.transition({ itemId: 'bd-resume', operationId: 'resume-blocked', status: 'open', actor: { kind: 'human', id: 'andrew' } });
  await service.reopen({ itemId: 'bd-resume', operationId: 'reopen-closed', actor: { kind: 'human', id: 'andrew' } });

  assert.equal(transitions[0].status, 'open');
  assert.equal(transitions[0].reopen, undefined);
  assert.equal(transitions[1].status, 'open');
  assert.equal(transitions[1].reopen, true);
});

test('Beads Todo completion accepts only host-resolved immutable verification receipts', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-evidence-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  const links = createMemoryExecutionLinkStore();
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem(input) { return { state: 'committed', result: { id: 'bd-evidence', revision: '1', status: 'open' }, operationId: input.operationId }; },
    async transition(input) { return { state: 'committed', result: { id: input.itemId, revision: '2', status: input.status } }; },
  };
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const service = createBeadsWorkActionService({
    tracker, executionLinks: links, approvedWorkspaceIds: [workspaceRoot], authorizeMutation: hostAuthorization,
    registeredEvidenceProducers: ['ci'],
    resolveEvidenceReceipt: async (id) => id === 'verified-1' ? {
      contract: 'jarvos.work-action-evidence-receipt/v1', immutable: true, kind: 'execution-verified', producer: 'ci',
      operationId: 'evidence-complete-2', itemId: 'bd-evidence', canonical,
    } : null,
  });
  await service.create({ title: 'linked work', operationId: 'evidence-create-1', canonical });
  await assert.rejects(() => service.completeWithEvidence({ itemId: 'bd-evidence', operationId: 'evidence-complete-1', evidence: { kind: 'execution-verified' } }), /host evidence receipt id/);
  const completed = await service.completeWithEvidence({ itemId: 'bd-evidence', operationId: 'evidence-complete-2', evidenceReceiptId: 'verified-1' });
  assert.equal(completed.status, 'done');
});

test('Beads Todo host completion resolves its receipt without caller evidence', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-host-complete-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem() { return { state: 'committed', result: { id: 'bd-host-complete', revision: '1', status: 'open' } }; },
    async transition(input) { return { state: 'committed', result: { id: input.itemId, revision: '2', status: input.status } }; },
  };
  let completionRequest = null;
  const service = createBeadsWorkActionService({
    tracker, executionLinks: createMemoryExecutionLinkStore(), approvedWorkspaceIds: [workspaceRoot], authorizeMutation: hostAuthorization,
    registeredEvidenceProducers: ['ci'],
    resolveCompletionReceipt: async (request) => {
      completionRequest = request;
      return { contract: 'jarvos.work-action-evidence-receipt/v1', immutable: true, kind: 'execution-verified', producer: 'ci', operationId: request.operationId, itemId: request.itemId, canonical };
    },
  });
  await service.create({ title: 'host completion', operationId: 'host-create-1', canonical });
  const completed = await service.completeFromHost({ itemId: 'bd-host-complete', operationId: 'host-complete-1' });
  assert.equal(completed.status, 'done');
  assert.deepEqual(completionRequest, { operationId: 'host-complete-1', itemId: 'bd-host-complete', workspaceId: completionRequest.workspaceId });
});

test('Beads Todo host completion hides private resolver failures', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-host-error-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem() { return { state: 'committed', result: { id: 'bd-host-error', revision: '1', status: 'open' } }; },
    async transition() { throw new Error('must not dispatch without completion evidence'); },
  };
  const service = createBeadsWorkActionService({
    tracker,
    executionLinks: createMemoryExecutionLinkStore(),
    approvedWorkspaceIds: [workspaceRoot],
    authorizeMutation: hostAuthorization,
    registeredEvidenceProducers: ['ci'],
    resolveCompletionReceipt: async () => { throw new Error('token=private /Users/private/receipt.json'); },
  });
  await service.create({ title: 'host completion error', operationId: 'host-error-create', canonical });
  await assert.rejects(
    () => service.completeFromHost({ itemId: 'bd-host-error', operationId: 'host-error-complete' }),
    (error) => error.message === 'host completion receipt is unavailable' && !error.message.includes('private'),
  );
});

test('live Todo mode accepts only host-resolved terminal evidence', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-terminal-workspace-'));
  const trackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-terminal-tracker-'));
  const actionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-terminal-action-'));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-terminal-links-'));
  const { createBeadsWorkActionService, createFileOperationStore } = require('../src/index.js');
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  let transitions = 0;
  const tracker = {
    authority: 'beads', workspaceRoot,
    operationStoreRoot: trackerRoot,
    operationStoreContract: 'jarvos-coding-operation-store/v1',
    operationStoreStorage: 'file',
    async createWorkItem() { return { state: 'committed', result: { id: 'bd-live-terminal', revision: '1', status: 'open' } }; },
    async transition(input) { transitions += 1; return { state: 'committed', result: { id: input.itemId, revision: '2', status: input.status } }; },
  };
  const service = createBeadsWorkActionService({
    tracker,
    mode: 'live',
    operationStore: createFileOperationStore({ root: actionRoot }),
    executionLinks: createFileExecutionLinkStore({ root: linkRoot }),
    workspaceId: 'workspace-live-terminal',
    approvedWorkspaceIds: ['workspace-live-terminal'],
    authorizeMutation: hostAuthorization,
    registeredEvidenceProducers: ['ci'],
    resolveCompletionReceipt: async (request) => ({
      contract: 'jarvos.work-action-evidence-receipt/v1', immutable: true,
      kind: 'execution-verified', producer: 'ci', canonical,
      operationId: request.operationId, itemId: request.itemId,
    }),
  });
  await service.create({ title: 'live terminal', operationId: 'live-terminal-create', canonical });
  await assert.rejects(
    () => service.completeWithEvidence({ itemId: 'bd-live-terminal', operationId: 'live-terminal-forged', evidenceReceiptId: 'forged' }),
    /host-resolved receipt/,
  );
  assert.equal(transitions, 0);
  const completed = await service.completeFromHost({ itemId: 'bd-live-terminal', operationId: 'live-terminal-complete' });
  assert.equal(completed.status, 'done');
  assert.equal(completed.completionEvidence.kind, 'execution-verified');
  assert.equal(transitions, 1);
});

test('Todo completion preserves its evidence class while an indeterminate mutation reconciles', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-completion-reconcile-workspace-'));
  const actionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-completion-reconcile-action-'));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-completion-reconcile-links-'));
  const { createBeadsWorkActionService, createFileOperationStore } = require('../src/index.js');
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  let transitionAttempts = 0;
  let receiptResolutions = 0;
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem() { return { state: 'committed', result: { id: 'bd-completion-reconcile', revision: '1', status: 'open' } }; },
    async transition(input) {
      transitionAttempts += 1;
      if (transitionAttempts === 1) return { state: 'indeterminate' };
      return { state: 'committed', result: { id: input.itemId, revision: '2', status: input.status } };
    },
  };
  const options = {
    tracker,
    operationStore: createFileOperationStore({ root: actionRoot }),
    executionLinks: createFileExecutionLinkStore({ root: linkRoot }),
    workspaceId: 'workspace-completion-reconcile',
    approvedWorkspaceIds: ['workspace-completion-reconcile'],
    authorizeMutation: hostAuthorization,
    registeredEvidenceProducers: ['ci'],
    resolveCompletionReceipt: async (request) => {
      receiptResolutions += 1;
      return {
        contract: 'jarvos.work-action-evidence-receipt/v1', immutable: true,
        kind: 'domain-verified', producer: 'ci', canonical,
        operationId: request.operationId, itemId: request.itemId,
      };
    },
  };
  const firstService = createBeadsWorkActionService(options);
  await firstService.create({ title: 'completion reconcile', operationId: 'completion-reconcile-create', canonical });
  const uncertain = await firstService.completeFromHost({ itemId: 'bd-completion-reconcile', operationId: 'completion-reconcile-complete' });
  assert.equal(uncertain.status, 'indeterminate');
  const completed = await createBeadsWorkActionService({
    ...options,
    operationStore: createFileOperationStore({ root: actionRoot }),
    executionLinks: createFileExecutionLinkStore({ root: linkRoot }),
  }).completeFromHost({ itemId: 'bd-completion-reconcile', operationId: 'completion-reconcile-complete' });
  assert.equal(completed.status, 'done');
  assert.equal(completed.completionEvidence.kind, 'domain-verified');
  assert.equal(receiptResolutions, 1);
});

test('host completion preserves Andrew owner attestation without calling it technical verification', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-owner-attestation-'));
  const operationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-owner-operation-'));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-owner-links-'));
  const { createBeadsWorkActionService, createFileOperationStore } = require('../src/index.js');
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem() { return { state: 'committed', result: { id: 'bd-owner-attestation', revision: '1', status: 'open' } }; },
    async transition(input) { return { state: 'committed', result: { id: input.itemId, revision: '2', status: input.status } }; },
  };
  let completionResolutionCount = 0;
  const serviceOptions = {
    tracker,
    workspaceId: 'owner-attestation-workspace',
    approvedWorkspaceIds: ['owner-attestation-workspace'],
    authorizeMutation: hostAuthorization,
    registeredEvidenceProducers: ['andrew-owner-attestation'],
    resolveCompletionReceipt: async (request) => {
      completionResolutionCount += 1;
      return {
        contract: 'jarvos.work-action-evidence-receipt/v1', immutable: true, kind: 'human-attested',
        producer: 'andrew-owner-attestation', attestation: 'andrew-owner-attested',
        operationId: request.operationId, itemId: request.itemId, canonical,
      };
    },
  };
  const service = createBeadsWorkActionService({
    ...serviceOptions,
    operationStore: createFileOperationStore({ root: operationRoot }),
    executionLinks: createFileExecutionLinkStore({ root: linkRoot }),
  });
  await service.create({ title: 'owner-attested work', operationId: 'owner-create-1', canonical });
  const completed = await service.completeFromHost({ itemId: 'bd-owner-attestation', operationId: 'owner-complete-1' });
  assert.equal(completed.status, 'done');
  assert.deepEqual(completed.completionEvidence, {
    kind: 'human-attested', producer: 'andrew-owner-attestation', attestation: 'andrew-owner-attested',
  });
  const restarted = createBeadsWorkActionService({
    ...serviceOptions,
    operationStore: createFileOperationStore({ root: operationRoot }),
    executionLinks: createFileExecutionLinkStore({ root: linkRoot }),
  });
  const replayed = await restarted.completeFromHost({ itemId: 'bd-owner-attestation', operationId: 'owner-complete-1' });
  assert.deepEqual(replayed.completionEvidence, completed.completionEvidence);
  assert.equal(completionResolutionCount, 1);
  await assert.rejects(() => service.transition({ itemId: 'bd-owner-attestation', operationId: 'owner-generic-terminal', status: 'done' }), /unsupported Todo transition status/);
  await assert.rejects(() => service.transition({ itemId: 'bd-owner-attestation', operationId: 'owner-generic-cancelled', status: 'cancelled' }), /unsupported Todo transition status/);
});

test('Beads Todo derives a workspace and canonical-bound external reference for create reconciliation', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-external-reference-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  let trackerInput;
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem(input) {
      trackerInput = input;
      return { state: 'committed', result: { id: 'bd-derived-reference', revision: '1', status: 'open' } };
    },
  };
  const service = createBeadsWorkActionService({
    tracker,
    workspaceId: 'workspace-one',
    approvedWorkspaceIds: ['workspace-one'],
    executionLinks: createMemoryExecutionLinkStore(),
    authorizeMutation: hostAuthorization,
  });
  await service.create({ title: 'bound create', operationId: 'caller-operation', canonical });
  assert.match(trackerInput.externalReference, /^jarvos-[a-f0-9]{32}$/);
  assert.notEqual(trackerInput.externalReference, 'caller-operation');
});

test('Beads Todo action facade replays a committed operation without a second Beads create', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-replay-workspace-'));
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-replay-ledger-'));
  const links = createFileExecutionLinkStore({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-replay-links-')),
  });
  const operationStore = require('../src/index.js').createFileOperationStore({ root: ledgerRoot });
  let creates = 0;
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem(input) { creates += 1; return { state: 'committed', result: { id: 'bd-replay', revision: '1', status: 'open' }, operationId: input.operationId }; },
  };
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  const first = await require('../src/index.js').createBeadsWorkActionService({ tracker, operationStore, executionLinks: links, workspaceId: 'workspace-main', approvedWorkspaceIds: ['workspace-main'], authorizeMutation: hostAuthorization }).create({ title: 'replay', operationId: 'replay-1', canonical });
  const secondService = require('../src/index.js').createBeadsWorkActionService({ tracker, operationStore, executionLinks: links, workspaceId: 'workspace-main', approvedWorkspaceIds: ['workspace-main'], authorizeMutation: hostAuthorization });
  const replay = await secondService.create({ title: 'replay', operationId: 'replay-1', canonical });
  assert.equal(creates, 1);
  assert.equal(replay.workReference.itemId, first.workReference.itemId);
  assert.equal(replay.executionLink.workspaceId, 'workspace-main');
  assert.deepEqual((await secondService.list()).items.map((item) => item.itemId), ['bd-replay']);
  assert.equal(fs.readFileSync(path.join(ledgerRoot, 'replay-1.json'), 'utf8').includes(workspaceRoot), false);
});

test('live Todo create reconciles both durable ledgers after timeout and restart', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-reconcile-workspace-'));
  const trackerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-reconcile-tracker-'));
  const actionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-reconcile-action-'));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-reconcile-links-'));
  const { createBeadsWorkActionService, createFileOperationStore } = require('../src/index.js');
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  let externalReference = null;
  let createDispatches = 0;
  const run = (_command, args) => {
    if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19' };
    if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }) };
    if (args[0] === 'schema') return { status: 0, stdout: '{}' };
    if (args[0] === 'where') return { status: 0, stdout: workspaceRoot };
    if (args[0] === 'list') {
      return { status: 0, stdout: JSON.stringify({ issues: [{ id: 'bd-reconciled', revision: '1', status: 'open', external_ref: externalReference }] }) };
    }
    if (args[0] === 'create') {
      createDispatches += 1;
      externalReference = args[args.indexOf('--external-ref') + 1];
      return { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: 'timed out' };
    }
    throw new Error(`unexpected Beads command: ${args.join(' ')}`);
  };
  const build = () => {
    const tracker = createLiveBeadsTracker({ workspaceRoot, approvedRoots: [workspaceRoot], operationStoreRoot: trackerRoot, mode: 'live', run });
    return createBeadsWorkActionService({
      tracker,
      mode: 'live',
      operationStore: createFileOperationStore({ root: actionRoot }),
      executionLinks: createFileExecutionLinkStore({ root: linkRoot }),
      workspaceId: 'workspace-reconcile',
      approvedWorkspaceIds: ['workspace-reconcile'],
      authorizeMutation: hostAuthorization,
    });
  };
  const first = await build().create({ title: 'reconcile me', operationId: 'reconcile-create-1', canonical });
  assert.equal(first.status, 'indeterminate');
  const reconciled = await build().create({ title: 'reconcile me', operationId: 'reconcile-create-1', canonical });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.workReference.itemId, 'bd-reconciled');
  assert.equal(createDispatches, 1);
});

test('failed and mismatched Beads mutations never change the durable execution link', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-failed-link-'));
  const { createBeadsWorkActionService, createMemoryExecutionLinkStore } = require('../src/index.js');
  const links = createMemoryExecutionLinkStore();
  const canonical = { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' };
  let responseMode = 'failed';
  const tracker = {
    authority: 'beads', workspaceRoot,
    async createWorkItem() { return { state: 'committed', result: { id: 'bd-stable-link', revision: '1', status: 'open' } }; },
    async transition(input) {
      if (responseMode === 'failed') return { state: 'failed', status: 'failed' };
      return { state: 'committed', result: { id: 'bd-other-item', revision: '2', status: input.status } };
    },
  };
  const service = createBeadsWorkActionService({ tracker, executionLinks: links, approvedWorkspaceIds: [workspaceRoot], authorizeMutation: hostAuthorization });
  await service.create({ title: 'stable link', operationId: 'stable-link-create', canonical });
  assert.equal((await service.transition({ itemId: 'bd-stable-link', operationId: 'stable-link-failed', status: 'review' })).status, 'failed');
  responseMode = 'mismatched';
  assert.equal((await service.transition({ itemId: 'bd-stable-link', operationId: 'stable-link-mismatch', status: 'review' })).status, 'failed');
  const [linkRecord] = (await service.list()).items;
  assert.equal(linkRecord.itemRevision, '1');
  assert.equal(linkRecord.status, 'open');
});

test('public package declares a registry-safe control-plane dependency', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.dependencies['@jarvos/control-plane'], '0.1.0');
  assert.doesNotMatch(manifest.dependencies['@jarvos/control-plane'], /^(file:|link:)/);
});

test('buildLiveCodingAdapters() constructs without clawd present (lazy clawd require)', () => {
  // In the public package clawd scripts are absent. Construction must NOT require
  // them — only actual live method calls do. Regression for premature clawd require.
  const adapters = buildLiveCodingAdapters();
  assert.ok(adapters.tracker, 'tracker built');
  assert.ok(adapters.postMerge, 'postMerge built');
  assert.ok(adapters.reviewEngine && typeof adapters.reviewEngine.sliceReview === 'function');
  assert.ok(adapters.git && adapters.fixer && adapters.pullRequest);
});

test('explicit Beads transport works without Paperclip and uses bounded argv', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-workspace-'));
  const calls = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    approvedRoots: [workspaceRoot],
    run(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19\n', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: `${workspaceRoot}\n`, stderr: '' };
      if (args[0] === 'update' && args.includes('--claim')) return { status: 0, stdout: JSON.stringify([{ id: 'bd-1', status: 'in_progress', updated_at: '2026-08-26T00:00:00Z' }]), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-1', status: 'open', external_ref: args.includes('--external-ref') ? args[args.indexOf('--external-ref') + 1] : undefined }), stderr: '' };
    },
  });

  const created = await tracker.createWorkItem({ title: 'Repair release readiness', operationId: 'op-create-1' });
  const claimed = await tracker.claimIssue({ workReference: { authority: 'beads', itemId: 'bd-1' }, operationId: 'op-claim-1' });
  const dependency = await tracker.addDependency({ itemId: 'bd-1', dependencyId: 'bd-0', operationId: 'op-dep-1' });
  const checkpoint = await tracker.writeCheckpoint({ itemId: 'bd-1', stage: 'review', nextStep: 'publish-pr', operationId: 'op-checkpoint-1' });

  assert.equal(created.state, 'committed');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.workReference.authority, 'beads');
  assert.equal(dependency.state, 'committed');
  assert.equal(checkpoint.state, 'committed');
  assert.ok(calls.every((call) => call.command === 'br' && call.options.shell === false));
  assert.ok(calls.some((call) => call.args.includes('--external-ref') && call.args.includes('op-create-1')));

  const adapters = buildLiveCodingAdapters({
    beads: { workspaceRoot, approvedRoots: [workspaceRoot], run: () => ({ status: 0, stdout: '', stderr: '' }) },
  });
  assert.equal(adapters.tracker.authority, 'beads');
});

test('Beads preflight derives logical capabilities from the real v0.2.19 command inventory', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-real-capabilities-'));
  const externalReference = 'real-capability-create';
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      if (args[0] === '--version') return { status: 0, stdout: 'br 0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({
        tool: 'br',
        version: '0.2.19',
        contract_version: 'br.capabilities.v1',
        commands: ['create', 'update', 'show', 'close', 'reopen', 'dep', 'comments'].map((name) => ({ name })),
      }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ tool: 'br', schemas: {}, commands: {} }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: `${workspaceRoot}\n  prefix: bd\n`, stderr: '' };
      if (args[0] === 'create') return { status: 0, stdout: JSON.stringify({ id: 'bd-real', status: 'open', external_ref: externalReference }), stderr: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  const result = await tracker.createWorkItem({ title: 'real capability shape', operationId: externalReference });
  assert.equal(result.state, 'committed');
  assert.equal(result.result.id, 'bd-real');
});

test('Beads workspace proof accepts only the exact discovered .beads directory when initialized', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-where-shape-'));
  const beadsRoot = path.join(workspaceRoot, '.beads');
  fs.mkdirSync(beadsRoot);
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      if (args[0] === '--version') return { status: 0, stdout: 'br 0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: '{}', stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: `${beadsRoot}\n  database: ${beadsRoot}/beads.db\n`, stderr: '' };
      if (args[0] === 'create') return { status: 0, stdout: JSON.stringify({ id: 'bd-where', status: 'open', external_ref: 'where-create' }), stderr: '' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  assert.equal((await tracker.createWorkItem({ title: 'where proof', operationId: 'where-create' })).state, 'committed');
});

test('Beads preflight rejects an unpinned version before mutation', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-version-'));
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run: (command, args) => args[0] === '--version'
      ? { status: 0, stdout: 'br v9.9.9', stderr: '' }
      : { status: 0, stdout: workspaceRoot, stderr: '' },
  });
  await assert.rejects(() => tracker.createWorkItem({ title: 'must not run', operationId: 'op-version-1' }), /version is unsupported/);
});

test('Beads caller validation happens before an operation is prepared', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-input-validation-'));
  const calls = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-input', external_ref: args.includes('--external-ref') ? args[args.indexOf('--external-ref') + 1] : undefined }), stderr: '' };
    },
  });
  await assert.rejects(() => tracker.createWorkItem({ title: '', operationId: 'op-input-1' }), /create title is required/);
  const valid = await tracker.createWorkItem({ title: 'valid after correction', operationId: 'op-input-1' });
  assert.equal(valid.state, 'committed');
  assert.equal(calls.filter((args) => args[0] === 'create').length, 1);
});

test('prepared Beads operations reconcile before replay after an uncertain launch', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-reconcile-'));
  const operationStore = new Map();
  const calls = [];
  let firstMutation = true;
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    operationStore: {
      read: async (id) => operationStore.get(id) || null,
      write: async (record) => { operationStore.set(record.operationId, record); return record; },
    },
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      if (args[0] === 'list') return { status: 0, stdout: JSON.stringify({ issues: [{ id: 'bd-9', status: 'open', external_ref: 'op-reconcile-1' }] }), stderr: '' };
      if (firstMutation) { firstMutation = false; return { status: 1, stdout: '', stderr: 'timed out', error: new Error('timed out') }; }
      return { status: 0, stdout: JSON.stringify({ id: 'bd-9', external_ref: args.includes('--external-ref') ? args[args.indexOf('--external-ref') + 1] : undefined }), stderr: '' };
    },
  });
  const uncertain = await tracker.createWorkItem({ title: 'reconcile me', operationId: 'op-reconcile-1' });
  assert.equal(uncertain.state, 'indeterminate');
  const replay = await tracker.createWorkItem({ title: 'reconcile me', operationId: 'op-reconcile-1' });
  assert.equal(replay.state, 'committed');
  assert.equal(calls.filter((args) => args[0] === 'create').length, 1);
  assert.ok(calls.some((args) => args[0] === 'list' && args.includes('--all') && args.includes('1001')));
});

test('derived create references survive timeout and restart reconciliation without duplicate dispatch', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-derived-reconcile-workspace-'));
  const operationStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-derived-reconcile-ledger-'));
  const externalReference = 'jarvos-1234567890abcdef1234567890abcdef';
  let createCount = 0;
  const calls = [];
  const run = (command, args) => {
    calls.push(args);
    if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19' };
    if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }) };
    if (args[0] === 'schema') return { status: 0, stdout: '{}' };
    if (args[0] === 'where') return { status: 0, stdout: workspaceRoot };
    if (args[0] === 'list') {
      return { status: 0, stdout: JSON.stringify({ issues: [{ id: 'bd-derived', status: 'open', external_ref: externalReference }] }) };
    }
    createCount += 1;
    return { status: 1, stdout: '', stderr: 'timed out', error: new Error('timed out') };
  };
  const input = { title: 'derived reconciliation', operationId: 'caller-operation', externalReference };
  const first = createLiveBeadsTracker({ workspaceRoot, operationStoreRoot, run });
  assert.equal((await first.createWorkItem(input)).state, 'indeterminate');
  const restarted = createLiveBeadsTracker({ workspaceRoot, operationStoreRoot, run });
  const reconciled = await restarted.createWorkItem(input);
  assert.equal(reconciled.state, 'committed');
  assert.equal(createCount, 1);
  assert.ok(calls.some((args) => args[0] === 'list' && args.includes('--all') && args.includes('1001')));
});

test('Beads create treats empty or unrelated external references as indeterminate', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-unrelated-create-'));
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }) };
      if (args[0] === 'schema') return { status: 0, stdout: '{}' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-unrelated', external_ref: 'another-operation' }) };
    },
  });
  const result = await tracker.createWorkItem({ title: 'must not link', operationId: 'expected-operation' });
  assert.equal(result.state, 'indeterminate');
  assert.equal(result.errorCode, 'CREATE_REFERENCE_UNCONFIRMED');
});

test('Beads replay reconciles non-create operations by their exact postcondition', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-reconcile-claim-'));
  const operationStore = new Map();
  const calls = [];
  let mutationCount = 0;
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    operationStore: {
      read: async (id) => operationStore.get(id) || null,
      write: async (record) => { operationStore.set(record.operationId, record); return record; },
    },
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      if (args[0] === 'update' && mutationCount++ === 0) return { status: 1, stdout: '', stderr: 'timed out', error: new Error('timed out') };
      if (args[0] === 'show') return { status: 0, stdout: JSON.stringify({ id: 'bd-claim', status: 'in_progress' }), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-claim' }), stderr: '' };
    },
  });

  const first = await tracker.claimIssue({ itemId: 'bd-claim', operationId: 'claim-reconcile-1' });
  assert.equal(first.state, 'indeterminate');
  const replay = await tracker.claimIssue({ itemId: 'bd-claim', operationId: 'claim-reconcile-1' });
  assert.equal(replay.status, 'claimed');
  assert.equal(calls.filter((args) => args[0] === 'update').length, 1);
  assert.ok(calls.some((args) => args[0] === 'show' && args[1] === 'bd-claim' && !args.includes('--external-ref')));
});

test('Beads default operation identities distinguish operation inputs', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-operation-id-'));
  const operationIds = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    operationStore: {
      async read() { return null; },
      async write(record) { operationIds.push(record.operationId); return record; },
    },
    run(command, args) {
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-identity', status: 'open' }), stderr: '' };
    },
  });
  await tracker.addDependency({ itemId: 'bd-identity', dependencyId: 'bd-a' });
  await tracker.addDependency({ itemId: 'bd-identity', dependencyId: 'bd-b' });
  assert.equal(new Set(operationIds).size, 2);
});

test('Beads close remains deferred until authoritative merge evidence', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-close-'));
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run: (command, args) => {
      if (args[0] === '--version') return { status: 0, stdout: '0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      if (args[0] === 'close') return { status: 0, stdout: JSON.stringify([{ id: 'bd-1', status: 'closed' }]), stderr: '' };
      if (args[0] === 'show') return { status: 0, stdout: JSON.stringify([{ id: 'bd-1', status: 'closed', updated_at: '2026-08-26T00:00:00Z' }]), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-1' }), stderr: '' };
    },
  });
  const deferred = await tracker.verifyAndClose({ itemId: 'bd-1', pullRequest: { state: 'OPEN' } });
  assert.equal(deferred.status, 'deferred');
  const closed = await tracker.verifyAndClose({ itemId: 'bd-1', pullRequest: { state: 'MERGED' }, operationId: 'op-close-1' });
  assert.equal(closed.status, 'closed');
});

test('Beads adapter emits exact argv for every live operation without a command-map override', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-argv-'));
  const calls = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      if (args[0] === 'update') {
        const status = args.includes('--claim') ? 'in_progress' : args[args.indexOf('--status') + 1];
        return { status: 0, stdout: JSON.stringify([{ id: 'bd-argv', status, updated_at: '2026-08-26T00:00:00Z' }]), stderr: '' };
      }
      if (args[0] === 'reopen') return { status: 0, stdout: JSON.stringify([{ id: 'bd-argv', status: 'open', updated_at: '2026-08-26T00:00:01Z' }]), stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-argv', status: 'open' }), stderr: '' };
    },
  });

  await tracker.createWorkItem({ title: 'Argv item', description: 'desc', priority: 2, operationId: 'op-argv-create' });
  await tracker.claimIssue({ itemId: 'bd-argv', operationId: 'op-argv-claim' });
  await tracker.transition({ itemId: 'bd-argv', status: 'review', operationId: 'op-argv-transition' });
  await tracker.transition({ itemId: 'bd-argv', status: 'open', operationId: 'op-argv-resume' });
  await tracker.transition({ itemId: 'bd-argv', status: 'open', reopen: true, operationId: 'op-argv-reopen' });
  await tracker.addDependency({ itemId: 'bd-argv', dependencyId: 'bd-dep', operationId: 'op-argv-dependency' });
  await tracker.writeCheckpoint({ itemId: 'bd-argv', stage: 'review', nextStep: 'publish-pr', operationId: 'op-argv-checkpoint' });
  await tracker.showWorkItem({ itemId: 'bd-argv' });

  assert.deepEqual(calls[0], ['--version']);
  assert.deepEqual(calls[1], ['capabilities', '--format', 'json']);
  assert.deepEqual(calls[2], ['schema', 'all', '--format', 'json']);
  assert.deepEqual(calls[3], ['where']);
  assert.deepEqual(calls[4], ['create', '--title', 'Argv item', '--description', 'desc', '--priority', '2', '--external-ref', 'op-argv-create', '--json']);
  assert.deepEqual(calls[5], ['where']);
  assert.deepEqual(calls[6], ['update', 'bd-argv', '--claim', '--json']);
  assert.deepEqual(calls[7], ['where']);
  assert.deepEqual(calls[8], ['update', 'bd-argv', '--status', 'review', '--json']);
  assert.deepEqual(calls[9], ['where']);
  assert.deepEqual(calls[10], ['update', 'bd-argv', '--status', 'open', '--json']);
  assert.deepEqual(calls[11], ['where']);
  assert.deepEqual(calls[12], ['reopen', 'bd-argv', '--reason', 'Reopened by jarvOS work action', '--json']);
  assert.deepEqual(calls[13], ['where']);
  assert.deepEqual(calls[14], ['dep', 'add', 'bd-argv', 'bd-dep', '--json']);
  assert.deepEqual(calls[15], ['where']);
  assert.deepEqual(calls[16], ['comments', 'add', 'bd-argv', '--message', '[jarvos-checkpoint/v1] {"operationId":"op-argv-checkpoint","stage":"review","nextStep":"publish-pr"}', '--json']);
  assert.deepEqual(calls[17], ['where']);
  assert.deepEqual(calls[18], ['show', 'bd-argv', '--format', 'json']);
  assert.equal(calls.length, 19);
});

test('Beads preflight fails closed when a required capability is missing before any mutation runs', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-missing-capability-'));
  const calls = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-missing' }), stderr: '' };
    },
  });
  await assert.rejects(() => tracker.createWorkItem({ title: 'must not run', operationId: 'op-missing-capability' }), /capability negotiation failed/);
  assert.ok(!calls.some((args) => args[0] === 'create'));
});

test('Beads preflight fails closed when capabilities output is not parseable JSON', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-bad-json-'));
  const calls = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: 'not-json-output', stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-badjson' }), stderr: '' };
    },
  });
  await assert.rejects(() => tracker.createWorkItem({ title: 'must not run', operationId: 'op-bad-json' }), /capability negotiation failed/);
  assert.ok(!calls.some((args) => args[0] === 'create'));
});

test('Beads mutation fails closed when the workspace realpath does not match at verification time', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-realpath-expected-'));
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-realpath-other-'));
  const calls = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: otherRoot, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-realpath' }), stderr: '' };
    },
  });
  await assert.rejects(() => tracker.createWorkItem({ title: 'must not run', operationId: 'op-realpath-1' }), /workspace verification failed/);
  assert.ok(!calls.some((args) => args[0] === 'create'));
});

test('Beads construction rejects a workspace outside its approved roots', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-unapproved-workspace-'));
  const approvedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-unapproved-approved-'));
  assert.throws(() => createLiveBeadsTracker({
    workspaceRoot,
    approvedRoots: [approvedRoot],
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  }), /not approved/);
});

test('Beads showWorkItem uses bounded read-only argv and fails closed when the read does not succeed', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-show-'));
  const calls = [];
  let failShow = false;
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      if (args[0] === 'show') {
        return failShow ? { status: 1, stdout: '', stderr: 'not found' } : { status: 0, stdout: JSON.stringify({ id: 'bd-show', status: 'open' }), stderr: '' };
      }
      return { status: 0, stdout: JSON.stringify({ id: 'bd-show' }), stderr: '' };
    },
  });
  const shown = await tracker.showWorkItem({ itemId: 'bd-show' });
  assert.equal(shown.state, 'committed');
  assert.equal(shown.status, 'available');
  assert.deepEqual(shown.result, { id: 'bd-show', status: 'open' });
  assert.deepEqual(calls.filter((args) => args[0] === 'show').pop(), ['show', 'bd-show', '--format', 'json']);

  failShow = true;
  const unavailable = await tracker.showWorkItem({ itemId: 'bd-show' });
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.errorCode, 'READ_FAILED');
});

test('Beads mutation refuses to reuse an operationId with different input before dispatching a second command', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-beads-identity-conflict-'));
  const calls = [];
  const tracker = createLiveBeadsTracker({
    workspaceRoot,
    run(command, args) {
      calls.push(args);
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ id: 'bd-identity-conflict', external_ref: args.includes('--external-ref') ? args[args.indexOf('--external-ref') + 1] : undefined }), stderr: '' };
    },
  });
  const first = await tracker.createWorkItem({ title: 'first title', operationId: 'op-identity-conflict' });
  assert.equal(first.state, 'committed');
  await assert.rejects(() => tracker.createWorkItem({ title: 'second title', operationId: 'op-identity-conflict' }), /operation identity conflict/);
  assert.equal(calls.filter((args) => args[0] === 'create').length, 1);
});

test('pre-PR fixer records real post-fix cleanliness and an explicit no-test rationale', async () => {
  const calls = [];
  const fixer = createLiveFixer({
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const result = await fixer.fixAndRerun({
    branch: 'SUP-3470/public-jarvos-coding',
    worktreeDir: '/tmp/SUP-3470',
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reasonCode, 'pre_pr_no_fix_context');
  assert.deepEqual(result.git, {
    clean: true,
    status: 'clean',
    worktreePath: '/tmp/SUP-3470',
    exitCode: 0,
  });
  assert.deepEqual(calls[0].args, ['status', '--porcelain']);
  assert.equal(calls[0].options.cwd, '/tmp/SUP-3470');
});

test('pre-PR fixer fails cleanliness closed when the post-fix worktree is dirty', async () => {
  const fixer = createLiveFixer({
    run: () => ({ status: 0, stdout: ' M src/index.js\n', stderr: '' }),
  });
  const result = await fixer.fixAndRerun({
    branch: 'SUP-3470/public-jarvos-coding',
    worktreeDir: '/tmp/SUP-3470',
  });
  assert.equal(result.git.clean, false);
  assert.equal(result.git.status, 'dirty');
});

test('PR-scoped fixer attaches post-fix git cleanliness to a successful primary pass', async () => {
  const fixer = createLiveFixer({
    primaryFixPass: () => ({ status: 'passed' }),
    run: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  const result = await fixer.fixAndRerun({
    branch: 'SUP-3470/public-jarvos-coding',
    worktreeDir: '/tmp/SUP-3470',
    pullRequest: { number: 112, headRefName: 'SUP-3470/public-jarvos-coding' },
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.git.clean, true);
  assert.equal(result.git.worktreePath, '/tmp/SUP-3470');
});

test('live PR adapter revalidates a merged reattachment by number after branch deletion', async () => {
  const calls = [];
  const adapter = createLivePullRequest({
    repo: 'levineam/jarVOS',
    run(command, args) {
      calls.push([command, args]);
      assert.deepEqual(args.slice(0, 3), ['pr', 'view', '112']);
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 112,
          url: 'https://github.com/levineam/jarVOS/pull/112',
          title: 'Coding compatibility',
          state: 'MERGED',
          headRefName: 'SUP-3470/public-jarvos-coding',
        }),
        stderr: '',
      };
    },
  });

  const result = await adapter.openPullRequest({
    branch: 'SUP-3470/public-jarvos-coding',
    existingPullRequest: { number: 112 },
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.state, 'MERGED');
  assert.equal(result.liveConfirmed, true);
  assert.equal(result.reattached, true);
  assert.equal(calls.length, 1);
});

test('live PR adapter rejects option injection in merge inputs', async () => {
  const calls = [];
  const adapter = createLivePullRequest({
    repo: 'levineam/jarVOS',
    run(command, args) {
      calls.push([command, args]);
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  await assert.rejects(() => adapter.merge({ number: '--admin' }), /positive integer pull request number/);
  await assert.rejects(() => adapter.merge({ number: 112, mergeMethod: 'admin' }), /must be one of/);
  assert.equal(calls.length, 0);
});

test('live tracker defers close until there is merge evidence', async () => {
  const tracker = createLivePaperclipTracker({
    prLink: {
      getIssueByIdentifier: () => ({ id: 'x', status: 'in_progress' }),
      transitionIssue: () => {
        throw new Error('must not transition an unmerged issue to done');
      },
    },
  });

  const open = await tracker.verifyAndClose({ issueIdentifier: 'SUP-1', pullRequest: { state: 'OPEN' } });
  assert.equal(open.status, 'deferred');
  assert.equal(open.ok, true);
  assert.match(open.reason, /not merged/);
});

test('live tracker closes once merge evidence is present', async () => {
  const transitions = [];
  const tracker = createLivePaperclipTracker({
    prLink: {
      getIssueByIdentifier: () => ({ id: 'x', status: 'in_progress' }),
      transitionIssue: (identifier, status) => {
        transitions.push([identifier, status]);
        return { ok: true };
      },
    },
  });

  const merged = await tracker.verifyAndClose({ issueIdentifier: 'SUP-1', pullRequest: { state: 'MERGED' } });
  assert.equal(merged.status, 'closed');
  assert.deepEqual(transitions, [['SUP-1', 'done']]);
});

test('post-merge sweep no-ops on an unmerged PR', async () => {
  const sweep = createLivePostMergeSweep({
    prLink: { onPRMerged: () => { throw new Error('must not sweep an unmerged PR'); } },
    repo: 'levineam/jarvOS',
  });
  const result = await sweep.sweep({ pullRequest: { number: 70, state: 'OPEN' } });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /not merged/);
});
