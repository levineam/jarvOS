'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateOperation } = require('./vault-mutation-contract');

const TERMINAL = new Set(['acknowledged', 'superseded']);
const BLOCKING = new Set(['planned', 'dispatched', 'unknown_after_dispatch', 'conflict']);
const STATES = new Set(['planned', 'dispatched', 'unknown_after_dispatch', 'acknowledged', 'conflict', 'superseded']);

function writeAtomic(filePath, value, fsImpl) {
  const directory = path.dirname(filePath);
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(directory, 0o700); } catch { /* platform best effort */ }
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  try { fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fsImpl.renameSync(temporary, filePath); try { fsImpl.chmodSync(filePath, 0o600); } catch {} } finally { try { fsImpl.unlinkSync(temporary); } catch {} }
}

function createVaultMutationLedger({ filePath, fsImpl = fs, now = () => Date.now(), leaseMs = 30_000, lockRetryMs = 5, lockAttempts = 100 } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('ledger filePath must be absolute');
  const lockPath = `${filePath}.lock`;
  function pause(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  function lock() {
    const ownerId = crypto.randomUUID();
    for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
      try {
        fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
        const fd = fsImpl.openSync(lockPath, 'wx', 0o600); fsImpl.writeFileSync(fd, JSON.stringify({ ownerId, acquiredAt: now() })); return { fd, ownerId };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (now() - fsImpl.statSync(lockPath).mtimeMs > leaseMs) fsImpl.unlinkSync(lockPath); } catch {}
        pause(lockRetryMs);
      }
    }
    throw new Error('Timed out acquiring vault mutation ledger lock');
  }
  function transaction(fn) { const held = lock(); try { return fn(); } finally { try { fsImpl.closeSync(held.fd); } catch {} try { const current = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')); if (current?.ownerId === held.ownerId) fsImpl.unlinkSync(lockPath); } catch {} } }
  function readUnlocked() { try { const data = JSON.parse(fsImpl.readFileSync(filePath, 'utf8')); if (data?.schemaVersion !== 1 || !data.operations || !data.claims) throw new Error('Invalid vault mutation ledger'); return data; } catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, operations: {}, claims: {} }; throw error; } }
  const key = (operation) => `${operation.vaultId}\0${operation.vaultRelativePath}`;
  function ensureUnlocked(data, input) {
    const operation = validateOperation(input); const old = data.operations[operation.operationId];
    if (old && JSON.stringify(old.operation) !== JSON.stringify(operation)) throw new Error('operationId already belongs to a different mutation');
    const collision = Object.values(data.operations).find((entry) => entry.operation.operationId !== operation.operationId && key(entry.operation) === key(operation) && entry.operation.sequence === operation.sequence);
    if (collision) throw new Error('Duplicate same-file operation sequence');
    if (!old) data.operations[operation.operationId] = { operation, status: 'planned', createdAt: now(), updatedAt: now(), attempts: 0 };
    return data.operations[operation.operationId];
  }
  function ensure(operation) { return transaction(() => { const data = readUnlocked(); const record = ensureUnlocked(data, operation); writeAtomic(filePath, data, fsImpl); return record; }); }
  function claim(operation, ownerId) { return transaction(() => {
    if (!ownerId) throw new Error('claim ownerId is required'); const data = readUnlocked(); const record = ensureUnlocked(data, operation); const claimKey = key(record.operation); const stamp = now();
    const prior = Object.values(data.operations).filter((entry) => key(entry.operation) === claimKey && entry.operation.sequence < record.operation.sequence && !TERMINAL.has(entry.status));
    if (prior.length) { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: prior.some((entry) => ['unknown_after_dispatch', 'conflict'].includes(entry.status)) ? 'prior_operation_blocked' : 'prior_operation_pending', record }; }
    if (record.status === 'acknowledged') { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: 'already_acknowledged', record }; }
    if (record.status === 'superseded') { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: 'already_terminal', record }; }
    if (['unknown_after_dispatch', 'conflict'].includes(record.status)) { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: 'operation_blocked', record }; }
    const existing = data.claims[claimKey];
    if (existing && existing.expiresAt > stamp) { writeAtomic(filePath, data, fsImpl); return { granted: false, reason: 'claim_active', record }; }
    const fence = (existing?.fence || 0) + 1; data.claims[claimKey] = { operationId: record.operation.operationId, ownerId, fence, expiresAt: stamp + leaseMs }; record.status = 'dispatched'; record.attempts += 1; record.updatedAt = stamp; writeAtomic(filePath, data, fsImpl); return { granted: true, fence, record };
  }); }
  function transition(operationId, status, { ownerId, fence, evidence } = {}) { return transaction(() => {
    if (!STATES.has(status)) throw new Error('Invalid ledger transition');
    const data = readUnlocked(); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); const claimKey = key(record.operation); const claim = data.claims[claimKey];
    if (!ownerId || !Number.isSafeInteger(fence) || !claim || claim.operationId !== operationId || claim.ownerId !== ownerId || claim.fence !== fence) throw new Error('Lost mutation claim ownership or fence');
    record.status = status; record.updatedAt = now(); if (evidence !== undefined) record.evidence = evidence; if (TERMINAL.has(status) || status === 'conflict') delete data.claims[claimKey]; writeAtomic(filePath, data, fsImpl); return record;
  }); }
  return Object.freeze({ claim, ensure, get: (id) => readUnlocked().operations[id] || null, read: readUnlocked, transition, filePath });
}
module.exports = { BLOCKING, STATES, TERMINAL, createVaultMutationLedger };
