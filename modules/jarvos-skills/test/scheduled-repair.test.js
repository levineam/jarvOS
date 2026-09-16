'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OPERATOR_NOTIFICATION_TRANSPORT_VERSION,
  eventFor,
  failureCauseFor,
  hourlyOccurrenceKey,
  scheduledRepairCliEnvelope,
  scheduledRepairCliOutput,
  scheduledRepairMessage,
  scheduledRepairNotification,
  scheduledRepairNotifications,
  runScheduledRepair,
} = require('../src/scheduled-repair');
const { parseArgs, failureOutput } = require('../scripts/scheduled-repair');
const { deferDecision } = require('../src/decision-store');
const {
  defaultConfig,
  saveConfig,
  decisionStatePath,
  reconcileDecisions,
  resolveDecision,
  acknowledgeDecision,
  resumeDecision,
  claimDelivery,
} = require('../src');
const {
  SKILL_DECISION_BATCH_LIMIT,
  evaluateOperatorNotification,
  notificationDedupeIdentity,
  validateOperatorNotificationEvent,
} = require('../../jarvos-runtime-kit');

function seededConfig(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(root, 'config.json');
  const config = defaultConfig();
  config.controlRoot = root;
  config.publicCatalogPath = path.join(root, 'public-catalog.json');
  config.localOverlayPath = path.join(root, 'local-overlay.json');
  saveConfig(config, configPath);
  return { root, configPath };
}

function heldSkill(overrides = {}) {
  return {
    logicalId: 'use-anthropic',
    treeDigest: 'a'.repeat(64),
    attention: 'actionable',
    disposition: { kind: 'needs_input', reasonCode: 'needs_owner_input' },
    matrix: ['claude', 'codex', 'hermes', 'openclaw'].map((harness) => ({
      harness,
      projection: harness === 'codex' ? 'source_present' : 'missing',
      verification: harness === 'codex' ? 'verification_pending' : 'unverifiable',
    })),
    ...overrides,
  };
}

function owner() { return { kind: 'owner', capabilities: ['skills.decisions.read', 'skills.decisions.resolve'] }; }

function healthy(overrides = {}) {
  return {
    ok: true,
    ran: true,
    mutationDenied: false,
    status: { counts: { skills: 103, actionable: 0 } },
    reconciliation: { repaired: false },
    attention: { raised: [], resolved: [] },
    ...overrides,
  };
}

test('healthy scheduled replays stay silent', () => {
  assert.equal(scheduledRepairMessage(healthy()), 'NO_REPLY');
});

test('first convergence summary is concise and count-only', () => {
  const message = scheduledRepairMessage(healthy({
    status: { counts: { skills: 103, actionable: 28 } },
  }), {
    announceConvergence: true,
    catalogStatus: { pairs: [{ status: 'clean' }, { status: 'clean' }] },
  });
  assert.match(message, /103 skills inventoried/);
  assert.match(message, /2\/2 managed harness projections clean/);
  assert.match(message, /28 items need review/);
  assert.doesNotMatch(message, /logicalId|sourceRoot|SKILL\.md/);
});

test('unsafe-source holds are durable, semantic, and quiet on repeats', () => {
  const result = healthy({
    status: { observedAt: '2026-08-16T12:30:00.000Z', counts: { skills: 1, actionable: 1 } },
    attention: { raised: [{ logicalId: 'private-skill', reasonCode: 'unsafe_source' }], resolved: [] },
  });
  const first = scheduledRepairNotification(result);
  const repeat = scheduledRepairNotification(result);
  assert.equal(first.output, 'NO_REPLY');
  assert.equal(first.disposition, 'durable-status');
  assert.match(first.statusMessage, /paused an unsafe change and left the existing setup unchanged/);
  assert.equal(first.dedupeIdentity, repeat.dedupeIdentity);
  assert.equal(repeat.output, 'NO_REPLY');
  assert.doesNotMatch(`${first.statusMessage} ${JSON.stringify(first.event)}`, /unsafe_source|private-skill/);
});

