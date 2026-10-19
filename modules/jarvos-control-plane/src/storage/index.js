'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const { clone, digest, stableStringify } = require('../contracts');

function nowIso() { return new Date().toISOString(); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
function isExpired(lease, now = nowIso()) {
  return lease && lease.expiresAt && new Date(lease.expiresAt).getTime() <= new Date(now).getTime();
}

function createMemoryStore(options = {}) {
  const journal = [];
  const records = new Map();
  const commandsByActionKey = new Map();
  const leases = new Map();
  const fences = new Map();
  const now = options.now || nowIso;
  if (options.initialState) {
    for (const entry of options.initialState.journal || []) journal.push(clone(entry));
    for (const record of options.initialState.records || []) {
      records.set(record.id, clone(record));
      if (record.type === 'command') commandsByActionKey.set(record.actionKey, record.id);
    }
    for (const lease of options.initialState.leases || []) leases.set(lease.key, clone(lease));
    for (const [key, value] of Object.entries(options.initialState.fences || {})) fences.set(key, value);
  }
  function append(type, payload) {
    const entry = { sequence: journal.length + 1, type, at: now(), payload: clone(payload) };
    entry.digest = digest({ sequence: entry.sequence, type: entry.type, at: entry.at, payload: entry.payload });
    journal.push(entry); return clone(entry);
  }
  function putRecord(record) {
    records.set(record.id, clone(record));
    if (record.type === 'command') commandsByActionKey.set(record.actionKey, record.id);
    append('record.put', record); return clone(record);
  }
  function getRecord(id) { return clone(records.get(id) || null); }
  function getCommandByActionKey(actionKey) { const id = commandsByActionKey.get(actionKey); return id ? getRecord(id) : null; }
  function putCommandIfAbsent(command) {
    const existing = getCommandByActionKey(command.actionKey);
    if (existing && !['failed', 'unverifiable', 'expired'].includes(existing.status)) return { inserted: false, command: existing };
    putRecord(command); return { inserted: true, command: clone(command), replaced: Boolean(existing) };
  }
  function allocateFence(key) { const next = (fences.get(key) || 0) + 1; fences.set(key, next); append('fence.allocate', { key, fence: next }); return next; }
  function acquireLease(input = {}) {
    if (!input.key) throw new Error('lease key is required');
    const current = leases.get(input.key);
    if (current && !isExpired(current, now()) && current.holder !== input.holder) {
      const conflict = { ok: false, reason: 'lease_conflict', holder: current.holder, leaseId: current.id, expiresAt: current.expiresAt, key: input.key };
      append('lease.conflict', conflict); return conflict;
    }
    const fence = allocateFence(input.key);
    const lease = { id: input.id || digest({ key: input.key, holder: input.holder, fence, at: now() }), key: input.key, holder: input.holder, fence,
      acquiredAt: now(), expiresAt: input.expiresAt || new Date(Date.now() + (input.ttlMs || 60000)).toISOString(), metadata: input.metadata || {} };
    leases.set(input.key, lease); append('lease.acquire', lease); return { ok: true, lease: clone(lease) };
  }
  function assertLeaseCurrent(lease) {
    const current = leases.get(lease.key);
    return Boolean(current && current.id === lease.id && current.fence === lease.fence && !isExpired(current, now()));
  }
  function releaseLease(lease) {
    const current = leases.get(lease.key);
    if (!current || current.id !== lease.id || current.fence !== lease.fence) return false;
    leases.delete(lease.key); append('lease.release', { key: lease.key, leaseId: lease.id, fence: lease.fence }); return true;
  }
  function commitEvidence(lease, record) {
    if (!assertLeaseCurrent(lease)) {
      const current = leases.get(lease.key);
      const result = { ok: false, reason: 'stale_fence', key: lease.key, expectedFence: current && current.fence, providedFence: lease.fence };
      append('evidence.rejected', result); return result;
    }
    putRecord(record); append('evidence.commit', { leaseId: lease.id, recordId: record.id }); return { ok: true, record: clone(record) };
  }
  function snapshot() { return { journal: clone(journal), records: [...records.values()].map(clone), leases: [...leases.values()].map(clone), fences: Object.fromEntries(fences) }; }
  return { append, putRecord, putCommandIfAbsent, getRecord, getCommandByActionKey, acquireLease, allocateFence, assertLeaseCurrent, releaseLease, commitEvidence, snapshot };
}

function parseJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return { entries: [], tornTailOffset: null };
  const text = fs.readFileSync(journalPath, 'utf8');
  const lines = text.split('\n');
  const entries = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextOffset = offset + Buffer.byteLength(line, 'utf8') + (index < lines.length - 1 ? 1 : 0);
    if (!line) { offset = nextOffset; continue; }
    let entry;
    try { entry = JSON.parse(line); } catch (error) {
      if (index === lines.length - 1) return { entries, tornTailOffset: offset };
      throw new Error(`Corrupt journal entry ${index + 1}: ${error.message}`);
    }
    if (entry.sequence !== entries.length + 1 || entry.digest !== digest({ sequence: entry.sequence, type: entry.type, at: entry.at, payload: entry.payload })) {
      throw new Error(`Invalid journal frame ${index + 1}`);
    }
    entries.push(entry);
    offset = nextOffset;
  }
  return { entries, tornTailOffset: null };
}

