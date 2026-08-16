'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OPERATOR_NOTIFICATION_TRANSPORT_VERSION,
  eventFor,
  scheduledRepairCliOutput,
  scheduledRepairMessage,
  scheduledRepairNotification,
  runScheduledRepair,
} = require('../src/scheduled-repair');

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
