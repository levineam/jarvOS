'use strict';

const path = require('node:path');

const HASH_RE = /^[a-f0-9]{64}$/i;

function normalizePrivateSyncSample(raw, { vaultRelativePath } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { capability: 'incompatible' };
  if (raw.capability && raw.capability !== 'available') return { capability: raw.capability };
  if (raw.syncEnabled === false) return { capability: 'disabled', vaultId: raw.vaultId };
  const file = raw.files?.[vaultRelativePath] || raw.file;
  if (!file || ![file.contentHash, file.localTrackedHash, file.remoteTrackedHash].every((value) => HASH_RE.test(String(value || '')))) {
    return { capability: 'incompatible', vaultId: raw.vaultId };
  }
  return {
    capability: 'available',
    vaultId: raw.vaultId,
    contentHash: file.contentHash.toLowerCase(),
    localTrackedHash: file.localTrackedHash.toLowerCase(),
    remoteTrackedHash: file.remoteTrackedHash.toLowerCase(),
  };
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Obsidian exposes no supported per-file Sync convergence API. This optional
// adapter is the only module allowed to parse host-provided private Sync state.
// It is read-only, disabled by default, and projects only bounded status.
function createObsidianSyncInspector({
  vaultId,
  vaultRelativePath,
  readPrivateSyncState,
  enabled = process.env.JARVOS_ENABLE_PRIVATE_SYNC_INSPECTOR === '1',
  maxAttempts = 12,
  maxDurationMs = 180_000,
  pollIntervalMs = 15_000,
  requiredStableSamples = 2,
  now = () => Date.now(),
  sleep = sleepSync,
} = {}) {
  if (typeof vaultId !== 'string' || !vaultId) throw new Error('vaultId is required');
  if (typeof vaultRelativePath !== 'string' || path.posix.normalize(vaultRelativePath) !== vaultRelativePath || vaultRelativePath.startsWith('../')) throw new Error('vaultRelativePath must be normalized');
  if (typeof readPrivateSyncState !== 'function') throw new Error('readPrivateSyncState is required');
  const attemptsLimit = Math.max(1, Math.min(12, Number(maxAttempts) || 12));
  const durationLimit = Math.max(1, Math.min(180_000, Number(maxDurationMs) || 180_000));
  const stableRequired = Math.max(2, Number(requiredStableSamples) || 2);

  function inspect({ expectedHash } = {}) {
    if (!enabled) return { status: 'unknown', reason: 'inspector_disabled', attempts: 0 };
    if (!HASH_RE.test(String(expectedHash || ''))) throw new Error('expectedHash must be SHA-256');
    const expected = expectedHash.toLowerCase();
    const startedAt = now();
    let attempts = 0;
    let stableSamples = 0;
    let trackedMismatch = false;

    while (attempts < attemptsLimit && now() - startedAt < durationLimit) {
      attempts += 1;
      let raw;
      try { raw = readPrivateSyncState({ vaultId, vaultRelativePath }); } catch { return { status: 'unknown', reason: 'inspection_unavailable', attempts }; }
      const sample = normalizePrivateSyncSample(raw, { vaultRelativePath });
      if (sample.capability === 'disabled') return { status: 'unknown', reason: 'sync_disabled', attempts };
      if (sample.capability !== 'available') return { status: 'unknown', reason: 'private_shape_incompatible', attempts };
      if (sample.vaultId !== vaultId) return { status: 'unknown', reason: 'wrong_vault', attempts };
      if (sample.contentHash !== expected) return { status: 'diverged', reason: 'local_content_mismatch', attempts };

      if (sample.localTrackedHash === expected && sample.remoteTrackedHash === expected) {
        stableSamples += 1;
        if (stableSamples >= stableRequired) return { status: 'converged', reason: 'two_stable_samples', attempts };
      } else {
        stableSamples = 0;
        trackedMismatch = true;
      }

      if (attempts < attemptsLimit) {
        const remaining = durationLimit - (now() - startedAt);
        if (remaining <= 0) break;
        sleep(Math.min(pollIntervalMs, remaining));
      }
    }

    if (trackedMismatch) return { status: 'diverged', reason: 'tracked_hash_mismatch', attempts };
    return { status: 'pending', reason: 'stable_sample_incomplete', attempts };
  }

  return Object.freeze({ inspect });
}

module.exports = { createObsidianSyncInspector, normalizePrivateSyncSample };
