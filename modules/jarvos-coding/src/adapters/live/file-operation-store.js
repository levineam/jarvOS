'use strict';

// Durable, host-owned ledger for idempotent tracker operations.  It deliberately
// stores only operation metadata/receipts: executable work remains in Beads.
const fs = require('node:fs');
const path = require('node:path');

const OPERATION_STORE_SCHEMA_VERSION = 'jarvos-coding-operation-store/v1';

function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function safeId(value) {
  const id = required(value, 'operationId');
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new TypeError('operationId contains unsupported characters');
  return id;
}

function metadataResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.contract === 'jarvos.work-action/v1') {
    const safe = {
      contract: value.contract,
      ok: value.ok === true,
      status: typeof value.status === 'string' ? value.status : 'unavailable',
      operationId: typeof value.operationId === 'string' ? value.operationId : null,
    };
    if (value.retryable !== undefined) safe.retryable = value.retryable === true;
    if (value.workReference && typeof value.workReference === 'object') {
      safe.workReference = {};
      for (const key of ['authority', 'itemId', 'revision']) {
        if (value.workReference[key] !== undefined) safe.workReference[key] = String(value.workReference[key]);
      }
    }
    if (value.executionLink && typeof value.executionLink === 'object') {
      safe.executionLink = {};
      for (const key of ['contract', 'authority', 'provider', 'workspaceId', 'itemId', 'itemRevision', 'status', 'capturedAt', 'sourceRevision']) {
        if (value.executionLink[key] !== undefined) safe.executionLink[key] = value.executionLink[key];
      }
      if (value.executionLink.canonical && typeof value.executionLink.canonical === 'object') {
        safe.executionLink.canonical = {};
        for (const key of ['contract', 'kind', 'id', 'revision', 'breadcrumb']) {
          if (value.executionLink.canonical[key] !== undefined) safe.executionLink.canonical[key] = value.executionLink.canonical[key];
        }
      }
    }
    return safe;
  }
  const item = value.item && typeof value.item === 'object' ? value.item : value;
  const result = {};
  for (const key of ['id', 'identifier', 'revision', 'version', 'status', 'state']) {
    if (item[key] !== undefined && (typeof item[key] === 'string' || typeof item[key] === 'number')) result[key] = String(item[key]);
  }
  return Object.keys(result).length ? result : null;
}

function sanitizeRecord(record) {
  const safe = { ...record };
  delete safe.workspaceRoot;
  if (safe.result !== undefined) safe.result = metadataResult(safe.result);
  if (safe.error) delete safe.error;
  return safe;
}

function createFileOperationStore(options = {}) {
  const root = path.resolve(required(options.root, 'operation ledger root'));
  const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0 ? options.maxRecords : 500;
  const fileFor = (operationId) => path.join(root, `${safeId(operationId)}.json`);
  const lockPath = path.join(root, '.operations.lock');
  const readFile = (operationId) => {
    const file = fileFor(operationId);
    if (!fs.existsSync(file)) return null;
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('operation ledger record is invalid'); }
    if (!value || value.schemaVersion !== OPERATION_STORE_SCHEMA_VERSION || value.operationId !== operationId || typeof value.fingerprint !== 'string' || typeof value.state !== 'string') {
      throw new Error('operation ledger record is invalid');
    }
    return value;
  };
  const retain = () => {
    const files = fs.readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => ({ name, stat: fs.statSync(path.join(root, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name));
    for (const stale of files.slice(maxRecords)) fs.unlinkSync(path.join(root, stale.name));
  };
  const withLock = (fn) => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(root, 0o700); } catch { /* owner-only enforcement is best effort on non-POSIX hosts */ }
    let fd = null;
    const deadline = Date.now() + 3000;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('operation ledger is busy');
        let stale = false;
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          stale = !Number.isInteger(lock.pid) || (Date.now() - Number(lock.createdAt || 0) > 30_000);
          if (!stale && lock.pid !== process.pid) {
            try { process.kill(lock.pid, 0); } catch (probeError) { stale = probeError.code === 'ESRCH'; }
          }
        } catch { stale = true; }
        if (stale) { try { fs.unlinkSync(lockPath); } catch {} }
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try { return fn(); } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  };
  return {
    schemaVersion: OPERATION_STORE_SCHEMA_VERSION,
    async read(operationId) { return readFile(safeId(operationId)); },
    async write(record) {
      const operationId = safeId(record?.operationId);
      if (!record || typeof record.fingerprint !== 'string' || !record.fingerprint || typeof record.state !== 'string' || !record.state) throw new TypeError('operation ledger record is invalid');
      return withLock(() => {
        const existing = readFile(operationId);
        if (existing && existing.fingerprint !== record.fingerprint) throw new Error('operation ledger operation identity conflict');
        const next = { ...sanitizeRecord(record), schemaVersion: OPERATION_STORE_SCHEMA_VERSION, operationId, updatedAt: new Date().toISOString() };
        const temporary = path.join(root, `.${operationId}.${process.pid}.${Date.now()}.tmp`);
        fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, fileFor(operationId));
        retain();
        return next;
      });
    },
  };
}

module.exports = { OPERATION_STORE_SCHEMA_VERSION, createFileOperationStore };
