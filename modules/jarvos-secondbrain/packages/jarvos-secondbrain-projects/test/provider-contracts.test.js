'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const contracts = require('../src/provider-contracts');

const NOW = '2026-08-08T12:00:00.000Z';
const LATER = '2026-08-08T12:05:00.000Z';
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

test('canonical references and execution links are provider-neutral and exact', () => {
  const todo = fixture('todo-provider.json');
  const beads = fixture('beads-provider.json');
  const reference = contracts.createCanonicalReference(todo.canonicalReference);
  assert.deepEqual(reference, todo.canonicalReference);
  assert.equal(contracts.validateCanonicalReference(reference).ok, true);
  assert.equal(contracts.validateExecutionReference(beads.executionReference).ok, true);
  assert.equal(beads.executionReference.authority, 'beads');
  assert.throws(() => contracts.validateCanonicalReference({ ...reference, extra: true }), /unsupported fields/);
  assert.throws(() => contracts.validateExecutionReference({ ...beads.executionReference, provider: 'paperclip' }), /authority/);
});

test('protected execution-link store rejects a canonical rewrite for the same Beads item', async () => {
  const { createMemoryExecutionLinkStore } = require('../src/execution-link-store');
  const beads = fixture('beads-provider.json');
  const store = createMemoryExecutionLinkStore();
  await store.write(beads.executionReference);
  assert.equal((await store.read(beads.executionReference.workspaceId, beads.executionReference.itemId)).canonical.id, beads.executionReference.canonical.id);
  await assert.rejects(() => store.write({ ...beads.executionReference, canonical: { ...beads.executionReference.canonical, id: 'out_000002', breadcrumb: 'other' } }), /canonical conflict/);
});

test('file execution-link store serializes compare-and-swap updates and recovers stale locks', async () => {
  const { createFileExecutionLinkStore } = require('../src/execution-link-store');
  const beads = fixture('beads-provider.json');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-execution-links-'));
  const store = createFileExecutionLinkStore({ root });
  await store.write(beads.executionReference);
  await assert.rejects(() => store.write({ ...beads.executionReference, itemRevision: '8' }, '0'), /compare-and-swap conflict/);
  await assert.rejects(() => store.write({ ...beads.executionReference, itemRevision: '8' }, '6'), /compare-and-swap conflict/);
  await store.write({ ...beads.executionReference, itemRevision: '8', sourceRevision: '8', capturedAt: LATER }, '7');
  assert.equal((await store.read(beads.executionReference.workspaceId, beads.executionReference.itemId)).itemRevision, '8');
  fs.writeFileSync(path.join(root, '.execution-links.lock'), '', { mode: 0o600 });
  await store.write({ ...beads.executionReference, itemRevision: '9', sourceRevision: '9', capturedAt: '2026-08-08T12:10:00.000Z' }, '8');
  assert.equal((await store.read(beads.executionReference.workspaceId, beads.executionReference.itemId)).itemRevision, '9');
  assert.deepEqual((await store.list()).map((entry) => entry.itemId), [beads.executionReference.itemId]);
});

test('file execution-link store lists an absent root as empty and preserves colon-bearing workspace identities', async () => {
  const { createFileExecutionLinkStore } = require('../src/execution-link-store');
  const beads = fixture('beads-provider.json');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-execution-links-fresh-'));
  const root = path.join(parent, 'not-created-yet');
  const store = createFileExecutionLinkStore({ root });
  assert.deepEqual(await store.list(), []);
  const reference = { ...beads.executionReference, workspaceId: 'workspace:local:main', itemId: 'bd-colon' };
  await store.write(reference);
  assert.deepEqual((await store.list()).map((entry) => [entry.workspaceId, entry.itemId]), [['workspace:local:main', 'bd-colon']]);
});

