'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createObsidianSyncInspector } = require('../adapters/obsidian/src/obsidian-sync-inspector');

const expected = 'a'.repeat(64);
const stale = 'b'.repeat(64);
const target = 'Notes/Incident.md';

function inspector(samples, options = {}) {
  let index = 0;
  let clock = 0;
  return createObsidianSyncInspector({
    vaultId: 'vault-a',
    vaultRelativePath: target,
    enabled: true,
    maxAttempts: samples.length,
    pollIntervalMs: 1,
    now: () => clock,
    sleep: (ms) => { clock += ms; },
    readPrivateSyncState: () => samples[Math.min(index++, samples.length - 1)],
    ...options,
  });
}

function sample({ contentHash = expected, localTrackedHash = expected, remoteTrackedHash = expected, vaultId = 'vault-a', syncEnabled = true, globalStatus = 'fully-synced' } = {}) {
  return { capability: 'available', vaultId, syncEnabled, globalStatus, files: { [target]: { contentHash, localTrackedHash, remoteTrackedHash } } };
}

test('newer disk bytes with stale tracked hashes are diverged even when the global UI says fully synced', () => {
  const result = inspector([sample({ localTrackedHash: stale, remoteTrackedHash: stale })]).inspect({ expectedHash: expected });
  assert.deepEqual(result, { status: 'diverged', reason: 'tracked_hash_mismatch', attempts: 1 });
});

test('convergence requires two consecutive agreeing samples', () => {
  const result = inspector([sample(), sample()]).inspect({ expectedHash: expected });
  assert.deepEqual(result, { status: 'converged', reason: 'two_stable_samples', attempts: 2 });
  assert.equal(inspector([sample()]).inspect({ expectedHash: expected }).status, 'pending');
});

test('missing fields, disabled Sync, and wrong vault return unknown without mutation', () => {
  assert.equal(inspector([{ capability: 'available', vaultId: 'vault-a', files: {} }]).inspect({ expectedHash: expected }).reason, 'private_shape_incompatible');
  assert.equal(inspector([sample({ syncEnabled: false })]).inspect({ expectedHash: expected }).reason, 'sync_disabled');
  assert.equal(inspector([sample({ vaultId: 'vault-b' })]).inspect({ expectedHash: expected }).reason, 'wrong_vault');
});

test('private reader failures and local content mismatches are classified explicitly', () => {
  const unavailable = createObsidianSyncInspector({
    vaultId: 'vault-a',
    vaultRelativePath: target,
    enabled: true,
    readPrivateSyncState: () => { throw new Error('private API changed'); },
  }).inspect({ expectedHash: expected });
  assert.deepEqual(unavailable, { status: 'unknown', reason: 'inspection_unavailable', attempts: 1 });
  assert.deepEqual(inspector([sample({ contentHash: stale })]).inspect({ expectedHash: expected }), {
    status: 'diverged', reason: 'local_content_mismatch', attempts: 1,
  });
});

test('attempt and time budgets stop polling deterministically', () => {
  let reads = 0;
  let clock = 0;
  const bounded = createObsidianSyncInspector({
    vaultId: 'vault-a',
    vaultRelativePath: target,
    enabled: true,
    maxAttempts: 12,
    maxDurationMs: 3,
    pollIntervalMs: 2,
    now: () => clock,
    sleep: (ms) => { clock += ms; },
    readPrivateSyncState: () => { reads += 1; return sample({ localTrackedHash: stale, remoteTrackedHash: stale }); },
  });
  const result = bounded.inspect({ expectedHash: expected });
  assert.equal(result.status, 'diverged');
  assert.ok(reads <= 2);
});

test('kill switch defaults to disabled', () => {
  let reads = 0;
  const disabled = createObsidianSyncInspector({ vaultId: 'vault-a', vaultRelativePath: target, readPrivateSyncState: () => { reads += 1; return sample(); } });
  assert.deepEqual(disabled.inspect({ expectedHash: expected }), { status: 'unknown', reason: 'inspector_disabled', attempts: 0 });
  assert.equal(reads, 0);
});
