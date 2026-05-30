'use strict';

/**
 * channel-context.js — Discord channel-as-context for jarvos-agentify
 *
 * Assembles a structured context object for an agent from:
 *   1. Recent Discord channel messages (windowed by hours)
 *   2. Active thread summaries in the channel
 *   3. Activity log events for the tenant (watermark/seq-based)
 *   4. Optional linked resources: vault notes, ledger path
 *
 * Also exposes MCP-compatible tool definitions for OpenClaw:
 *   get_channel_context  — fetch messages + threads + activity events → markdown
 *   get_thread_messages  — fetch all messages in a specific thread → markdown
 *
 * The tools log a `channel.context.fetched` event after each successful fetch
 * so the activity log reflects agent context reads.
 *
 * Release: jarvos-agentify v0.5.x (Discord channel-as-context, SUP-2197)
 */

const {
  fetchChannelMessages,
  fetchActiveThreads,
  fetchThreadMessages,
  normaliseMessage,
} = require('./discord-api');

const { createActivityLog } = require('./activity-log');

const HOUR_MS = 60 * 60 * 1000;

function isAtOrAfter(value, cutoff) {
  const valueMs = Date.parse(value);
  const cutoffMs = Date.parse(cutoff);
  return Number.isFinite(valueMs) && Number.isFinite(cutoffMs) && valueMs >= cutoffMs;
}

// ── Context builder ──────────────────────────────────────────────────────────

/**
 * Build a full channel context object for an agent turn.
 *
 * @param {object} params
 * @param {string}   params.tenantId          — e.g. 'aaf'
 * @param {string}   params.channelId         — Discord channel snowflake ID
 * @param {string}   [params.guildId]         — Discord guild snowflake (required for thread listing)
 * @param {number}   [params.windowHours=24]  — hours of message history to include
 * @param {number}   [params.afterSeq=0]      — activity-log watermark (seq cursor)
 * @param {string[]} [params.notesPaths=[]]   — vault note paths to surface as linked context
 * @param {string}   [params.ledgerPath]      — path to ledger file
 * @param {string}   [params.token]           — Discord bot token (falls back to DISCORD_BOT_TOKEN)
 * @param {string}   [params.storeDir]        — activity-log store dir (falls back to default)
 * @returns {Promise<ChannelContext>}
 */
async function buildChannelContext({
  tenantId,
  channelId,
  guildId,
  windowHours = 24,
  afterSeq    = 0,
  notesPaths  = [],
  ledgerPath  = null,
  token,
  storeDir,
} = {}) {
  if (!tenantId)  throw new Error('tenantId is required');
  if (!channelId) throw new Error('channelId is required');

  const cutoff = new Date(Date.now() - windowHours * HOUR_MS).toISOString();
  const errors = [];

  // 1. Channel messages — filtered to window
  let rawMessages = [];
  try {
    rawMessages = await fetchChannelMessages(channelId, { limit: 100, token });
    rawMessages = rawMessages.filter(m => isAtOrAfter(m.timestamp, cutoff));
  } catch (err) {
    errors.push({ source: 'messages', message: err.message });
    rawMessages = [];
  }

  // 2. Active threads (requires guildId)
  let threads = [];
  if (guildId) {
    try {
      const active = await fetchActiveThreads(guildId, channelId, { token });
      threads = active.map(t => ({ id: t.id, name: t.name, messageCount: t.message_count || 0 }));
    } catch (err) {
      errors.push({ source: 'threads', message: err.message });
      threads = [];
    }
  }

  // 3. Activity log events since watermark
  const log = createActivityLog({ storeDir });
  const { events: activityEvents, error: activityError } = log.read(tenantId, { after: afterSeq });
  if (activityError) errors.push({ source: 'activity-log', message: activityError });

  // 4. Linked resources
  const linkedResources = notesPaths.map(p => ({ type: 'note', path: p }));
  if (ledgerPath) linkedResources.push({ type: 'ledger', path: ledgerPath });

  return {
    tenantId,
    channelId,
    fetchedAt:      new Date().toISOString(),
    windowHours,
    afterSeq,
    messages:       rawMessages.map(normaliseMessage),
    threads,
    activityEvents,
    linkedResources,
    partial:         errors.length > 0,
    errors,
  };
}

/**
 * Render a ChannelContext to a compact markdown string for agent consumption.
 *
 * @param {object} ctx  — result of buildChannelContext
 * @returns {string}
 */
