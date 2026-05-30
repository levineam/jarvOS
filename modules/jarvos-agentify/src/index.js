'use strict';

/**
 * @jarvos/agentify — Agentify-a-channel platform module
 *
 * v0.5.0: Activity log (the seam) — foundational export.
 * The activity log is the typed, append-only, per-tenant event stream
 * that is the central seam between the agentification half (write) and
 * the content half (read).
 *
 * Later releases (v0.5.x–v0.9.x) will add:
 *   - Discord channel-as-context tools
 *   - Agent-session object
 *   - Daily loop + two-tier autonomy
 *   - Metric-gated self-improvement gate
 *   - Approval-in-channel
 *   - Content subscriber (content-as-exhaust)
 *   - Per-tenant config + agentify command
 *   - AAF tenant wiring (tenant #1)
 */

const { createActivityLog, ActivityLog, Subscription } = require('./lib/activity-log');
const schema = require('./lib/activity-log-schema');
const store  = require('./lib/activity-log-store');

module.exports = {
  // High-level API (preferred entry point)
  createActivityLog,
  ActivityLog,
  Subscription,

  // Schema: event taxonomy + validation
  SCHEMA_VERSION:         schema.SCHEMA_VERSION,
  EVENT_TYPES:            schema.EVENT_TYPES,
  REQUIRED_FIELDS:        schema.REQUIRED_FIELDS,
  validateEvent:          schema.validateEvent,
  getEventTypeDef:        schema.getEventTypeDef,
  listEventTypes:         schema.listEventTypes,
  listEventTypesByGroup:  schema.listEventTypesByGroup,

  // Store: low-level adapter (direct access if needed)
  store,
};
