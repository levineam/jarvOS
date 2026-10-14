'use strict';

/**
 * Redacted, deduplicated attention state for autonomous inventory runs.
 * This module deliberately knows no notification transport: an installed
 * runtime may supply one, while the public package remains local-only.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
 * Persist only meaningful transitions. Healthy replays are a strict no-op.
 * `deliver` is optional and receives the redacted transition only.
 */
function reconcileAttention({ attentionPath, status, observedAt, deliver = null } = {}) {
  if (!attentionPath) throw new Error('attentionPath is required');
  const prior = loadAttention(attentionPath);
  const current = redactedAttention(status);
  const before = new Map(prior.active.map((item) => [item.fingerprint, item]));
  const after = new Map(current.map((item) => [item.fingerprint, item]));
  const raised = current.filter((item) => !before.has(item.fingerprint));
  const resolved = prior.active.filter((item) => !after.has(item.fingerprint)).map((item) => ({
    logicalId: item.logicalId,
    reasonCode: item.reasonCode,
    attention: 'resolved',
    fingerprint: item.fingerprint,
  }));
  const transitions = [...raised, ...resolved];
  if (transitions.length === 0) return { wrote: false, raised: [], resolved: [], delivery: [] };

  const next = {
    schemaVersion: ATTENTION_SCHEMA_VERSION,
    updatedAt: observedAt || new Date().toISOString(),
    active: current,
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
  return { wrote: true, raised, resolved, delivery };
}

module.exports = { ATTENTION_SCHEMA_VERSION, redactedAttention, reconcileAttention };
