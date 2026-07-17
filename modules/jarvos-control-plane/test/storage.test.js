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

test('stale-lock recovery never unlinks a fresh lock installed after takeover', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-lock-race-'));
  const lockPath = path.join(tmp, 'state.lock');
  const originalRename = fs.renameSync;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, createdAt: '2000-01-01T00:00:00.000Z' }));
    const staleAt = new Date(Date.now() - 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);
    let installedFreshLock = false;
    fs.renameSync = (from, to) => {
      const result = originalRename(from, to);
      if (from === lockPath && String(to).startsWith(`${lockPath}.takeover-`) && !installedFreshLock) {
        installedFreshLock = true;
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'fresh-owner' }));
      }
      return result;
    };

    assert.throws(
      () => createFileStore(tmp, { staleLockMs: 10, lockTimeoutMs: 20 }).acquireLease({ key: 'race', holder: 'contender' }),
      /Timed out acquiring file store lock/
    );
    assert.equal(installedFreshLock, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'fresh-owner');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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

test('file store truncates a torn tail before a later mutation is appended', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-torn-tail-'));
  try {
    const store = createFileStore(tmp);
    store.putRecord({ id: 'old-record', type: 'request' });
    fs.appendFileSync(path.join(tmp, 'journal.ndjson'), '{"sequence":999');

    createFileStore(tmp).putRecord({ id: 'new-record', type: 'request' });
    const reopened = createFileStore(tmp).snapshot();
    assert.ok(reopened.records.some((record) => record.id === 'old-record'));
    assert.ok(reopened.records.some((record) => record.id === 'new-record'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store checkpoints the journal without losing records or evidence', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-checkpoint-'));
  try {
    const store = createFileStore(tmp, { checkpointEntries: 2 });
    store.putRecord({ id: 'record-a', type: 'request' });
    store.putRecord({ id: 'evidence-a', type: 'evidence', digest: 'durable-digest' });
    assert.equal(fs.readFileSync(path.join(tmp, 'journal.ndjson'), 'utf8'), '');

    const reopened = createFileStore(tmp).snapshot();
    assert.deepEqual(reopened.records.map((record) => record.id).sort(), ['evidence-a', 'record-a']);
    assert.equal(reopened.records.find((record) => record.id === 'evidence-a').digest, 'durable-digest');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store fails closed when a compacted checkpoint is missing or corrupt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-checkpoint-corrupt-'));
  try {
    const store = createFileStore(tmp, { checkpointEntries: 1 });
    store.putRecord({ id: 'record-a', type: 'request' });
    fs.writeFileSync(path.join(tmp, 'state.json'), '{not-json');
    assert.throws(() => createFileStore(tmp).snapshot(), /Corrupt state checkpoint/);

    fs.rmSync(path.join(tmp, 'state.json'));
    assert.throws(() => createFileStore(tmp).snapshot(), /Missing state checkpoint/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('file store accepts a committed journal mutation when state snapshot persistence fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-state-failure-'));
  const warnings = [];
  try {
    const store = createFileStore(tmp, { logger: { warn: (message) => warnings.push(message) } });
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === path.join(tmp, 'state.json')) throw new Error('simulated snapshot failure');
      return originalRename(from, to);
    };
    try {
      const lease = store.acquireLease({ key: 'journal-survives', holder: 'command-1' });
      assert.equal(lease.ok, true);
    } finally { fs.renameSync = originalRename; }

    const reopened = createFileStore(tmp);
    assert.equal(reopened.snapshot().leases.length, 1);
    assert.match(warnings[0], /State snapshot persistence failed/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
