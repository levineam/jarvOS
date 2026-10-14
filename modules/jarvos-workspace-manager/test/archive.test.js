'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const workspace = require('../src');

const observation = {
  version: 'jarvos-workspace-manager.v1',
  repositoryId: 'repo-1', checkoutId: 'checkout-1', worktreeId: 'worktree-1',
  branchId: 'branch-1', candidateId: 'candidate-1', subjectIdentity: 'subject-1',
  observedAt: '2026-08-12T12:00:00.000Z', freshUntil: '2026-08-12T13:00:00.000Z',
  state: { clean: false, complete: true, protected: true },
};

test('metadata archive durably records a bounded disposition without a mutation port', async () => {
  const records = [];
  let dispatched = false;
  const archive = workspace.createMetadataArchive({ store: { append: async (record) => records.push(record) } });
  const result = await archive.archive({ observation, evidenceRef: 'evidence-1', archivedAt: '2026-08-12T12:10:00.000Z' });
  assert.equal(result.ok, true);
  assert.equal(result.mutationDispatched, false);
  assert.equal(records.length, 1);
  assert.equal(records[0].disposition, 'archived');
  assert.equal(records[0].mutationClass, null);
  assert.deepEqual(records[0].observation, observation);
  assert.equal(dispatched, false);
});

test('archive refuses mutation ports and rejects mutation-shaped requests', async () => {
  assert.throws(() => workspace.createMetadataArchive({ store: { append() {} }, gitMutationPort: {} }), /mutation ports/);
  const archive = workspace.createMetadataArchive({ store: { append() {} } });
  await assert.rejects(() => archive.archive({ observation, mutationPort: { execute() {} } }), /mutations/);
});

test('archive retains deterministic observation proof without private workspace details', () => {
  const record = workspace.createArchiveRecord({ observation, evidenceRef: 'evidence-1', archivedAt: '2026-08-12T12:10:00.000Z' });
  assert.match(record.observationDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'command'), false);
});
