'use strict';

const fs = require('fs');
const path = require('path');

const {
  clone,
  digest,
  stableStringify,
} = require('../contracts');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

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
    for (const [key, value] of Object.entries(options.initialState.fences || {})) {
      fences.set(key, value);
    }
  }

  function append(type, payload) {
    const entry = {
      sequence: journal.length + 1,
      type,
      at: now(),
      payload: clone(payload),
    };
    entry.digest = digest({ sequence: entry.sequence, type: entry.type, at: entry.at, payload: entry.payload });
    journal.push(entry);
    return clone(entry);
  }

  function putRecord(record) {
    records.set(record.id, clone(record));
    if (record.type === 'command') commandsByActionKey.set(record.actionKey, record.id);
    append('record.put', record);
    return clone(record);
  }

  function getRecord(id) {
    return clone(records.get(id) || null);
  }

  function getCommandByActionKey(actionKey) {
    const id = commandsByActionKey.get(actionKey);
    return id ? getRecord(id) : null;
  }

  function allocateFence(key) {
    const next = (fences.get(key) || 0) + 1;
    fences.set(key, next);
    append('fence.allocate', { key, fence: next });
    return next;
  }

  function acquireLease(input = {}) {
    const key = input.key;
    if (!key) throw new Error('lease key is required');
    const current = leases.get(key);
    const currentExpired = isExpired(current, now());
    if (current && !currentExpired && current.holder !== input.holder) {
      const conflict = {
        ok: false,
        reason: 'lease_conflict',
        holder: current.holder,
        leaseId: current.id,
        expiresAt: current.expiresAt,
        key,
      };
      append('lease.conflict', conflict);
      return conflict;
    }
    const fence = allocateFence(key);
    const lease = {
      id: input.id || digest({ key, holder: input.holder, fence, at: now() }),
      key,
      holder: input.holder,
      fence,
      acquiredAt: now(),
      expiresAt: input.expiresAt || new Date(Date.now() + (input.ttlMs || 60000)).toISOString(),
      metadata: input.metadata || {},
    };
    leases.set(key, lease);
    append('lease.acquire', lease);
    return { ok: true, lease: clone(lease) };
  }

  function commitEvidence(lease, record) {
    const current = leases.get(lease.key);
    if (!current || current.id !== lease.id || current.fence !== lease.fence) {
      const result = {
        ok: false,
        reason: 'stale_fence',
        key: lease.key,
        expectedFence: current && current.fence,
        providedFence: lease.fence,
      };
      append('evidence.rejected', result);
      return result;
    }
    putRecord(record);
    append('evidence.commit', { leaseId: lease.id, recordId: record.id });
    return { ok: true, record: clone(record) };
  }

  function snapshot() {
    return {
      journal: clone(journal),
      records: Array.from(records.values()).map(clone),
      leases: Array.from(leases.values()).map(clone),
      fences: Object.fromEntries(fences),
    };
  }

  return {
    append,
    putRecord,
    getRecord,
    getCommandByActionKey,
    acquireLease,
    allocateFence,
    commitEvidence,
    snapshot,
  };
}

function createFileStore(rootDir, options = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  ensureDir(rootDir);
  const statePath = path.join(rootDir, 'state.json');
  const journalPath = path.join(rootDir, 'journal.ndjson');
  const initialState = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : null;
  const memory = createMemoryStore({ ...options, initialState: initialState || options.initialState });

  function writeState() {
    const tmp = `${statePath}.${process.pid}.tmp`;
    const body = JSON.stringify(memory.snapshot(), null, 2);
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'w' });
    fs.renameSync(tmp, statePath);
  }

  function appendJournal(entry) {
    fs.appendFileSync(journalPath, `${stableStringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  function wrap(methodName) {
    return (...args) => {
      const before = memory.snapshot().journal.length;
      const result = memory[methodName](...args);
      writeState();
      const snapshot = memory.snapshot();
      for (const entry of snapshot.journal.slice(before)) {
        appendJournal(entry);
      }
      return result;
    };
  }

  return {
    append: wrap('append'),
    putRecord: wrap('putRecord'),
    getRecord: memory.getRecord,
    getCommandByActionKey: memory.getCommandByActionKey,
    acquireLease: wrap('acquireLease'),
    allocateFence: wrap('allocateFence'),
    commitEvidence: wrap('commitEvidence'),
    snapshot: memory.snapshot,
    paths: { rootDir, statePath, journalPath },
  };
}

module.exports = {
  createFileStore,
  createMemoryStore,
  isExpired,
};
