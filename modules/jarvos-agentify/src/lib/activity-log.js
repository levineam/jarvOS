'use strict';

/**
 * activity-log.js — write/read API for the jarvos-agentify activity log
 *
 * This is the central seam between the agentification half (write) and
 * the content half (read). All events are append-only, per-tenant, and typed.
 *
 * Usage — write:
 *   const log = createActivityLog({ storeDir: '/path/to/store' });
 *   const { event, error } = log.write('my-tenant', 'agent.loop.started', {
 *     loop_id: 'loop-001', trigger: 'cron',
 *   });
 *
 * Usage — read (watermark-based):
 *   const { events, cursor } = log.read('my-tenant', { after: 0 });
 *   // next poll: log.read('my-tenant', { after: cursor })
 *
 * Usage — subscribe (polling EventEmitter):
 *   const sub = log.subscribe('my-tenant', (events) => { ... });
 *   // later:
 *   sub.stop();
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const store  = require('./activity-log-store');
const schema = require('./activity-log-schema');

const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Create an ActivityLog API bound to a store directory.
 *
 * @param {{ storeDir?: string }} [opts]
 * @returns {ActivityLog}
 */
function createActivityLog(opts = {}) {
  const storeDir = store.resolveStoreDir(opts.storeDir);
  return new ActivityLog(storeDir);
}

class ActivityLog {
  /**
   * @param {string} storeDir
   */
  constructor(storeDir) {
    this._storeDir = storeDir;
  }

  /**
   * Write a typed event to the log.
   *
   * @param {string} tenantId          — tenant namespace
   * @param {string} type              — event type from EVENT_TYPES taxonomy
   * @param {object} [payload]         — event-specific data
   * @param {{ source?: string, occurredAt?: string }} [opts]
   * @returns {{ event: object|null, error: string|null }}
   */
  write(tenantId, type, payload = {}, opts = {}) {
    if (!tenantId || typeof tenantId !== 'string') {
      return { event: null, error: 'tenant_id is required and must be a string' };
    }

    const now = new Date().toISOString();
    const rawEvent = {
      tenant_id:   tenantId,
      type,
      occurred_at: opts.occurredAt || now,
      source:      opts.source || 'jarvos-agentify',
      payload,
    };

    const { valid, errors } = schema.validateEvent(rawEvent);
    if (!valid) {
      return { event: null, error: `Event validation failed: ${errors.join('; ')}` };
    }

    const id = crypto.createHash('sha256')
      .update(`${tenantId}:${type}:${rawEvent.occurred_at}:${Math.random()}`)
      .digest('hex')
      .slice(0, 16);

    const record = {
      schema:      schema.SCHEMA_VERSION,
      id,
      tenant_id:   tenantId,
      type,
      occurred_at: rawEvent.occurred_at,
      recorded_at: now,
      source:      rawEvent.source,
      payload:     payload || {},
    };

    return store.appendEvent(this._storeDir, tenantId, record);
  }

  /**
   * Read events for a tenant, starting after a watermark seq.
   *
   * @param {string} tenantId
   * @param {{ after?: number, limit?: number, types?: string[] }} [opts]
   * types supports exact matches or prefix wildcard (e.g. "plan.*")
   * @returns {{ events: object[], cursor: number, error: string|null }}
   */
  read(tenantId, opts = {}) {
    return store.readEvents(this._storeDir, tenantId, opts);
  }

  /**
   * Return the current watermark (highest seq) for a tenant.
   *
   * @param {string} tenantId
   * @returns {{ seq: number, error: string|null }}
   */
  watermark(tenantId) {
    return store.getWatermark(this._storeDir, tenantId);
  }

  /**
   * Subscribe to new events for a tenant via polling.
   * Returns a Subscription with `.stop()` and `.on('events', cb)`.
   *
   * The callback receives an array of new events each time events arrive.
   * If pollIntervalMs=0, polling is disabled (useful for tests driving manually).
   *
   * @param {string} tenantId
   * @param {function(object[]):void} callback     — called with new event batches
   * @param {{ pollIntervalMs?: number, after?: number }} [opts]
   * @returns {Subscription}
   */
  subscribe(tenantId, callback, opts = {}) {
    const pollInterval = typeof opts.pollIntervalMs === 'number'
      ? opts.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS;
    const startAfter = typeof opts.after === 'number'
      ? opts.after
      : this.watermark(tenantId).seq;

    const sub = new Subscription(this, tenantId, callback, startAfter, pollInterval);
    return sub;
  }
}

/**
 * A poll-based subscription handle.
 * Emits 'events' with new event arrays; 'error' on read failure.
 */
class Subscription extends EventEmitter {
  /**
   * @param {ActivityLog} log
   * @param {string} tenantId
   * @param {function} callback
   * @param {number} startAfter
   * @param {number} pollIntervalMs
   */
  constructor(log, tenantId, callback, startAfter, pollIntervalMs) {
    super();
    this._log = log;
    this._tenantId = tenantId;
    this._cursor = startAfter;
    this._stopped = false;

    if (callback) this.on('events', callback);

    if (pollIntervalMs > 0) {
      this._timer = setInterval(() => this._poll(), pollIntervalMs);
      // Don't hold the process open
      if (this._timer.unref) this._timer.unref();
    }
  }

  /**
   * Poll for new events and emit them.
   * Can also be called manually (e.g., in tests).
   */
  _poll() {
    if (this._stopped) return;
    const { events, cursor, error } = this._log.read(this._tenantId, { after: this._cursor });
    if (error) {
      this.emit('error', new Error(error));
      return;
    }
    if (events.length > 0) {
      this._cursor = cursor;
      this.emit('events', events);
    }
  }

  /**
   * Stop polling and clean up.
   */
  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
  }

  /**
   * Return the current cursor position.
   * @returns {number}
   */
  get cursor() {
    return this._cursor;
  }
}

module.exports = {
  createActivityLog,
  ActivityLog,
  Subscription,
};
