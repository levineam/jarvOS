'use strict';

/**
 * @jarvos/agentify — Agentify-a-channel platform module
 *
 * v0.5.0: Activity log (the seam) — foundational export.
 * v0.5.1: Discord channel-as-context tools (SUP-2197).
 *
 * The activity log is the typed, append-only, per-tenant event stream
 * that is the central seam between the agentification half (write) and
 * the content half (read).
 *
 * The channel-context tools expose MCP-compatible tool definitions for
 * OpenClaw: get_channel_context and get_thread_messages pull Discord
 * messages, active threads, and activity log events on demand.
 *
 * Later releases (v0.5.x–v0.9.x) will add:
 *   - Agent-session object
 *   - Daily loop + two-tier autonomy
 *   - Metric-gated self-improvement gate
 *   - Approval-in-channel
 *   - Content subscriber (content-as-exhaust)
 *   - Per-tenant config + agentify command
 *   - AAF tenant wiring (tenant #1)
 */

const { createActivityLog, ActivityLog, Subscription } = require('./lib/activity-log');
const schema         = require('./lib/activity-log-schema');
const store          = require('./lib/activity-log-store');
const channelContext = require('./lib/channel-context');

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

  // Channel-context: Discord channel-as-context tools (v0.5.1, SUP-2197)
  channelContext,
  buildChannelContext:     channelContext.buildChannelContext,
  renderContextMarkdown:   channelContext.renderContextMarkdown,
  getChannelContextTool:   channelContext.getChannelContextTool,
  getThreadMessagesTool:   channelContext.getThreadMessagesTool,
  CHANNEL_CONTEXT_TOOLS:   channelContext.ALL_TOOLS,
};
