'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  createMemoryStore,
  createPolicyEngine,
  createReconciler,
  createRegistry,
  createRequest,
} = require('../src/index.js');

function fixtureRequest(overrides = {}) {
  return createRequest({
    id: overrides.id,
    principal: overrides.principal || { id: 'principal:codex' },
    actor: { kind: 'agent', harness: 'codex' },
    resource: overrides.resource || { machineId: 'machine-a', type: 'git-repository', id: 'repo-1' },
    mutationClass: overrides.mutationClass || 'workspace.cleanup',
    desiredGeneration: overrides.desiredGeneration || 'desired-1',
    commandSpec: overrides.commandSpec || {
      operation: 'cleanup-worktree',
      arguments: { pathToken: 'repo-1' },
      constraints: { reversible: true },
      lifecycle: { idempotent: true },
    },
  });
}

function buildFixture() {
  const registry = createRegistry({ machineId: 'machine-a' });
  registry.registerManager({
    managerId: 'workspace-manager',
    trust: { level: 'trusted' },
    capabilities: ['observe', 'execute', 'verify'],
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
    operationContract: {
      finalSideEffectFence: { required: true, mode: 'compare-and-set' },
      verifier: { authoritativeReadPath: 'fixture-current-state' },
    },
  });
  const policy = createPolicyEngine({ allowlist: ['git-repository:workspace.cleanup'] });
  const store = createMemoryStore();
  const managers = {
    'workspace-manager': {
      async executeFenced(command, context) {
        assert.ok(context.fence > 0);
        assert.equal(context.assertCurrentFence(), true);
        return { applied: true, commandId: command.id, fence: context.fence };
      },
      async verify(command, context) {
        assert.equal(context.execution.applied, true);
        return {
          outcome: 'satisfied',
          verifier: 'fixture.verify',
          postcondition: { clean: true },
        };
      },
    },
  };
  return { registry, policy, store, managers };
}

test('allowed request emits one command and independently verified evidence', async () => {
  const fixture = buildFixture();
  const reconciler = createReconciler(fixture);
  const result = await reconciler.reconcileRequest(fixtureRequest());

  assert.equal(result.ok, true);
  assert.equal(result.status, 'satisfied');
  assert.equal(result.command.status, 'satisfied');
  assert.equal(result.evidence.outcome, 'satisfied');
  assert.match(result.command.lifecycle.map((entry) => entry.status).join(','), /lease_acquired,dispatching,executed,verifying,satisfied/);
});

test('equivalent allowed requests converge on the same action key without duplicate dispatch', async () => {
  const fixture = buildFixture();
  let dispatches = 0;
  fixture.managers['workspace-manager'].executeFenced = async () => {
    dispatches += 1;
    return { applied: true };
  };
  const reconciler = createReconciler(fixture);

  const first = await reconciler.reconcileRequest(fixtureRequest({ id: 'request-1', principal: { id: 'principal:one' } }));
  const second = await reconciler.reconcileRequest(fixtureRequest({ id: 'request-2', principal: { id: 'principal:two' } }));

  assert.equal(first.status, 'satisfied');
  assert.equal(second.status, 'deduped');
  assert.equal(first.command.actionKey, second.command.actionKey);
  assert.equal(dispatches, 1);
});

test('reconciler requires atomic action-key reservation from injected stores', () => {
  const fixture = buildFixture();
  delete fixture.store.putCommandIfAbsent;
  assert.throws(() => createReconciler(fixture), /putCommandIfAbsent is required/);
});

test('reconciler dispatching checkpoint merges phase without masking reattachment hints', async () => {
  const fixture = buildFixture();
  let seenCommand;
  fixture.managers['workspace-manager'].executeFenced = async (command, context) => {
    seenCommand = command;
    assert.ok(context.fence > 0);
    return { applied: true, commandId: command.id, fence: context.fence };
  };
  const reconciler = createReconciler(fixture);
  const reattachment = {
    branch: 'SUP-2214/existing',
    pr: 'https://example.test/pr/42',
    codeThread: { issueIdentifier: 'SUP-2214', branch: 'SUP-2214/existing' },
  };

  const result = await reconciler.reconcileRequest(fixtureRequest({
    id: 'request-reattach',
    commandSpec: {
      operation: 'cleanup-worktree',
      arguments: {
        pathToken: 'repo-1',
        resumeFrom: reattachment,
      },
      constraints: { reversible: true },
      lifecycle: { idempotent: true },
    },
  }));

  assert.equal(result.ok, true);
  assert.ok(seenCommand, 'executeFenced must observe the command');
  // Phase is updated, but branch/PR reattachment hints must survive.
  assert.equal(seenCommand.checkpoint.phase, 'dispatching');
  assert.equal(seenCommand.checkpoint.branch, 'SUP-2214/existing');
  assert.equal(seenCommand.checkpoint.pr, 'https://example.test/pr/42');
  assert.equal(seenCommand.checkpoint.codeThread.issueIdentifier, 'SUP-2214');
});

