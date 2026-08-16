'use strict';

/**
 * Redacted, deduplicated attention state for autonomous inventory runs.
 * This module deliberately knows no notification transport: an installed
 * runtime may supply one, while the public package remains local-only.
 *
 * Reason codes remain in durable status for the shared-skills status/explain
 * surface. Human-facing delivery is owned by the scheduled-repair notification
 * contract projection and must never print raw codes.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { atomicWriteJson } = require('./config');

const ATTENTION_SCHEMA_VERSION = 'jarvos.skill-attention/v1';

function fingerprint(item) {
  return crypto.createHash('sha256').update(JSON.stringify({
    logicalId: item.logicalId,
    reasonCode: item.reasonCode,
    attention: item.attention,
  })).digest('hex');
}

function redactedAttention(status) {
  return (status?.skills || [])
    .filter((skill) => skill.attention === 'actionable')
    .map((skill) => ({
      logicalId: skill.logicalId,
      reasonCode: skill.disposition?.reasonCode || 'needs_owner_input',
      attention: 'actionable',
    }))
    .map((item) => ({ ...item, fingerprint: fingerprint(item) }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function loadAttention(filePath) {
  if (!fs.existsSync(filePath)) return { schemaVersion: ATTENTION_SCHEMA_VERSION, active: [] };
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      return { schemaVersion: ATTENTION_SCHEMA_VERSION, active: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed?.schemaVersion !== ATTENTION_SCHEMA_VERSION || !Array.isArray(parsed.active)) {
      return { schemaVersion: ATTENTION_SCHEMA_VERSION, active: [] };
    }
    return { schemaVersion: ATTENTION_SCHEMA_VERSION, active: parsed.active };
  } catch {
    return { schemaVersion: ATTENTION_SCHEMA_VERSION, active: [] };
  }
}

/**
 * Build the durable shared-skills status projection for quiet holds.
 * Includes first-seen time and occurrence count; never a transport payload.
 */
function durableHoldStatus(active = [], { observedAt } = {}) {
  const byReason = new Map();
  for (const item of active) {
    const reason = typeof item?.reasonCode === 'string' ? item.reasonCode : 'needs_owner_input';
    const existing = byReason.get(reason) || {
      reasonCode: reason,
      occurrenceCount: 0,
      firstSeenAt: item.firstSeenAt || observedAt || null,
      fingerprints: [],
    };
    existing.occurrenceCount += Number(item.occurrenceCount || 1);
    if (item.firstSeenAt && (!existing.firstSeenAt || item.firstSeenAt < existing.firstSeenAt)) {
      existing.firstSeenAt = item.firstSeenAt;
    }
    if (item.fingerprint) existing.fingerprints.push(item.fingerprint);
    byReason.set(reason, existing);
  }
  return [...byReason.values()]
    .map((entry) => ({
      reasonCode: entry.reasonCode,
      occurrenceCount: entry.occurrenceCount,
      firstSeenAt: entry.firstSeenAt,
      // Fingerprints stay owner-only evidence for explain surfaces.
      fingerprintCount: entry.fingerprints.length,
    }))
    .sort((left, right) => left.reasonCode.localeCompare(right.reasonCode));
}

/**
 * Persist only meaningful transitions. Healthy replays are a strict no-op.
 * `deliver` is optional and receives the redacted transition only.
 *
 * Active items retain firstSeenAt + occurrenceCount so quiet safety holds stay
 * readable on the shared-skills status surface without a Telegram interrupt.
 * Occurrence count is the number of distinct active fingerprints per reason at
 * write time; pure replays do not rewrite state.
 */
function reconcileAttention({ attentionPath, status, observedAt, deliver = null } = {}) {
  if (!attentionPath) throw new Error('attentionPath is required');
  const observed = observedAt || new Date().toISOString();
  const prior = loadAttention(attentionPath);
  const current = redactedAttention(status);
  const before = new Map(prior.active.map((item) => [item.fingerprint, item]));
  const after = new Map(current.map((item) => [item.fingerprint, item]));

  const nextActive = current.map((item) => {
    const previous = before.get(item.fingerprint);
    if (previous) {
      return {
        ...item,
        firstSeenAt: previous.firstSeenAt || observed,
        occurrenceCount: Number(previous.occurrenceCount || 1),
        lastSeenAt: previous.lastSeenAt || previous.firstSeenAt || observed,
      };
    }
    return {
      ...item,
      firstSeenAt: observed,
      occurrenceCount: 1,
      lastSeenAt: observed,
    };
  });

  const raised = nextActive
    .filter((item) => !before.has(item.fingerprint))
    .map((item) => ({
      logicalId: item.logicalId,
      reasonCode: item.reasonCode,
      attention: 'actionable',
      fingerprint: item.fingerprint,
      firstSeenAt: item.firstSeenAt,
      occurrenceCount: item.occurrenceCount,
    }));
  const resolved = prior.active.filter((item) => !after.has(item.fingerprint)).map((item) => ({
    logicalId: item.logicalId,
    reasonCode: item.reasonCode,
    attention: 'resolved',
    fingerprint: item.fingerprint,
    firstSeenAt: item.firstSeenAt || null,
    occurrenceCount: Number(item.occurrenceCount || 1),
  }));
  const transitions = [...raised, ...resolved];
  const durableStatus = durableHoldStatus(
    transitions.length === 0 ? prior.active : nextActive,
    { observedAt: observed },
  );

  if (transitions.length === 0) {
    return {
      wrote: false,
      raised: [],
      resolved: [],
      delivery: [],
      durableStatus,
      replay: true,
    };
  }

  const next = {
    schemaVersion: ATTENTION_SCHEMA_VERSION,
    updatedAt: observed,
    active: nextActive,
    durableStatus: durableHoldStatus(nextActive, { observedAt: observed }),
  };
  atomicWriteJson(attentionPath, next);
  const delivery = [];
  for (const item of transitions) {
    if (typeof deliver !== 'function') {
      delivery.push({ fingerprint: item.fingerprint, status: 'local_status_only' });
      continue;
    }
    try {
      deliver(item);
      delivery.push({ fingerprint: item.fingerprint, status: 'delivered' });
    } catch {
      // A later transition/retry owner may retry. Never expose transport errors.
      delivery.push({ fingerprint: item.fingerprint, status: 'pending_retry' });
    }
  }
  return {
    wrote: true,
    raised,
    resolved,
    delivery,
    durableStatus: next.durableStatus,
    replay: false,
  };
}

module.exports = {
  ATTENTION_SCHEMA_VERSION,
  redactedAttention,
  reconcileAttention,
  durableHoldStatus,
};
