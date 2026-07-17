'use strict';

const fs = require('fs');
const path = require('path');

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
  if (!fs.existsSync(journalPath)) return [];
  const text = fs.readFileSync(journalPath, 'utf8');
  const lines = text.split('\n');
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); } catch (error) {
      if (index === lines.length - 1) break;
      throw new Error(`Corrupt journal entry ${index + 1}: ${error.message}`);
    }
    if (entry.sequence !== entries.length + 1 || entry.digest !== digest({ sequence: entry.sequence, type: entry.type, at: entry.at, payload: entry.payload })) {
      throw new Error(`Invalid journal frame ${index + 1}`);
    }
    entries.push(entry);
  }
  return entries;
}

function replayJournal(entries) {
  const state = { journal: entries, records: [], leases: [], fences: {} };
  const records = new Map(); const leases = new Map(); const fences = new Map();
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
  const retryMs = options.lockRetryMs ?? 10;
  const staleLockMs = options.staleLockMs ?? 100;
  function lockOwnerIsRunning(lock) {
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return false;
    try { process.kill(lock.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  }
  function recoverStaleLock() {
    let stat; let lock = {};
    try {
      stat = fs.statSync(lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    try { const text = fs.readFileSync(lockPath, 'utf8'); if (text) lock = JSON.parse(text); } catch (error) { if (error.code === 'ENOENT') return false; }
    const ageMs = Date.now() - stat.mtimeMs;
    if (lockOwnerIsRunning(lock) || ageMs < staleLockMs) return false;
    try { fs.unlinkSync(lockPath); return true; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  }
  function withLock(fn) {
    let fd; const deadline = Date.now() + (options.lockTimeoutMs || 5000);
    while (!fd) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: nowIso() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (fd) { fs.closeSync(fd); fs.rmSync(lockPath, { force: true }); fd = undefined; throw error; }
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('Timed out acquiring file store lock');
        if (!recoverStaleLock()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
      }
    }
    try { return fn(); } finally { fs.closeSync(fd); fs.rmSync(lockPath, { force: true }); }
  }
  function load() { const entries = parseJournal(journalPath); return createMemoryStore({ ...options, initialState: entries.length ? replayJournal(entries) : options.initialState }); }
  function persist(memory, before) {
    const entries = memory.snapshot().journal.slice(before);
    if (entries.length) { const fd = fs.openSync(journalPath, 'a', 0o600); try { fs.writeFileSync(fd, `${entries.map(stableStringify).join('\n')}\n`, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    const tmp = `${statePath}.${process.pid}.tmp`; const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(memory.snapshot(), null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, statePath); const dirfd = fs.openSync(rootDir, 'r'); try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  }
  function mutate(method) { return (...args) => withLock(() => { const memory = load(); const before = memory.snapshot().journal.length; const result = memory[method](...args); persist(memory, before); return result; }); }
  function read(method) { return (...args) => withLock(() => load()[method](...args)); }
  return { append: mutate('append'), putRecord: mutate('putRecord'), putCommandIfAbsent: mutate('putCommandIfAbsent'), getRecord: read('getRecord'), getCommandByActionKey: read('getCommandByActionKey'), acquireLease: mutate('acquireLease'), allocateFence: mutate('allocateFence'), assertLeaseCurrent: read('assertLeaseCurrent'), releaseLease: mutate('releaseLease'), commitEvidence: mutate('commitEvidence'), snapshot: read('snapshot'), paths: { rootDir, statePath, journalPath } };
}

module.exports = { createFileStore, createMemoryStore, isExpired };
