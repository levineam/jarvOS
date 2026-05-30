'use strict';

/**
 * activity-log-store.js — JSONL file adapter for the activity log
 *
 * Each tenant gets its own append-only JSONL file:
 *   {storeDir}/{tenantId}/activity.jsonl
 *
 * The file is pure append — lines are never modified or deleted.
 * The seq field is a monotonically increasing integer per-tenant, assigned at write time.
 * Watermark = seq of the last event written.
 * This JSONL adapter uses a per-tenant lock file for local multi-process writes.
 *
 * This adapter is the default "zero-dependency" implementation. A future adapter
 * could swap in SQLite or Postgres behind the same interface.
 *
 * Adapter interface:
 *   appendEvent(tenantId, record)           → { event, error }
 *   readEvents(tenantId, opts)              → { events, cursor, error }
 *   getWatermark(tenantId)                  → { seq, error }
 *   ensureTenantDir(tenantId)              → { path, error }
 *
 * opts for readEvents:
 *   after   {number}   — return only events with seq > after (default 0)
 *   limit   {number}   — max events to return (default 1000)
 *   types   {string[]} — filter to these event types (default all)
 */

const fs   = require('fs');
const path = require('path');
const { isValidTenantId } = require('./activity-log-schema');

const LOCK_RETRY_MS = 25;
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_STALE_MS = 30_000;

const DEFAULT_STORE_DIR = path.join(
  process.env.JARVOS_AGENTIFY_STORE_DIR || path.join(process.env.HOME || '/tmp', '.jarvos', 'agentify'),
  'activity-log',
);

/**
 * Resolve the store directory (env override or default).
 * @param {string} [override]
 * @returns {string}
 */
function resolveStoreDir(override) {
  return override || process.env.JARVOS_AGENTIFY_STORE_DIR
    ? path.join(override || process.env.JARVOS_AGENTIFY_STORE_DIR, 'activity-log')
    : DEFAULT_STORE_DIR;
}

/**
 * Return the path to the tenant's JSONL file.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {string}
 */
function tenantFilePath(storeDir, tenantId) {
  if (!isValidTenantId(tenantId)) throw new Error(`Invalid tenant_id: ${tenantId}`);
  return path.join(storeDir, tenantId, 'activity.jsonl');
}

/**
 * Return the path to the tenant's metadata file (stores current seq).
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {string}
 */
function tenantMetaPath(storeDir, tenantId) {
  if (!isValidTenantId(tenantId)) throw new Error(`Invalid tenant_id: ${tenantId}`);
  return path.join(storeDir, tenantId, 'meta.json');
}

function tenantLockPath(storeDir, tenantId) {
  if (!isValidTenantId(tenantId)) throw new Error(`Invalid tenant_id: ${tenantId}`);
  return path.join(storeDir, tenantId, '.activity.lock');
}

/**
 * Ensure the tenant directory exists.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ path: string, error: string|null }}
 */
function ensureTenantDir(storeDir, tenantId) {
  if (!isValidTenantId(tenantId)) {
    return { path: '', error: `Invalid tenant_id: ${tenantId}` };
  }
  const dir = path.join(storeDir, tenantId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { path: dir, error: null };
  } catch (err) {
    return { path: dir, error: err.message };
  }
}

function scanWatermarkFromEvents(storeDir, tenantId) {
  const filePath = tenantFilePath(storeDir, tenantId);
  if (!fs.existsSync(filePath)) return 0;

  let maxSeq = 0;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (typeof event.seq === 'number' && event.seq > maxSeq) maxSeq = event.seq;
    } catch {
      // Corrupt lines are ignored consistently with readEvents.
    }
  }
  return maxSeq;
}

function eventFileSize(storeDir, tenantId) {
  const filePath = tenantFilePath(storeDir, tenantId);
  if (!fs.existsSync(filePath)) return 0;
  return fs.statSync(filePath).size;
}

/**
 * Read the current seq watermark for a tenant.
 * Returns seq=0 if no events have been written.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ seq: number, error: string|null }}
 */
function getWatermark(storeDir, tenantId) {
  try {
    if (!isValidTenantId(tenantId)) return { seq: 0, error: `Invalid tenant_id: ${tenantId}` };
    const metaPath = tenantMetaPath(storeDir, tenantId);
    if (!fs.existsSync(metaPath)) return { seq: scanWatermarkFromEvents(storeDir, tenantId), error: null };
    const raw = fs.readFileSync(metaPath, 'utf8');
    const meta = JSON.parse(raw);
    if (typeof meta.seq !== 'number' || meta.seq < 0) {
      return { seq: scanWatermarkFromEvents(storeDir, tenantId), error: null };
    }
    if (typeof meta.bytes === 'number' && meta.bytes === eventFileSize(storeDir, tenantId)) {
      return { seq: meta.seq, error: null };
    }
    const eventSeq = scanWatermarkFromEvents(storeDir, tenantId);
    return { seq: Math.max(meta.seq, eventSeq), error: null };
  } catch (err) {
    try {
      return { seq: scanWatermarkFromEvents(storeDir, tenantId), error: null };
    } catch {
      return { seq: 0, error: err.message };
    }
  }
}

/**
 * Persist the seq counter after the JSONL append succeeds.
 * @param {string} storeDir
 * @param {string} tenantId
 * @param {number} currentSeq
 * @param {number} fileBytes
 * @returns {{ seq: number, error: string|null }}
 */
