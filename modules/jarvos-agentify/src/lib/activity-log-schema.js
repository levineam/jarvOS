'use strict';

/**
 * activity-log-schema.js — typed event taxonomy and validation for jarvos-agentify
 *
 * The activity log is an append-only, per-tenant event stream: the central seam
 * between the agentification half (write) and the content half (read).
 *
 * Every event must carry tenant_id. The seq field is assigned by the store on
 * write and forms the watermark cursor for incremental reads.
 *
 * Event taxonomy groups:
 *   agent.*      — agent lifecycle and autonomy loop
 *   session.*    — agent-session object lifecycle
 *   plan.*       — proposed/approved/rejected plans
 *   action.*     — bounded actions taken
 *   metric.*     — measured values for the self-improvement gate
 *   content.*    — content-as-exhaust pipeline
 *   channel.*    — channel context reads
 *   system.*     — internal system/admin events
 */

const SCHEMA_VERSION = 'jarvos-agentify/activity-log/v1';

/**
 * Full event type taxonomy.
 * Each entry: { group, description, payloadFields }
 * payloadFields lists the expected payload keys (informational, not enforced beyond presence check).
 */
const EVENT_TYPES = {
  // ── Agent lifecycle ─────────────────────────────────────────────────────────
  'agent.loop.started': {
    group: 'agent',
    description: 'Daily agent loop began for the tenant.',
    payloadFields: ['loop_id', 'trigger'],
  },
  'agent.loop.completed': {
    group: 'agent',
    description: 'Daily agent loop finished.',
    payloadFields: ['loop_id', 'duration_ms', 'outcome'],
  },
  'agent.loop.failed': {
    group: 'agent',
    description: 'Daily agent loop failed or was interrupted.',
    payloadFields: ['loop_id', 'error', 'duration_ms'],
  },

  // ── Session lifecycle ───────────────────────────────────────────────────────
  'session.started': {
    group: 'session',
    description: 'Agent session started (Linear-style durable session object).',
    payloadFields: ['session_id', 'channel_id', 'trigger'],
  },
  'session.ended': {
    group: 'session',
    description: 'Agent session ended.',
    payloadFields: ['session_id', 'duration_ms', 'outcome'],
  },
  'session.paused': {
    group: 'session',
    description: 'Agent session paused, awaiting human input.',
    payloadFields: ['session_id', 'reason'],
  },
  'session.resumed': {
    group: 'session',
    description: 'Agent session resumed after human input.',
    payloadFields: ['session_id', 'resumed_by'],
  },

  // ── Plan lifecycle ──────────────────────────────────────────────────────────
  'plan.proposed': {
    group: 'plan',
    description: 'A plan was proposed; awaiting approval.',
    payloadFields: ['plan_id', 'summary', 'items', 'proposed_by'],
  },
  'plan.approved': {
    group: 'plan',
    description: 'A proposed plan was approved.',
    payloadFields: ['plan_id', 'approved_by'],
  },
  'plan.rejected': {
    group: 'plan',
    description: 'A proposed plan was rejected.',
    payloadFields: ['plan_id', 'rejected_by', 'reason'],
  },
  'plan.revised': {
    group: 'plan',
    description: 'A plan was revised before approval.',
    payloadFields: ['plan_id', 'revised_by', 'changes'],
  },

  // ── Bounded actions ─────────────────────────────────────────────────────────
  'action.taken': {
    group: 'action',
    description: 'A bounded action was executed (hardening-only on silence).',
    payloadFields: ['action_id', 'kind', 'description', 'result', 'hardening_only'],
  },
  'action.proposed': {
    group: 'action',
    description: 'An action was proposed but not yet executed (requires approval).',
    payloadFields: ['action_id', 'kind', 'description'],
  },
  'action.reverted': {
    group: 'action',
    description: 'An action was reverted (metric gate or manual).',
    payloadFields: ['action_id', 'reason'],
  },

  // ── Metric gate ─────────────────────────────────────────────────────────────
  'metric.measured': {
    group: 'metric',
    description: 'A metric value was recorded (used by the self-improvement gate).',
    payloadFields: ['metric_name', 'value', 'unit', 'context'],
  },
  'metric.gate.passed': {
    group: 'metric',
    description: 'Self-improvement gate: metric held or improved — action kept.',
    payloadFields: ['action_id', 'metric_name', 'before', 'after'],
  },
  'metric.gate.failed': {
    group: 'metric',
    description: 'Self-improvement gate: metric degraded — action reverted.',
    payloadFields: ['action_id', 'metric_name', 'before', 'after'],
  },

  // ── Content-as-exhaust ──────────────────────────────────────────────────────
  'content.skeleton.emitted': {
    group: 'content',
    description: 'A publishable content skeleton was generated from activity log events.',
    payloadFields: ['skeleton_id', 'source_events', 'verbatim_count'],
  },
  'content.voice_pass.requested': {
    group: 'content',
    description: 'Human voice pass requested before publication.',
    payloadFields: ['skeleton_id', 'reviewer'],
  },
  'content.attested': {
    group: 'content',
    description: 'Human attested the content skeleton for publication.',
    payloadFields: ['skeleton_id', 'attested_by'],
  },
  'content.published': {
    group: 'content',
    description: 'Content was published after human attestation.',
    payloadFields: ['skeleton_id', 'channel', 'url'],
  },

  // ── Channel context ─────────────────────────────────────────────────────────
  'channel.context.fetched': {
    group: 'channel',
    description: 'Channel messages/context fetched as agent input.',
    payloadFields: ['channel_id', 'message_count', 'time_range'],
  },

  // ── System ──────────────────────────────────────────────────────────────────
  'system.tenant.registered': {
    group: 'system',
    description: 'A new tenant was registered with jarvos-agentify.',
    payloadFields: ['tenant_id', 'config'],
  },
  'system.checkpoint': {
    group: 'system',
    description: 'Periodic health checkpoint or heartbeat.',
    payloadFields: ['status', 'message'],
  },
};

/**
 * Required fields on every raw event before the store assigns seq/recorded_at.
 */
const REQUIRED_FIELDS = ['tenant_id', 'type', 'occurred_at', 'source'];

/**
 * Validate a raw event object.
 * @param {object} event
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateEvent(event = {}) {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (!event[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (event.type && !EVENT_TYPES[event.type]) {
    errors.push(`Unknown event type: "${event.type}". Valid types: ${Object.keys(EVENT_TYPES).join(', ')}`);
  }

  if (event.occurred_at) {
    const d = new Date(event.occurred_at);
    if (isNaN(d.getTime())) {
      errors.push('occurred_at must be a valid ISO 8601 timestamp');
    }
  }

  if (event.tenant_id && typeof event.tenant_id !== 'string') {
    errors.push('tenant_id must be a string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Return the definition for an event type.
 * @param {string} type
 * @returns {{ group: string, description: string, payloadFields: string[] } | null}
 */
function getEventTypeDef(type) {
  return EVENT_TYPES[type] || null;
}

/**
 * Return all registered event type names.
 * @returns {string[]}
 */
function listEventTypes() {
  return Object.keys(EVENT_TYPES);
}

/**
 * Return all event type names in a given group.
 * @param {string} group
 * @returns {string[]}
 */
function listEventTypesByGroup(group) {
  return Object.entries(EVENT_TYPES)
    .filter(([, def]) => def.group === group)
    .map(([type]) => type);
}

module.exports = {
  SCHEMA_VERSION,
  EVENT_TYPES,
  REQUIRED_FIELDS,
  validateEvent,
  getEventTypeDef,
  listEventTypes,
  listEventTypesByGroup,
};
