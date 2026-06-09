'use strict';

/**
 * discord-api.js — minimal Discord REST client for channel-context fetching
 *
 * Uses the bot token from DISCORD_BOT_TOKEN env var (or explicit token arg).
 * Handles rate-limit retries automatically.
 *
 * Public API:
 *   fetchChannelMessages(channelId, opts)        — recent messages, oldest-first
 *   fetchThreadMessages(threadId, opts)          — all messages in a thread
 *   fetchActiveThreads(guildId, channelId, opts) — active threads in a channel
 *   normaliseMessage(msg)                        — compact context-friendly shape
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Authenticated GET against the Discord API with automatic rate-limit retry.
 * Throws on non-2xx after 3 attempts.
 *
 * @param {string} path
 * @param {{ token?: string }} [opts]
 * @returns {Promise<any>}
 */
async function discordGet(path, { token } = {}) {
  const botToken = token || process.env.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error('DISCORD_BOT_TOKEN is required');

  const url = `${DISCORD_API_BASE}${path}`;
  let attempts = 0;

  while (attempts < 3) {
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get('Retry-After') || '1');
      await new Promise(r => setTimeout(r, retryAfter * 1000 + 100));
      attempts++;
      continue;
    }

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Discord API error ${resp.status} for ${path}: ${body}`);
    }

    return resp.json();
  }

  throw new Error(`Discord API: rate-limited after 3 attempts on ${path}`);
}

/**
 * Fetch up to `limit` recent messages from a channel.
 * Discord returns newest-first; we reverse to oldest-first.
 *
 * @param {string} channelId
 * @param {{ limit?: number, before?: string|null, token?: string }} [opts]
 * @returns {Promise<object[]>}
 */
async function fetchChannelMessages(channelId, { limit = 50, before = null, token } = {}) {
  let qs = `?limit=${Math.min(limit, 100)}`;
  if (before) qs += `&before=${before}`;
  const messages = await discordGet(`/channels/${channelId}/messages${qs}`, { token });
  return messages.reverse(); // oldest-first
}

/**
 * Fetch all messages in a thread, paginating automatically.
 *
 * @param {string} threadId
 * @param {{ maxMessages?: number, token?: string }} [opts]
 * @returns {Promise<object[]>}
 */
async function fetchThreadMessages(threadId, { maxMessages = 200, token } = {}) {
  const all = [];
  let before = null;

  while (all.length < maxMessages) {
    const batch = await fetchChannelMessages(threadId, { limit: 100, before, token });
    if (batch.length === 0) break;
    all.unshift(...batch); // maintain oldest-first
    before = batch[0].id;
    if (batch.length < 100) break;
  }

  return all.slice(-maxMessages);
}

/**
 * Fetch active threads in a channel.
 * Discord's active-threads endpoint is guild-level; we filter by parent channel.
 *
 * @param {string} guildId
 * @param {string} channelId
 * @param {{ token?: string }} [opts]
 * @returns {Promise<object[]>}
 */
async function fetchActiveThreads(guildId, channelId, { token } = {}) {
  const data = await discordGet(`/guilds/${guildId}/threads/active`, { token });
  return (data.threads || []).filter(t => t.parent_id === channelId);
}

/**
 * Normalise a raw Discord message to a compact, context-friendly shape.
 *
 * @param {object} msg  — raw Discord message object
 * @returns {{ id, ts, author, content, embeds, thread }}
 */
function normaliseMessage(msg) {
  return {
    id:      msg.id,
    ts:      msg.timestamp,
    author:  msg.author?.username || 'unknown',
    content: msg.content || '',
    embeds:  (msg.embeds || []).map(e => ({ title: e.title, description: e.description })),
    thread:  msg.thread ? { id: msg.thread.id, name: msg.thread.name } : null,
  };
}

module.exports = {
  fetchChannelMessages,
  fetchThreadMessages,
  fetchActiveThreads,
  normaliseMessage,
};
