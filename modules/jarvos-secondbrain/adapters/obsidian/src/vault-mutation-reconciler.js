'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashUtf8, resolveVaultTarget } = require('./vault-mutation-contract');

function invariantSatisfied(operation, content, transforms) {
  if (operation.operationKind === 'create') return typeof operation.content === 'string' && content === operation.content;
  if (operation.operationKind === 'replace') return typeof operation.content === 'string' && content === operation.content;
  return Boolean(transforms && transforms.isSatisfied(content, operation));
}

function createVaultMutationReconciler({ adapter, ledger, vaultRoot, transforms, fsImpl = fs, now = () => Date.now(), ownerId = crypto.randomUUID(), offlineSourceAllowlist = [], proveObsidianAbsent, exclusiveWriterCapability } = {}) {
  if (!ledger || typeof ledger.active !== 'function') throw new Error('ledger is required');
  if (!adapter || typeof adapter.execute !== 'function') throw new Error('adapter is required');
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be absolute');
  function safeOfflineSave(operation) {
    ledger.ensure(operation);
    // These are host-owned capabilities, never booleans accepted from callers.
    if (!offlineSourceAllowlist.includes(operation.source) || typeof proveObsidianAbsent !== 'function' || proveObsidianAbsent(operation) !== true) return { status: 'unavailable', persistence: 'durable', localMutation: 'queued' };
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
    const inspection = adapter.inspectInvariant(operation);
    if (inspection.status === 'satisfied' && inspection.invariant === true) {
      ledger.acknowledgeFromObsidianRead(operation.operationId, { acknowledgedBy: 'app.vault.read', invariant: true });
      return 'acknowledged';
    }
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
  return Object.freeze({ drain, reconcileOne, safeOfflineSave });
}

module.exports = { createVaultMutationReconciler, invariantSatisfied };