test('Todo to Beads promotion is idempotent, revision-bound, and timeout-safe', () => {
  const todo = fixture('todo-provider.json');
  const beads = fixture('beads-provider.json');
  const operation = contracts.createPromotionOperation(todo.promotionRequest);
  assert.equal(operation.state, 'pending');
  assert.equal(operation.resolution, 'pending');
  assert.match(operation.correlationKey, /^promote_[a-f0-9]{32}$/);
  assert.equal(contracts.validatePromotionOperation(operation).ok, true);

  const replay = contracts.replayPromotionOperation(operation, todo.promotionRequest);
  assert.equal(replay.status, 'deduped');
  assert.equal(replay.operation.operationId, operation.operationId);

  const timedOut = contracts.resolvePromotionOperation(operation, {
    outcome: 'indeterminate', observedAt: LATER, reason: 'executor-timeout',
  });
  assert.equal(timedOut.state, 'indeterminate');
  assert.equal(contracts.promotionRetryStatus(timedOut), 'blocked');
  assert.equal(contracts.replayPromotionOperation(timedOut, todo.promotionRequest).status, 'reconcile-required');

  const committed = contracts.resolvePromotionOperation(timedOut, {
    outcome: 'committed', observedAt: LATER, observedTodoRevision: todo.promotionRequest.todoRevision,
    executionReference: beads.executionReference,
  });
  assert.equal(committed.state, 'committed');
  assert.equal(committed.resolution, 'committed');
  assert.equal(committed.beadsReference.itemId, beads.executionReference.itemId);
  assert.equal(contracts.promotionRetryStatus(committed), 'blocked');

  const stale = contracts.replayPromotionOperation(operation, { ...todo.promotionRequest, todoRevision: todo.promotionRequest.todoRevision - 1 });
  assert.equal(stale.status, 'conflict');
  const targetConflict = contracts.replayPromotionOperation(operation, {
    ...todo.promotionRequest,
    target: { ...todo.promotionRequest.target, id: 'out_000002', breadcrumb: 'other › outcome' },
  });
  assert.equal(targetConflict.status, 'conflict');

  const notCommitted = contracts.resolvePromotionOperation(operation, { outcome: 'not-committed', observedAt: LATER, reason: 'no-side-effect' });
  assert.equal(contracts.promotionRetryStatus(notCommitted), 'allowed');
});

test('release evidence belongs to the Outcome and links repair without creating release tasks', () => {
  const release = fixture('release-outcome.json');
  const evidence = contracts.createReleaseEvidence(release.releaseEvidence);
  assert.equal(contracts.validateReleaseEvidence(evidence).ok, true);
  assert.equal(evidence.canonical.kind, 'outcome');
  assert.equal(evidence.canonical.breadcrumb, 'jarvOS › v1.0.0 release');
  assert.equal(evidence.repairReference.authority, 'beads');
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'task'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, 'lifecycle'), false);
  assert.equal(evidence.release.published, false);
});

test('unknown links become proposals and explicit Paperclip handoffs remain optional', () => {
  const release = fixture('release-outcome.json');
  const proposal = contracts.createUnknownLinkProposal(release.unknownLink);
  assert.equal(contracts.validateUnknownLinkProposal(proposal).ok, true);
  assert.equal(proposal.status, 'proposed');
  assert.equal(Object.prototype.hasOwnProperty.call(proposal, 'canonicalId'), false);

  const beads = fixture('beads-provider.json');
  const handoff = contracts.createExplicitHandoff(beads.explicitHandoff);
  assert.equal(contracts.validateExplicitHandoff(handoff).ok, true);
  assert.equal(handoff.toAuthority, 'paperclip');
  assert.equal(handoff.state, 'external-owned');
  assert.deepEqual(contracts.paperclipProjection(null), { state: 'omitted', reference: null });
  assert.deepEqual(contracts.paperclipProjection(handoff), { state: 'external-owned', reference: handoff.externalReference });
});

test('provider contract validators remain isolated from live Todo, Beads, Paperclip, and release imports', () => {
  assert.equal(contracts.PROVIDER_SNAPSHOT_CONTRACT, 'jarvos.provider-snapshot/v1');
  assert.equal(contracts.PROMOTION_OPERATION_CONTRACT, 'jarvos.todo-beads-promotion/v1');
  assert.equal(contracts.RELEASE_EVIDENCE_CONTRACT, 'jarvos.release-evidence/v1');
  assert.equal(contracts.HANDOFF_CONTRACT, 'jarvos.explicit-handoff/v1');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'provider-contracts.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:\.\.?\/)*.*(?:todos|beads|paperclip|release)/i);
});
