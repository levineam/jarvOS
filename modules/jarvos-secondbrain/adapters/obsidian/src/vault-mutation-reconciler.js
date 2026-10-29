'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashUtf8, resolveVaultTarget } = require('./vault-mutation-contract');

// Stuck-operation resolution. An "ensure the journal exists" create has one
// intent: the day's journal is there. The storage adapter names these
// `journal-create-<date>-<uuid>`, and the link-to-journal path names them
// `<intent>:create`. Their create content is a snapshot of the journal at that
// moment, so once the journal is edited the exact-content readback can never
// match again and an ambiguous one blocks every later write to the same file.
const ENSURE_EXISTS_ID = /^journal-create-|:create$/;
const DEFAULT_JOURNAL_PATH = /^Journal\/\d{4}-\d{2}-\d{2}\.md$/;
const RESOLVABLE_STATUSES = new Set(['planned', 'unknown_after_dispatch', 'conflict', 'blocked']);
const STUCK_STATUSES = new Set(['unknown_after_dispatch', 'conflict']);
const TERMINAL_STATUSES = new Set(['acknowledged', 'superseded', 'abandoned']);
const ENSURE_EXISTS_RESOLUTION = 'ensure_exists_satisfied: target journal exists, create intent met';

function createVaultMutationReconciler({ adapter, ledger, vaultRoot, vaultId, journalPathPattern = DEFAULT_JOURNAL_PATH, transforms, fsImpl = fs, now = () => Date.now(), ownerId = crypto.randomUUID(), offlineSourceAllowlist = [], proveObsidianAbsent, exclusiveWriterCapability, offlineWriteCapability } = {}) {
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

  function isEnsureExistsCreate(operation) {
    return operation.operationKind === 'create'
      && typeof operation.content === 'string'
      && ENSURE_EXISTS_ID.test(operation.operationId)
      && journalPathPattern.test(operation.vaultRelativePath);
  }
  // Plans (and, unless dryRun, applies) the safe resolution of stuck ensure-exists
  // creates on journal paths. Rule, per (vault, path) queue in FIFO order:
  //   1. take the leading run of ensure-exists creates (create, journal path,
  //      ensure id, status planned|unknown_after_dispatch|conflict|blocked, no
  //      live dispatch claim);
  //   2. act only if the run contains a stuck op (unknown_after_dispatch or conflict);
  //   3. act only if the target is verified present by the adapter's read of the
  //      app's vault index (the source acknowledgement itself trusts); an absent
  //      or unreadable answer leaves everything untouched;
  //   4. then mark each op in the run `superseded` through the ledger's operator
  //      resolution, conditionally on its status not having changed.
  // Vault content is never compared, written, or deleted. Any other
  // head (transform, replace, delete, a create that is not an ensure) keeps the
  // strict reconcile rules and is only reported.
  function resolveSatisfiedEnsureCreates({ dryRun = false, operatorId = 'reconciler.ensure-exists' } = {}) {
    const summary = { dryRun: dryRun === true, resolved: [], skipped: [] };
    if (typeof vaultId !== 'string' || !vaultId) return { ...summary, skipped: [{ reason: 'vault_identity_unavailable' }] };
    if (typeof ledger.read !== 'function' || typeof ledger.resolve !== 'function') return { ...summary, skipped: [{ reason: 'ledger_resolution_unavailable' }] };
    const data = ledger.read();
    const queues = new Map();
    for (const record of Object.values(data.operations)) {
      const { operation } = record;
      if (operation.vaultId !== vaultId || !journalPathPattern.test(operation.vaultRelativePath) || TERMINAL_STATUSES.has(record.status)) continue;
      if (!queues.has(operation.vaultRelativePath)) queues.set(operation.vaultRelativePath, []);
      queues.get(operation.vaultRelativePath).push(record);
    }
    const describe = (record) => ({ operationId: record.operation.operationId, vaultRelativePath: record.operation.vaultRelativePath, sequence: record.operation.sequence, operationKind: record.operation.operationKind, status: record.status });
    for (const [vaultRelativePath, queue] of [...queues.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      queue.sort((a, b) => a.operation.sequence - b.operation.sequence);
      const claim = data.claims?.[`${vaultId}\0${vaultRelativePath}`];
      const claimed = (record) => Boolean(claim && claim.operationId === record.operation.operationId && claim.expiresAt > now());
      const run = [];
      for (const record of queue) {
        if (!isEnsureExistsCreate(record.operation) || !RESOLVABLE_STATUSES.has(record.status) || claimed(record)) break;
        run.push(record);
      }
      const head = queue[0];
      if (!run.length) {
        if (head.status !== 'planned') summary.skipped.push({ ...describe(head), reason: claimed(head) ? 'claim_active' : 'head_not_ensure_exists_create' });
        continue;
      }
      if (!run.some((record) => STUCK_STATUSES.has(record.status))) continue;
      const presence = typeof adapter.inspectFileExists === 'function' ? adapter.inspectFileExists(vaultRelativePath).status : 'unavailable';
      if (presence !== 'present') {
        summary.skipped.push({ ...describe(run[0]), reason: presence === 'absent' ? 'target_absent' : 'target_unverifiable' });
        continue;
      }
      for (const record of run) {
        if (dryRun) { summary.resolved.push({ ...describe(record), resolution: 'superseded' }); continue; }
        const done = ledger.resolve(operatorId, record.operation.operationId, 'superseded', ENSURE_EXISTS_RESOLUTION, { onlyIfStatus: [...RESOLVABLE_STATUSES] });
        if (!done) { summary.skipped.push({ ...describe(record), reason: 'changed_during_resolution' }); break; }
        summary.resolved.push({ ...describe(record), resolution: 'superseded' });
      }
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
  return Object.freeze({ drain, health, reconcileOne, resolveSatisfiedEnsureCreates, safeOfflineSave });
}

module.exports = { DEFAULT_JOURNAL_PATH, ENSURE_EXISTS_RESOLUTION, createVaultMutationReconciler };
