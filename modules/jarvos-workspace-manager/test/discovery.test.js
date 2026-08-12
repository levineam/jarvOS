'use strict';

const assert = require('assert');
const test = require('node:test');
const workspace = require('../src');

const now = '2026-08-12T12:10:00.000Z';
const base = (id, state = {}) => ({
  repositoryId: `repo-${id}`, checkoutId: `checkout-${id}`, worktreeId: `worktree-${id}`,
  branchId: `branch-${id}`, candidateId: `candidate-${id}`, subjectIdentity: `subject-${id}`,
  observedAt: '2026-08-12T12:00:00.000Z', freshUntil: '2026-08-12T13:00:00.000Z',
  state: { clean: true, complete: true, dirty: false, conflicts: false, nestedRepository: false, detached: false, missing: false, unknownOwnership: false, duplicateIdentity: false, protected: false, divergedRefs: false, uniqueCommits: false, incomplete: false, ...state },
});
const evidence = (id) => ({ sourceVersion: 'lifecycle.v1', subjectIdentity: `subject-${id}`, digest: 'a'.repeat(64), observedAt: '2026-08-12T12:01:00.000Z', freshUntil: '2026-08-12T13:00:00.000Z', outcome: 'landed' });
const clearance = (id, outcome = 'satisfied') => ({ version: workspace.RELEASE_CLEARANCE_CONTRACT_VERSION, sourceVersion: 'release.v1', subjectIdentity: `subject-${id}`, digest: 'b'.repeat(64), observedAt: '2026-08-12T12:02:00.000Z', freshUntil: '2026-08-12T13:00:00.000Z', outcome, generation: 1, receiptId: `receipt-${id}`, currentPointerId: `pointer-${id}` });

test('discovery keeps healthy roots when one Git root fails and lifecycle is unavailable', async () => {
  const result = await workspace.discoverWorkspaces({
    roots: [{ rootId: 'root-good' }, { rootId: 'root-bad' }], now,
    gitObservationPort: { observeRoot: async ({ rootId }) => {
      if (rootId === 'root-bad') throw new Error('git unavailable');
      return { observations: [base('good')] };
    } },
    lifecycleEvidencePort: { resolve: async () => { throw new Error('lifecycle unavailable'); } },
  });
  assert.equal(result.inventory.length, 1);
  assert.equal(result.inventory[0].disposition.disposition, 'deferred');
  assert.equal(result.health.state, 'degraded');
  assert.equal(result.roots.find((root) => root.rootId === 'root-good').health.state, 'degraded');
  assert.equal(result.roots.find((root) => root.rootId === 'root-bad').health.state, 'degraded');
});

test('dirty, protected, and incomplete observations preserve before lifecycle lookup', async () => {
  const requested = [];
  const result = await workspace.discoverWorkspaces({
    roots: [{ rootId: 'root-a' }], now,
    gitObservationPort: { observeRoot: async () => ({ observations: [base('dirty', { dirty: true }), base('protected', { protected: true }), base('old', { incomplete: true })] }) },
    lifecycleEvidencePort: { resolve: async ({ subjectIdentity }) => { requested.push(subjectIdentity); return evidence(subjectIdentity.slice('subject-'.length)); } },
  });
  assert.deepEqual(result.inventory.map((item) => item.disposition.disposition), ['preserve', 'preserve', 'preserve']);
  assert.deepEqual(requested, []);
});

test('detached, missing, nested, conflicted, diverged, duplicate, and unknown observations never become cleanup candidates', async () => {
  const unsafe = ['detached', 'missing', 'nestedRepository', 'conflicts', 'divergedRefs', 'duplicateIdentity', 'unknownOwnership'];
  for (const flag of unsafe) {
    const result = await workspace.discoverWorkspaces({ roots: [{ rootId: 'root-a' }], now,
      gitObservationPort: { observeRoot: async () => ({ observations: [base(flag, { [flag]: true })] }) },
      lifecycleEvidencePort: { resolve: async () => evidence(flag) },
    });
    assert.equal(result.inventory[0].disposition.disposition, 'preserve', flag);
  }
});