test('lifecycleTransition merges phase checkpoints onto existing reattachment hints', () => {
  const { lifecycleTransition, createCommand } = require('../src/index.js');
  const command = createCommand({
    requestId: 'req-1',
    managerId: 'workspace-manager',
    resource: { machineId: 'machine-a', type: 'git-repository', id: 'repo-1' },
    mutationClass: 'workspace.cleanup',
    desiredGeneration: 'desired-1',
    commandSpec: { operation: 'cleanup-worktree', arguments: {} },
    checkpoint: {
      branch: 'SUP-2214/existing',
      pr: 'https://example.test/pr/7',
      sessionId: 'session-reattach',
    },
  });

  const dispatched = lifecycleTransition(command, 'dispatching', {
    checkpoint: { phase: 'dispatching' },
  });

  assert.equal(dispatched.checkpoint.phase, 'dispatching');
  assert.equal(dispatched.checkpoint.branch, 'SUP-2214/existing');
  assert.equal(dispatched.checkpoint.pr, 'https://example.test/pr/7');
  assert.equal(dispatched.checkpoint.sessionId, 'session-reattach');
  // Lifecycle history records the phase patch as provided (not the merge).
  assert.deepEqual(dispatched.lifecycle.at(-1).checkpoint, { phase: 'dispatching' });
});

test('unavailable manager port releases the acquired lease', async () => {
  const fixture = buildFixture();
  delete fixture.managers['workspace-manager'];
  const result = await createReconciler(fixture).reconcileRequest(fixtureRequest());
  assert.equal(result.status, 'deferred');
  assert.equal(fixture.store.snapshot().leases.length, 0);
});

test('policy denial records a decision and never dispatches manager code', async () => {
  const fixture = buildFixture();
  let dispatches = 0;
  fixture.policy = createPolicyEngine({ denied: ['workspace.cleanup'] });
  fixture.managers['workspace-manager'].executeFenced = async () => {
    dispatches += 1;
    return { applied: true };
  };

  const result = await createReconciler(fixture).reconcileRequest(fixtureRequest());
  assert.equal(result.ok, false);
  assert.equal(result.status, 'deny');
  assert.equal(result.policyDecision.outcome, 'deny');
  assert.equal(dispatches, 0);
});

test('incompatible trusted manager version remains health-only and unable to mutate', async () => {
  const registry = createRegistry({ machineId: 'machine-a' });
  const registration = registry.registerManager({
    managerId: 'future-manager',
    contractVersion: '2.0.0',
    trust: { level: 'trusted' },
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
  });
  assert.equal(registration.status, 'incompatible');
  assert.equal(registration.executable, false);
  assert.match(registration.diagnostics.join('\n'), /compatible/);
});

test('conflicting mutation ownership fails registration as executable owner', () => {
  const registry = createRegistry({ machineId: 'machine-a' });
  const first = registry.registerManager({
    managerId: 'workspace-manager',
    trust: { level: 'trusted' },
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
    operationContract: { finalSideEffectFence: { required: true, mode: 'compare-and-set' } },
  });
  const second = registry.registerManager({
    managerId: 'release-manager',
    trust: { level: 'trusted' },
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
    operationContract: { finalSideEffectFence: { required: true, mode: 'compare-and-set' } },
  });

  assert.equal(first.status, 'active');
  assert.equal(second.status, 'conflict');
  assert.equal(second.executable, false);
  assert.equal(registry.listConflicts().length, 1);
});

test('untrusted plugin can be observed but cannot execute mutations', () => {
  const registry = createRegistry({ machineId: 'machine-a' });
  const registration = registry.registerManager({
    managerId: 'untrusted-plugin',
    trust: { level: 'data-only' },
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
  });

  assert.equal(registration.status, 'observation_only');
  assert.equal(registration.executable, false);
  assert.equal(registry.selectManager({ machineId: 'machine-a', type: 'git-repository', id: 'repo-1' }, 'workspace.cleanup').ok, false);
});

test('verifier failures become terminal and permit a later retry', async () => {
  const fixture = buildFixture();
  fixture.managers['workspace-manager'].verify = async () => { throw new Error('read path unavailable'); };
  const reconciler = createReconciler(fixture);
  const first = await reconciler.reconcileRequest(fixtureRequest({ id: 'verify-failure-1' }));
  assert.equal(first.status, 'unverifiable');
  fixture.managers['workspace-manager'].verify = async () => ({ outcome: 'satisfied' });
  const second = await reconciler.reconcileRequest(fixtureRequest({ id: 'verify-failure-2' }));
  assert.equal(second.status, 'satisfied');
});

test('invalid verifier output becomes terminal and releases the lease for retry', async () => {
  const fixture = buildFixture();
  fixture.managers['workspace-manager'].verify = async () => undefined;
  const reconciler = createReconciler(fixture);

  const first = await reconciler.reconcileRequest(fixtureRequest({ id: 'invalid-verifier-1' }));
  assert.equal(first.status, 'unverifiable');
  assert.equal(first.command.status, 'unverifiable');
  assert.equal(fixture.store.snapshot().leases.length, 0);

  fixture.managers['workspace-manager'].verify = async () => ({ outcome: 'satisfied' });
  const second = await reconciler.reconcileRequest(fixtureRequest({ id: 'invalid-verifier-2' }));
  assert.equal(second.status, 'satisfied');
});

test('a fence superseded during execution never transitions to executed', async () => {
  const fixture = buildFixture();
  fixture.managers['workspace-manager'].executeFenced = async (_command, context) => {
    fixture.store.releaseLease(context.lease);
    fixture.store.acquireLease({ key: context.lease.key, holder: 'new-holder', ttlMs: 60000 });
    return { applied: true };
  };

  const result = await createReconciler(fixture).reconcileRequest(fixtureRequest());
  assert.equal(result.status, 'failed');
  assert.equal(result.command.status, 'failed');
  assert.doesNotMatch(result.command.lifecycle.map((entry) => entry.status).join(','), /executed/);
});