function replayJournal(entries, initialState = {}) {
  const state = { journal: entries, records: [], leases: [], fences: {} };
  const records = new Map(); const leases = new Map(); const fences = new Map();
  for (const record of initialState.records || []) records.set(record.id, record);
  for (const lease of initialState.leases || []) leases.set(lease.key, lease);
  for (const [key, value] of Object.entries(initialState.fences || {})) fences.set(key, value);
  for (const entry of entries) {
    if (entry.type === 'record.put') records.set(entry.payload.id, entry.payload);
    if (entry.type === 'lease.acquire') leases.set(entry.payload.key, entry.payload);
    if (entry.type === 'lease.release') leases.delete(entry.payload.key);
    if (entry.type === 'fence.allocate') fences.set(entry.payload.key, entry.payload.fence);
  }
  state.records = [...records.values()]; state.leases = [...leases.values()]; state.fences = Object.fromEntries(fences); return state;
}

function createFileStore(rootDir, options = {}) {
  if (!rootDir) throw new Error('rootDir is required'); ensureDir(rootDir);
  const statePath = path.join(rootDir, 'state.json'); const journalPath = path.join(rootDir, 'journal.ndjson'); const lockPath = path.join(rootDir, 'state.lock');
  const checkpointMarkerPath = path.join(rootDir, 'journal.checkpointed');
  const retryMs = options.lockRetryMs ?? 10;
  const staleLockMs = options.staleLockMs ?? 100;
  const checkpointEntries = options.checkpointEntries ?? 128;
  function processStartMarker(pid) {
    try {
      // Linux exposes a process-start tick that makes recycled PIDs distinguishable.
      return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ')[21] || null;
    } catch (_) {
      try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null; } catch (_) { return null; }
    }
  }
  let ownProcessStart;
  function ownProcessStartMarker() {
    if (ownProcessStart === undefined) ownProcessStart = processStartMarker(process.pid);
    return ownProcessStart;
  }
  function lockOwnerIsRunning(lock) {
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return false;
    try {
      process.kill(lock.pid, 0);
      if (!lock.processStart) return true;
      const marker = processStartMarker(lock.pid);
      return !marker || marker === lock.processStart;
    } catch (error) { return error.code === 'EPERM'; }
  }
  function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
  // Lock protocol (cooperative parties only):
  // - acquire: write the COMPLETE owner record into a private per-attempt staging
  //   file (`${lockPath}.stage-<pid>-<uuid>`, 0600, fsynced), then publish it with
  //   an atomic no-overwrite hard link at lockPath (EEXIST while any lock exists).
  //   lockPath therefore never exposes empty/partial owner metadata, so a writer
  //   preempted while preparing its record cannot look like a stale malformed
  //   lock. The owner enters only after verifying lockPath is its staging inode,
  //   then removes only its own staging name. An unsupported link primitive fails
  //   closed (no check-then-rename fallback). Recovery examines lockPath only;
  //   staging names are never selected, scanned or removed by anyone else;
  // - release: the owner unlinks lockPath only while it still names its own
  //   inode; nobody else can remove a live owner's lock, so the path cannot be
  //   replaced between that check and the unlink;
  // - recovery: lockPath is never renamed. A candidate qualified as dead-and-stale
  //   is removed only by the holder of the exclusive recovery gate, after it
  //   re-verifies (under the gate) that lockPath is still that exact pinned inode
  //   and still dead-and-stale. While the dead candidate occupies lockPath no
  //   acquirer can install a new lock, so unlinking it cannot remove a live owner.
  // A gate left by a crashed recoverer is never guessed about or removed
  // automatically; stale recovery then fails closed until an operator reconciles
  // it (normal acquisition with no stale lock present is unaffected).
  const recoveryGatePath = `${lockPath}.recover`;
  function readLockOwner(fd) {
    let lock = {};
    try {
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(size);
      const length = size ? fs.readSync(fd, buffer, 0, size, 0) : 0;
      const text = buffer.toString('utf8', 0, length);
      if (text) lock = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return lock && typeof lock === 'object' ? lock : {};
  }
  // A matching process-start marker proves a live owner; a recycled PID fails the
  // comparison and is recoverable once stale. Malformed/empty content is
  // recoverable only once it is stale.
  function isDeadAndStale(fd) {
    const ageMs = Date.now() - fs.fstatSync(fd).mtimeMs;
    return !lockOwnerIsRunning(readLockOwner(fd)) && ageMs >= staleLockMs;
  }
  function releaseRecoveryGate(gateFd) {
    try {
      let owned = false;
      try {
        owned = sameFile(fs.fstatSync(gateFd), fs.statSync(recoveryGatePath));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (owned) fs.unlinkSync(recoveryGatePath);
    } finally {
      fs.closeSync(gateFd);
    }
  }
  function recoverStaleLock() {
    let observed;
    try {
      observed = fs.statSync(lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    let candidateFd;
    try {
      candidateFd = fs.openSync(lockPath, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    try {
      // Holding candidateFd open pins the inode, so its dev/ino cannot be reused
      // by a replacement while this function runs.
      const pinned = fs.fstatSync(candidateFd);
      if (!sameFile(observed, pinned) || !isDeadAndStale(candidateFd)) return false;
      let gateFd;
      try {
        gateFd = fs.openSync(recoveryGatePath, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') return false; // another recoverer (or a crashed one) owns recovery
        throw error;
      }
      try {
        try { fs.writeSync(gateFd, JSON.stringify({ pid: process.pid, createdAt: nowIso() })); } catch (_) { /* diagnostic only */ }
        // Re-qualify while holding the gate: a lagging recoverer whose candidate
        // was already removed (and possibly replaced by a live owner) stops here.
        let current;
        try {
          current = fs.statSync(lockPath);
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
        if (!sameFile(current, pinned) || !isDeadAndStale(candidateFd)) return false;
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
        return true;
      } finally {
        releaseRecoveryGate(gateFd);
      }
    } finally {
      fs.closeSync(candidateFd);
    }
  }
  function lockTimeoutError() {
    let gatePresent = false;
    try { fs.lstatSync(recoveryGatePath); gatePresent = true; } catch (_) { /* absent or unreadable */ }
    // Constant messages: no store path or raw cause is disclosed.
    return gatePresent
      ? safeLockError('FILE_STORE_RECOVERY_GATE_HELD', 'Timed out acquiring file store lock: the store\'s stale-lock recovery gate is present; it is never removed automatically and a crashed recoverer requires operator reconciliation')
      : safeLockError('FILE_STORE_LOCK_TIMEOUT', 'Timed out acquiring file store lock');
  }
  function safeLockError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  // Link failures meaning "this filesystem cannot publish atomically by hard link".
  const UNSUPPORTED_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);
  function publicationUnsupportedError() {
    return safeLockError('FILE_STORE_LOCK_PUBLICATION_UNSUPPORTED', 'File store lock publication requires an atomic no-overwrite hard link, which this filesystem refused; no lock was taken and the store was not modified');
  }
  function publicationFailedError() {
    return safeLockError('FILE_STORE_LOCK_PUBLICATION_FAILED', 'File store lock publication failed; no lock was taken and the store was not modified');
  }
  // Best effort: removes this attempt's own staging name only while it still
  // names the staging inode. Never throws (no raw path-bearing errors); a name it
  // cannot remove is a bounded, never-selected leftover.
  function removeOwnStaging(stagingFd, stagingPath) {
    try {
      if (sameFile(fs.fstatSync(stagingFd), fs.lstatSync(stagingPath))) fs.unlinkSync(stagingPath);
    } catch (_) { /* absent or not ours: leave it */ }
  }
  // Unlinks lockPath only if it still names this exact inode; a replacement is
  // never removed (see protocol above for why no gap exists cooperatively).
  function releaseOwnedLock(fd) {
    try {
      let owned = false;
      try {
        owned = sameFile(fs.fstatSync(fd), fs.statSync(lockPath));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (owned) {
        try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  function withLock(fn) {
    // Resolved before the deadline starts (the first lookup may spawn `ps`).
    const processStart = ownProcessStartMarker();
    let fd; const deadline = Date.now() + (options.lockTimeoutMs || 5000);
    while (fd === undefined) {
      const stagingPath = `${lockPath}.stage-${process.pid}-${randomUUID()}`;
      const ownerRecord = JSON.stringify({ pid: process.pid, processStart, token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: nowIso() });
      let stagingFd;
      try {
        stagingFd = fs.openSync(stagingPath, 'wx', 0o600);
      } catch (_) {
        throw publicationFailedError();
      }
      let owned = false;
      let linked = false;
      let linkError = null;
      try {
        fs.writeFileSync(stagingFd, ownerRecord, 'utf8');
        fs.fsyncSync(stagingFd);
        try {
          fs.linkSync(stagingPath, lockPath); // atomic, never overwrites
          linked = true;
        } catch (error) {
          linkError = error;
        }
        if (linked) {
          // Enter only while lockPath is this attempt's own complete inode.
          try { owned = sameFile(fs.fstatSync(stagingFd), fs.statSync(lockPath)); } catch (_) { owned = false; }
          if (!owned) {
            // Not verifiable: withdraw only if lockPath is still our inode.
            try { if (sameFile(fs.fstatSync(stagingFd), fs.statSync(lockPath))) fs.unlinkSync(lockPath); } catch (_) { /* not ours or gone */ }
          }
        }
      } finally {
        removeOwnStaging(stagingFd, stagingPath);
        if (!owned) fs.closeSync(stagingFd);
      }
      if (owned) { fd = stagingFd; break; }
      if (linked) throw publicationFailedError();
      if (linkError.code === 'EEXIST') {
        if (Date.now() >= deadline) throw lockTimeoutError();
        if (!recoverStaleLock()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
        continue;
      }
      throw UNSUPPORTED_LINK_CODES.has(linkError.code) ? publicationUnsupportedError() : publicationFailedError();
    }
    // fd is the staging fd, i.e. the published inode: release stays keyed to it.
    try { return fn(); } finally { releaseOwnedLock(fd); }
  }
  function load() {
    const hasCheckpoint = fs.existsSync(statePath);
    let checkpoint = options.initialState || {};
    if (hasCheckpoint) {
      try { checkpoint = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (error) { throw new Error(`Corrupt state checkpoint: ${error.message}`); }
    }
    const parsed = parseJournal(journalPath);
    const journalExists = fs.existsSync(journalPath);
    const journalSize = journalExists ? fs.statSync(journalPath).size : 0;
    if (!hasCheckpoint && fs.existsSync(checkpointMarkerPath)) {
      throw new Error('Missing state checkpoint for compacted journal');
    }
    if (!hasCheckpoint && journalExists && journalSize > 0 && parsed.entries.length === 0 && parsed.tornTailOffset === null) throw new Error('Missing state checkpoint for compacted journal');
    if (parsed.tornTailOffset !== null) {
      const fd = fs.openSync(journalPath, 'r+');
      try { fs.ftruncateSync(fd, parsed.tornTailOffset); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return createMemoryStore({ ...options, initialState: replayJournal(parsed.entries, checkpoint) });
  }
  function persist(memory, before) {
    const entries = memory.snapshot().journal.slice(before);
    if (entries.length) { const fd = fs.openSync(journalPath, 'a', 0o600); try { fs.writeFileSync(fd, `${entries.map(stableStringify).join('\n')}\n`, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    const tmp = `${statePath}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      const snapshot = memory.snapshot();
      try { fs.writeFileSync(fd, JSON.stringify({ records: snapshot.records, leases: snapshot.leases, fences: snapshot.fences }, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, statePath); const dirfd = fs.openSync(rootDir, 'r'); try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
      if (checkpointEntries > 0 && fs.existsSync(journalPath) && parseJournal(journalPath).entries.length >= checkpointEntries) {
        const markerFd = fs.openSync(checkpointMarkerPath, 'w', 0o600);
        try { fs.writeFileSync(markerFd, JSON.stringify({ checkpointedAt: nowIso() }), 'utf8'); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); }
        const journalFd = fs.openSync(journalPath, 'r+');
        try { fs.ftruncateSync(journalFd, 0); fs.fsyncSync(journalFd); } finally { fs.closeSync(journalFd); }
        const checkpointDirFd = fs.openSync(rootDir, 'r');
        try { fs.fsyncSync(checkpointDirFd); } finally { fs.closeSync(checkpointDirFd); }
      }
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* journal remains authoritative */ }
      if (options.logger && typeof options.logger.warn === 'function') options.logger.warn(`State snapshot persistence failed: ${error.message}`);
    }
  }
  function mutate(method) { return (...args) => withLock(() => { const memory = load(); const before = memory.snapshot().journal.length; const result = memory[method](...args); persist(memory, before); return result; }); }
  function read(method) { return (...args) => withLock(() => load()[method](...args)); }
  return { append: mutate('append'), putRecord: mutate('putRecord'), putCommandIfAbsent: mutate('putCommandIfAbsent'), getRecord: read('getRecord'), getCommandByActionKey: read('getCommandByActionKey'), acquireLease: mutate('acquireLease'), allocateFence: mutate('allocateFence'), assertLeaseCurrent: read('assertLeaseCurrent'), releaseLease: mutate('releaseLease'), commitEvidence: mutate('commitEvidence'), snapshot: read('snapshot'), paths: { rootDir, statePath, journalPath } };
}

module.exports = { createFileStore, createMemoryStore, isExpired };
