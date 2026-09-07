'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  NO_REPLY,
  OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  evaluateOperatorNotification,
  notificationDedupeIdentity,
  renderOperatorNotification,
  validateOperatorNotificationEvent,
} = require('../src');

const EVENT_REFERENCE = 'uTQf8DG1p9Ck5Lm3Nw2RzAqB';

function event(overrides = {}) {
  return {
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    code: 'recovery-failed',
    audience: 'operator',
    severity: 'error',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'choose-recovery',
    nextState: 'continue-monitoring',
    eventReference: EVENT_REFERENCE,
    dedupeKey: 'recovery-window-42',
    observedAt: '2026-08-16T12:30:00Z',
    freshness: 'current',
    privateDetailReference: 'jJ3xbPq7YvmT0n6eC1fKrS9D',
    ...overrides,
  };
}

test('action-required events answer what happened, what jarvOS did, the action, and next step', () => {
  const output = renderOperatorNotification(event());
  assert.equal(output, "jarvOS could not complete a safe recovery and preserved the existing state. Action required: Choose how jarvOS should proceed. Next: jarvOS will continue monitoring safely. Reference: uTQf8DG1p9Ck5Lm3Nw2RzAqB.");
});

test('safe holds remain durable status with first-seen and occurrence information outside the renderer', () => {
  const result = evaluateOperatorNotification(event({
    code: 'safety-hold',
    severity: 'warning',
    automationOutcome: 'safe-hold',
    actionRequired: false,
    action: 'none',
    nextState: 'continue-monitoring',
  }));
  assert.equal(result.output, NO_REPLY);
  assert.equal(result.disposition, 'durable-status');
  assert.equal(result.statusMessage, 'jarvOS paused an unsafe change and left the existing setup unchanged. No action is needed from you. Next: jarvOS will continue monitoring safely.');
});

test('routine safe repairs and resolutions stay quiet', () => {
  const result = evaluateOperatorNotification(event({
    code: 'repair-complete',
    severity: 'info',
    automationOutcome: 'repaired',
    actionRequired: false,
    action: 'none',
    nextState: 'none',
  }));
  assert.equal(result.output, NO_REPLY);
  assert.equal(result.disposition, 'quiet');
  assert.equal(result.statusMessage, null);
});

test('validation rejects free prose and private or raw diagnostic fields before rendering', () => {
  for (const unsafe of [
    { diagnostic: 'unsafe_source at /Users/andrew/private' },
    { action: 'call the private skill immediately' },
    { nextState: 'read receipt-123 and retry' },
    { sourceSha: '8cb3909' },
    { stack: 'Error: failed\n at private.js:1:1' },
  ]) {
    const result = validateOperatorNotificationEvent(event(unsafe));
    assert.equal(result.ok, false, JSON.stringify(result.errors));
  }
});

