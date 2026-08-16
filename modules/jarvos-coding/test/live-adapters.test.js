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

function hostAuthorization({ action, workspaceId, operationId, itemId, canonical }) {
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

test('Beads Todo action facade replays a committed operation without a second Beads create', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-replay-workspace-'));
  const ledgerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-replay-ledger-'));
  const links = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/execution-link-store').createFileExecutionLinkStore({
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
      return { status: 0, stdout: JSON.stringify({ id: 'bd-1', status: 'open' }), stderr: '' };
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
      return { status: 0, stdout: JSON.stringify({ id: 'bd-input' }), stderr: '' };
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
      if (args[0] === 'show' && args.includes('--external-ref')) return { status: 0, stdout: JSON.stringify({ id: 'bd-9', status: 'open' }), stderr: '' };
      if (firstMutation) { firstMutation = false; return { status: 1, stdout: '', stderr: 'timed out', error: new Error('timed out') }; }
      return { status: 0, stdout: JSON.stringify({ id: 'bd-9' }), stderr: '' };
    },
  });
  const uncertain = await tracker.createWorkItem({ title: 'reconcile me', operationId: 'op-reconcile-1' });
  assert.equal(uncertain.state, 'indeterminate');
  const replay = await tracker.createWorkItem({ title: 'reconcile me', operationId: 'op-reconcile-1' });
  assert.equal(replay.state, 'committed');
  assert.equal(calls.filter((args) => args[0] === 'create').length, 1);
  assert.ok(calls.some((args) => args[0] === 'show' && args.includes('--external-ref')));
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
    run(command, args) {
      if (args[0] === '--version') return { status: 0, stdout: 'br v0.2.19', stderr: '' };
      if (args[0] === 'capabilities') return { status: 0, stdout: JSON.stringify({ capabilities: ['create', 'update', 'dependency', 'checkpoint'] }), stderr: '' };
      if (args[0] === 'schema') return { status: 0, stdout: JSON.stringify({ schema: 'beads/v1' }), stderr: '' };
      if (args[0] === 'where') return { status: 0, stdout: workspaceRoot, stderr: '' };
      const index = args.indexOf('--operation-id');
      if (index >= 0) operationIds.push(args[index + 1]);
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
      return { status: 0, stdout: JSON.stringify({ id: 'bd-1' }), stderr: '' };
    },
  });
  const deferred = await tracker.verifyAndClose({ itemId: 'bd-1', pullRequest: { state: 'OPEN' } });
  assert.equal(deferred.status, 'deferred');
  const closed = await tracker.verifyAndClose({ itemId: 'bd-1', pullRequest: { state: 'MERGED' }, operationId: 'op-close-1' });
  assert.equal(closed.status, 'closed');
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
