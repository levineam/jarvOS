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
      finalSideEffectFence: { required: true },
      verifier: { authoritativeReadPath: 'fixture-current-state' },
    },
  });
  const policy = createPolicyEngine({ allowlist: ['git-repository:workspace.cleanup'] });
  const store = createMemoryStore();
  const managers = {
    'workspace-manager': {
      async execute(command, context) {
        assert.ok(context.fence > 0);
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
  fixture.managers['workspace-manager'].execute = async () => {
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

test('policy denial records a decision and never dispatches manager code', async () => {
  const fixture = buildFixture();
  let dispatches = 0;
  fixture.policy = createPolicyEngine({ denied: ['workspace.cleanup'] });
  fixture.managers['workspace-manager'].execute = async () => {
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
  });
  const second = registry.registerManager({
    managerId: 'release-manager',
    trust: { level: 'trusted' },
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
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
