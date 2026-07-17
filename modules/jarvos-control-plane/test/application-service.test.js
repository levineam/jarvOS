'use strict';

const assert = require('assert');
const test = require('node:test');
const { createApplicationService, createMemoryApplicationStore } = require('../src');

function fixture() {
  let time = Date.parse('2026-07-17T00:00:00.000Z');
  const store = createMemoryApplicationStore();
  const principals = {
    writer: { id: 'principal:writer', capabilities: ['control-plane.read', 'control-plane.mutate'], maxSensitivity: 'internal' },
    reader: { id: 'principal:reader', capabilities: ['control-plane.read'], maxSensitivity: 'internal' },
    private: { id: 'principal:private', capabilities: ['control-plane.read', 'control-plane.mutate'], maxSensitivity: 'private' },
  };
  const service = createApplicationService({ store, clock: () => time, resolveCredential: (credential) => principals[credential] || null });
  const request = (credential = 'writer', extra = {}) => service.execute('createRequest', {
    credential, principal: { id: 'principal:forged', capabilities: ['control-plane.mutate'] },
    actor: { kind: 'agent', harness: 'test' }, resource: { machineId: 'machine-a', type: 'repository', id: 'one' },
    mutationClass: 'workspace.cleanup', desiredGeneration: 'g1', commandSpec: { operation: 'dry-run' }, ...extra,
  });
  return { service, store, request, advance(ms) { time += ms; } };
}

test('credentials, not caller principal fields, establish authority', () => {
  const { request } = fixture();
  assert.throws(() => request('reader'), /mutation is not authorized/);
  const created = request();
  assert.equal(created.request.principal.id, 'principal:writer');
  assert.notEqual(created.request.principal.id, 'principal:forged');
});

test('approval is bound to action, required capability, expiry, and fence', () => {
  const { service, request, advance } = fixture();
  const created = request(); const fence = created.request.approval.fence;
  assert.throws(() => service.execute('approve', { credential: 'writer', requestId: created.request.id, fence: fence + 1 }), /stale|bound/);
  advance(300001);
  assert.throws(() => service.execute('approve', { credential: 'writer', requestId: created.request.id, fence }), /expired/);
});

test('approval cannot be replayed and stale concurrent mutation fences fail', () => {
  const { service, request } = fixture();
  const first = request();
  const approved = service.execute('approve', { credential: 'writer', requestId: first.request.id, fence: first.request.approval.fence });
  assert.equal(approved.request.status, 'approved');
  assert.throws(() => service.execute('approve', { credential: 'writer', requestId: first.request.id, fence: first.request.approval.fence }), /not awaiting approval/);
  const second = request();
  assert.throws(() => service.execute('mutate', { credential: 'writer', requestId: first.request.id, fence: first.request.approval.fence }), /stale fence/);
  assert.equal(second.request.approval.fence, 2);
});

test('list and inspect projections are capability and sensitivity filtered', () => {
  const { service, request, store } = fixture();
  const created = request('private', { sensitivity: { level: 'private' }, adapterExtensions: { privatePath: '/not/public' } });
  const listed = service.execute('list', { credential: 'reader' });
  assert.equal(listed.requests[0].redacted, true);
  const inspected = service.execute('inspect', { credential: 'private', requestId: created.request.id });
  assert.equal(inspected.request.redacted, undefined);
  assert.equal(inspected.request.adapterExtensions, undefined);
  assert.equal(store.load().requests[0].principal.id, 'principal:private');
});