test('unknown codes are rejected before rendering', () => {
  const result = validateOperatorNotificationEvent(event({ code: 'new-private-machine-code' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /not a supported operator notification code/);
});

test('evaluation and dedupe identity are deterministic', () => {
  const input = event();
  assert.deepEqual(evaluateOperatorNotification(input), evaluateOperatorNotification(input));
  assert.equal(notificationDedupeIdentity(input), notificationDedupeIdentity(input));
});

test('current release evidence distinguishes published, approval-ready, and future lanes', () => {
  const output = renderOperatorNotification(event({
    code: 'release-state',
    severity: 'info',
    automationOutcome: 'none',
    actionRequired: true,
    action: 'review-release',
    nextState: 'resume-after-review',
    release: {
      publishedVersion: '0.7.0',
      approvalReadyVersion: '0.8.0',
      futureVersion: 'v1.0.0',
    },
  }));
  assert.equal(output, "jarvOS 0.7.0 is currently published. A proposed 0.8.0 release has passed checks and is ready for Andrew's review; nothing will publish automatically. The separate v1.0.0 milestone remains future work. Action required: Review the proposed release before it can publish. Next: after your review, jarvOS will continue the release process. Reference: uTQf8DG1p9Ck5Lm3Nw2RzAqB.");
  assert.equal(output.includes('8cb3909'), false);
});

test('stale or unknown release evidence uses qualified wording and stays quiet when no action is required', () => {
  for (const freshness of ['stale', 'unknown']) {
    const result = evaluateOperatorNotification(event({
      code: 'release-state',
      severity: 'warning',
      automationOutcome: 'none',
      actionRequired: false,
      action: 'none',
      nextState: 'wait-for-fresh-observation',
      freshness,
      release: {
        publishedVersion: '0.7.0',
        approvalReadyVersion: '0.8.0',
        futureVersion: 'v1.0.0',
      },
    }));
    assert.equal(result.output, NO_REPLY);
    assert.equal(result.disposition, 'durable-status');
    assert.match(result.statusMessage, /last observed 0\.7\.0 as published/);
    assert.doesNotMatch(result.statusMessage, /currently published|ready for Andrew's review/);
    assert.equal(renderOperatorNotification(event({
      code: 'release-state', severity: 'warning', automationOutcome: 'safe-hold', actionRequired: false,
      action: 'none', nextState: 'wait-for-fresh-observation', freshness,
      release: { publishedVersion: '0.7.0', approvalReadyVersion: '0.8.0', futureVersion: 'v1.0.0' },
    })), NO_REPLY);
  }
});

test('stale release evidence cannot request approval', () => {
  const result = validateOperatorNotificationEvent(event({
    code: 'release-state', action: 'review-release', freshness: 'stale',
    release: { publishedVersion: '0.7.0', approvalReadyVersion: '0.8.0', futureVersion: 'v1.0.0' },
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /cannot request release review/);
});

test('skill owner decision names the held skill and gives exact plain-English choices', () => {
  const output = renderOperatorNotification({
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    code: 'skill-owner-decision',
    audience: 'operator',
    severity: 'warning',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'choose-skill-option',
    nextState: 'await-owner-decision',
    eventReference: EVENT_REFERENCE,
    decisionReference: EVENT_REFERENCE,
    revision: 1,
    optionSetVersion: 'v1',
    skillName: 'newsletter-generator',
    reasonCode: 'needs_owner_input',
    options: ['share', 'keep-local', 'exclude', 'details'],
    dedupeKey: 'skill-owner-decision-newsletter-generator',
    observedAt: '2026-08-16T12:30:00Z',
    freshness: 'current',
    privateDetailReference: 'jJ3xbPq7YvmT0n6eC1fKrS9D',
  });
  assert.match(output, /found the newsletter-generator skill/);
  assert.match(output, /did not share it because it needs your approval/);
  assert.match(output, /Nothing changed/);
  assert.match(output, /Reply “share”/);
  assert.match(output, /reply “keep local”/);
  assert.match(output, /reply “exclude”/);
  assert.match(output, /reply “details”/);
  assert.match(output, /leave the skill unchanged until you choose an option/);
  assert.doesNotMatch(output, /needs_owner_input|SKILL\.md|\//);
});

test('skill decision summaries are actionable without exposing internal identifiers', () => {
  const event = {
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    code: 'skill-decision-summary',
    audience: 'operator',
    severity: 'warning',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'review-decisions',
    nextState: 'await-owner-decision',
    eventReference: EVENT_REFERENCE,
    dedupeKey: 'skill-decision-migration-abc123',
    observedAt: '2026-08-16T12:30:00Z',
    freshness: 'current',
    itemCount: 28,
    resolvedCount: 1,
  };
  const output = renderOperatorNotification(event);
  assert.match(output, /28 skills that still need your decision/);
  assert.match(output, /left them unchanged/);
  assert.match(output, /confirmed that 1 earlier item is resolved/);
  assert.match(output, /Review the pending decisions/);
  assert.doesNotMatch(output, /resolvedCount|needs_owner_input|decision-/);
});

test('skill notification fields stay scoped to their event kind and options remain strings', () => {
  const summaryWithSkillFields = validateOperatorNotificationEvent({
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    code: 'skill-decision-summary',
    audience: 'operator',
    severity: 'warning',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'review-decisions',
    nextState: 'await-owner-decision',
    eventReference: EVENT_REFERENCE,
    dedupeKey: 'skill-decision-summary-1',
    observedAt: '2026-08-16T12:30:00Z',
    freshness: 'current',
    itemCount: 1,
    skillName: '/Users/andrew/private/skill',
  });
  assert.equal(summaryWithSkillFields.ok, false);
  assert.match(summaryWithSkillFields.errors.join('\n'), /skillName is only valid for individual skill decisions/);

  const individualDecision = {
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    code: 'skill-owner-decision',
    audience: 'operator',
    severity: 'warning',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'choose-skill-option',
    nextState: 'await-owner-decision',
    eventReference: EVENT_REFERENCE,
    decisionReference: EVENT_REFERENCE,
    revision: 1,
    optionSetVersion: 'v1',
    skillName: 'newsletter-generator',
    reasonCode: 'needs_owner_input',
    options: ['share'],
    dedupeKey: 'skill-owner-decision-1',
    observedAt: '2026-08-16T12:30:00Z',
    freshness: 'current',
    itemCount: 1,
  };
  const decisionWithSummaryFields = validateOperatorNotificationEvent(individualDecision);
  assert.equal(decisionWithSummaryFields.ok, false);
  assert.match(decisionWithSummaryFields.errors.join('\n'), /itemCount is only valid for skill decision summaries/);

  const objectOption = validateOperatorNotificationEvent({
    ...individualDecision,
    itemCount: undefined,
    options: [{ toString: () => 'share' }],
  });
  assert.equal(objectOption.ok, false);
  assert.match(objectOption.errors.join('\n'), /unsupported or duplicate choice/);
});
