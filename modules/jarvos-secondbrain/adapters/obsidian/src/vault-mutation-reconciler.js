'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashUtf8, resolveVaultTarget } = require('./vault-mutation-contract');

function createVaultMutationReconciler({ adapter, ledger, vaultRoot, transforms, fsImpl = fs, now = () => Date.now(), ownerId = crypto.randomUUID(), offlineSourceAllowlist = [], proveObsidianAbsent, exclusiveWriterCapability, offlineWriteCapability } = {}) {
  if (!ledger || typeof ledger.active !== 'function') throw new Error('ledger is required');
  if (!adapter || typeof adapter.execute !== 'function') throw new Error('adapter is required');
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be absolute');
  function safeOfflineSave(operation, capability) {
    // These are host-owned capabilities, never booleans accepted from callers.
    if (!offlineWriteCapability || capability !== offlineWriteCapability || (offlineSourceAllowlist.length > 0 && !offlineSourceAllowlist.includes(operation.source)) || typeof proveObsidianAbsent !== 'function' || proveObsidianAbsent(operation) !== true) return { status: 'unavailable', persistence: 'durable', localMutation: 'queued' };
    ledger.ensure(operation);
    const claim = ledger.claim(operation, ownerId, { local: true });
    if (!claim.granted) return { status: 'blocked', reason: claim.reason };
    let target;
    try {
      target = resolveVaultTarget({ vaultRoot, vaultRelativePath: operation.vaultRelativePath, fsImpl });
      if (operation.operationKind === 'create') {
        if (typeof operation.content !== 'string') throw new Error('create content is required');
        fsImpl.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        // Re-resolve immediately before the write so a parent swap cannot redirect it.
        if (resolveVaultTarget({ vaultRoot, vaultRelativePath: operation.vaultRelativePath, fsImpl }) !== target) throw new Error('vault target changed during local mutation');
        const fd = fsImpl.openSync(target, 'wx', 0o600);
        try { fsImpl.writeFileSync(fd, operation.content, 'utf8'); try { fsImpl.fsyncSync(fd); } catch {} } finally { fsImpl.closeSync(fd); }
      } else if (operation.operationKind === 'replace' && typeof exclusiveWriterCapability === 'function' && exclusiveWriterCapability(operation) === true) {
        const current = fsImpl.readFileSync(target, 'utf8');
        if (!operation.expectedHash || hashUtf8(current) !== operation.expectedHash) {
          ledger.transition(operation.operationId, 'conflict', { ownerId, fence: claim.fence, evidence: { errorClass: 'expected_hash_mismatch' } });
          return { status: 'conflict' };
        }
        if (resolveVaultTarget({ vaultRoot, vaultRelativePath: operation.vaultRelativePath, fsImpl }) !== target) throw new Error('vault target changed during local mutation');
        const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${operation.operationId}.tmp`);
        fsImpl.writeFileSync(temporary, operation.content, { mode: 0o600 }); fsImpl.renameSync(temporary, target);
      } else {
        ledger.transition(operation.operationId, 'planned', { ownerId, fence: claim.fence, evidence: { localMutation: 'disabled_without_exclusive_writer' } });
        return { status: 'unavailable', persistence: 'durable', localMutation: 'not_written' };
      }
      ledger.transition(operation.operationId, 'local_applied', { ownerId, fence: claim.fence, evidence: { localHash: hashUtf8(operation.content) } });
      return { status: 'saved_locally_sync_pending', persistence: 'pending', localMutation: 'applied' };
    } catch (error) {
      try { ledger.transition(operation.operationId, 'conflict', { ownerId, fence: claim.fence, evidence: { errorClass: error.code === 'EEXIST' ? 'create_collision' : 'local_mutation_failed' } }); } catch {}
      return { status: 'conflict', errorClass: error.code === 'EEXIST' ? 'create_collision' : 'local_mutation_failed' };
    }
  }
  function reconcileOne(record) {
    const { operation } = record;
    // Lack of a composed registry is an unavailable dependency, not grounds to
    // destroy a retained replay payload. Only an explicit registry rejection
    // can quarantine it.
    if (operation.operationKind === 'transform') {
      if (!transforms) return 'blocked';
      if (transforms.quarantine(operation)) { ledger.quarantine(operation.operationId, 'unknown_transform_or_replay_payload'); return 'quarantined'; }
    }
    if (typeof adapter.acknowledgeIfSatisfied === 'function' && adapter.acknowledgeIfSatisfied(operation)) return 'acknowledged';
    if (record.status === 'unknown_after_dispatch') return 'blocked'; // ambiguity may not be retried until app readback proves the invariant
    if (record.status === 'local_mutating') return 'blocked'; // crash boundary: no automatic disk retry
    if (record.status === 'conflict' || record.status === 'quarantined') return 'blocked';
    const result = adapter.execute(operation, { excludeOperationId: operation.operationId });
    return result.status === 'committed' || result.status === 'already_satisfied' ? 'acknowledged' : result.status;
  }
  function drain({ limit = 8, timeMs = 1_000, excludeOperationId } = {}) {
    const started = now(); const summary = { processed: 0, acknowledged: 0, conflicts: 0, blocked: 0, quarantined: 0, pending: 0 };
    const heads = new Set();
    for (const record of ledger.active()) {
      if (summary.processed >= limit || now() - started >= timeMs) break;
      if (record.operation.operationId === excludeOperationId) continue;
      const fileKey = `${record.operation.vaultId}\0${record.operation.vaultRelativePath}`;
      if (heads.has(fileKey)) continue; heads.add(fileKey);
      const result = reconcileOne(record); summary.processed += 1;
      if (result === 'acknowledged') summary.acknowledged += 1;
      else if (result === 'conflict') summary.conflicts += 1;
      else if (result === 'quarantined') summary.quarantined += 1;
      else if (result === 'blocked') summary.blocked += 1;
      else summary.pending += 1;
    }
    return summary;
  }
  function health() {
    const counts = { pending: 0, ambiguous: 0, conflict: 0, quarantined: 0, retainedTerminal: 0 };
    for (const record of Object.values(ledger.read().operations)) {
      if (record.status === 'unknown_after_dispatch') counts.ambiguous += 1;
      else if (record.status === 'conflict') counts.conflict += 1;
      else if (record.status === 'quarantined') counts.quarantined += 1;
      else if (['acknowledged', 'superseded', 'abandoned'].includes(record.status)) counts.retainedTerminal += 1;
      else counts.pending += 1;
    }
    return counts;
  }
  return Object.freeze({ drain, health, reconcileOne, safeOfflineSave });
}

module.exports = { createVaultMutationReconciler };
