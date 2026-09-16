'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  NO_REPLY,
  OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  chunkSkillDecisions,
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

function decisionEvent(overrides = {}) {
  return {
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
    skillName: 'use-anthropic',
    reasonCode: 'source_absent',
    options: ['keep-local', 'exclude', 'details'],
    affectedHarnesses: ['claude', 'hermes', 'openclaw'],
    preservedState: 'shared-copies-kept',
    dedupeKey: 'skill-owner-decision-1-hour-2026-08-16t12',
    observedAt: '2026-08-16T12:30:00Z',
    freshness: 'current',
    ...overrides,
  };
}

test('skill owner decision states the skill, affected tools, cause, preserved state, recovery, exact choices, and hourly reminders', () => {
  const output = renderOperatorNotification(decisionEvent());
  assert.match(output, /found the use-anthropic skill but did not share it with Claude, Hermes, and OpenClaw because its source is no longer available\./);
  assert.match(output, /Nothing was removed: the copies it already shared stay in place\./);
  assert.match(output, /To fix it, restore the skill folder, or tell jarvOS to stop offering it\./);
  assert.match(output, /Choices: reply “keep local” to leave it where it is; reply “exclude” to stop offering it; reply “details”/);
  assert.match(output, /remind you every hour until you choose; ignoring this message does not pause reminders/);
  assert.match(output, /“acknowledge”/);
  assert.match(output, /“defer until”/);
  assert.match(output, /“resume”/);
  assert.doesNotMatch(output, /source_absent|shared-copies-kept|\/|[a-f0-9]{24}/);
  assert.match(renderOperatorNotification(decisionEvent({ affectedHarnesses: ['codex'], preservedState: 'unchanged', reasonCode: 'ambiguous_identity' })),
    /did not share it with Codex because jarvOS found more than one possible source for it\. Nothing changed/);
});

