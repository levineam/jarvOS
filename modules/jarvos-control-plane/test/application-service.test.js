'use strict';

const assert = require('assert');
const test = require('node:test');
const { createApplicationService, createMemoryApplicationStore } = require('../src');

function fixture(options = {}) {
  let time = Date.parse('2026-07-17T00:00:00.000Z');
  const store = options.store || createMemoryApplicationStore();
  const principals = {
    writer: { id: 'principal:writer', capabilities: ['control-plane.read', 'control-plane.mutate'], maxSensitivity: 'internal' },
    approver: { id: 'principal:approver', capabilities: ['control-plane.read', 'control-plane.approve'], maxSensitivity: 'internal' },
    reader: { id: 'principal:reader', capabilities: ['control-plane.read'], maxSensitivity: 'internal' },
    private: { id: 'principal:private', capabilities: ['control-plane.read', 'control-plane.mutate'], maxSensitivity: 'private' },
  };
  const service = createApplicationService({
    store,
    clock: () => time,
    policy: options.policy,
    canRead: options.canRead || ((principal, record) => !record.principal || record.principal.id === principal.id),
    resolveCredential: (credential) => principals[credential] || null,
  });
  const request = (credential = 'writer', extra = {}) => service.execute('createRequest', {
    credential, principal: { id: 'principal:forged', capabilities: ['control-plane.approve'] },
    actor: { kind: 'agent', harness: 'test' }, resource: { machineId: 'machine-a', type: 'repository', id: 'one' },
    mutationClass: 'workspace.cleanup', desiredGeneration: 'g1', commandSpec: { operation: 'dry-run', arguments: { token: 'secret' } }, ...extra,
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

test('approval defaults to an independent approver and is bound to action, expiry, and keyed fence', () => {
  const { service, request, advance } = fixture();
  const created = request(); const fence = created.request.approval.fence;
  assert.equal(created.request.approval.requiredCapability, 'control-plane.approve');
  assert.throws(() => service.execute('approve', { credential: 'writer', requestId: created.request.id, fence }), /capability|creator/);
  assert.throws(() => service.execute('approve', { credential: 'approver', requestId: created.request.id, fence: fence + 1 }), /stale|bound/);
  advance(300001);
  assert.throws(() => service.execute('approve', { credential: 'approver', requestId: created.request.id, fence }), /expired/);
});

test('explicit policy delegation may permit creator approval', () => {
  const { service, request } = fixture({ policy: () => ({ outcome: 'require_approval', requiredCapability: 'control-plane.mutate', allowCreatorApproval: true }) });
  const created = request();
  assert.equal(service.execute('approve', { credential: 'writer', requestId: created.request.id, fence: created.request.approval.fence }).request.status, 'approved');
});

test('approval cannot replay and unrelated requests do not invalidate keyed approval freshness', () => {
  const { service, request } = fixture();
  const first = request();
  const unrelated = request('writer', { resource: { machineId: 'machine-a', type: 'repository', id: 'two' }, idempotencyKey: 'other' });
  assert.equal(unrelated.request.approval.fence, 1);
  const approved = service.execute('approve', { credential: 'approver', requestId: first.request.id, fence: first.request.approval.fence });
  assert.equal(approved.request.status, 'approved');
  assert.throws(() => service.execute('approve', { credential: 'approver', requestId: first.request.id, fence: first.request.approval.fence }), /not awaiting/);
});

test('same action key advances only its own fence and rejects stale approval', () => {
  const { service, request } = fixture();
  const first = request('writer', { idempotencyKey: 'first' });
  request('writer', { idempotencyKey: 'second' });
  assert.throws(() => service.execute('approve', { credential: 'approver', requestId: first.request.id, fence: first.request.approval.fence }), /stale|current action fence/);
});

test('createRequest is principal-scoped idempotent after authorization', () => {
  const { request, store } = fixture();
  const first = request('writer', { idempotencyKey: 'retry-1' });
  const retry = request('writer', { idempotencyKey: 'retry-1' });
  assert.equal(retry.deduped, true);
  assert.equal(retry.request.id, first.request.id);
  assert.equal(store.load().requests.length, 1);
});

test('read projections invoke canRead and structurally redact nested sensitive values and evidence', () => {
  const { service, request } = fixture({ canRead: (principal, record) => principal.id === record.principal.id });
  const created = request('writer', {
    sensitivity: { level: 'internal', fields: [{ path: 'commandSpec.arguments.token', level: 'secret' }] },
  });
  const inspected = service.execute('inspect', { credential: 'writer', requestId: created.request.id });
  assert.equal(inspected.request.commandSpec.arguments.token, undefined);
  assert.equal(inspected.evidence[0].detail, 'request accepted by authenticated application service');
  assert.throws(() => service.execute('inspect', { credential: 'reader', requestId: created.request.id }), /not authorized/);
  assert.equal(service.execute('list', { credential: 'reader' }).requests.length, 0);
});

test('application service has no mutation execution or terminal-status operation', () => {
  const { service, request, store } = fixture();
  const created = request();
  assert.throws(() => service.execute('mutate', { credential: 'writer', requestId: created.request.id }), /unknown operation/);
  assert.deepEqual(store.load().requests.map((item) => item.status), ['approval_required']);
});

test('revision compare-and-set rejects a stale application service write', () => {
  const store = createMemoryApplicationStore();
  const stale = store.load();
  const { request } = fixture({ store });
  request();
  assert.throws(() => store.save(stale, stale.revision), /concurrent state mutation/);
});