function _incrementSeq(storeDir, tenantId, currentSeq, fileBytes) {
  const next = currentSeq + 1;
  const metaPath = tenantMetaPath(storeDir, tenantId);
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ seq: next, bytes: fileBytes }), 'utf8');
    return { seq: next, error: null };
  } catch (err) {
    return { seq: currentSeq, error: err.message };
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLockOwner(fd) {
  fs.writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    created_at: new Date().toISOString(),
  }), 'utf8');
}

function openReclaimLock(reclaimPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return fs.openSync(reclaimPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      try {
        const stat = fs.statSync(reclaimPath);
        if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;
        fs.rmSync(reclaimPath, { force: true });
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
      }
    }
  }

  return null;
}

function tryStealStaleLock(lockPath) {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd = null;
  let createdReclaim = false;
  try {
    reclaimFd = openReclaimLock(reclaimPath);
    if (reclaimFd === null) return null;
    createdReclaim = true;

    const stat = fs.statSync(lockPath);
    const owner = readLockOwner(lockPath);
    const holderAlive = owner && isProcessAlive(owner.pid);
    if (holderAlive || Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return null;

    fs.rmSync(lockPath, { force: true });
    const fd = fs.openSync(lockPath, 'wx');
    writeLockOwner(fd);
    return fd;
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOENT') return null;
    throw err;
  } finally {
    if (createdReclaim && reclaimFd !== null) {
      fs.closeSync(reclaimFd);
      fs.rmSync(reclaimPath, { force: true });
    }
  }
}

function withTenantLock(storeDir, tenantId, fn) {
  const lockPath = tenantLockPath(storeDir, tenantId);
  let fd = null;
  try {
    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
      try {
        fd = fs.openSync(lockPath, 'wx');
        writeLockOwner(fd);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        fd = tryStealStaleLock(lockPath);
        if (fd !== null) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      }
    }
    if (fd === null) throw new Error(`Timed out waiting for tenant lock: ${tenantId}`);
    return fn();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

/**
 * Append a fully-formed event record to the tenant's JSONL file.
 * The record must already have: id, seq, tenant_id, type, occurred_at,
 * recorded_at, source, and (optional) payload.
 *
 * @param {string} storeDir
 * @param {string} tenantId
 * @param {object} record  — pre-assembled event record
 * @returns {{ event: object|null, error: string|null }}
 */
function appendEvent(storeDir, tenantId, record) {
  const { error: dirErr } = ensureTenantDir(storeDir, tenantId);
  if (dirErr) return { event: null, error: `Could not create tenant dir: ${dirErr}` };

  try {
    return withTenantLock(storeDir, tenantId, () => {
      const { seq: currentSeq, error: seqErr } = getWatermark(storeDir, tenantId);
      if (seqErr) return { event: null, error: `Could not read watermark: ${seqErr}` };

      const nextSeq = currentSeq + 1;
      const event = { ...record, seq: nextSeq };

      const line = JSON.stringify(event) + '\n';
      const filePath = tenantFilePath(storeDir, tenantId);

      try {
        fs.appendFileSync(filePath, line, 'utf8');
      } catch (err) {
        return { event: null, error: `Could not append event: ${err.message}` };
      }

      const { error: incrErr } = _incrementSeq(storeDir, tenantId, currentSeq, eventFileSize(storeDir, tenantId));
      if (incrErr) return { event, error: `Event appended but could not persist seq: ${incrErr}` };

      return { event, error: null };
    });
  } catch (err) {
    return { event: null, error: err.message };
  }
}

/**
 * Read events for a tenant, supporting incremental watermark reads.
 *
 * @param {string} storeDir
 * @param {string} tenantId
 * @param {{ after?: number, limit?: number, types?: string[] }} [opts]
 * @returns {{ events: object[], cursor: number, error: string|null }}
 */
function readEvents(storeDir, tenantId, opts = {}) {
  if (!isValidTenantId(tenantId)) {
    return { events: [], cursor: 0, error: `Invalid tenant_id: ${tenantId}` };
  }

  const after = typeof opts.after === 'number' ? opts.after : 0;
  const limit  = typeof opts.limit  === 'number' ? opts.limit  : 1000;
  const types  = Array.isArray(opts.types) && opts.types.length > 0 ? new Set(opts.types) : null;

  const filePath = tenantFilePath(storeDir, tenantId);

  if (!fs.existsSync(filePath)) {
    return { events: [], cursor: 0, error: null };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { events: [], cursor: 0, error: `Could not read events: ${err.message}` };
  }

  const events = [];
  let lastSeq = after;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // corrupt line — skip
      continue;
    }

    if (typeof event.seq !== 'number' || event.seq <= after) continue;
    if (types && !types.has(event.type)) continue;

    events.push(event);
    if (event.seq > lastSeq) lastSeq = event.seq;

    if (events.length >= limit) break;
  }

  return { events, cursor: lastSeq, error: null };
}

module.exports = {
  DEFAULT_STORE_DIR,
  resolveStoreDir,
  tenantFilePath,
  tenantMetaPath,
  tenantLockPath,
  ensureTenantDir,
  getWatermark,
  appendEvent,
  readEvents,
};
