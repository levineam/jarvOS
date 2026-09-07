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
const ACTIONS = new Set(['none', 'review-release', 'choose-recovery', 'review-safety-hold', 'choose-skill-option', 'review-decisions']);
const NEXT_STATES = new Set(['none', 'continue-monitoring', 'wait-for-fresh-observation', 'resume-after-review', 'await-owner-decision']);
const EVENT_CODES = new Set([
  'release-state', 'safety-hold', 'recovery-failed', 'repair-complete', 'resolution-complete',
  'skill-owner-decision', 'skill-decision-summary',
]);
const EVENT_FIELDS = new Set([
  'schemaVersion', 'code', 'audience', 'severity', 'automationOutcome',
  'actionRequired', 'action', 'nextState', 'eventReference', 'dedupeKey',
  'observedAt', 'freshness', 'privateDetailReference', 'release',
  'skillName', 'reasonCode', 'options', 'decisionReference', 'revision',
  'optionSetVersion', 'deliveryAttemptId', 'deliveryAttemptKind', 'itemCount', 'resolvedCount',
]);

const SKILL_REASON_CODES = new Set([
  'needs_owner_input', 'semantic_collision', 'ambiguous_identity',
  'capability_unsupported', 'source_absent',
]);
const SKILL_OPTIONS = new Set(['share', 'keep-local', 'exclude', 'details']);
const SKILL_DECISION_FIELDS = ['skillName', 'reasonCode', 'options', 'decisionReference', 'revision', 'optionSetVersion', 'deliveryAttemptId', 'deliveryAttemptKind'];
const SKILL_SUMMARY_FIELDS = ['itemCount', 'resolvedCount'];

const ACTION_TEXT = {
  'review-release': 'Review the proposed release before it can publish.',
  'choose-recovery': 'Choose how jarvOS should proceed.',
  'review-safety-hold': 'Review the held change and choose whether to continue.',
  'choose-skill-option': 'Choose one of the listed options for this skill.',
  'review-decisions': 'Review the pending skill decisions in jarvOS shared skills.',
};
const NEXT_TEXT = {
  'continue-monitoring': 'jarvOS will continue monitoring safely.',
  'wait-for-fresh-observation': 'jarvOS will keep monitoring for a fresh observation.',
  'resume-after-review': 'after your review, jarvOS will continue the release process.',
  'await-owner-decision': 'jarvOS will leave the skill unchanged until you choose an option.',
};

const SKILL_REASON_TEXT = {
  needs_owner_input: 'it needs your approval before jarvOS can share it',
  semantic_collision: 'its name conflicts with another skill',
  ambiguous_identity: 'jarvOS found more than one possible source for it',
  capability_unsupported: 'its capabilities do not match every target harness',
  source_absent: 'its source is no longer available',
};

