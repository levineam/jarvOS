'use strict';

// The ledger deliberately keeps the replay payload in its original operation.
// It is local operational evidence, never a public result.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateOperation } = require('./vault-mutation-contract');

const TERMINAL = new Set(['acknowledged', 'superseded', 'abandoned']);
const BLOCKING = new Set(['planned', 'local_mutating', 'local_applied', 'dispatched', 'unknown_after_dispatch', 'conflict', 'blocked']);
const STATES = new Set([...BLOCKING, ...TERMINAL, 'quarantined']);

function writeAtomic(filePath, value, fsImpl) {
  const directory = path.dirname(filePath);
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(directory, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    let fd;
    try { fd = fsImpl.openSync(temporary, 'r'); fsImpl.fsyncSync(fd); } catch { /* fsync unavailable in test doubles */ } finally { try { if (fd !== undefined) fsImpl.closeSync(fd); } catch {} }
    fsImpl.renameSync(temporary, filePath);
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
  } finally { try { fsImpl.unlinkSync(temporary); } catch {} }
}

function unsafeMode(stat) { return (stat.mode & 0o077) !== 0; }

function createVaultMutationLedger({ filePath, fsImpl = fs, now = () => Date.now(), leaseMs = 30_000, lockRetryMs = 5, lockAttempts = 100, retentionMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('ledger filePath must be absolute');
  const lockPath = `${filePath}.lock`;
  const quarantineDir = `${filePath}.quarantine`;
  const key = (operation) => `${operation.vaultId}\0${operation.vaultRelativePath}`;
  function pause(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  function lock() {
    const ownerId = crypto.randomUUID();
    for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
      try {
        fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        try { fsImpl.chmodSync(path.dirname(lockPath), 0o700); } catch {}
        const fd = fsImpl.openSync(lockPath, 'wx', 0o600);
        fsImpl.writeFileSync(fd, JSON.stringify({ ownerId, acquiredAt: now() }));
        return { fd, ownerId };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (now() - fsImpl.statSync(lockPath).mtimeMs > leaseMs) fsImpl.unlinkSync(lockPath); } catch {}
        pause(lockRetryMs);
      }
    }
    throw new Error('Timed out acquiring vault mutation ledger lock');
  }
  function transaction(fn) {
    const held = lock();
    try { return fn(); }
    finally {
      try { fsImpl.closeSync(held.fd); } catch {}
      try { if (JSON.parse(fsImpl.readFileSync(lockPath, 'utf8'))?.ownerId === held.ownerId) fsImpl.unlinkSync(lockPath); } catch {}
    }
  }
  function quarantineUnlocked(raw, reason) {
    fsImpl.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    try { fsImpl.chmodSync(quarantineDir, 0o700); } catch {}
    const file = path.join(quarantineDir, `${now()}-${crypto.randomUUID()}.json`);
    fsImpl.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, reason, quarantinedAt: now(), record: raw })}\n`, { mode: 0o600 });
    try { fsImpl.chmodSync(file, 0o600); } catch {}
  }
  function readUnlocked({ repair = false } = {}) {
    let data;
    try {
      const stat = fsImpl.statSync(filePath);
      if (unsafeMode(stat)) throw new Error('ledger permissions are unsafe');
      data = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, operations: {}, claims: {} };
      if (repair) { quarantineUnlocked({ rawLedger: true }, error.message); return { schemaVersion: 1, operations: {}, claims: {} }; }
      throw error;
    }
    if (data?.schemaVersion !== 1 || !data.operations || !data.claims || typeof data.operations !== 'object') {
      if (repair) { quarantineUnlocked(data, 'malformed_ledger'); return { schemaVersion: 1, operations: {}, claims: {} }; }
      throw new Error('Invalid vault mutation ledger');
    }
    let changed = false;
    for (const [id, record] of Object.entries(data.operations)) {
      try {
        if (!record || !STATES.has(record.status) || record.operation?.operationId !== id) throw new Error('malformed_record');
        validateOperation(record.operation);
      } catch (error) {
        if (!repair) throw error;
        quarantineUnlocked(record, error.message || 'malformed_record'); delete data.operations[id]; changed = true;
      }
    }
    if (repair && changed) writeAtomic(filePath, data, fsImpl);
    return data;
  }
  function ensureUnlocked(data, input) {
    const operation = validateOperation(input); const old = data.operations[operation.operationId];
    if (old && JSON.stringify(old.operation) !== JSON.stringify(operation)) throw new Error('operationId already belongs to a different mutation');
    const collision = Object.values(data.operations).find((entry) => entry.operation.operationId !== operation.operationId && key(entry.operation) === key(operation) && entry.operation.sequence === operation.sequence);
    if (collision) throw new Error('Duplicate same-file operation sequence');
    if (!old) data.operations[operation.operationId] = { operation, status: 'planned', createdAt: now(), updatedAt: now(), attempts: 0, history: [{ status: 'planned', at: now() }] };
    return data.operations[operation.operationId];
  }
  function recordTransition(record, status, evidence) {
    if (!STATES.has(status)) throw new Error('Invalid ledger transition');
    record.status = status; record.updatedAt = now();
    record.history = [...(record.history || []), { status, at: record.updatedAt, evidence }];
    if (evidence !== undefined) record.evidence = evidence;
  }
  function ensure(operation) { return transaction(() => { const data = readUnlocked({ repair: true }); const record = ensureUnlocked(data, operation); writeAtomic(filePath, data, fsImpl); return record; }); }
  function claim(operation, ownerId, { allowAmbiguousRetry = false, local = false } = {}) { return transaction(() => {
    if (!ownerId) throw new Error('claim ownerId is required');
    const data = readUnlocked({ repair: true }); const record = ensureUnlocked(data, operation); const claimKey = key(record.operation); const stamp = now();
    const prior = Object.values(data.operations).filter((entry) => key(entry.operation) === claimKey && entry.operation.sequence < record.operation.sequence && !TERMINAL.has(entry.status));
    if (prior.length) { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: prior.some((entry) => ['unknown_after_dispatch', 'conflict', 'quarantined'].includes(entry.status)) ? 'prior_operation_blocked' : 'prior_operation_pending', record }; }
    if (TERMINAL.has(record.status)) { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: record.status === 'acknowledged' ? 'already_acknowledged' : 'already_terminal', record }; }
    if (record.status === 'quarantined' || record.status === 'conflict' || (record.status === 'unknown_after_dispatch' && !allowAmbiguousRetry)) { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: 'operation_blocked', record }; }
    const existing = data.claims[claimKey];
    if (existing && existing.expiresAt > stamp) { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: 'claim_active', record }; }
    const fence = (existing?.fence || 0) + 1;
    data.claims[claimKey] = { operationId: record.operation.operationId, ownerId, fence, expiresAt: stamp + leaseMs };
    record.attempts += 1; recordTransition(record, local ? 'local_mutating' : 'dispatched'); writeAtomic(filePath, data, fsImpl);
    return { granted: true, fence, record };
  }); }
  function transition(operationId, status, { ownerId, fence, evidence } = {}) { return transaction(() => {
    if (!STATES.has(status)) throw new Error('Invalid ledger transition');
    const data = readUnlocked({ repair: true }); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); const claimKey = key(record.operation); const claim = data.claims[claimKey];
    if (!ownerId || !Number.isSafeInteger(fence) || !claim || claim.operationId !== operationId || claim.ownerId !== ownerId || claim.fence !== fence) throw new Error('Lost mutation claim ownership or fence');
    recordTransition(record, status, evidence); if (TERMINAL.has(status) || ['planned', 'conflict', 'quarantined', 'local_applied', 'unknown_after_dispatch'].includes(status)) delete data.claims[claimKey]; writeAtomic(filePath, data, fsImpl); return record;
  }); }
  function acknowledgeFromObsidianRead(operationId, receipt) { return transaction(() => {
    if (!receipt || receipt.acknowledgedBy !== 'app.vault.read' || receipt.invariant !== true) throw new Error('Obsidian readback invariant receipt is required');
    const data = readUnlocked({ repair: true }); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); recordTransition(record, 'acknowledged', receipt); delete data.claims[key(record.operation)]; writeAtomic(filePath, data, fsImpl); return record;
  }); }
  function quarantine(operationId, reason) { return transaction(() => { const data = readUnlocked({ repair: true }); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); quarantineUnlocked(record, reason); recordTransition(record, 'quarantined', { reason }); delete data.claims[key(record.operation)]; writeAtomic(filePath, data, fsImpl); return record; }); }
  function resolve(operatorId, operationId, status, reason) { if (!operatorId || !reason || !['superseded', 'abandoned'].includes(status)) throw new Error('operator, reason, and terminal resolution are required'); return transaction(() => { const data = readUnlocked({ repair: true }); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); recordTransition(record, status, { operatorId, reason }); delete data.claims[key(record.operation)]; writeAtomic(filePath, data, fsImpl); return record; }); }
  function read() { return transaction(() => readUnlocked({ repair: true })); }
  function active() { return Object.values(read().operations).filter((record) => !TERMINAL.has(record.status) && record.status !== 'quarantined').sort((a, b) => key(a.operation).localeCompare(key(b.operation)) || a.operation.sequence - b.operation.sequence); }
  function pruneRetained() { return transaction(() => { const data = readUnlocked({ repair: true }); for (const [id, record] of Object.entries(data.operations)) if (TERMINAL.has(record.status) && now() - record.updatedAt > retentionMs) delete data.operations[id]; writeAtomic(filePath, data, fsImpl); }); }
  return Object.freeze({ active, acknowledgeFromObsidianRead, claim, ensure, get: (id) => read().operations[id] || null, read, resolve, transition, quarantine, pruneRetained, filePath });
}
module.exports = { BLOCKING, STATES, TERMINAL, createVaultMutationLedger };