test('equivalent observations dedupe without a mutation lease and roots obey bounded concurrency', async () => {
  let active = 0; let peak = 0;
  const result = await workspace.discoverWorkspaces({ roots: [{ rootId: 'a' }, { rootId: 'b' }], now, concurrency: 1,
    gitObservationPort: { observeRoot: async ({ rootId }) => { active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return { observations: [base('same')] }; } },
    lifecycleEvidencePort: { resolve: async () => evidence('same') },
  });
  assert.equal(peak, 1);
  assert.equal(result.inventory.length, 1);
  assert.equal(result.deduplicated, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'mutationLease'), false);
});

test('release clearance is a third proof and absent or nonterminal release state never becomes cleanup', async () => {
  const baseOptions = {
    roots: [{ rootId: 'root-a' }], now,
    gitObservationPort: { observeRoot: async () => ({ observations: [base('a')] }) },
    lifecycleEvidencePort: { resolve: async () => evidence('a') },
  };
  const absent = await workspace.discoverWorkspaces(baseOptions);
  assert.equal(absent.inventory[0].disposition.disposition, 'deferred');
  const pending = await workspace.discoverWorkspaces({ ...baseOptions, releaseClearancePort: { resolve: async () => clearance('a', 'pending') } });
  assert.equal(pending.inventory[0].disposition.disposition, 'preserve');
  const satisfied = await workspace.discoverWorkspaces({ ...baseOptions, releaseClearancePort: { resolve: async () => clearance('a') } });
  assert.equal(satisfied.inventory[0].disposition.disposition, 'cleanup_candidate');
  assert.equal(satisfied.inventory[0].disposition.releaseClearance.currentPointerId, 'pointer-a');
});

test('release adapter failure degrades the root while preserving inventory', async () => {
  const result = await workspace.discoverWorkspaces({
    roots: [{ rootId: 'root-a' }], now,
    gitObservationPort: { observeRoot: async () => ({ observations: [base('a')] }) },
    lifecycleEvidencePort: { resolve: async () => evidence('a') },
    releaseClearancePort: { resolve: async () => { throw new Error('release unavailable'); } },
  });
  assert.equal(result.inventory.length, 1);
  assert.equal(result.inventory[0].disposition.disposition, 'deferred');
  assert.equal(result.roots[0].health.reason, 'release_clearance_unavailable');
  assert.equal(result.health.state, 'degraded');
});

test('single-flight overlap and root budgets report bounded health without queuing work', async () => {
  let release;
  const service = workspace.createWorkspaceDiscoveryService({ roots: [{ rootId: 'root-a' }], now: () => now, rootBudgetMs: 1,
    gitObservationPort: { observeRoot: () => new Promise((resolve) => { release = () => resolve({ observations: [base('a')] }); }) },
  });
  const first = service.discover();
  const overlap = await service.discover();
  assert.equal(overlap.health.overlap, true);
  const timed = await first;
  assert.equal(timed.roots[0].health.reason, 'root_time_budget_exhausted');
  release();
});

test('discovery caps per-root inventory and reports truncation as degraded health', async () => {
  const result = await workspace.discoverWorkspaces({
    roots: [{ rootId: 'root-a' }], now, maxObservationsPerRoot: 1,
    gitObservationPort: { observeRoot: async () => ({ observations: [base('a'), base('b')] }) },
  });
  assert.equal(result.inventory.length, 1);
  assert.equal(result.roots[0].health.truncated, true);
  assert.equal(result.roots[0].health.omittedObservations, 1);
  assert.equal(result.roots[0].health.reason, 'observation_limit_exhausted');
  assert.equal(result.health.state, 'degraded');
});

test('lifecycle evidence resolution is globally bounded across roots', async () => {
  let active = 0; let peak = 0;
  const result = await workspace.discoverWorkspaces({
    roots: [{ rootId: 'root-a' }, { rootId: 'root-b' }], now, concurrency: 2, lifecycleConcurrency: 2,
    gitObservationPort: { observeRoot: async ({ rootId }) => ({ observations: [base(`${rootId}-1`), base(`${rootId}-2`), base(`${rootId}-3`)] }) },
    lifecycleEvidencePort: { resolve: async ({ subjectIdentity }) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return evidence(subjectIdentity.replace(/^subject-/, ''));
    } },
    releaseClearancePort: { resolve: async ({ subjectIdentity }) => clearance(subjectIdentity.replace(/^subject-/, '')) },
  });
  assert.equal(result.health.state, 'healthy');
  assert.ok(peak <= 2, `lifecycle peak ${peak} exceeded global limit`);
});
