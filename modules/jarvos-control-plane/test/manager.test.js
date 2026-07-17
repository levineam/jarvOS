'use strict';

const assert = require('assert');
const test = require('node:test');
const { createApplicationService, createMemoryApplicationStore } = require('../src');
const { createControlPlaneService, normalizeOperation, verifyHostService } = require('../scripts/jarvos-manager.js');

function fixture() {
  const applicationService = createApplicationService({
    store: createMemoryApplicationStore(),
    resolveCredential: (credential) => credential === 'writer'
      ? { id: 'principal:writer', capabilities: ['control-plane.read', 'control-plane.mutate', 'control-plane.approve'] }
      : null,
    canRead: () => true,
    policy: () => ({ outcome: 'require_approval', allowCreatorApproval: true }),
  });
  return createControlPlaneService({ applicationService });
}

test('manager delegates human aliases to the trusted application service', () => {
  const manager = fixture();
  const created = manager.execute('request', {
    credential: 'writer', actor: { kind: 'human' }, resource: { machineId: 'machine-a', type: 'workspace', id: 'one' },
    mutationClass: 'workspace.test', desiredGeneration: '1', commandSpec: { operation: 'test' },
  });
  assert.equal(created.request.principal.id, 'principal:writer');
  assert.equal(created.request.status, 'approval_required');
  const approved = manager.execute('approve', { credential: 'writer', requestId: created.request.id, fence: created.request.approval.fence });
  assert.equal(approved.request.status, 'approved');
});

test('manager has no adapter-owned lifecycle or configuration escape hatch', () => {
  const manager = fixture();
  assert.throws(() => manager.execute('pause', { credential: 'writer' }), /unsupported public control-plane operation/);
  assert.throws(() => normalizeOperation('cancel'), /unsupported public control-plane operation/);
  assert.throws(() => createControlPlaneService(), /host service is not configured/);
});

test('host-service readiness verification is boolean and does not disclose configuration', () => {
  assert.deepEqual(verifyHostService(), { ok: false });
  assert.deepEqual(verifyHostService(__filename), { ok: false });
});