test('one new owner decision becomes a plain-English question with a safe answer path', () => {
  const notification = scheduledRepairNotification(healthy({
    status: { observedAt: '2026-08-16T12:30:00.000Z', counts: { skills: 1, actionable: 1 } },
    decisions: {
      created: 1,
      pending: 1,
      items: [{
        id: 'decision-0123456789abcdef01234567',
        decisionReference: 'AbCdEfGhIjKlMnOpQrStUvWx',
        skill: 'newsletter-generator',
        revision: 1,
        reason: 'needs_owner_input',
        options: ['share', 'keep-local', 'exclude', 'details'],
      }],
      migration: null,
    },
  }));
  assert.equal(notification.disposition, 'direct-notification');
  assert.match(notification.output, /found the newsletter-generator skill/);
  assert.match(notification.output, /did not share it because it needs your approval/);
  assert.match(notification.output, /Reply “share”/);
  assert.match(notification.output, /reply “keep local”/);
  assert.match(notification.output, /Nothing changed/);
  assert.doesNotMatch(notification.output, /needs_owner_input|SKILL\.md|\//);
  assert.equal(notification.event.eventReference, notification.event.decisionReference);
});

test('scheduled repair claims the write-ahead attempt before emitting an owner question', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-scheduled-claim-'));
  const configPath = path.join(root, 'config.json');
  try {
    const decision = {
      id: 'decision-0123456789abcdef01234567',
      decisionReference: 'AbCdEfGhIjKlMnOpQrStUvWx',
      skill: 'newsletter-generator',
      revision: 1,
      reason: 'needs_owner_input',
      options: ['share', 'keep-local', 'exclude', 'details'],
    };
    const config = defaultConfig();
    config.controlRoot = root;
    config.publicCatalogPath = path.join(root, 'public-catalog.json');
    config.localOverlayPath = path.join(root, 'local-overlay.json');
    saveConfig(config, configPath);
    let claimInput;
    const run = runScheduledRepair({
      configPath,
      now: '2026-08-16T16:00:00.000Z',
      repair: () => healthy({ decisions: { created: 1, pending: 1, pendingItems: [decision], items: [decision], migration: null } }),
      claimReminder: ({ decisionId, occurrenceKey }) => ({ decisionId, occurrenceKey, sequence: 1 }),
      claimDelivery: (input) => {
        claimInput = input;
        return { decisionId: decision.id, decisionReference: decision.decisionReference, revision: 1, attemptId: 'attempt-AbCdEfGhIjKlMnOpQrStUvWx', kind: 'initial' };
      },
    });
    assert.equal(claimInput.decisionId, decision.id);
    assert.equal(run.notification.event.deliveryAttemptKind, 'initial');
    assert.equal(run.notification.event.deliveryAttemptId, 'attempt-AbCdEfGhIjKlMnOpQrStUvWx');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a single older pending decision retry is rendered with its new delivery attempt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-scheduled-retry-'));
  const configPath = path.join(root, 'config.json');
  try {
    const decision = {
      id: 'decision-abcdef0123456789abcdef01',
      decisionReference: 'QrStUvWxYz0123456789abcd',
      skill: 'newsletter-generator',
      revision: 1,
      reason: 'needs_owner_input',
      options: ['share', 'keep-local', 'exclude', 'details'],
    };
    const config = defaultConfig();
    config.controlRoot = root;
    config.publicCatalogPath = path.join(root, 'public-catalog.json');
    config.localOverlayPath = path.join(root, 'local-overlay.json');
    saveConfig(config, configPath);
    const run = runScheduledRepair({
      configPath,
      now: '2026-08-17T16:00:00.000Z',
      repair: () => healthy({ decisions: { created: 0, pending: 1, pendingItems: [decision], items: [], migration: null } }),
      claimReminder: ({ decisionId, occurrenceKey }) => ({ decisionId, occurrenceKey, sequence: 2 }),
      claimDelivery: () => ({
        decisionId: decision.id,
        decisionReference: decision.decisionReference,
        revision: 1,
        attemptId: 'attempt-retry-QrStUvWxYz',
        kind: 'fallback',
      }),
    });
    assert.equal(run.notification.event.code, 'skill-owner-decision');
    assert.equal(run.notification.event.deliveryAttemptKind, 'fallback');
    assert.equal(run.notification.event.deliveryAttemptId, 'attempt-retry-QrStUvWxYz');
    assert.match(run.notification.output, /found the newsletter-generator skill/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('three distinct hourly occurrences send three reminders for one unresolved decision; a repeat of the current occurrence replays it and an older one never reopens', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-hourly-');
  try {
    const statePath = decisionStatePath({ configPath });
    const pending = reconcileDecisions({ statePath, skills: [heldSkill()] }).pending;
    const repair = () => healthy({
      status: { observedAt: '2026-08-16T16:00:00.000Z', counts: { skills: 1, actionable: 1 } },
      decisions: { created: 0, pending: 1, items: [], pendingItems: pending, migration: null },
    });
    const reminderCount = () => JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions[0].reminder.count;
    const runs = ['2026-08-16T16:00:00.000Z', '2026-08-16T16:20:00.000Z', '2026-08-16T17:00:00.000Z', '2026-08-16T18:05:00.000Z']
      .map((now) => runScheduledRepair({ configPath, now, repair }));
    // The retry inside the first hour is the same occurrence: it renders the
    // same reminder under the same delivery identity, so a sender that already
    // accepted it delivers nothing twice, while one that failed can recover.
    assert.equal(runs[1].notification.dedupeIdentity, runs[0].notification.dedupeIdentity);
    const sent = runs.filter((run) => run.message !== 'NO_REPLY');
    assert.equal(sent.length, 4);
    assert.equal(new Set(sent.map((run) => run.notification.dedupeIdentity)).size, 3, 'three occurrences, three identities');
    assert.equal(reminderCount(), 3, 'the replay never counted as a fourth reminder');
    assert.equal(runs[0].notification.event.deliveryAttemptKind, 'initial');
    assert.equal(runs[1].notification.event.deliveryAttemptKind, undefined, 'a replay never spends a delivery attempt');
    assert.equal(runs[2].notification.event.deliveryAttemptKind, undefined);
    for (const run of sent) {
      assert.match(run.message, /found the use-anthropic skill but did not share it with Claude, Hermes, and OpenClaw because it needs your approval/);
      assert.match(run.message, /Nothing changed/);
      assert.match(run.message, /To fix it, decide whether this skill may be shared/);
      assert.match(run.message, /Reply “share”/);
      assert.match(run.message, /remind you every hour/);
      assert.doesNotMatch(run.message, /needs_owner_input|[a-f0-9]{64}|\//);
    }
    // The current occurrence stays recoverable for the rest of its hour.
    const current = runScheduledRepair({ configPath, now: '2026-08-16T18:59:00.000Z', occurrenceKey: 'hour-2026-08-16T18', repair });
    assert.equal(current.notification.dedupeIdentity, runs[3].notification.dedupeIdentity);
    // An hour that a later occurrence has already succeeded is closed for
    // good: a historical delivery can never be reopened.
    for (const old of ['hour-2026-08-16T16', 'hour-2026-08-16T17']) {
      assert.equal(runScheduledRepair({ configPath, now: '2026-08-16T18:59:00.000Z', occurrenceKey: old, repair }).message, 'NO_REPLY', old);
    }
    assert.equal(reminderCount(), 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI passes a bounded explicit occurrence through and still fails closed', () => {
  assert.deepEqual(parseArgs(['--config', '/c.json', '--occurrence', 'sched-2026-08-16T16']), {
    configPath: '/c.json', announceConvergence: false, occurrenceKey: 'sched-2026-08-16T16',
  });
  assert.equal('occurrenceKey' in parseArgs([]), false);
  assert.throws(() => parseArgs(['--occurrence']), /--occurrence requires a key/);
  assert.throws(() => parseArgs(['--occurrence', '--config', '/c.json']), /--occurrence requires a key/);
  assert.throws(() => parseArgs(['--occurrence', 'a'.repeat(65)]), /--occurrence requires a key/);
  assert.throws(() => parseArgs(['--occurence', 'x']), /unknown argument/);
});

test('one explicit occurrence keeps its reminder identity across wall-clock retries', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-occurrence-');
  try {
    const statePath = decisionStatePath({ configPath });
    const pending = reconcileDecisions({ statePath, skills: [heldSkill()] }).pending;
    const repair = () => healthy({ decisions: { created: 0, pending: 1, items: [], pendingItems: pending, migration: null } });
    const options = parseArgs(['--config', configPath, '--occurrence', 'sched-2026-08-16T16']);
    const claimed = [];
    const stub = (now) => runScheduledRepair({
      ...options,
      now,
      repair,
      claimReminder: ({ decisionId, occurrenceKey }) => { claimed.push(occurrenceKey); return { decisionId, occurrenceKey, sequence: 1 }; },
      claimDelivery: () => null,
    });
    const onTime = stub('2026-08-16T16:00:00.000Z');
    const late = stub('2026-08-16T19:45:00.000Z');
    assert.deepEqual(claimed, ['sched-2026-08-16T16', 'sched-2026-08-16T16']);
    assert.equal(onTime.notification.dedupeIdentity, late.notification.dedupeIdentity);

    const real = runScheduledRepair({ ...options, now: '2026-08-16T16:00:00.000Z', repair });
    assert.match(real.message, /use-anthropic/);
    // A wall-clock retry of the same named occurrence replays it rather than
    // claiming a second reminder for it.
    const retried = runScheduledRepair({ ...options, now: '2026-08-16T19:45:00.000Z', repair });
    assert.equal(retried.notification.dedupeIdentity, real.notification.dedupeIdentity);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions[0].reminder.count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scheduled reminders honor owner pauses and stop once the decision is resolved', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-pause-');
  try {
    const statePath = decisionStatePath({ configPath });
    const pending = reconcileDecisions({ statePath, skills: [heldSkill()] }).pending;
    const repair = () => healthy({ decisions: { created: 0, pending: 1, items: [], pendingItems: pending, migration: null } });
    acknowledgeDecision({ statePath, principal: owner(), decisionId: pending[0].id });
    assert.equal(runScheduledRepair({ configPath, now: '2026-08-16T16:00:00.000Z', repair }).message, 'NO_REPLY');
    resumeDecision({ statePath, principal: owner(), decisionId: pending[0].id });
    assert.match(runScheduledRepair({ configPath, now: '2026-08-16T17:00:00.000Z', repair }).message, /use-anthropic/);
    resolveDecision({ statePath, principal: owner(), decisionId: pending[0].id, revision: 1, option: 'keep-local', currentSkill: heldSkill(), mutate: () => {} });
    assert.equal(runScheduledRepair({ configPath, now: '2026-08-16T18:00:00.000Z', repair }).message, 'NO_REPLY');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a reminded named decision is rendered before a generic safety hold', () => {
  const decision = {
    id: 'decision-0123456789abcdef01234567',
    decisionReference: 'AbCdEfGhIjKlMnOpQrStUvWx',
    skill: 'use-anthropic',
    revision: 1,
    reason: 'needs_owner_input',
    options: ['share', 'keep-local', 'exclude', 'details'],
    affectedHarnesses: ['claude'],
    preservedState: 'unchanged',
  };
  const result = healthy({
    attention: { raised: [{ logicalId: 'other-skill', reasonCode: 'unsafe_source' }], resolved: [] },
    decisions: { created: 0, pending: 1, items: [], pendingItems: [decision], migration: null },
  });
  const occurrenceKey = 'hour-2026-08-16T16';
  const named = eventFor(result, { reminderClaims: [{ decisionId: decision.id }], occurrenceKey });
  assert.equal(named.code, 'skill-owner-decision');
  assert.equal(named.dedupeKey, `skill-owner-decision-${decision.id}-hour-2026-08-16t16`);
  assert.deepEqual(named.affectedHarnesses, ['claude']);
  assert.equal(eventFor(result, { reminderClaims: [], occurrenceKey }).code, 'safety-hold');
});

test('a batch of reminded decisions names every skill with its own facts and skill-qualified choices', () => {
  const decisions = ['0123456789abcdef01234567', 'abcdef0123456789abcdef01'].map((suffix, index) => ({
    id: `decision-${suffix}`,
    decisionReference: `AbCdEfGhIjKlMnOpQrStUvW${index}`,
    skill: index ? 'use-anthropic' : 'newsletter-generator',
    revision: 1,
    reason: index ? 'source_absent' : 'needs_owner_input',
    options: index ? ['keep-local', 'exclude', 'details'] : ['share', 'keep-local', 'exclude', 'details'],
    affectedHarnesses: index ? ['claude', 'hermes', 'openclaw'] : ['claude'],
    preservedState: index ? 'shared-copies-kept' : 'unchanged',
  }));
  const result = healthy({ decisions: { created: 0, pending: 2, items: [], pendingItems: decisions, migration: null } });
  const render = (occurrenceKey) => scheduledRepairNotification(result, {
    reminderClaims: decisions.map((decision) => ({ decisionId: decision.id })), occurrenceKey,
  });
  const notification = render('hour-2026-08-16T16');
  const { event, output } = notification;
  assert.equal(event.code, 'skill-owner-decision-batch');
  assert.deepEqual(event.decisions.map((item) => [item.skillName, item.decisionReference]), decisions.map((decision) => [decision.skill, decision.decisionReference]));
  assert.equal(decisions.some((decision) => decision.decisionReference === event.eventReference), false);
  assert.equal(event.deliveryAttemptId, undefined);
  for (const expected of [
    '1. newsletter-generator: jarvOS did not share it with Claude because it needs your approval before jarvOS can share it. Nothing changed:',
    'Reply “share newsletter-generator”, “keep local newsletter-generator”, “exclude newsletter-generator”, or “details newsletter-generator”.',
    '2. use-anthropic: jarvOS did not share it with Claude, Hermes, and OpenClaw because its source is no longer available. Nothing was removed: the copies it already shared stay in place. To fix it, restore the skill folder, or tell jarvOS to stop offering it. Reply “keep local use-anthropic”, “exclude use-anthropic”, or “details use-anthropic”.',
    'a reply that does not name one of these skills changes nothing',
    'remind you every hour until each skill is decided',
  ]) assert.ok(output.includes(expected), `${expected}\n---\n${output}`);
  assert.doesNotMatch(output, /decision-[a-f0-9]|needs_owner_input|source_absent|shared-copies-kept|\//);
  assert.doesNotMatch(JSON.stringify(event), /decision-[a-f0-9]{24}/);
  assert.match(event.dedupeKey, /^skill-owner-decision-batch-[a-f0-9]{32}-hour-2026-08-16t16$/);
  assert.equal(render('hour-2026-08-16T16').dedupeIdentity, notification.dedupeIdentity);
  assert.notEqual(render('hour-2026-08-16T17').dedupeIdentity, notification.dedupeIdentity);
});

test('one occurrence names every pending decision in bounded messages, claims no delivery attempt, and repeats them all next hour', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-batch-');
  try {
    const statePath = decisionStatePath({ configPath });
    const names = ['alpha-skill', 'bravo-skill', 'charlie-skill', 'delta-skill', 'echo-skill',
      'foxtrot-skill', 'golf-skill', 'hotel-skill', 'india-skill'];
    const skills = names.map((logicalId) => heldSkill({ logicalId }));
    const repair = () => {
      const { pending } = reconcileDecisions({ statePath, skills });
      return healthy({ decisions: { created: 0, pending: pending.length, items: [], pendingItems: pending, migration: null } });
    };
    let deliveryClaims = 0;
    const run = (now) => runScheduledRepair({ configPath, now, repair, claimDelivery: (input) => { deliveryClaims += 1; return claimDelivery(input); } });
    const sentEvents = (sent) => sent.notifications.filter((item) => item.output !== 'NO_REPLY').map((item) => item.event);
    const namedIn = (sent) => sentEvents(sent).flatMap((event) => event.decisions.map((item) => item.skillName));

    // Nine unresolved decisions cannot fit one bounded message, so the same
    // occurrence sends several bounded messages rather than naming four.
    const first = run('2026-08-16T16:00:00.000Z');
    const events = sentEvents(first);
    assert.equal(events.length, 3);
    assert.deepEqual([...new Set(events.map((event) => event.code))], ['skill-owner-decision-batch']);
    assert.deepEqual(events.map((event) => [event.chunkIndex, event.chunkCount]), [[1, 3], [2, 3], [3, 3]]);
    for (const event of events) assert.ok(event.decisions.length <= SKILL_DECISION_BATCH_LIMIT, `${event.decisions.length} decisions in one message`);
    assert.deepEqual(namedIn(first).slice().sort(), [...names].sort(), 'every pending decision is named this hour');
    assert.equal(first.messages.length, 3);
    assert.equal(new Set(first.notifications.map((item) => item.dedupeIdentity)).size, 3, 'each bounded message has its own delivery identity');
    for (const message of first.messages) {
      assert.ok(message.length <= 4000, `bounded message is ${message.length} characters`);
      assert.match(message, /This is message \d of 3/);
      assert.match(message, /Name the skill in every reply/);
      assert.doesNotMatch(message, /[a-f0-9]{64}|\/|decision-[a-f0-9]/);
    }

    // A retry inside the same occurrence claims nothing new, but re-renders
    // the same bounded messages under the same per-message identities, so a
    // sender that accepted only some of them can deliver the rest. The
    // reminder counts do not move and the ledger is not written again.
    const ledgerAfterFirst = fs.readFileSync(statePath, 'utf8');
    const replay = run('2026-08-16T16:40:00.000Z');
    const replayEvents = sentEvents(replay);
    assert.equal(replayEvents.length, 3);
    assert.deepEqual(replayEvents.map((event) => [event.chunkIndex, event.chunkCount]), [[1, 3], [2, 3], [3, 3]]);
    assert.deepEqual(namedIn(replay), namedIn(first), 'the same decisions in the same chunks');
    assert.deepEqual(replay.notifications.map((item) => item.dedupeIdentity), first.notifications.map((item) => item.dedupeIdentity));
    // Only the per-message correlation reference is minted fresh; the owner
    // text is identical, so the replay is the same reminder, not a new one.
    const withoutReference = (messages) => messages.map((message) => message.replace(/Reference: [A-Za-z0-9_-]+\./, 'Reference.'));
    assert.deepEqual(withoutReference(replay.messages), withoutReference(first.messages));
    assert.equal(fs.readFileSync(statePath, 'utf8'), ledgerAfterFirst, 'a replay never writes the ledger');
    assert.deepEqual([...new Set(JSON.parse(ledgerAfterFirst).decisions.map((decision) => decision.reminder.count))], [1]);

    // The next occurrence repeats every still-unresolved decision, under new
    // per-message identities.
    const second = run('2026-08-16T17:00:00.000Z');
    assert.deepEqual(namedIn(second).slice().sort(), [...names].sort());
    assert.equal(new Set([...first.notifications, ...second.notifications].map((item) => item.dedupeIdentity)).size, 6);
    assert.equal(deliveryClaims, 0);
    assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions.every((decision) => decision.attempts.length === 0));

    // A reply correlated only to a message resolves nothing; a reply that
    // names a skill resolves only that skill's decision, whichever bounded
    // message named it.
    const chunk = sentEvents(second)[2];
    const target = chunk.decisions[0];
    const current = (name) => skills.find((item) => item.logicalId === name);
    assert.equal(resolveDecision({
      statePath, principal: owner(), decisionReference: chunk.eventReference, revision: 1, option: 'keep-local', currentSkill: current(target.skillName),
      mutate: () => assert.fail('a reply without a skill must not mutate a decision'),
    }).status, 'not_found');
    const mutated = [];
    assert.equal(resolveDecision({
      statePath, principal: owner(), decisionReference: target.decisionReference, revision: target.revision, option: 'keep-local', currentSkill: current(target.skillName),
      mutate: ({ skill }) => mutated.push(skill),
    }).status, 'resolved');
    assert.deepEqual(mutated, [target.skillName]);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions.filter((decision) => decision.status === 'resolved').map((decision) => decision.skill), [target.skillName]);

    // A replay of that same occurrence renders the safe current subset: the
    // decision resolved in the meantime is omitted rather than revived, and
    // the remaining eight are re-chunked within the same bound.
    const remaining = names.filter((name) => name !== target.skillName);
    const afterResolve = run('2026-08-16T17:45:00.000Z');
    assert.deepEqual(namedIn(afterResolve).slice().sort(), [...remaining].sort());
    const afterResolveEvents = sentEvents(afterResolve);
    assert.deepEqual(afterResolveEvents.map((event) => [event.chunkIndex, event.chunkCount]), [[1, 2], [2, 2]]);
    for (const event of afterResolveEvents) assert.ok(event.decisions.length <= SKILL_DECISION_BATCH_LIMIT);
    assert.deepEqual([...new Set(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions
      .filter((decision) => decision.status === 'pending').map((decision) => decision.reminder.count))], [2],
    'the replay after a resolution still moved no reminder count');

    // A resolved decision drops out; every other one is named again.
    const third = run('2026-08-16T18:00:00.000Z');
    assert.deepEqual(namedIn(third).slice().sort(), [...remaining].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI envelope recovers a partly delivered occurrence and never reopens an older one', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-cli-recovery-');
  try {
    const statePath = decisionStatePath({ configPath });
    const names = ['alpha-skill', 'bravo-skill', 'charlie-skill', 'delta-skill', 'echo-skill',
      'foxtrot-skill', 'golf-skill', 'hotel-skill', 'india-skill'];
    const skills = names.map((logicalId) => heldSkill({ logicalId }));
    const repair = () => {
      const { pending } = reconcileDecisions({ statePath, skills });
      return healthy({ decisions: { created: 0, pending: pending.length, items: [], pendingItems: pending, migration: null } });
    };
    // This is exactly what the CLI writes to stdout.
    const cli = (now, occurrenceKey) => scheduledRepairCliEnvelope(runScheduledRepair({ configPath, now, occurrenceKey, repair }).notifications);
    const parse = (output) => (output === 'NO_REPLY' ? null : JSON.parse(output));
    const skillsIn = (envelope) => envelope.messages.flatMap((entry) => entry.event.decisions.map((item) => item.skillName));
    const identities = (envelope) => envelope.messages.map((entry) => entry.dedupeIdentity);
    const counts = () => [...new Set(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions
      .filter((decision) => decision.status === 'pending').map((decision) => decision.reminder.count))];

    const first = parse(cli('2026-08-16T16:00:00.000Z'));
    assert.equal(first.messages.length, 3, 'nine decisions become three bounded messages');
    assert.deepEqual(skillsIn(first).slice().sort(), [...names].sort());
    assert.deepEqual(counts(), [1]);

    // Suppose the sender accepted messages 1 and 2 and failed message 3.
    // Rerunning the same occurrence re-emits all three under the same
    // identities, so the sender's own accepted-delivery dedupe suppresses the
    // two it already delivered and sends the one it missed.
    const retry = parse(cli('2026-08-16T16:20:00.000Z'));
    assert.deepEqual(identities(retry), identities(first));
    assert.deepEqual(skillsIn(retry), skillsIn(first));
    assert.deepEqual(counts(), [1], 'a recovery rerun is not a second reminder');

    // A decision resolved inside the occurrence leaves the recoverable set.
    const target = 'india-skill';
    const decision = reconcileDecisions({ statePath, skills }).pending.find((item) => item.skill === target);
    assert.equal(resolveDecision({
      statePath, principal: owner(), decisionId: decision.id, revision: decision.revision, option: 'keep-local',
      currentSkill: skills.find((item) => item.logicalId === target), mutate: () => {},
    }).status, 'resolved');
    const remaining = names.filter((name) => name !== target);
    const shrunk = parse(cli('2026-08-16T16:40:00.000Z'));
    assert.deepEqual(skillsIn(shrunk).slice().sort(), [...remaining].sort(), 'a resolved decision is never revived');
    assert.deepEqual(counts(), [1]);

    // The next hour emits every remaining decision under fresh identities.
    const nextHour = parse(cli('2026-08-16T17:00:00.000Z'));
    assert.deepEqual(skillsIn(nextHour).slice().sort(), [...remaining].sort());
    assert.equal(new Set([...identities(first), ...identities(nextHour)]).size, first.messages.length + nextHour.messages.length);
    assert.deepEqual(counts(), [2]);

    // Once that later hour is claimed, the hour before it is closed for good.
    assert.equal(cli('2026-08-16T17:30:00.000Z', 'hour-2026-08-16T16'), 'NO_REPLY');
    assert.deepEqual(counts(), [2]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the action-required envelope carries every bounded message of the occurrence', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-envelope-');
  try {
    const statePath = decisionStatePath({ configPath });
    const names = ['alpha-skill', 'bravo-skill', 'charlie-skill', 'delta-skill', 'echo-skill'];
    const skills = names.map((logicalId) => heldSkill({ logicalId }));
    const repair = () => {
      const { pending } = reconcileDecisions({ statePath, skills });
      return healthy({ decisions: { created: 0, pending: pending.length, items: [], pendingItems: pending, migration: null } });
    };
    const run = runScheduledRepair({ configPath, now: '2026-08-16T16:00:00.000Z', repair });
    const envelope = JSON.parse(scheduledRepairCliEnvelope(run.notifications));
    assert.deepEqual(Object.keys(envelope).sort(), ['dedupeIdentity', 'disposition', 'event', 'message', 'messages', 'schema']);
    assert.equal(envelope.schema, OPERATOR_NOTIFICATION_TRANSPORT_VERSION);
    assert.equal(envelope.disposition, 'action-required');
    assert.equal(envelope.messages.length, 2);
    // The legacy single-message fields always mirror the first entry, so an
    // older sender still delivers one safe, correlatable message.
    assert.equal(envelope.message, envelope.messages[0].message);
    assert.equal(envelope.dedupeIdentity, envelope.messages[0].dedupeIdentity);
    assert.deepEqual(envelope.event, envelope.messages[0].event);
    assert.equal(new Set(envelope.messages.map((item) => item.dedupeIdentity)).size, 2);
    assert.deepEqual(envelope.messages.flatMap((item) => item.event.decisions.map((decision) => decision.skillName)).sort(), [...names].sort());
    // Both schema identifiers carry a slash as contract syntax; every other
    // slash anywhere in the envelope would be a leaked absolute path.
    const withoutSchemaIds = JSON.stringify(envelope)
      .split(OPERATOR_NOTIFICATION_TRANSPORT_VERSION).join('')
      .split('jarvos-operator-notification/v1').join('');
    assert.doesNotMatch(withoutSchemaIds, /\/|decision-[a-f0-9]{24}/);
    // A repeat of the current occurrence re-emits the same envelope identities
    // so a sender can recover a message it failed to deliver.
    const again = JSON.parse(scheduledRepairCliEnvelope(runScheduledRepair({ configPath, now: '2026-08-16T16:30:00.000Z', repair }).notifications));
    assert.deepEqual(again.messages.map((item) => item.dedupeIdentity), envelope.messages.map((item) => item.dedupeIdentity));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The serialized envelope is what a sender actually parses, so the contract is
// asserted against the real serialized bytes: each `messages` entry must stand
// on its own as a complete transport entry with its reviewed disposition, not
// as a fragment that only means something beside its envelope.
function assertTransportEntry(entry, label) {
  assert.deepEqual(Object.keys(entry).sort(), ['dedupeIdentity', 'disposition', 'event', 'message', 'schema'], label);
  assert.equal(entry.schema, OPERATOR_NOTIFICATION_TRANSPORT_VERSION, label);
  assert.equal(entry.disposition, 'action-required', label);
  assert.equal(typeof entry.message, 'string', label);
  assert.ok(entry.message.length > 0 && entry.message !== 'NO_REPLY', label);
  const validation = validateOperatorNotificationEvent(entry.event);
  assert.equal(validation.ok, true, `${label}: ${validation.errors.join('; ')}`);
  // The entry's own event must reproduce the entry's own message and identity,
  // so a sender that only ever sees this entry renders and dedupes correctly.
  const evaluated = evaluateOperatorNotification(entry.event);
  assert.equal(evaluated.output, entry.message, label);
  assert.equal(evaluated.dedupeIdentity, entry.dedupeIdentity, label);
  assert.equal(entry.dedupeIdentity, notificationDedupeIdentity(entry.event), label);
}

test('every entry of the serialized multi-message envelope is independently a complete transport entry', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-envelope-members-');
  try {
    const statePath = decisionStatePath({ configPath });
    const names = ['alpha-skill', 'bravo-skill', 'charlie-skill', 'delta-skill', 'echo-skill',
      'foxtrot-skill', 'golf-skill', 'hotel-skill', 'india-skill'];
    const skills = names.map((logicalId) => heldSkill({ logicalId }));
    const repair = () => {
      const { pending } = reconcileDecisions({ statePath, skills });
      return healthy({ decisions: { created: 0, pending: pending.length, items: [], pendingItems: pending, migration: null } });
    };
    const serialized = scheduledRepairCliEnvelope(runScheduledRepair({ configPath, now: '2026-08-16T16:00:00.000Z', repair }).notifications);
    const envelope = JSON.parse(serialized);
    assert.equal(envelope.messages.length, 3);
    envelope.messages.forEach((entry, index) => assertTransportEntry(entry, `messages[${index}]`));
    // The outer object is itself a legacy transport entry mirroring the first
    // message, with `messages` added, so an older sender is unaffected.
    const { messages, ...outer } = envelope;
    assertTransportEntry(outer, 'envelope');
    assert.deepEqual(outer, messages[0]);
    // Every entry declares a position in one complete, consistent sequence.
    assert.deepEqual(messages.map((entry) => [entry.event.chunkIndex, entry.event.chunkCount]), [[1, 3], [2, 3], [3, 3]]);

    // A single-message occurrence is the same entry shape without `messages`.
    const single = JSON.parse(scheduledRepairCliOutput(scheduledRepairNotification(healthy({
      attention: { raised: [{ logicalId: 'private-skill', reasonCode: 'stale_source' }], resolved: [] },
    }))));
    assertTransportEntry(single, 'single');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an occurrence with more pending decisions than any chunk ceiling would allow still names every one of them exactly once', () => {
  // The inventory can represent this population, so the occurrence must be
  // able to name it. Only the individual message is bounded; there is no
  // aggregate ceiling on how many bounded messages one occurrence may take.
  const total = 1001;
  const decisions = Array.from({ length: total }, (unused, index) => ({
    id: `decision-${String(index).padStart(24, '0')}`,
    decisionReference: `Ref${String(index).padStart(4, '0')}0123456789abcdefgh`,
    skill: `skill-number-${index}`,
    revision: 1,
    reason: 'needs_owner_input',
    options: ['share', 'keep-local', 'exclude', 'details'],
    affectedHarnesses: ['claude', 'hermes', 'openclaw'],
    preservedState: 'unchanged',
  }));
  const notifications = scheduledRepairNotifications(
    healthy({ decisions: { created: 0, pending: total, items: [], pendingItems: decisions, migration: null } }),
    { reminderClaims: decisions.map((decision) => ({ decisionId: decision.id })), occurrenceKey: 'hour-2026-08-16T16' },
  );
  const expectedChunks = Math.ceil(total / SKILL_DECISION_BATCH_LIMIT);
  assert.equal(expectedChunks, 251, 'this population exceeds the removed 250-chunk ceiling');
  assert.equal(notifications.length, expectedChunks);
  assert.equal(new Set(notifications.map((item) => item.dedupeIdentity)).size, expectedChunks, 'each message has its own delivery identity');

  const named = [];
  notifications.forEach((notification, index) => {
    const { event, output } = notification;
    const validation = validateOperatorNotificationEvent(event);
    assert.equal(validation.ok, true, `chunk ${index + 1}: ${validation.errors.join('; ')}`);
    assert.deepEqual([event.chunkIndex, event.chunkCount], [index + 1, expectedChunks]);
    assert.ok(event.decisions.length >= 2 && event.decisions.length <= SKILL_DECISION_BATCH_LIMIT, `chunk ${index + 1} holds ${event.decisions.length}`);
    assert.ok(output.length <= 4000, `chunk ${index + 1} is ${output.length} characters`);
    for (const item of event.decisions) named.push(item.skillName);
  });
  assert.deepEqual(named, decisions.map((decision) => decision.skill), 'every decision appears exactly once, in order');

  // The whole occurrence still serializes as one envelope whose entries form a
  // complete, consistent sequence.
  const envelope = JSON.parse(scheduledRepairCliEnvelope(notifications));
  assert.equal(envelope.messages.length, expectedChunks);
  envelope.messages.forEach((entry, index) => assertTransportEntry(entry, `messages[${index}]`));
});

test('the transport envelope fails closed on an incomplete or repeated chunk sequence', () => {
  // A message can only declare its own position, so the transport layer checks
  // that the occurrence's positions form one complete 1..count sequence rather
  // than handing a sender a set that silently omits or repeats a message.
  const decisions = Array.from({ length: 9 }, (unused, index) => ({
    id: `decision-${String(index).padStart(24, '0')}`,
    decisionReference: `Ref${String(index).padStart(4, '0')}0123456789abcdefgh`,
    skill: `skill-number-${index}`,
    revision: 1,
    reason: 'needs_owner_input',
    options: ['share', 'keep-local', 'exclude', 'details'],
  }));
  const notifications = scheduledRepairNotifications(
    healthy({ decisions: { created: 0, pending: 9, items: [], pendingItems: decisions, migration: null } }),
    { reminderClaims: decisions.map((decision) => ({ decisionId: decision.id })), occurrenceKey: 'hour-2026-08-16T16' },
  );
  assert.equal(notifications.length, 3);
  assert.equal(JSON.parse(scheduledRepairCliEnvelope(notifications)).messages.length, 3);
  for (const broken of [
    notifications.slice(0, 2),
    [notifications[0], notifications[0], notifications[2]],
    [...notifications, notifications[2]],
  ]) {
    assert.throws(() => scheduledRepairCliEnvelope(broken), /chunk sequence is inconsistent/);
  }
});

test('an hourly occurrence key names a series and the UTC hour', () => {
  assert.equal(hourlyOccurrenceKey('2026-09-15T10:30:00.000Z'), 'hour-2026-09-15T10');
  assert.equal(hourlyOccurrenceKey('2026-09-15T10:30:00.000Z', 'jarvos-shared-skill-repair'), 'jarvos-shared-skill-repair-2026-09-15T10');
  // A series that is not a bounded name falls back to the default rather than
  // producing a key the decision ledger would refuse.
  assert.equal(hourlyOccurrenceKey('2026-09-15T10:30:00.000Z', 'not a series'), 'hour-2026-09-15T10');
  assert.equal(hourlyOccurrenceKey('2026-09-15T10:30:00.000Z', 'x'.repeat(46)), 'hour-2026-09-15T10');
  assert.equal(hourlyOccurrenceKey('not-a-time'), null);
});

test('a production run key stamped to the minute reminds once an hour, not once a minute', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-production-key-');
  try {
    const statePath = decisionStatePath({ configPath });
    const pending = reconcileDecisions({ statePath, skills: [heldSkill()] }).pending;
    const repair = () => healthy({ decisions: { created: 0, pending: 1, items: [], pendingItems: pending, migration: null } });
    const run = (minute) => runScheduledRepair({
      configPath,
      now: `2026-08-16T16:${minute}:00.000Z`,
      occurrenceKey: `jarvos-shared-skill-repair:2026-08-16T16:${minute}`,
      repair,
    });
    const onTheHour = run('00');
    assert.match(onTheHour.message, /use-anthropic/);
    // Every minute of the hour names the same occurrence, so a retry replays
    // that one reminder under its one identity rather than claiming another.
    for (const minute of ['05', '30', '59']) {
      assert.equal(run(minute).notification.dedupeIdentity, onTheHour.notification.dedupeIdentity, `retry at :${minute}`);
    }
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions[0].reminder.count, 1, 'one reminder for the hour');
    const next = runScheduledRepair({
      configPath,
      now: '2026-08-16T17:02:00.000Z',
      occurrenceKey: 'jarvos-shared-skill-repair:2026-08-16T17:02',
      repair,
    });
    assert.match(next.message, /use-anthropic/);
    assert.notEqual(next.notification.dedupeIdentity, onTheHour.notification.dedupeIdentity);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.decisions[0].reminder.count, 2);
    // Minutes are not remembered as custom keys, so the bounded custom history
    // can never fill up and silence later hours.
    assert.deepEqual(persisted.reminderOccurrences.occurrences, []);
    // Once the next hour has been claimed, the hour before it is closed.
    assert.equal(run('30').message, 'NO_REPLY', 'a superseded hour never reopens');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy migration produces one understandable batch summary and stays quiet on replay', () => {
  const result = healthy({
    decisions: {
      created: 0,
      pending: 2,
      items: [],
      migration: { migrated: true, replay: false, reference: 'batch-0123456789abcdef01234567', pendingCount: 2, migratedCount: 2 },
    },
  });
  const notification = scheduledRepairNotification(result);
  assert.equal(notification.disposition, 'direct-notification');
  assert.match(notification.output, /2 skills that still need your decision/);
  assert.match(notification.output, /left them unchanged/);
  assert.doesNotMatch(notification.output, /batch-|needs_owner_input|receipt|\//);
  const replay = scheduledRepairNotification(healthy({ decisions: { created: 0, pending: 2, items: [], migration: { migrated: false, replay: true, reference: 'batch-0123456789abcdef01234567', pendingCount: 2, migratedCount: 2 } } }));
  assert.equal(replay.output, 'NO_REPLY');
});

test('missing runner receipt produces an opaque owner-action recovery message', () => {
  const message = scheduledRepairMessage({
    ok: false,
    reason: 'runner_receipt_missing',
    status: { observedAt: '2026-08-16T12:30:00.000Z' },
  });
  assert.match(message, /could not complete a safe recovery and preserved the existing state/);
  assert.match(message, /Action required: Choose how jarvOS should proceed/);
  assert.match(message, /Next: jarvOS will continue monitoring safely/);
  assert.match(message, /Reference: [A-Za-z0-9_-]{22,128}\./);
  assert.doesNotMatch(message, /runner_receipt_missing|receipt|missing|\//);
});

test('action-required CLI output is a strict redacted semantic envelope', () => {
  const result = healthy({
    attention: { raised: [{ logicalId: 'private-skill', reasonCode: 'stale_source', sourceRoot: '/Users/andrew/private' }], resolved: [] },
  });
  const notification = scheduledRepairNotification(result);
  const envelope = JSON.parse(scheduledRepairCliOutput(notification));
  assert.deepEqual(Object.keys(envelope).sort(), ['dedupeIdentity', 'disposition', 'event', 'message', 'schema']);
  assert.equal(envelope.schema, OPERATOR_NOTIFICATION_TRANSPORT_VERSION);
  assert.equal(envelope.disposition, 'action-required');
  assert.equal(envelope.event.schemaVersion, 'jarvos-operator-notification/v1');
  assert.equal(envelope.message, notification.output);
  assert.equal(envelope.dedupeIdentity, notification.dedupeIdentity);
  assert.match(envelope.message, /Action required: Choose how jarvOS should proceed/);
  assert.doesNotMatch(JSON.stringify(envelope), /private-skill|unsafe_source|\/Users\/andrew/);
});

test('quiet scheduled repair output remains exactly NO_REPLY', () => {
  assert.equal(scheduledRepairCliOutput(scheduledRepairNotification(healthy())), 'NO_REPLY');
});

test('event references are random while the dedupe identity is stable', () => {
  const result = healthy({ attention: { raised: [{ logicalId: 'private-skill', reasonCode: 'stale_source' }], resolved: [] } });
  const first = scheduledRepairNotification(result);
  const second = scheduledRepairNotification(result);
  assert.notEqual(first.event.eventReference, second.event.eventReference);
  assert.notEqual(first.event.privateDetailReference, second.event.privateDetailReference);
  assert.equal(first.dedupeIdentity, second.dedupeIdentity);
  assert.match(eventFor(result).eventReference, /^[A-Za-z0-9_-]{22,128}$/);
});

test('incomplete inventory remains a quiet durable safety hold', () => {
  const notification = scheduledRepairNotification(healthy({
    mutationDenied: true,
    reason: 'incomplete_generation',
    status: { counts: { actionable: 3 } },
  }));
  assert.equal(notification.output, 'NO_REPLY');
  assert.equal(notification.disposition, 'durable-status');
  assert.match(notification.statusMessage, /paused an unsafe change/);
  assert.doesNotMatch(notification.statusMessage, /incomplete_generation|actionable/);
});

test('automatic repairs remain quiet', () => {
  const notification = scheduledRepairNotification(healthy({
    reconciliation: { repaired: true, applied: [{ applied: true }] },
  }));
  assert.equal(notification.output, 'NO_REPLY');
  assert.equal(notification.disposition, 'quiet');
  assert.equal(notification.statusMessage, null);
});

test('runner calls status only for an explicit convergence announcement', () => {
  let statusReads = 0;
  const normal = runScheduledRepair({
    configPath: '/not-read',
    repair: () => healthy(),
    readStatus: () => { statusReads += 1; return { pairs: [] }; },
  });
  assert.equal(normal.message, 'NO_REPLY');
  assert.equal(statusReads, 0);

  const announced = runScheduledRepair({
    configPath: '/not-read',
    announceConvergence: true,
    repair: () => healthy(),
    readStatus: () => { statusReads += 1; return { pairs: [{ status: 'clean' }] }; },
  });
  assert.match(announced.message, /1\/1 managed harness projection clean/);
  assert.equal(statusReads, 1);
});

test('each actionable unsafe, private, or under-trusted skill gets a complete named hourly reminder until resolved, with acknowledge, defer, and resume', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-restricted-');
  try {
    const statePath = decisionStatePath({ configPath });
    const cases = [
      ['privacy-skill', 'privacy_restricted', /because it appears to contain private information, such as a credential\. Nothing changed/, /To fix it, remove the private information from the skill, or keep it local\./],
      ['script-skill', 'trust_class_insufficient', /because it includes scripts, but its folder is trusted only for instructions\. Nothing changed/, /To fix it, remove its scripts, or move it to a folder trusted for scripts; otherwise keep it local\./],
      ['unsafe-skill', 'unsafe_source', /because jarvOS could not confirm that its files are safe to share\. Nothing changed/, /To fix it, review the skill’s files and remove anything unsafe, or keep it local\./],
    ];
    cases.forEach(([logicalId, reasonCode, cause, recovery], index) => {
      const skills = [heldSkill({ logicalId, disposition: { kind: 'blocked', reasonCode } })];
      const repair = () => {
        const { pending } = reconcileDecisions({ statePath, skills });
        return healthy({ decisions: { created: 0, pending: pending.length, items: [], pendingItems: pending, migration: null } });
      };
      const at = (hour, minute = '00') => `2026-08-1${6 + index}T${String(hour).padStart(2, '0')}:${minute}:00.000Z`;
      const run = (now) => runScheduledRepair({ configPath, now, repair });

      const first = run(at(10));
      assert.equal(first.notification.event.code, 'skill-owner-decision', reasonCode);
      assert.match(first.message, new RegExp(`found the ${logicalId} skill but did not share it with Claude, Hermes, and OpenClaw`));
      assert.match(first.message, cause);
      assert.match(first.message, recovery);
      assert.match(first.message, /Choices: reply “keep local” to leave it where it is; reply “exclude” to stop offering it; reply “details”/);
      assert.match(first.message, /remind you every hour until you choose.*“acknowledge”.*“defer until”.*“resume”/);
      assert.doesNotMatch(first.message, /“share”|privacy_restricted|trust_class_insufficient|unsafe_source|[a-f0-9]{64}|\//);
      // A retry within the hour replays that one reminder; it never claims a
      // second one for the occurrence.
      assert.equal(run(at(10, '30')).notification.dedupeIdentity, first.notification.dedupeIdentity, 'one reminder per occurrence');

      const decision = reconcileDecisions({ statePath, skills }).pending[0];
      assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions.find((item) => item.id === decision.id).reminder.count, 1, reasonCode);
      acknowledgeDecision({ statePath, principal: owner(), decisionId: decision.id });
      // An owner pause inside the occurrence silences its replay too.
      assert.equal(run(at(10, '45')).message, 'NO_REPLY', 'acknowledged mid-occurrence');
      assert.equal(run(at(11)).message, 'NO_REPLY', 'acknowledged');
      resumeDecision({ statePath, principal: owner(), decisionId: decision.id });
      assert.match(run(at(12)).message, new RegExp(`found the ${logicalId} skill`), 'resumed');
      assert.equal(deferDecision({ statePath, principal: owner(), decisionId: decision.id, until: at(15), now: at(12, '10') }).status, 'updated');
      assert.equal(run(at(13)).message, 'NO_REPLY', 'deferred');
      assert.match(run(at(15)).message, new RegExp(`found the ${logicalId} skill`), 'deferral expired');
      assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: decision.id, revision: 1, option: 'keep-local', currentSkill: skills[0], mutate: () => {} }).status, 'resolved');
      assert.equal(run(at(16)).message, 'NO_REPLY', 'resolved');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a quiet, never-accepted absent source never alerts and records nothing', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-quiet-absent-');
  try {
    const statePath = decisionStatePath({ configPath });
    const skills = [heldSkill({ attention: 'quiet', disposition: { kind: 'needs_input', reasonCode: 'source_absent' } })];
    const repair = () => {
      const { pending } = reconcileDecisions({ statePath, skills });
      return healthy({ decisions: { created: 0, pending: pending.length, items: [], pendingItems: pending, migration: null } });
    };
    for (const now of ['2026-08-16T16:00:00.000Z', '2026-08-16T17:00:00.000Z']) {
      const run = runScheduledRepair({ configPath, now, repair });
      assert.equal(run.message, 'NO_REPLY');
      assert.equal(scheduledRepairCliOutput(run.notification), 'NO_REPLY');
    }
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a batch whose membership changes within one occurrence sends one message with one delivery identity', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-membership-');
  try {
    const statePath = decisionStatePath({ configPath });
    let skills = ['alpha-skill', 'bravo-skill'].map((logicalId) => heldSkill({ logicalId }));
    const repair = () => {
      const { pending } = reconcileDecisions({ statePath, skills });
      return healthy({ decisions: { created: 0, pending: pending.length, items: [], pendingItems: pending, migration: null } });
    };
    const first = runScheduledRepair({ configPath, now: '2026-08-16T16:00:00.000Z', repair });
    assert.equal(first.notification.event.code, 'skill-owner-decision-batch');
    skills = [...skills, heldSkill({ logicalId: 'charlie-skill' })];
    // A decision that first becomes actionable inside the occurrence does not
    // join it: the replay names the occurrence's own members and nothing else,
    // so a message a sender already accepted never changes underneath it.
    const grown = runScheduledRepair({ configPath, now: '2026-08-16T16:45:00.000Z', repair });
    assert.equal(grown.notification.dedupeIdentity, first.notification.dedupeIdentity);
    assert.deepEqual(grown.notification.event.decisions.map((item) => item.skillName), ['alpha-skill', 'bravo-skill']);
    // Even rendered, the same occurrence keeps one identity whatever it names.
    const pending = reconcileDecisions({ statePath, skills }).pending;
    const render = (members) => scheduledRepairNotification(healthy({ decisions: { created: 0, pending: members.length, items: [], pendingItems: members, migration: null } }), {
      reminderClaims: members.map((decision) => ({ decisionId: decision.id })), occurrenceKey: 'hour-2026-08-16T16',
    });
    assert.equal(render(pending).dedupeIdentity, first.notification.dedupeIdentity);
    assert.equal(render(pending.slice(1)).dedupeIdentity, first.notification.dedupeIdentity);
    const next = runScheduledRepair({ configPath, now: '2026-08-16T17:00:00.000Z', repair });
    assert.notEqual(next.notification.dedupeIdentity, first.notification.dedupeIdentity);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stuck decision lock gate during a reminder claim is a safe, visible failure once per occurrence that preserves state', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-lock-gate-');
  try {
    const statePath = decisionStatePath({ configPath });
    const gate = `${statePath}.lock.gate`;
    const pending = reconcileDecisions({ statePath, skills: [heldSkill()] }).pending;
    const repair = () => healthy({ decisions: { created: 0, pending: 1, items: [], pendingItems: pending, migration: null } });
    const before = fs.readFileSync(statePath, 'utf8');
    fs.mkdirSync(gate);

    // The real ledger reports the stuck gate with its structured code.
    const stuck = runScheduledRepair({ configPath, now: '2026-08-16T16:00:00.000Z', repair });
    const { event } = stuck.notification;
    assert.equal(event.code, 'recovery-failed');
    assert.equal(event.failureCause, 'decision-lock-gate');
    assert.equal(event.action, 'follow-recovery');
    assert.equal(stuck.notification.disposition, 'direct-notification');
    // The reminder claim fails after the skill sync of the same run, so the
    // recovery claims only the decision and reminder ledger, never that no
    // skill changed: repair may already have updated compatible skills.
    for (const expected of [
      'could not record skill decision reminders because an interrupted jarvOS process left the decision ledger lock gate behind',
      'Your skill decisions and reminders were left exactly as they were.',
      'Any shared skill sync that already finished in this run still stands; jarvOS did not undo it.',
      'confirm no jarvOS process is running, then remove the leftover folder named “owner-decisions.json.lock.gate”',
      'Action required: Follow the recovery step above',
    ]) assert.ok(stuck.message.includes(expected), `${expected}\n---\n${stuck.message}`);
    assert.doesNotMatch(stuck.message, /no skill, decision, or reminder was changed|preserved the existing state/);
    // The envelope declares the established `jarvos-operator-notification/v1`
    // schema identifier, whose slash is contract syntax rather than a path.
    // Every other slash anywhere in the envelope would be a leaked absolute
    // path, so it is stripped before the leak check rather than allowed for.
    const withoutSchemaId = (notification) => JSON.stringify(notification).split('jarvos-operator-notification/v1').join('');
    assert.doesNotMatch(withoutSchemaId(stuck.notification), /\/|ELEASEGATE|decision state is busy|use-anthropic/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    assert.ok(fs.existsSync(gate), 'the gate is never removed automatically');

    // A failure that persists is reported once per occurrence, never deduped
    // forever, and its thrown message never leaks.
    const thrown = () => { throw Object.assign(new Error(`decision state is busy; remove ${gate}`), { code: 'ELEASEGATE', operation: 'decision-ledger' }); };
    const again = (now) => runScheduledRepair({ configPath, now, repair, claimReminders: thrown });
    assert.equal(again('2026-08-16T16:30:00.000Z').notification.dedupeIdentity, stuck.notification.dedupeIdentity);
    const nextHour = again('2026-08-16T17:00:00.000Z');
    assert.notEqual(nextHour.notification.dedupeIdentity, stuck.notification.dedupeIdentity);
    assert.doesNotMatch(withoutSchemaId(nextHour.notification), /\/|busy/);

    fs.rmdirSync(gate);
    const recovered = runScheduledRepair({ configPath, now: '2026-08-16T17:05:00.000Z', repair });
    assert.equal(recovered.notification.event.code, 'skill-owner-decision');
    assert.match(recovered.message, /use-anthropic/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable decision ledger during a reminder claim is reported and never overwritten', () => {
  const { root, configPath } = seededConfig('jarvos-scheduled-unreadable-');
  try {
    const statePath = decisionStatePath({ configPath });
    const pending = reconcileDecisions({ statePath, skills: [heldSkill()] }).pending;
    const repair = () => healthy({ decisions: { created: 0, pending: 1, items: [], pendingItems: pending, migration: null } });
    fs.chmodSync(statePath, 0o644);
    const before = fs.readFileSync(statePath, 'utf8');
    const run = runScheduledRepair({ configPath, now: '2026-08-16T16:00:00.000Z', repair });
    assert.equal(run.notification.event.failureCause, 'decision-ledger-unreadable');
    assert.match(run.message, /It did not overwrite that file\./);
    assert.match(run.message, /Your skill decisions and reminders were left exactly as they were\./);
    assert.doesNotMatch(run.message, /no skill, decision, or reminder was changed/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI catch keeps only the reviewed failure cause and occurrence identity', () => {
  const leaked = Object.assign(new Error('shared skill scheduler is already running; a lock gate was left behind: remove /Users/andrew/.jarvos/.shared-skill-cli.lock.gate token=abc'), { code: 'ELEASEGATE', operation: 'scheduler' });
  const envelope = JSON.parse(failureOutput(leaked, { occurrenceKey: 'hour-2026-08-16T16', now: '2026-08-16T16:10:00.000Z' }));
  assert.equal(envelope.disposition, 'action-required');
  assert.equal(envelope.event.failureCause, 'skill-sync-lock-gate');
  assert.equal(envelope.event.action, 'follow-recovery');
  // The sync lock gate fails before any skill work, so it alone may still say
  // that nothing at all changed.
  assert.match(envelope.message, /It stopped before doing any skill work, so no skill, AI tool, or decision was changed\./);
  assert.match(envelope.message, /remove the leftover folder named “\.shared-skill-cli\.lock\.gate”/);
  assert.doesNotMatch(JSON.stringify(envelope), /\/Users|token|already running|ELEASEGATE/);
  const nextHour = JSON.parse(failureOutput(leaked, { occurrenceKey: 'hour-2026-08-16T17', now: '2026-08-16T17:10:00.000Z' }));
  assert.notEqual(nextHour.dedupeIdentity, envelope.dedupeIdentity);

  const unknown = JSON.parse(failureOutput(new Error('/Users/andrew/private boom')));
  assert.equal(unknown.event.failureCause, undefined);
  assert.match(unknown.message, /could not complete a safe recovery and preserved the existing state/);
  assert.doesNotMatch(JSON.stringify(unknown), /\/Users|boom/);

  const coded = (code, operation) => failureCauseFor(Object.assign(new Error('x'), { code, operation }));
  assert.equal(coded('ELEASEGATE', 'decision-ledger'), 'decision-lock-gate');
  assert.equal(coded('ELEASEBUSY', 'decision-ledger'), 'decision-ledger-busy');
  assert.equal(coded('ELEASEBUSY', 'scheduler'), null);
  assert.equal(coded('EDECISIONSTATE'), 'decision-ledger-unreadable');
  assert.equal(coded('EOCCURRENCE'), 'reminder-occurrence-rejected');
  assert.equal(coded('ENOENT'), null);
});
