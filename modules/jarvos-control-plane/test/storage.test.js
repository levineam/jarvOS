'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  createEvidence,
  createFileStore,
  createMemoryStore,
} = require('../src/index.js');

test('memory store allocates monotonic fences per mutation key', () => {
  const store = createMemoryStore();
  assert.equal(store.allocateFence('machine-a:repo:1:cleanup'), 1);
  assert.equal(store.allocateFence('machine-a:repo:1:cleanup'), 2);
  assert.equal(store.allocateFence('machine-a:repo:2:cleanup'), 1);
});

test('store rejects stale evidence after a newer fence is acquired', () => {
  const store = createMemoryStore();
  const first = store.acquireLease({ key: 'resource:cleanup', holder: 'command-1', ttlMs: -1 });
  const second = store.acquireLease({ key: 'resource:cleanup', holder: 'command-2' });
  const evidence = createEvidence({
    commandId: 'command-1',
    managerId: 'workspace-manager',
    outcome: 'satisfied',
    data: { stale: true },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const result = store.commitEvidence(first.lease, evidence);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_fence');
});

test('file store writes canonical state and journal after interruption-safe updates', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-store-'));
  try {
    const store = createFileStore(tmp);
    const lease = store.acquireLease({ key: 'resource:cleanup', holder: 'command-1' });
    assert.equal(lease.ok, true);

    const state = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
    const journal = fs.readFileSync(path.join(tmp, 'journal.ndjson'), 'utf8').trim().split('\n');
    assert.equal(state.leases.length, 1);
    assert.equal(journal.length, 2);
    assert.match(journal[0], /fence\.allocate|lease\.acquire/);

    const reopened = createFileStore(tmp);
    const recovered = reopened.snapshot();
    assert.equal(recovered.leases.length, 1);
    assert.equal(recovered.leases[0].id, lease.lease.id);
    assert.equal(recovered.journal.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
