'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createApplicationService, createMemoryApplicationStore } = require('../src');

const PRINCIPALS = {
  codex: { id: 'principal:codex', capabilities: ['control-plane.read', 'control-plane.mutate'] },
  steward: { id: 'principal:steward', capabilities: ['control-plane.read', 'control-plane.approve'] },
};

function fixture(outcome = 'require_approval') {
  const store = createMemoryApplicationStore();
  const service = createApplicationService({
    store,
    policy: () => ({ outcome }),
    canRead: () => true,
    resolveCredential: (credential) => PRINCIPALS[credential] || null,
  });
  return { service, store };
}

function request(service, generation = '1', idempotencyKey = undefined) {
  return service.execute('createRequest', {
    credential: 'codex',
    idempotencyKey,
    actor: { kind: 'agent', id: 'codex' },
    resource: { machineId: 'machine:one', type: 'paperclip-issue', id: 'SUP-4029' },
    mutationClass: 'coding.take-issue-to-done',
    desiredGeneration: generation,
    commandSpec: { operation: 'take-issue-to-done', arguments: { issueIdentifier: 'SUP-4029', branch: 'SUP-4029/fixture' } },
  }).request;
}

test('approval-state discloses the execution binding only to the creating principal', () => {
  const { service } = fixture();
  const created = request(service);
  const pending = service.execute('approval-state', { credential: 'codex', requestId: created.id });
  assert.equal(pending.binding.status, 'approval_required');
  assert.equal(pending.binding.fence, 1);
  assert.equal(pending.binding.currentFence, 1);
  assert.equal(pending.binding.approvedAt, null);
  assert.deepEqual(pending.binding.commandSpec.arguments, { issueIdentifier: 'SUP-4029', branch: 'SUP-4029/fixture' });

  service.execute('approve', { credential: 'steward', requestId: created.id, fence: 1 });
  const approved = service.execute('approval-state', { credential: 'codex', requestId: created.id });
  assert.equal(approved.binding.status, 'approved');
  assert.equal(approved.binding.principalId, 'principal:codex');
  assert.equal(typeof approved.binding.approvedAt, 'string');
  assert.equal(approved.binding.paused, false);

  assert.equal(service.execute('approval-state', { credential: 'steward', requestId: created.id }).binding, null);
});

test('a superseding request advances the current fence seen through the binding', () => {
  const { service } = fixture();
  const first = request(service, '1');
  service.execute('approve', { credential: 'steward', requestId: first.id, fence: 1 });
  request(service, '1', 'superseding-request');
  // Same action key: the approved request is now behind the current fence.
  const binding = service.execute('approval-state', { credential: 'codex', requestId: first.id }).binding;
  assert.equal(binding.fence, 1);
  assert.equal(binding.currentFence >= 2, true);
});

test('redacting any binding input or its ancestor withholds the whole execution binding', () => {
  // Paths a caller can declare at creation; the contract validates they exist.
  const callerPaths = [
    'id', 'principal', 'principal.id',
    'resource', 'resource.id', 'resource.type', 'mutationClass', 'desiredGeneration',
    'commandSpec', 'commandSpec.operation', 'commandSpec.arguments', 'commandSpec.arguments.plan',
  ];
  // Fields the service adds after validation. Their rules are stamped on the
  // stored record through the existing store load/save, as a stored policy would.
  const serverPaths = ['status', 'actionKey', 'fence', 'approval', 'approval.fence', 'approval.usedAt', 'approval.actionKey'];
  for (const outcome of ['allow', 'require_approval']) {
    const intact = limitedCreator({ level: 'public' }, outcome);
    assert.notEqual(intact.binding, null, outcome);
    assert.equal(intact.binding.principalId, 'principal:limited', outcome);
    const rows = [
      ...callerPaths.map((fieldPath) => [fieldPath, { level: 'public', fields: [{ path: fieldPath, level: 'secret' }] }, []]),
      ...serverPaths.map((fieldPath) => [fieldPath, { level: 'public' }, [{ path: fieldPath, level: 'secret' }]]),
    ];
    for (const [fieldPath, sensitivity, storedFields] of rows) {
      if (outcome === 'allow' && fieldPath.startsWith('approval')) continue;
      const state = limitedCreator(sensitivity, outcome, storedFields);
      assert.equal(state.binding, null, `${outcome}: ${fieldPath}`);
      if (fieldPath.startsWith('principal')) assert.doesNotMatch(JSON.stringify(state), /principal:limited/, `${outcome}: ${fieldPath}`);
    }
  }
});

function limitedCreator(sensitivity, outcome = 'allow', storedFields = []) {
  const store = createMemoryApplicationStore();
  const service = createApplicationService({
    store,
    policy: () => ({ outcome }),
    canRead: () => true,
    resolveCredential: (credential) => credential === 'limited'
      ? { id: 'principal:limited', capabilities: ['control-plane.read', 'control-plane.mutate'], maxSensitivity: 'public' }
      : null,
  });
  const created = service.execute('createRequest', {
    credential: 'limited',
    actor: { kind: 'agent', id: 'codex' },
    resource: { machineId: 'machine:one', type: 'paperclip-issue', id: 'SUP-4029' },
    mutationClass: 'coding.accept-plan',
    desiredGeneration: '1',
    sensitivity,
    commandSpec: {
      operation: 'accept-plan',
      arguments: { issueIdentifier: 'SUP-4029', plan: { path: 'docs/plan.md', fixtureOnlySecret: 'SYNTHETIC-MARKER-4029' } },
    },
  });
  if (storedFields.length) {
    const state = store.load();
    const record = state.requests[0];
    record.sensitivity = { ...record.sensitivity, fields: [...(record.sensitivity.fields || []), ...storedFields] };
    store.save(state, state.revision);
  }
  // Read the id from the store: an `id` redaction hides it from the projection.
  return service.execute('approval-state', { credential: 'limited', requestId: store.load().requests[0].id });
}

test('a record redacted from the creator yields no execution binding and discloses nothing', () => {
  const state = limitedCreator({ level: 'secret' });
  assert.equal(state.request.redacted, true);
  assert.equal(state.binding, null);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC-MARKER-4029/);
});

test('a redacted command field yields no execution binding rather than an incomplete command', () => {
  const state = limitedCreator({
    level: 'public',
    fields: [{ path: 'commandSpec.arguments.plan.fixtureOnlySecret', level: 'secret' }],
  });
  assert.notEqual(state.request.redacted, true);
  assert.equal(state.binding, null);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC-MARKER-4029/);
});

test('a policy-allowed request carries its own fence without an approval record', () => {
  const { service } = fixture('allow');
  const created = request(service);
  const binding = service.execute('approval-state', { credential: 'codex', requestId: created.id }).binding;
  assert.equal(binding.status, 'approved');
  assert.equal(binding.approvalRequired, false);
  assert.equal(binding.fence, binding.currentFence);
});