function renderContextMarkdown(ctx) {
  const parts = [];

  parts.push(`## Channel Context — ${ctx.tenantId} (${new Date(ctx.fetchedAt).toUTCString()})`);
  parts.push(
    `Window: last ${ctx.windowHours}h | ` +
    `${ctx.messages.length} message(s) | ` +
    `${ctx.threads.length} active thread(s) | ` +
    `${ctx.activityEvents.length} new activity event(s)`
  );

  if (ctx.messages.length > 0) {
    parts.push('\n### Recent Messages');
    for (const m of ctx.messages) {
      const preview = m.content.slice(0, 300) + (m.content.length > 300 ? '…' : '');
      parts.push(`**${m.author}** (${m.ts}): ${preview}`);
    }
  }

  if (ctx.threads.length > 0) {
    parts.push('\n### Active Threads');
    for (const t of ctx.threads) {
      parts.push(`- **${t.name}** (${t.messageCount} messages)`);
    }
  }

  if (ctx.activityEvents.length > 0) {
    parts.push('\n### Activity Log (new events)');
    for (const e of ctx.activityEvents) {
      parts.push(`- [${e.type}] **${e.source || ''}** seq=${e.seq} (${e.occurred_at})`);
    }
  }

  if (ctx.linkedResources.length > 0) {
    parts.push('\n### Linked Resources');
    for (const r of ctx.linkedResources) {
      parts.push(`- ${r.type}: \`${r.path}\``);
    }
  }

  if (ctx.errors && ctx.errors.length > 0) {
    parts.push('\n### Context Fetch Errors');
    for (const err of ctx.errors) {
      parts.push(`- ${err.source}: ${err.message}`);
    }
  }

  return parts.join('\n');
}

// ── MCP tool definitions ─────────────────────────────────────────────────────

/**
 * Tool: get_channel_context
 *
 * Fetches recent messages, active threads, and activity log events for a
 * jarvos-agentify tenant channel. Returns a markdown context block.
 * Also logs a `channel.context.fetched` event to the activity log.
 */
const getChannelContextTool = {
  name: 'get_channel_context',
  description:
    'Fetch recent messages, active threads, and activity log events for a jarvos-agentify ' +
    'channel. Returns a markdown context block ready for agent consumption.',
  input_schema: {
    type: 'object',
    properties: {
      tenant_id:   { type: 'string',  description: 'Tenant identifier, e.g. "aaf"' },
      channel_id:  { type: 'string',  description: 'Discord channel snowflake ID' },
      guild_id:    { type: 'string',  description: 'Discord guild snowflake ID (enables thread listing)' },
      window_hours:{ type: 'number',  description: 'Hours of message history to include (default 24)' },
      after_seq:   { type: 'number',  description: 'Activity log watermark — return events with seq > this value (default 0)' },
      notes_paths: { type: 'array', items: { type: 'string' }, description: 'Vault note paths to surface as linked context' },
      ledger_path: { type: 'string',  description: 'Path to the AAF ledger file' },
    },
    required: ['tenant_id', 'channel_id'],
  },

  async execute(input) {
    const ctx = await buildChannelContext({
      tenantId:    input.tenant_id,
      channelId:   input.channel_id,
      guildId:     input.guild_id,
      windowHours: input.window_hours ?? 24,
      afterSeq:    input.after_seq    ?? 0,
      notesPaths:  input.notes_paths  ?? [],
      ledgerPath:  input.ledger_path  ?? null,
    });

    // Record the fetch in the activity log
    try {
      const log = createActivityLog();
      log.write(input.tenant_id, 'channel.context.fetched', {
        channel_id:    input.channel_id,
        message_count: ctx.messages.length,
        time_range:    `last ${ctx.windowHours}h`,
        partial:       ctx.partial,
        errors:        ctx.errors.map(err => err.source),
      }, { source: 'get_channel_context' });
    } catch {
      // Non-fatal — context is still returned even if the event write fails
    }

    return renderContextMarkdown(ctx);
  },
};

/**
 * Tool: get_thread_messages
 *
 * Fetches all messages in a specific Discord thread, returned as markdown.
 * Useful for deep-reading a specific discussion.
 */
const getThreadMessagesTool = {
  name: 'get_thread_messages',
  description:
    'Fetch all messages in a Discord thread by its ID. ' +
    'Useful for deep-reading a specific discussion.',
  input_schema: {
    type: 'object',
    properties: {
      thread_id:    { type: 'string', description: 'Discord thread (channel) snowflake ID' },
      max_messages: { type: 'number', description: 'Maximum messages to return (default 200)' },
    },
    required: ['thread_id'],
  },

  async execute(input) {
    const messages = await fetchThreadMessages(input.thread_id, {
      maxMessages: input.max_messages ?? 200,
    });
    const normalised = messages.map(normaliseMessage);

    const lines = [`## Thread ${input.thread_id} — ${normalised.length} messages\n`];
    for (const m of normalised) {
      lines.push(`**${m.author}** (${m.ts}): ${m.content}`);
    }
    return lines.join('\n');
  },
};

/** All channel-context MCP tools in registration order. */
const ALL_TOOLS = [getChannelContextTool, getThreadMessagesTool];

module.exports = {
  buildChannelContext,
  renderContextMarkdown,
  getChannelContextTool,
  getThreadMessagesTool,
  ALL_TOOLS,
};
