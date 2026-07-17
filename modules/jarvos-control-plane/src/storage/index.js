'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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
  function lockOwnerIsRunning(lock) {
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return false;
    try {
      process.kill(lock.pid, 0);
      const marker = processStartMarker(lock.pid);
      return !lock.processStart || !marker || marker === lock.processStart;
    } catch (error) { return error.code === 'EPERM'; }
  }
  function recoverStaleLock() {
    let stat; let lock = {};
    try {
      stat = fs.statSync(lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }

    const takeoverPath = `${lockPath}.takeover-${stat.dev}-${stat.ino}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      fs.renameSync(lockPath, takeoverPath);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EEXIST') return false;
      throw error;
    }

    let preserveTakeoverPath = false;
    try {
      const takeoverStat = fs.statSync(takeoverPath);
      if (takeoverStat.dev !== stat.dev || takeoverStat.ino !== stat.ino) {
        try {
          fs.renameSync(takeoverPath, lockPath);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          preserveTakeoverPath = true;
        }
        return false;
      }
      try {
        const text = fs.readFileSync(takeoverPath, 'utf8');
        if (text) lock = JSON.parse(text);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        if (!(error instanceof SyntaxError)) throw error;
      }
      const ageMs = Date.now() - fs.statSync(takeoverPath).mtimeMs;
      // A matching process-start marker proves this is a live owner; a recycled
      // PID fails the comparison and is recoverable once the stale interval passes.
      if (lockOwnerIsRunning(lock) || ageMs < staleLockMs) {
        try { fs.renameSync(takeoverPath, lockPath); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        return false;
      }
      fs.unlinkSync(takeoverPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    } finally {
      if (!preserveTakeoverPath) {
        try { fs.unlinkSync(takeoverPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  function withLock(fn) {
    let fd; const deadline = Date.now() + (options.lockTimeoutMs || 5000);
    while (!fd) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, processStart: processStartMarker(process.pid), token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: nowIso() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (fd) { fs.closeSync(fd); fs.rmSync(lockPath, { force: true }); fd = undefined; throw error; }
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Timed out acquiring file store lock');
        if (!recoverStaleLock()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
      }
    }
    try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lockPath, { force: true }); }
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