const SKILL_OPTION_TEXT = {
  share: 'Reply “share” to copy it to compatible AI tools',
  'keep-local': 'reply “keep local” to leave it where it is',
  exclude: 'reply “exclude” to stop offering it',
  details: 'reply “details” to review more information without changing anything',
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

function validateSkillDecision(event, errors) {
  if (!isBoundedIdentifier(event.skillName, { max: 80 })) errors.push('skill-owner-decision.skillName is invalid');
  if (!SKILL_REASON_CODES.has(event.reasonCode)) errors.push('skill-owner-decision.reasonCode is invalid');
  if (!isOpaqueReference(event.decisionReference)) errors.push('skill-owner-decision.decisionReference is invalid');
  if (event.eventReference !== event.decisionReference) errors.push('skill-owner-decision.eventReference must match decisionReference');
  if (!Number.isInteger(event.revision) || event.revision < 1 || event.revision > 1000000) errors.push('skill-owner-decision.revision is invalid');
  if (typeof event.optionSetVersion !== 'string' || !/^v[0-9]+$/.test(event.optionSetVersion)) errors.push('skill-owner-decision.optionSetVersion is invalid');
  if (event.deliveryAttemptId !== undefined && !isOpaqueReference(event.deliveryAttemptId)) errors.push('skill-owner-decision.deliveryAttemptId is invalid');
  if (event.deliveryAttemptKind !== undefined && !['initial', 'fallback'].includes(event.deliveryAttemptKind)) errors.push('skill-owner-decision.deliveryAttemptKind is invalid');
  if ((event.deliveryAttemptId === undefined) !== (event.deliveryAttemptKind === undefined)) errors.push('skill-owner-decision delivery attempt fields must be provided together');
  if (!Array.isArray(event.options) || event.options.length < 1 || event.options.length > 4) {
    errors.push('skill-owner-decision.options must contain one to four choices');
  } else {
    const choices = event.options;
    if (choices.some((option) => typeof option !== 'string')
      || new Set(choices).size !== choices.length
      || choices.some((option) => !SKILL_OPTIONS.has(option))) {
      errors.push('skill-owner-decision.options contains an unsupported or duplicate choice');
    }
  }
  if (event.action !== 'choose-skill-option' || event.nextState !== 'await-owner-decision' || event.actionRequired !== true) {
    errors.push('skill-owner-decision must require a skill option and await the owner decision');
  }
}

function validateSkillDecisionSummary(event, errors) {
  if (!Number.isInteger(event.itemCount) || event.itemCount < 1 || event.itemCount > 10000) errors.push('skill-decision-summary.itemCount is invalid');
  if (event.resolvedCount !== undefined && (!Number.isInteger(event.resolvedCount) || event.resolvedCount < 0 || event.resolvedCount > 10000)) {
    errors.push('skill-decision-summary.resolvedCount is invalid');
  }
  if (event.action !== 'review-decisions' || event.nextState !== 'await-owner-decision' || event.actionRequired !== true) {
    errors.push('skill-decision-summary must require decision review and await the owner');
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
  if (event.code === 'skill-owner-decision') validateSkillDecision(event, errors);
  if (event.code === 'skill-decision-summary') validateSkillDecisionSummary(event, errors);
  if (event.code === 'skill-owner-decision') {
    for (const field of SKILL_SUMMARY_FIELDS) {
      if (event[field] !== undefined) errors.push(`${field} is only valid for skill decision summaries`);
    }
  }
  if (event.code === 'skill-decision-summary') {
    for (const field of SKILL_DECISION_FIELDS) {
      if (event[field] !== undefined) errors.push(`${field} is only valid for individual skill decisions`);
    }
  }
  if (!['skill-owner-decision', 'skill-decision-summary'].includes(event.code)) {
    for (const field of [...SKILL_DECISION_FIELDS, ...SKILL_SUMMARY_FIELDS]) {
      if (event[field] !== undefined) errors.push(`${field} is only valid for skill decision events`);
    }
  }
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

function skillDecisionMessage(event) {
  const reason = SKILL_REASON_TEXT[event.reasonCode];
  return `jarvOS found the ${event.skillName} skill but did not share it because ${reason}. Nothing changed.`;
}

function skillDecisionSummaryMessage(event) {
  const count = `${event.itemCount} skill${event.itemCount === 1 ? '' : 's'}`;
  const resolved = event.resolvedCount > 0
    ? ` It also confirmed that ${event.resolvedCount} earlier item${event.resolvedCount === 1 ? '' : 's'} ${event.resolvedCount === 1 ? 'is' : 'are'} resolved.`
    : '';
  return `jarvOS found ${count} that still need your decision. It left them unchanged.${resolved} Review the pending decisions in jarvOS shared skills; nothing will be shared automatically until you choose.`;
}

function eventMessage(event) {
  if (event.code === 'release-state') return releaseMessage(event);
  if (event.code === 'skill-owner-decision') return skillDecisionMessage(event);
  if (event.code === 'skill-decision-summary') return skillDecisionSummaryMessage(event);
  if (event.code === 'safety-hold') return 'jarvOS paused an unsafe change and left the existing setup unchanged.';
  if (event.code === 'recovery-failed') return 'jarvOS could not complete a safe recovery and preserved the existing state.';
  if (event.code === 'repair-complete') return 'jarvOS completed a safe repair.';
  if (event.code === 'resolution-complete') return 'jarvOS resolved the condition safely.';
  return null;
}

function renderMessage(event) {
  const parts = [eventMessage(event)];
  if (event.code === 'skill-owner-decision') {
    parts.push(`Choices: ${event.options.map((option) => SKILL_OPTION_TEXT[option]).join('; ')}.`);
  }
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
