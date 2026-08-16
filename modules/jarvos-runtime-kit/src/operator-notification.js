'use strict';

const crypto = require('crypto');

// This is intentionally an unstable 0.x contract. Producers must retain their
// detailed diagnostics privately and send this module only reviewed semantics.
const OPERATOR_NOTIFICATION_SCHEMA_VERSION = 'jarvos-operator-notification/v1';
const NO_REPLY = 'NO_REPLY';
const AUDIENCES = new Set(['operator']);
const SEVERITIES = new Set(['info', 'warning', 'error', 'security']);
const AUTOMATION_OUTCOMES = new Set(['none', 'safe-hold', 'repaired', 'resolved', 'failed']);
const FRESHNESS_STATES = new Set(['current', 'stale', 'unknown']);
const ACTIONS = new Set(['none', 'review-release', 'choose-recovery', 'review-safety-hold']);
const NEXT_STATES = new Set(['none', 'continue-monitoring', 'wait-for-fresh-observation', 'resume-after-review']);
const EVENT_CODES = new Set(['release-state', 'safety-hold', 'recovery-failed', 'repair-complete', 'resolution-complete']);
const EVENT_FIELDS = new Set([
  'schemaVersion', 'code', 'audience', 'severity', 'automationOutcome',
  'actionRequired', 'action', 'nextState', 'eventReference', 'dedupeKey',
  'observedAt', 'freshness', 'privateDetailReference', 'release',
]);

