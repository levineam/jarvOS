'use strict';

const crypto = require('node:crypto');

const SESSION_WAIT_CONTRACT_VERSION = '1.0.0';
const SESSION_WAIT_SCHEMA_VERSION = 'jarvos.session-wait.v1';
const DEFAULT_DEADLINE_WAKE_SOURCE = 'jarvos-managed-software-reconcile';
const DEFAULT_DEADLINE_OBSERVATION_WINDOW_MS = 86400000;
const SESSION_WAIT_STATES = [
  'registered',
  'waiting',
  'terminal_observed',
  'delivery_claimed',
  'delivered',
  'queued',
  'consumed',
  'expired_missing_result',
  'cancelled',
  'superseded',
  'delivery_uncertain',
];
const TERMINAL_OUTCOMES = ['completed', 'failed', 'result_missing', 'cancelled'];
const SAFE_PROJECTION_KEYS = new Set(['status', 'label', 'reference', 'digest', 'summary', 'resultClass']);
const FORBIDDEN_TEXT = /(?:[\r\n\0-\x1f\x7f]|(?:^|[\s("'`])(?:\/|~\/|[A-Za-z]:[\\/])|https?:\/\/|\b(?:api[ _-]?key|secret|password|token|credential|bearer|transcript|prompt|instruction)\b)/i;

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizeTimestamp(value, fallback = new Date().toISOString()) {
  const normalized = value == null ? fallback : new Date(value).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw new Error('session wait timestamp is invalid');
  return normalized;
}

function opaque(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(`${label} must be an opaque identifier`);
  }
  return value;
}

function observationWindow(value, label = 'deadline observation window') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 604800000) throw new Error(`${label} is invalid`);
  return value;
}

function digestBinding(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a sha256 binding`);
  return value.toLowerCase();
}

function assertOrigin(origin) {
  if (!isObject(origin)) throw new Error('session wait origin is required');
  if (origin.harness !== 'codex') throw new Error('session wait origin harness must be codex');
  return {
    harness: origin.harness,
    stableSessionId: opaque(origin.stableSessionId, 'stableSessionId'),
    repoBinding: digestBinding(origin.repoBinding, 'repoBinding'),
    workspaceBinding: digestBinding(origin.workspaceBinding, 'workspaceBinding'),
    adapterGeneration: opaque(origin.adapterGeneration, 'adapterGeneration'),
  };
}

function assertExpectedTerminal(expected) {
  if (!isObject(expected)) throw new Error('session wait expectedTerminal is required');
  return {
    producer: opaque(expected.producer, 'terminal producer'),
    eventType: opaque(expected.eventType, 'terminal event type'),
    subject: opaque(expected.subject, 'terminal subject'),
    revision: opaque(expected.revision, 'terminal revision'),
    fence: expected.fence == null ? null : opaque(expected.fence, 'terminal fence'),
  };
}

function assertSafeProjection(projection) {
  if (projection == null) return null;
  if (!isObject(projection)) throw new Error('safe projection must be an object');
  const keys = Object.keys(projection);
  if (keys.some((key) => !SAFE_PROJECTION_KEYS.has(key))) throw new Error('safe projection contains unsupported fields');
  if (keys.length > 6) throw new Error('safe projection is too large');
  for (const [key, value] of Object.entries(projection)) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 240 || value.trim() !== value || FORBIDDEN_TEXT.test(value)) {
      throw new Error(`safe projection ${key} is invalid`);
    }
  }
  if (projection.digest != null && !/^sha256:[a-f0-9]{64}$/i.test(projection.digest)) throw new Error('safe projection digest is invalid');
  return clone(projection);
}

function assertResult(result, outcome) {
  if (result == null) {
    if (outcome === 'completed') throw new Error('result digest is required for completed terminal outcome');
    return null;
  }
  if (!isObject(result)) throw new Error('terminal result must be an object');
  const normalized = {
    digest: digestBinding(result.digest, 'result digest'),
    handle: opaque(result.handle, 'result handle'),
  };
  return normalized;
}

function waitIdentity(input) {
  return {
    workId: opaque(input.workId, 'workId'),
    actionKey: opaque(input.actionKey, 'actionKey'),
    origin: assertOrigin(input.origin),
    expectedTerminal: assertExpectedTerminal(input.expectedTerminal),
  };
}

function validateEventIds(value) {
  if (!isObject(value)) throw new Error('session wait eventIds are required');
  opaque(value.registration, 'registration event id');
  for (const key of ['terminal', 'decision', 'delivery']) {
    if (value[key] != null) opaque(value[key], `${key} event id`);
  }
  return value;
}

function validateDelivery(value) {
  if (!isObject(value)) throw new Error('session wait delivery is required');
  if (!['none', 'immediate', 'queued_next_hook', 'hook_claimed', 'uncertain'].includes(value.disposition)) {
    throw new Error('session wait delivery disposition is invalid');
  }
  for (const key of ['claimedAt', 'queuedAt', 'consumedAt']) {
    if (value[key] != null) normalizeTimestamp(value[key]);
  }
  if (value.deliveredReceipt != null) opaque(value.deliveredReceipt, 'delivered receipt');
  return value;
}

function validateSessionWait(value) {
  if (!isObject(value) || value.schemaVersion !== SESSION_WAIT_SCHEMA_VERSION || value.contractVersion !== SESSION_WAIT_CONTRACT_VERSION) {
    throw new Error('session wait schema or contract version is unsupported');
  }
  opaque(value.waitId, 'waitId');
  waitIdentity(value);
  normalizeTimestamp(value.createdAt);
  normalizeTimestamp(value.updatedAt);
  normalizeTimestamp(value.deadline);
  opaque(value.deadlineWakeSource, 'deadline wake source');
  observationWindow(value.deadlineObservationWindowMs);
  if (!SESSION_WAIT_STATES.includes(value.state)) throw new Error('session wait state is invalid');
  validateEventIds(value.eventIds);
  validateDelivery(value.delivery);
  assertSafeProjection(value.safeProjection);
  if (value.resultDigest != null) digestBinding(value.resultDigest, 'resultDigest');
  return true;
}

function createSessionWait(input = {}) {
  const identity = waitIdentity(input);
  const waitId = input.waitId || `session-wait:${digest(identity).slice(0, 48)}`;
  opaque(waitId, 'waitId');
  const createdAt = normalizeTimestamp(input.createdAt);
  const record = {
    schemaVersion: SESSION_WAIT_SCHEMA_VERSION,
    contractVersion: SESSION_WAIT_CONTRACT_VERSION,
    waitId,
    workId: identity.workId,
    actionKey: identity.actionKey,
    origin: identity.origin,
    expectedTerminal: identity.expectedTerminal,
    state: 'registered',
    deadline: normalizeTimestamp(input.deadline),
    deadlineWakeSource: opaque(input.deadlineWakeSource || DEFAULT_DEADLINE_WAKE_SOURCE, 'deadline wake source'),
    deadlineObservationWindowMs: observationWindow(input.deadlineObservationWindowMs == null
      ? DEFAULT_DEADLINE_OBSERVATION_WINDOW_MS : input.deadlineObservationWindowMs),
    createdAt,
    updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    resultDigest: null,
    safeProjection: null,
    eventIds: {
      registration: `session-wait-registration:${digest({ waitId, createdAt }).slice(0, 48)}`,
      terminal: null,
      decision: null,
      delivery: null,
    },
    delivery: {
      disposition: 'none',
      claimedAt: null,
      deliveredReceipt: null,
      queuedAt: null,
      consumedAt: null,
    },
  };
  validateSessionWait(record);
  return record;
}

function createTerminalReceipt(input = {}) {
  const current = input.wait;
  validateSessionWait(current);
  if (input.waitId != null && input.waitId !== current.waitId) throw new Error('terminal receipt waitId does not match');
  const expected = current.expectedTerminal;
  if (input.producer !== expected.producer) throw new Error('terminal receipt producer does not match');
  if (input.eventType !== expected.eventType) throw new Error('terminal receipt event type does not match');
  if (input.subject !== expected.subject) throw new Error('terminal receipt subject does not match');
  if (String(input.revision) !== expected.revision) throw new Error('terminal receipt revision does not match');
  if ((input.fence || null) !== expected.fence) throw new Error('terminal receipt fence does not match');
  if (!TERMINAL_OUTCOMES.includes(input.outcome)) throw new Error('terminal receipt outcome is invalid');
  const receiptId = opaque(input.receiptId, 'receiptId');
  const result = assertResult(input.result, input.outcome);
  const safeProjection = assertSafeProjection(input.safeProjection);
  const occurredAt = normalizeTimestamp(input.occurredAt);
  const body = {
    schemaVersion: SESSION_WAIT_SCHEMA_VERSION,
    contractVersion: SESSION_WAIT_CONTRACT_VERSION,
    receiptId,
    waitId: current.waitId,
    producer: expected.producer,
    eventType: expected.eventType,
    subject: expected.subject,
    revision: expected.revision,
    fence: expected.fence,
    outcome: input.outcome,
    occurredAt,
    result,
    safeProjection,
  };
  return { ...body, receiptDigest: `sha256:${digest(body)}` };
}

const TRANSITIONS = {
  registered: new Set(['waiting', 'cancelled', 'superseded']),
  waiting: new Set(['terminal_observed', 'expired_missing_result', 'cancelled', 'superseded']),
  terminal_observed: new Set(['delivery_claimed', 'cancelled', 'superseded']),
  delivery_claimed: new Set(['delivered', 'queued', 'delivery_uncertain']),
  delivered: new Set(['consumed']),
  queued: new Set(['consumed', 'delivery_uncertain']),
  delivery_uncertain: new Set(['queued', 'consumed', 'cancelled', 'superseded']),
  consumed: new Set(),
  expired_missing_result: new Set(['delivery_claimed', 'queued', 'delivery_uncertain', 'consumed']),
  cancelled: new Set(),
  superseded: new Set(),
};

function transitionSessionWait(current, nextState, patch = {}) {
  validateSessionWait(current);
  if (!SESSION_WAIT_STATES.includes(nextState) || !TRANSITIONS[current.state]?.has(nextState)) {
    throw new Error(`invalid session wait transition: ${current.state} -> ${nextState}`);
  }
  const next = clone(current);
  next.state = nextState;
  next.updatedAt = normalizeTimestamp(patch.at, current.updatedAt);
  if (patch.terminalReceiptId != null) next.eventIds.terminal = opaque(patch.terminalReceiptId, 'terminal receipt id');
  if (patch.decisionId != null) next.eventIds.decision = opaque(patch.decisionId, 'decision id');
  if (patch.deliveryId != null) next.eventIds.delivery = opaque(patch.deliveryId, 'delivery id');
  if (patch.resultDigest != null) next.resultDigest = digestBinding(patch.resultDigest, 'resultDigest');
  if (patch.safeProjection !== undefined) next.safeProjection = assertSafeProjection(patch.safeProjection);
  if (patch.delivery) next.delivery = validateDelivery({ ...next.delivery, ...patch.delivery });
  validateSessionWait(next);
  return next;
}

function projectSessionWait(current) {
  validateSessionWait(current);
  return {
    schemaVersion: SESSION_WAIT_SCHEMA_VERSION,
    contractVersion: SESSION_WAIT_CONTRACT_VERSION,
    waitId: current.waitId,
    workId: current.workId,
    actionKey: current.actionKey,
    origin: {
      harness: current.origin.harness,
      stableSessionId: current.origin.stableSessionId,
      adapterGeneration: current.origin.adapterGeneration,
    },
    state: current.state,
    deadline: current.deadline,
    deadlineWakeSource: current.deadlineWakeSource,
    deadlineObservationWindowMs: current.deadlineObservationWindowMs,
    resultDigest: current.resultDigest,
    safeProjection: current.safeProjection,
    delivery: current.delivery,
    eventIds: current.eventIds,
    updatedAt: current.updatedAt,
  };
}

module.exports = {
  SESSION_WAIT_CONTRACT_VERSION,
  SESSION_WAIT_SCHEMA_VERSION,
  DEFAULT_DEADLINE_WAKE_SOURCE,
  DEFAULT_DEADLINE_OBSERVATION_WINDOW_MS,
  SESSION_WAIT_STATES,
  TERMINAL_OUTCOMES,
  createSessionWait,
  createTerminalReceipt,
  projectSessionWait,
  transitionSessionWait,
  validateSessionWait,
};
