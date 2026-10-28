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
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
// Existing ledger state that cannot be read or validated is uncertain evidence.
// It is preserved byte for byte and refused; it is never reset, deleted or
// quarantined to let a caller proceed. The message never includes ledger bytes.
function ledgerUncertain(reason) {
  const error = new Error(`vault mutation ledger state is uncertain: ${reason}`);
  error.code = 'vault_mutation_ledger_uncertain';
  return error;
}

// Stages of one identified capture share an identity family. The first request
// planned for any stage binds the whole family to its hash, vault and source.
const CAPTURE_STAGE = /^(capture:.+):(?:note|journal:create|journal:section)$/;
const REQUEST_HASH = /^[a-f0-9]{64}$/;
function captureFamilyId(operationId) {
  const match = CAPTURE_STAGE.exec(String(operationId || ''));
  return match ? match[1] : null;
}
function captureConflict(message) {
  const error = new Error(message);
  error.code = 'capture_identity_request_conflict';
  return error;
}
function validCaptureBinding(binding) {
  return Boolean(binding) && typeof binding === 'object' && !Array.isArray(binding)
    && typeof binding.requestHash === 'string' && REQUEST_HASH.test(binding.requestHash)
    && typeof binding.vaultId === 'string' && Boolean(binding.vaultId)
    && typeof binding.source === 'string' && Boolean(binding.source);
}
function sameCaptureBinding(left, right) {
  return left.requestHash === right.requestHash && left.vaultId === right.vaultId && left.source === right.source;
}

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
  // The single shared read for every public path. Only a ledger file that the
  // initial stat reports missing is a new store. Once stat succeeds, any read
  // failure (including ENOENT), unsafe mode, bad JSON, wrong schema or core
  // maps, or any malformed record is refused before any caller can plan,
  // claim, prune or replay.
  function readUnlocked() {
    let stat;
    try {
      stat = fsImpl.statSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, operations: {}, claims: {}, sequences: {} };
      throw ledgerUncertain('unreadable');
    }
    if (unsafeMode(stat)) throw ledgerUncertain('unsafe_permissions');
    let text;
    try { text = fsImpl.readFileSync(filePath, 'utf8'); } catch { throw ledgerUncertain('unreadable'); }
    let data;
    try { data = JSON.parse(text); } catch { throw ledgerUncertain('unparseable'); }
    if (!isPlainObject(data) || data.schemaVersion !== 1 || !isPlainObject(data.operations) || !isPlainObject(data.claims)) {
      throw ledgerUncertain('malformed_ledger');
    }
    if (data.sequences === undefined) data.sequences = {};
    else if (!isPlainObject(data.sequences)) throw ledgerUncertain('malformed_sequences');
    for (const [id, record] of Object.entries(data.operations)) {
      let valid = false;
      try {
        valid = isPlainObject(record) && STATES.has(record.status) && record.operation?.operationId === id && Boolean(validateOperation(record.operation));
      } catch { valid = false; }
      if (!valid) throw ledgerUncertain('malformed_record');
    }
    return data;
  }
  function ensureUnlocked(data, input) {
    const operation = validateOperation(input); const old = data.operations[operation.operationId];
    if (old && JSON.stringify(old.operation) !== JSON.stringify(operation)) throw new Error('operationId already belongs to a different mutation');
    const collision = Object.values(data.operations).find((entry) => entry.operation.operationId !== operation.operationId && key(entry.operation) === key(operation) && entry.operation.sequence === operation.sequence);
    if (collision) throw new Error('Duplicate same-file operation sequence');
    // Every admission path (planNext, ensure, claim) passes here inside its own
    // transaction, for new and existing records alike, so the family binding is
    // enforced before any claim or effect.
    const bindingCreated = admitCaptureFamilyUnlocked(data, operation);
    const created = !old;
    if (created) data.operations[operation.operationId] = { operation, status: 'planned', createdAt: now(), updatedAt: now(), attempts: 0, history: [{ status: 'planned', at: now() }] };
    return { record: data.operations[operation.operationId], created, changed: created || bindingCreated };
  }
  // The family's current binding: a valid map entry and every family record
  // (including an exact stored one) must agree on hash, vault and source.
  // Anything malformed, missing or inconsistent is held, never repaired.
  function captureFamilyBindingUnlocked(data, family) {
    const map = data.captureRequests;
    if (map !== undefined && !isPlainObject(map)) throw captureConflict('capture request bindings are malformed');
    const entry = map ? map[family] : undefined;
    if (entry !== undefined && !validCaptureBinding(entry)) throw captureConflict('capture request binding is malformed');
    let bound = entry;
    for (const record of Object.values(data.operations)) {
      if (captureFamilyId(record.operation.operationId) !== family) continue;
      const earlier = { requestHash: record.operation.captureRequestHash, vaultId: record.operation.vaultId, source: record.operation.source };
      if (!validCaptureBinding(earlier)) throw captureConflict('capture identity has an uncertain earlier request');
      if (bound && !sameCaptureBinding(bound, earlier)) throw captureConflict('capture identity has inconsistent earlier requests');
      bound = bound || earlier;
    }
    return { bound, entry };
  }
  // Runs inside the caller's transaction, so concurrent first admissions of
  // different stages serialize on the ledger lock and the first request wins.
  // Reserved family IDs are matched whether or not they carry a hash. The
  // ledger is left unchanged on refusal; the map is replaced only after all
  // checks pass.
  function admitCaptureFamilyUnlocked(data, operation) {
    const family = captureFamilyId(operation.operationId);
    if (!family) return false;
    const requested = { requestHash: operation.captureRequestHash, vaultId: operation.vaultId, source: operation.source };
    if (!validCaptureBinding(requested)) throw captureConflict('capture request is missing a valid hash, vault or source');
    const { bound, entry } = captureFamilyBindingUnlocked(data, family);
    if (bound && !sameCaptureBinding(bound, requested)) throw captureConflict('capture identity is already bound to a different request');
    if (entry !== undefined) return false;
    data.captureRequests = { ...(data.captureRequests || {}), [family]: { ...requested, boundAt: now() } };
    return true;
  }
  function recordTransition(record, status, evidence) {
    if (!STATES.has(status)) throw new Error('Invalid ledger transition');
    record.status = status; record.updatedAt = now();
    record.history ||= [];
    record.history.push({ status, at: record.updatedAt, evidence });
    if (evidence !== undefined) record.evidence = evidence;
  }
  function ensure(operation) { return transaction(() => { const data = readUnlocked(); const { record, changed } = ensureUnlocked(data, operation); if (changed) writeAtomic(filePath, data, fsImpl); return record; }); }
  // Allocate the FIFO sequence and persist the complete operation in one
  // transaction. Callers may use any positive placeholder sequence; an
  // existing operationId keeps its original durable sequence on retry.
  function planNext(input) { return transaction(() => {
    const candidate = validateOperation(input);
    const data = readUnlocked();
    const bindingCreated = admitCaptureFamilyUnlocked(data, candidate);
    const existing = data.operations[candidate.operationId];
    if (existing) {
      const retried = validateOperation({ ...candidate, sequence: existing.operation.sequence });
      if (JSON.stringify(existing.operation) !== JSON.stringify(retried)) throw new Error('operationId already belongs to a different mutation');
      if (bindingCreated) writeAtomic(filePath, data, fsImpl);
      return existing;
    }
    const sequenceKey = key(candidate);
    const observed = Object.values(data.operations)
      .filter((record) => key(record.operation) === sequenceKey)
      .reduce((maximum, record) => Math.max(maximum, record.operation.sequence), 0);
    const sequence = Math.max(Number(data.sequences[sequenceKey]) || 0, observed) + 1;
    const operation = validateOperation({ ...candidate, sequence });
    data.sequences[sequenceKey] = sequence;
    const { record } = ensureUnlocked(data, operation);
    writeAtomic(filePath, data, fsImpl);
    return record;
  }); }
  function nextSequence(vaultId, vaultRelativePath) { return transaction(() => {
    if (typeof vaultId !== 'string' || !vaultId || typeof vaultRelativePath !== 'string' || !vaultRelativePath) throw new Error('vaultId and vaultRelativePath are required');
    const data = readUnlocked();
    const sequenceKey = `${vaultId}\0${vaultRelativePath}`;
    const observed = Object.values(data.operations)
      .filter((record) => key(record.operation) === sequenceKey)
      .reduce((maximum, record) => Math.max(maximum, record.operation.sequence), 0);
    const sequence = Math.max(Number(data.sequences[sequenceKey]) || 0, observed) + 1;
    data.sequences[sequenceKey] = sequence;
    writeAtomic(filePath, data, fsImpl);
    return sequence;
  }); }
  function claim(operation, ownerId, { allowAmbiguousRetry = false, local = false } = {}) { return transaction(() => {
    if (!ownerId) throw new Error('claim ownerId is required');
    const data = readUnlocked(); const ensured = ensureUnlocked(data, operation); const { record, changed } = ensured; const claimKey = key(record.operation); const stamp = now();
    const persistCreated = () => { if (changed) writeAtomic(filePath, data, fsImpl); };
    const prior = Object.values(data.operations).filter((entry) => key(entry.operation) === claimKey && entry.operation.sequence < record.operation.sequence && !TERMINAL.has(entry.status));
    if (prior.length) { persistCreated(); return { granted: false, reason: prior.some((entry) => ['unknown_after_dispatch', 'conflict', 'quarantined'].includes(entry.status)) ? 'prior_operation_blocked' : 'prior_operation_pending', record }; }
    if (TERMINAL.has(record.status)) { persistCreated(); return { granted: false, reason: record.status === 'acknowledged' ? 'already_acknowledged' : 'already_terminal', record }; }
    if (record.status === 'quarantined' || record.status === 'conflict' || (record.status === 'unknown_after_dispatch' && !allowAmbiguousRetry)) { persistCreated(); return { granted: false, reason: 'operation_blocked', record }; }
    const existing = data.claims[claimKey];
    if (existing && existing.expiresAt > stamp) { persistCreated(); return { granted: false, reason: 'claim_active', record }; }
    const fence = (existing?.fence || 0) + 1;
    data.claims[claimKey] = { operationId: record.operation.operationId, ownerId, fence, expiresAt: stamp + leaseMs };
    record.attempts += 1; recordTransition(record, local ? 'local_mutating' : 'dispatched'); writeAtomic(filePath, data, fsImpl);
    return { granted: true, fence, record };
  }); }
  function transition(operationId, status, { ownerId, fence, evidence } = {}) { return transaction(() => {
    if (!STATES.has(status)) throw new Error('Invalid ledger transition');
    const data = readUnlocked(); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); const claimKey = key(record.operation); const claim = data.claims[claimKey];
    if (!ownerId || !Number.isSafeInteger(fence) || !claim || claim.operationId !== operationId || claim.ownerId !== ownerId || claim.fence !== fence) throw new Error('Lost mutation claim ownership or fence');
    recordTransition(record, status, evidence); if (TERMINAL.has(status) || ['planned', 'conflict', 'quarantined', 'local_applied', 'unknown_after_dispatch'].includes(status)) delete data.claims[claimKey]; writeAtomic(filePath, data, fsImpl); return record;
  }); }
  function quarantine(operationId, reason) { return transaction(() => { const data = readUnlocked(); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); quarantineUnlocked(record, reason); recordTransition(record, 'quarantined', { reason }); delete data.claims[key(record.operation)]; writeAtomic(filePath, data, fsImpl); return record; }); }
  function resolve(operatorId, operationId, status, reason) { if (!operatorId || !reason || !['superseded', 'abandoned'].includes(status)) throw new Error('operator, reason, and terminal resolution are required'); return transaction(() => { const data = readUnlocked(); const record = data.operations[operationId]; if (!record) throw new Error('Unknown operationId'); recordTransition(record, status, { operatorId, reason }); delete data.claims[key(record.operation)]; writeAtomic(filePath, data, fsImpl); return record; }); }
  function read() { return transaction(() => readUnlocked()); }
  function active() { return Object.values(read().operations).filter((record) => !TERMINAL.has(record.status) && record.status !== 'quarantined').sort((a, b) => key(a.operation).localeCompare(key(b.operation)) || a.operation.sequence - b.operation.sequence); }
  // Before any expired terminal capture record is deleted, its complete family
  // binding is derived from every retained sibling and persisted in the same
  // write. An uncertain or inconsistent family refuses the whole prune, so no
  // record is deleted before its family is safely bound. Non-terminal states,
  // including unknown_after_dispatch, are never pruned.
  function pruneRetained() { return transaction(() => {
    const data = readUnlocked();
    const expired = Object.entries(data.operations)
      .filter(([, record]) => TERMINAL.has(record.status) && now() - record.updatedAt > retentionMs)
      .map(([id]) => id);
    if (!expired.length) return;
    const additions = {};
    for (const family of new Set(expired.map((id) => captureFamilyId(id)).filter(Boolean))) {
      const { bound, entry } = captureFamilyBindingUnlocked(data, family);
      if (entry === undefined) additions[family] = { requestHash: bound.requestHash, vaultId: bound.vaultId, source: bound.source, boundAt: now() };
    }
    if (Object.keys(additions).length) data.captureRequests = { ...(data.captureRequests || {}), ...additions };
    for (const id of expired) delete data.operations[id];
    writeAtomic(filePath, data, fsImpl);
  }); }
  return Object.freeze({ active, claim, ensure, get: (id) => read().operations[id] || null, nextSequence, planNext, read, resolve, transition, quarantine, pruneRetained, filePath });
}
module.exports = { BLOCKING, STATES, TERMINAL, createVaultMutationLedger };