const ACTION_TEXT = {
  'review-release': 'Review the proposed release before it can publish.',
  'choose-recovery': 'Choose how jarvOS should proceed.',
  'review-safety-hold': 'Review the held change and choose whether to continue.',
};
const NEXT_TEXT = {
  'continue-monitoring': 'jarvOS will continue monitoring safely.',
  'wait-for-fresh-observation': 'jarvOS will keep monitoring for a fresh observation.',
  'resume-after-review': 'after your review, jarvOS will continue the release process.',
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSemanticVersion(value) {
  return typeof value === 'string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function isBoundedIdentifier(value, { min = 1, max = 120 } = {}) {
  return typeof value === 'string' && value.length >= min && value.length <= max
    && /^[a-z][a-z0-9-]*$/.test(value);
}

function isOpaqueReference(value) {
  // A base64url token of this length has enough entropy to be non-guessable
  // when minted by the owner-authorized context. Its contents are never shown
  // other than as the correlation reference for an action-required message.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value);
}

function isIsoTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validateRelease(release, errors) {
  if (!isObject(release)) {
    errors.push('release must be an object');
    return;
  }
  const allowed = new Set(['publishedVersion', 'approvalReadyVersion', 'futureVersion']);
  for (const key of Object.keys(release)) if (!allowed.has(key)) errors.push(`release has unknown field: ${key}`);
  for (const field of ['publishedVersion', 'approvalReadyVersion', 'futureVersion']) {
    if (!isSemanticVersion(release[field])) errors.push(`release.${field} must be a semantic version`);
  }
}

function validateOperatorNotificationEvent(event) {
  const errors = [];
  if (!isObject(event)) return { ok: false, errors: ['operator notification event must be an object'] };
  for (const key of Object.keys(event)) if (!EVENT_FIELDS.has(key)) errors.push(`operator notification event has unknown field: ${key}`);
  if (event.schemaVersion !== OPERATOR_NOTIFICATION_SCHEMA_VERSION) errors.push(`event.schemaVersion must be ${OPERATOR_NOTIFICATION_SCHEMA_VERSION}`);
  if (!isBoundedIdentifier(event.code)) errors.push('event.code must be a bounded stable identifier');
  if (isBoundedIdentifier(event.code) && !EVENT_CODES.has(event.code)) errors.push('event.code is not a supported operator notification code');
  if (!AUDIENCES.has(event.audience)) errors.push('event.audience must be operator');
  if (!SEVERITIES.has(event.severity)) errors.push('event.severity is invalid');
  if (!AUTOMATION_OUTCOMES.has(event.automationOutcome)) errors.push('event.automationOutcome is invalid');
  if (typeof event.actionRequired !== 'boolean') errors.push('event.actionRequired must be boolean');
  if (!ACTIONS.has(event.action)) errors.push('event.action is invalid');
  if (!NEXT_STATES.has(event.nextState)) errors.push('event.nextState is invalid');
  if (event.actionRequired && event.action === 'none') errors.push('action-required events need a reviewed action');
  if (!event.actionRequired && event.action !== 'none') errors.push('non-action events must use action none');
  if (!isOpaqueReference(event.eventReference)) errors.push('event.eventReference must be an opaque reference');
  if (!isBoundedIdentifier(event.dedupeKey, { max: 180 })) errors.push('event.dedupeKey must be a bounded stable identifier');
  if (!isIsoTime(event.observedAt)) errors.push('event.observedAt must be an ISO-8601 UTC timestamp');
  if (!FRESHNESS_STATES.has(event.freshness)) errors.push('event.freshness is invalid');
  if (event.privateDetailReference !== undefined && !isOpaqueReference(event.privateDetailReference)) errors.push('event.privateDetailReference must be an opaque reference');
  if (event.code === 'release-state') validateRelease(event.release, errors);
  if (event.code !== 'release-state' && event.release !== undefined) errors.push('release is only valid for release-state events');
  if (event.code === 'release-state' && event.freshness !== 'current' && event.actionRequired) errors.push('stale or unknown release evidence cannot request release review');
  return { ok: errors.length === 0, errors, value: event };
}

function assertOperatorNotificationEvent(event) {
  const validation = validateOperatorNotificationEvent(event);
  if (!validation.ok) throw new TypeError(validation.errors.join('; '));
  return event;
}

function notificationDedupeIdentity(event) {
  assertOperatorNotificationEvent(event);
  return crypto.createHash('sha256')
    .update(`${event.schemaVersion}\0${event.code}\0${event.dedupeKey}\0${event.actionRequired}\0${event.freshness}`)
    .digest('hex');
}

function releaseMessage(event) {
  const { publishedVersion, approvalReadyVersion, futureVersion } = event.release;
  if (event.freshness === 'current') {
    return `jarvOS ${publishedVersion} is currently published. A proposed ${approvalReadyVersion} release has passed checks and is ready for Andrew's review; nothing will publish automatically. The separate ${futureVersion} milestone remains future work.`;
  }
  const qualifier = event.freshness === 'stale' ? 'stale' : 'unconfirmed';
  return `jarvOS last observed ${publishedVersion} as published, but that observation is ${qualifier}. The proposed ${approvalReadyVersion} release needs a fresh check before it can be reviewed. The separate ${futureVersion} milestone remains future work.`;
}

function eventMessage(event) {
  if (event.code === 'release-state') return releaseMessage(event);
  if (event.code === 'safety-hold') return 'jarvOS paused an unsafe change and left the existing setup unchanged.';
  if (event.code === 'recovery-failed') return 'jarvOS could not complete a safe recovery and preserved the existing state.';
  if (event.code === 'repair-complete') return 'jarvOS completed a safe repair.';
  if (event.code === 'resolution-complete') return 'jarvOS resolved the condition safely.';
  return null;
}

function renderMessage(event) {
  const parts = [eventMessage(event)];
  if (event.actionRequired) {
    parts.push(`Action required: ${ACTION_TEXT[event.action]}`);
    parts.push(`Next: ${NEXT_TEXT[event.nextState] || 'jarvOS will wait for your direction.'}`);
    parts.push(`Reference: ${event.eventReference}.`);
  } else {
    parts.push('No action is needed from you.');
    if (event.nextState !== 'none') parts.push(`Next: ${NEXT_TEXT[event.nextState]}`);
  }
  return parts.join(' ');
}

function evaluateOperatorNotification(event) {
  assertOperatorNotificationEvent(event);
  const direct = event.actionRequired;
  const message = renderMessage(event);
  if (direct) {
    return {
      disposition: 'direct-notification',
      output: message,
      statusMessage: null,
      dedupeIdentity: notificationDedupeIdentity(event),
    };
  }
  const durableStatus = event.automationOutcome === 'safe-hold'
    || (event.code === 'release-state' && event.freshness !== 'current');
  return {
    disposition: durableStatus ? 'durable-status' : 'quiet',
    output: NO_REPLY,
    statusMessage: durableStatus ? message : null,
    dedupeIdentity: notificationDedupeIdentity(event),
  };
}

function renderOperatorNotification(event) {
  return evaluateOperatorNotification(event).output;
}

module.exports = {
  ACTIONS,
  AUTOMATION_OUTCOMES,
  FRESHNESS_STATES,
  NO_REPLY,
  OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  assertOperatorNotificationEvent,
  evaluateOperatorNotification,
  notificationDedupeIdentity,
  renderOperatorNotification,
  validateOperatorNotificationEvent,
};
