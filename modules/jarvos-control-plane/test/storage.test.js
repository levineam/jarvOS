'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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

test('file store recovers from an orphaned stale lock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-stale-lock-'));
  try {
    const lockPath = path.join(tmp, 'state.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' }));
    const staleAt = new Date(Date.now() - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const result = createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 1000 })
      .acquireLease({ key: 'recoverable-lock', holder: 'command-1' });

    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store serializes leases across independent processes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-process-store-'));
  const modulePath = path.resolve(__dirname, '../src/index.js');
  const script = `const {createFileStore}=require(process.argv[1]); const r=createFileStore(process.argv[2]).acquireLease({key:'shared',holder:process.argv[3]}); process.stdout.write(JSON.stringify(r));`;
  try {
    const run = (holder) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, modulePath, tmp, holder]); let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`child exited ${code}`)));
    });
    const results = await Promise.all([run('process-a'), run('process-b')]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok)[0].reason, 'lease_conflict');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store replays durable frames and ignores only a torn final frame', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-recovery-'));
  try {
    const store = createFileStore(tmp);
    const lease = store.acquireLease({ key: 'recoverable', holder: 'command-1' });
    fs.appendFileSync(path.join(tmp, 'journal.ndjson'), '{"sequence":999');
    const reopened = createFileStore(tmp);
    assert.equal(reopened.snapshot().leases[0].id, lease.lease.id);
    fs.appendFileSync(path.join(tmp, 'journal.ndjson'), '\n{"sequence":999}\n');
    assert.throws(() => createFileStore(tmp).snapshot(), /(Corrupt|Invalid) journal/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