test('owner decision facts are allowlisted and scoped to individual decisions', () => {
  for (const unsafe of [
    { affectedHarnesses: ['/Users/andrew/.claude/skills'] },
    { affectedHarnesses: ['claude', 'claude'] },
    { affectedHarnesses: 'claude' },
    { preservedState: 'kept /Users/andrew/private intact' },
    { sourcePath: '/Users/andrew/private/use-anthropic' },
  ]) {
    const result = validateOperatorNotificationEvent(decisionEvent(unsafe));
    assert.equal(result.ok, false, JSON.stringify(unsafe));
  }
  const summary = validateOperatorNotificationEvent({
    ...event({ code: 'skill-decision-summary', severity: 'warning', action: 'review-decisions', nextState: 'await-owner-decision' }),
    itemCount: 2,
    affectedHarnesses: ['claude'],
  });
  assert.equal(summary.ok, false);
  assert.match(summary.errors.join('\n'), /affectedHarnesses is only valid for individual skill decisions/);
  const recovery = validateOperatorNotificationEvent(event({ preservedState: 'unchanged' }));
  assert.equal(recovery.ok, false);
  assert.match(recovery.errors.join('\n'), /preservedState is only valid for skill decision events/);
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

function batchItem(index, overrides = {}) {
  return {
    skillName: ['newsletter-generator', 'use-anthropic', 'weekly-review', 'deploy-helper'][index],
    reasonCode: 'needs_owner_input',
    options: ['share', 'keep-local', 'exclude', 'details'],
    decisionReference: `ItemReference0123456789${index}`,
    revision: 1,
    ...overrides,
  };
}

function batchEvent(overrides = {}) {
  return {
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    code: 'skill-owner-decision-batch',
    audience: 'operator',
    severity: 'warning',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'choose-skill-options',
    nextState: 'await-owner-decision',
    eventReference: EVENT_REFERENCE,
    optionSetVersion: 'v1',
    decisions: [
      batchItem(0, { affectedHarnesses: ['claude', 'hermes'], preservedState: 'unchanged' }),
      batchItem(1, {
        reasonCode: 'source_absent', options: ['keep-local', 'exclude', 'details'],
        affectedHarnesses: ['claude', 'hermes', 'openclaw'], preservedState: 'shared-copies-kept',
      }),
    ],
    dedupeKey: 'skill-owner-decision-batch-1-hour-2026-08-16t12',
    observedAt: '2026-08-16T12:30:00Z',
    freshness: 'current',
    ...overrides,
  };
}

test('a skill decision batch names every skill with its own cause, preserved state, recovery, and skill-qualified choices', () => {
  const result = evaluateOperatorNotification(batchEvent());
  assert.equal(result.disposition, 'direct-notification');
  const output = result.output;
  for (const expected of [
    'jarvOS found 2 skills it did not share, and each needs its own decision.',
    '1. newsletter-generator: jarvOS did not share it with Claude and Hermes because it needs your approval before jarvOS can share it. Nothing changed: the skill and every AI tool were left exactly as they were. To fix it, decide whether this skill may be shared. Reply “share newsletter-generator”, “keep local newsletter-generator”, “exclude newsletter-generator”, or “details newsletter-generator”.',
    '2. use-anthropic: jarvOS did not share it with Claude, Hermes, and OpenClaw because its source is no longer available. Nothing was removed: the copies it already shared stay in place. To fix it, restore the skill folder, or tell jarvOS to stop offering it. Reply “keep local use-anthropic”, “exclude use-anthropic”, or “details use-anthropic”.',
    'Name the skill in every reply; a reply that does not name one of these skills changes nothing.',
    'remind you every hour until each skill is decided; ignoring this message does not pause reminders.',
    'Action required: Choose one listed option for each skill, naming the skill in your reply.',
    'Next: jarvOS will leave each skill unchanged until you choose one of its options.',
    `Reference: ${EVENT_REFERENCE}.`,
  ]) assert.ok(output.includes(expected), `${expected}\n---\n${output}`);
  assert.doesNotMatch(output, /needs_owner_input|source_absent|shared-copies-kept|ItemReference|at most|\//);
});

test('skill decision batches are bounded, name each skill once, and never reuse a decision reference or carry attempts', () => {
  assert.equal(validateOperatorNotificationEvent(batchEvent()).ok, true);
  const five = [0, 1, 2, 3].map((index) => batchItem(index)).concat(batchItem(0, { skillName: 'fifth-skill', decisionReference: 'ItemReference01234567894' }));
  for (const [unsafe, pattern] of [
    [{ decisions: [batchItem(0)] }, /two to 4 decisions/],
    [{ decisions: five }, /two to 4 decisions/],
    [{ decisions: [batchItem(0), batchItem(1, { skillName: 'newsletter-generator' })] }, /name each skill once/],
    [{ decisions: [batchItem(0), batchItem(1, { decisionReference: batchItem(0).decisionReference })] }, /distinct decision references/],
    [{ decisions: [batchItem(0, { decisionReference: EVENT_REFERENCE }), batchItem(1)] }, /must differ from eventReference/],
    [{ decisions: [batchItem(0, { deliveryAttemptId: 'attempt-AbCdEfGhIjKlMnOpQrStUvWx' }), batchItem(1)] }, /unknown field: deliveryAttemptId/],
    [{ decisions: [batchItem(0, { sourcePath: '/Users/andrew/private/skill' }), batchItem(1)] }, /unknown field: sourcePath/],
    [{ decisions: [batchItem(0, { affectedHarnesses: ['/Users/andrew/.claude/skills'] }), batchItem(1)] }, /affectedHarnesses is invalid/],
    [{ decisions: [batchItem(0, { skillName: 'x'.repeat(65) }), batchItem(1)] }, /skillName is invalid/],
    [{ skillName: 'newsletter-generator' }, /skillName is only valid for individual skill decisions/],
    [{ deliveryAttemptId: 'attempt-AbCdEfGhIjKlMnOpQrStUvWx', deliveryAttemptKind: 'initial' }, /deliveryAttemptId is only valid for individual skill decisions/],
    [{ itemCount: 2 }, /itemCount is only valid for skill decision summaries/],
    [{ action: 'choose-skill-option' }, /must require a choice for each skill/],
  ]) {
    const result = validateOperatorNotificationEvent(batchEvent(unsafe));
    assert.equal(result.ok, false, JSON.stringify(unsafe));
    assert.match(result.errors.join('\n'), pattern);
  }
  assert.match(validateOperatorNotificationEvent(decisionEvent({ decisions: [batchItem(0), batchItem(1)] })).errors.join('\n'), /decisions is only valid for skill decision batches/);
  assert.match(validateOperatorNotificationEvent(event({ decisions: [batchItem(0), batchItem(1)] })).errors.join('\n'), /decisions is only valid for skill decision events/);
});

test('a full skill decision batch stays within one chat message', () => {
  const decisions = [0, 1, 2, 3].map((index) => batchItem(index, {
    skillName: `${'x'.repeat(63)}${index}`,
    affectedHarnesses: ['claude', 'codex', 'hermes', 'openclaw'],
    preservedState: 'unchanged',
  }));
  const output = renderOperatorNotification(batchEvent({ eventReference: 'R'.repeat(128), decisions }));
  assert.ok(output.length <= 4000, `batch message is ${output.length} characters`);
  // A single-message occurrence names every pending decision, so it must not
  // tell the owner that anything was held back for a later reminder.
  assert.doesNotMatch(output, /at most|follow in later reminders|message 1 of/);
  for (const item of decisions) assert.ok(output.includes(`“details ${item.skillName}”`), item.skillName);
});

test('one occurrence splits into bounded chunks that each name their position and never drop a decision', () => {
  // Nine pending decisions cannot fit one bounded message, so the occurrence
  // becomes the fewest balanced bounded messages: none is oversized, none is
  // left holding a single decision, and together they name all nine.
  const items = Array.from({ length: 9 }, (unused, index) => ({
    skillName: `skill-number-${index}`,
    reasonCode: 'needs_owner_input',
    options: ['share', 'keep-local', 'exclude', 'details'],
    decisionReference: `ItemReference012345678${String(index).padStart(2, '0')}`,
    revision: 1,
  }));
  const chunks = chunkSkillDecisions(items);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [3, 3, 3]);
  assert.deepEqual(chunks.flat().map((item) => item.skillName), items.map((item) => item.skillName));
  assert.deepEqual(chunkSkillDecisions(items), chunks, 'the split is deterministic');

  const named = [];
  chunks.forEach((decisions, index) => {
    const input = batchEvent({ decisions, chunkIndex: index + 1, chunkCount: chunks.length });
    assert.equal(validateOperatorNotificationEvent(input).ok, true, JSON.stringify(input));
    const output = renderOperatorNotification(input);
    assert.ok(output.length <= 4000, `chunk ${index + 1} is ${output.length} characters`);
    assert.ok(output.includes(`This is message ${index + 1} of 3`), output);
    assert.ok(output.includes('The other messages in this reminder name the rest of your pending skill decisions.'), output);
    assert.ok(output.includes('Name the skill in every reply; a reply that does not name one of these skills changes nothing.'), output);
    for (const item of decisions) {
      assert.ok(output.includes(`“share ${item.skillName}”`), `${item.skillName}\n---\n${output}`);
      named.push(item.skillName);
    }
    assert.doesNotMatch(output, /needs_owner_input|ItemReference|\//);
  });
  assert.deepEqual(named, items.map((item) => item.skillName));

  // Balanced chunking never leaves a tail message naming a single decision,
  // which the batch contract could not represent.
  for (let total = 2; total <= 40; total += 1) {
    const sizes = chunkSkillDecisions(items.slice(0, 1).concat(Array.from({ length: total - 1 }, () => items[0]))).map((chunk) => chunk.length);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), total, `total ${total}`);
    assert.ok(Math.min(...sizes) >= 2, `total ${total} produced ${sizes}`);
    assert.ok(Math.max(...sizes) <= 4, `total ${total} produced ${sizes}`);
  }
  assert.deepEqual(chunkSkillDecisions([]), []);
  assert.deepEqual(chunkSkillDecisions([items[0]]), [[items[0]]]);
});

test('chunk identity is validated as a positive safe-integer position and belongs only to batches', () => {
  for (const [unsafe, pattern] of [
    [{ chunkIndex: 1 }, /chunk fields must be provided together/],
    [{ chunkCount: 2 }, /chunk fields must be provided together/],
    [{ chunkIndex: 0, chunkCount: 2 }, /chunkIndex is invalid/],
    [{ chunkIndex: 3, chunkCount: 2 }, /chunkIndex is invalid/],
    [{ chunkIndex: 1, chunkCount: 0 }, /chunkCount is invalid/],
    [{ chunkIndex: 1, chunkCount: -1 }, /chunkCount is invalid/],
    [{ chunkIndex: 1, chunkCount: 2.5 }, /chunkCount is invalid/],
    [{ chunkIndex: 1, chunkCount: Number.MAX_SAFE_INTEGER + 2 }, /chunkCount is invalid/],
    [{ chunkIndex: 1, chunkCount: Infinity }, /chunkCount is invalid/],
    [{ chunkIndex: 1, chunkCount: Number.NaN }, /chunkCount is invalid/],
    [{ chunkIndex: '1', chunkCount: 2 }, /chunkIndex is invalid/],
  ]) {
    const result = validateOperatorNotificationEvent(batchEvent(unsafe));
    assert.equal(result.ok, false, JSON.stringify(unsafe));
    assert.match(result.errors.join('\n'), pattern);
  }
  assert.equal(validateOperatorNotificationEvent(batchEvent({ chunkIndex: 2, chunkCount: 2 })).ok, true);
  // There is no aggregate ceiling on how many bounded messages one occurrence
  // may take: a ceiling below the population the inventory can represent would
  // leave real pending decisions unnamed. Only the individual message is
  // bounded, which the decisions check above already enforces.
  for (const chunkCount of [251, 1000, 100000]) {
    assert.equal(validateOperatorNotificationEvent(batchEvent({ chunkIndex: chunkCount, chunkCount })).ok, true, `chunkCount ${chunkCount}`);
  }
  assert.match(validateOperatorNotificationEvent(decisionEvent({ chunkIndex: 1, chunkCount: 2 })).errors.join('\n'), /chunkIndex is only valid for skill decision batches/);
  assert.match(validateOperatorNotificationEvent(event({ chunkIndex: 1, chunkCount: 2 })).errors.join('\n'), /chunkIndex is only valid for skill decision events/);
});

test('unsafe, private, and under-trusted skills name their cause and offer only non-share choices', () => {
  for (const [reasonCode, cause, recovery] of [
    ['privacy_restricted', 'because it appears to contain private information, such as a credential.', 'To fix it, remove the private information from the skill, or keep it local.'],
    ['trust_class_insufficient', 'because it includes scripts, but its folder is trusted only for instructions.', 'To fix it, remove its scripts, or move it to a folder trusted for scripts; otherwise keep it local.'],
    ['unsafe_source', 'because jarvOS could not confirm that its files are safe to share.', 'To fix it, review the skill’s files and remove anything unsafe, or keep it local.'],
  ]) {
    const input = decisionEvent({ reasonCode, affectedHarnesses: ['claude', 'codex'], preservedState: 'unchanged' });
    assert.equal(validateOperatorNotificationEvent(input).ok, true, reasonCode);
    const output = renderOperatorNotification(input);
    assert.ok(output.includes(`found the use-anthropic skill but did not share it with Claude and Codex ${cause}`), output);
    assert.ok(output.includes('Nothing changed: the skill and every AI tool were left exactly as they were.'), output);
    assert.ok(output.includes(recovery), output);
    assert.match(output, /Choices: reply “keep local” to leave it where it is; reply “exclude” to stop offering it; reply “details”/);
    assert.match(output, /“acknowledge”.*“defer until”.*“resume”/);
    assert.doesNotMatch(output, /“share”|privacy_restricted|trust_class_insufficient|unsafe_source|\//);
  }
});

test('a named scheduled-repair failure states the subsystem, cause, preserved state, and exact recovery', () => {
  const failure = (overrides = {}) => event({
    action: 'follow-recovery', failureCause: 'decision-lock-gate', dedupeKey: 'scheduled-repair-failure-decision-lock-gate-hour-2026-08-16t12', ...overrides,
  });
  const result = evaluateOperatorNotification(failure());
  assert.equal(result.disposition, 'direct-notification');
  for (const expected of [
    'jarvOS could not record skill decision reminders because an interrupted jarvOS process left the decision ledger lock gate behind.',
    'Your skill decisions and reminders were left exactly as they were.',
    'Any shared skill sync that already finished in this run still stands; jarvOS did not undo it.',
    'confirm no jarvOS process is running, then remove the leftover folder named “owner-decisions.json.lock.gate”',
    'Action required: Follow the recovery step above; jarvOS cannot clear this by itself.',
    `Reference: ${EVENT_REFERENCE}.`,
  ]) assert.ok(result.output.includes(expected), `${expected}\n---\n${result.output}`);
  // A reminder failure happens after the skill sync of the same run, so it may
  // never claim that no skill changed: repair can already have updated
  // compatible skills before the reminder claim failed. Only the sync lock
  // gate, which fails before any skill work, still proves nothing changed.
  for (const cause of ['decision-lock-gate', 'decision-ledger-busy', 'decision-ledger-unreadable', 'reminder-occurrence-rejected', 'decision-claim-failed']) {
    const output = renderOperatorNotification(failure({ failureCause: cause }));
    assert.match(output, /Your skill decisions and reminders were left exactly as they were\./, cause);
    assert.match(output, /Any shared skill sync that already finished in this run still stands; jarvOS did not undo it\./, cause);
    assert.doesNotMatch(output, /no skill, decision, or reminder was changed|no skill, AI tool, or decision was changed|preserved the existing state/, cause);
    assert.doesNotMatch(output, /\/|[a-f0-9]{32}|Users/, cause);
    assert.match(output, /To recover, /, cause);
  }
  const syncGate = renderOperatorNotification(failure({ failureCause: 'skill-sync-lock-gate' }));
  assert.match(syncGate, /It stopped before doing any skill work, so no skill, AI tool, or decision was changed\./);
  assert.match(syncGate, /To recover, /);
  assert.equal(renderOperatorNotification(failure({ failureCause: 'decision-ledger-unreadable' })).includes('It did not overwrite that file.'), true);
  for (const [unsafe, pattern] of [
    [{ failureCause: 'remove /Users/andrew/.jarvos/lock' }, /failureCause is invalid/],
    [{ action: 'choose-recovery' }, /must require its recovery/],
    [{ code: 'safety-hold', severity: 'warning', automationOutcome: 'safe-hold', actionRequired: false, action: 'none' }, /failureCause is only valid for recovery-failed events/],
  ]) {
    const validation = validateOperatorNotificationEvent(failure(unsafe));
    assert.equal(validation.ok, false, JSON.stringify(unsafe));
    assert.match(validation.errors.join('\n'), pattern);
  }
  assert.match(validateOperatorNotificationEvent(event({ action: 'follow-recovery' })).errors.join('\n'), /requires a named failure cause/);
});
