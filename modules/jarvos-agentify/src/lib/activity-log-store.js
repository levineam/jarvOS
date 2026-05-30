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

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const DEFAULT_STORE_DIR = path.join(process.env.HOME || '/tmp', '.jarvos', 'agentify', 'activity-log');
const TENANT_APPEND_LOCKS = new Set();

/**
 * Resolve the store directory (env override or default).
 * @param {string} [override]
 * @returns {string}
 */
function resolveStoreDir(override) {
  return override || process.env.JARVOS_AGENTIFY_STORE_DIR || DEFAULT_STORE_DIR;
}

/**
 * Validate tenant IDs before using them as filesystem path segments.
 * @param {string} tenantId
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    return {
      valid: false,
      error: 'tenant_id must be a safe path segment: letters, numbers, dot, underscore, or hyphen; must start with a letter or number',
    };
  }
  return { valid: true, error: null };
}

/**
 * Return the path to a tenant directory after tenant validation.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ dir: string, error: string|null }}
 */
function tenantDirPath(storeDir, tenantId) {
  const validation = validateTenantId(tenantId);
  if (!validation.valid) return { dir: '', error: validation.error };

  const root = path.resolve(storeDir);
  const dir = path.resolve(root, tenantId);
  const relative = path.relative(root, dir);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    return { dir: '', error: 'tenant_id resolves outside the activity-log store' };
  }

  return { dir, error: null };
}

/**
 * Return the path to the tenant's JSONL file.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ filePath: string, error: string|null }}
 */
function tenantFilePath(storeDir, tenantId) {
  const { dir, error } = tenantDirPath(storeDir, tenantId);
  return { filePath: error ? '' : path.join(dir, 'activity.jsonl'), error };
}

/**
 * Return the path to the tenant's metadata file (stores current seq).
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ metaPath: string, error: string|null }}
 */
function tenantMetaPath(storeDir, tenantId) {
  const { dir, error } = tenantDirPath(storeDir, tenantId);
  return { metaPath: error ? '' : path.join(dir, 'meta.json'), error };
}

/**
 * Ensure the tenant directory exists.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ path: string, error: string|null }}
 */
function ensureTenantDir(storeDir, tenantId) {
  const { dir, error } = tenantDirPath(storeDir, tenantId);
  if (error) return { path: '', error };
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { path: dir, error: null };
  } catch (err) {
    return { path: dir, error: err.message };
  }
}

/**
 * Read the current seq watermark for a tenant.
 * Returns seq=0 if no events have been written.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ seq: number, error: string|null }}
 */
function getWatermark(storeDir, tenantId) {
  const { metaPath, error: metaPathErr } = tenantMetaPath(storeDir, tenantId);
  if (metaPathErr) return { seq: 0, error: metaPathErr };

  try {
    const metaSeq = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf8')).seq
      : 0;
    const logSeq = _readLogWatermark(storeDir, tenantId);
    return { seq: Math.max(typeof metaSeq === 'number' ? metaSeq : 0, logSeq), error: null };
  } catch (err) {
    try {
      return { seq: _readLogWatermark(storeDir, tenantId), error: null };
    } catch (logErr) {
      return { seq: 0, error: logErr.message || err.message };
    }
  }
}

/**
 * Read the highest durable seq from the append-only JSONL file.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {number}
 */
function _readLogWatermark(storeDir, tenantId) {
  const { filePath, error } = tenantFilePath(storeDir, tenantId);
  if (error || !fs.existsSync(filePath)) return 0;

  let lastSeq = 0;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq;
    } catch {
      // corrupt line — skip
    }
  }
  return lastSeq;
}

/**
 * Persist the current seq counter after the event line is durable.
 * @param {string} storeDir
 * @param {string} tenantId
 * @param {number} seq
 * @returns {{ error: string|null }}
 */
function _writeWatermark(storeDir, tenantId, seq) {
  const { metaPath, error: metaPathErr } = tenantMetaPath(storeDir, tenantId);
  if (metaPathErr) return { error: metaPathErr };
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ seq }), 'utf8');
    return { error: null };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Serialize append sequence allocation per tenant within this process.
 * @param {string} storeDir
 * @param {string} tenantId
 * @returns {{ release: function|null, error: string|null }}
 */
function acquireTenantAppendLock(storeDir, tenantId) {
  const key = `${path.resolve(storeDir)}\0${tenantId}`;
  if (TENANT_APPEND_LOCKS.has(key)) {
    return { release: null, error: 'tenant append lock is already held' };
  }

  TENANT_APPEND_LOCKS.add(key);
  return {
    release: () => TENANT_APPEND_LOCKS.delete(key),
    error: null,
  };
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

  const { release, error: lockErr } = acquireTenantAppendLock(storeDir, tenantId);
  if (lockErr) return { event: null, error: `Could not acquire tenant append lock: ${lockErr}` };

  try {
    const { seq: currentSeq, error: seqErr } = getWatermark(storeDir, tenantId);
    if (seqErr) return { event: null, error: `Could not read watermark: ${seqErr}` };

    const nextSeq = currentSeq + 1;
    const event = { ...record, seq: nextSeq };

    const line = JSON.stringify(event) + '\n';
    const { filePath, error: filePathErr } = tenantFilePath(storeDir, tenantId);
    if (filePathErr) return { event: null, error: filePathErr };

    try {
      fs.appendFileSync(filePath, line, 'utf8');
    } catch (err) {
      return { event: null, error: `Could not append event: ${err.message}` };
    }

    const { error: watermarkErr } = _writeWatermark(storeDir, tenantId, nextSeq);
    if (watermarkErr) {
      return { event, error: `Event appended but could not update watermark meta: ${watermarkErr}` };
    }

    return { event, error: null };
  } finally {
    release();
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
 const after = typeof opts.after === 'number' ? opts.after : 0;
  const limit  = typeof opts.limit  === 'number' ? opts.limit  : 1000;
  const rawTypes = Array.isArray(opts.types) && opts.types.length > 0 ? opts.types : null;
  const hasTypeFilters = Array.isArray(rawTypes) && rawTypes.length > 0;
  const exactTypes = new Set(
    (hasTypeFilters ? rawTypes.filter((type) => !String(type).endsWith('.*')) : [])
      .map((type) => String(type))
  );
  const prefixFilters = hasTypeFilters
    ? rawTypes
      .filter((type) => String(type).endsWith('.*'))
      .map((type) => String(type).slice(0, -1))
    : [];

  const matchesTypeFilter = (type) => {
    if (!hasTypeFilters) return true;
    if (exactTypes.has(type)) return true;
    return prefixFilters.some((prefix) => type.startsWith(prefix));
  };

  const { filePath, error: filePathErr } = tenantFilePath(storeDir, tenantId);
  if (filePathErr) return { events: [], cursor: 0, error: filePathErr };

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
    if (!matchesTypeFilter(event.type)) continue;

    events.push(event);
    if (event.seq > lastSeq) lastSeq = event.seq;

    if (events.length >= limit) break;
  }

  return { events, cursor: lastSeq, error: null };
}

module.exports = {
  DEFAULT_STORE_DIR,
  resolveStoreDir,
  validateTenantId,
  tenantDirPath,
  tenantFilePath,
  tenantMetaPath,
  ensureTenantDir,
  getWatermark,
  appendEvent,
  readEvents,
};
