'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  scheduledRepairMessage,
  scheduledRepairNotification,
  runScheduledRepair,
} = require('../src/scheduled-repair');

const OBSERVED_AT = '2026-08-16T15:00:00Z';

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

function assertNoRawCodes(text) {
  assert.equal(typeof text, 'string');
  assert.doesNotMatch(text, /unsafe_source|needs_owner_input|review_required|incomplete_observation|semantic_collision|ambiguous_identity/);
  assert.doesNotMatch(text, /logicalId|sourceRoot|SKILL\.md|\/Users\//);
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
  assertNoRawCodes(message);
});

test('AE1: unsafe_source safety hold is quiet and keeps codes out of human output', () => {
  const notification = scheduledRepairNotification(healthy({
    attention: {
      raised: [
        { logicalId: 'private-name', reasonCode: 'unsafe_source', fingerprint: 'a'.repeat(64) },
      ],
      resolved: [],
    },
  }), { observedAt: OBSERVED_AT });

  assert.equal(notification.message, 'NO_REPLY');
  assert.equal(notification.disposition, 'durable-status');
  assert.match(notification.statusMessage, /paused an unsafe change/i);
  assertNoRawCodes(notification.message);
  assertNoRawCodes(notification.statusMessage || '');
  assert.equal(notification.durableStatus[0].kind, 'safe-hold');
  assert.match(notification.durableStatus[0].reasons, /unsafe_source/);
});

test('automatic repairs and resolutions stay quiet', () => {
  const repaired = scheduledRepairNotification(healthy({
    reconciliation: { repaired: true, applied: [{ applied: true }, { applied: false }] },
    attention: { raised: [], resolved: [] },
  }), { observedAt: OBSERVED_AT });
  assert.equal(repaired.message, 'NO_REPLY');
  assert.equal(repaired.disposition, 'quiet');

  const resolved = scheduledRepairNotification(healthy({
    attention: {
      raised: [],
      resolved: [{ logicalId: 'old-private-name', reasonCode: 'old_reason', fingerprint: 'b'.repeat(64) }],
    },
  }), { observedAt: OBSERVED_AT });
  assert.equal(resolved.message, 'NO_REPLY');
  assert.ok(resolved.disposition === 'quiet' || resolved.disposition === 'durable-status');
  assertNoRawCodes(resolved.message);
});

test('AE2: owner decision produces one complete actionable message with opaque reference', () => {
  const notification = scheduledRepairNotification(healthy({
    attention: {
      raised: [
        { logicalId: 'private-name', reasonCode: 'needs_owner_input', fingerprint: 'c'.repeat(64) },
        { logicalId: 'another-private-name', reasonCode: 'semantic_collision', fingerprint: 'd'.repeat(64) },
      ],
      resolved: [],
    },
  }), { observedAt: OBSERVED_AT });

  assert.equal(notification.disposition, 'direct-notification');
  assert.match(notification.message, /could not complete a safe recovery|preserved the existing state/i);
  assert.match(notification.message, /Action required:/);
  assert.match(notification.message, /Next:/);
  assert.match(notification.message, /Reference: [A-Za-z0-9_-]{22,}/);
  assertNoRawCodes(notification.message);
  assert.doesNotMatch(notification.message, /private-name|another-private-name/);
});

test('untrusted reason text never enters human output and fails closed as owner decision', () => {
  const notification = scheduledRepairNotification(healthy({
    attention: { raised: [{ reasonCode: 'private value\nsecond line', fingerprint: 'e'.repeat(64) }], resolved: [] },
  }), { observedAt: OBSERVED_AT });
  assert.equal(notification.disposition, 'direct-notification');
  assertNoRawCodes(notification.message);
  assert.doesNotMatch(notification.message, /private value|second line|needs_owner_input/);
  assert.match(notification.message, /Reference:/);
});

test('incomplete inventory fails closed with an owner decision and no raw codes', () => {
  const notification = scheduledRepairNotification(healthy({
    mutationDenied: true,
    reason: 'incomplete_generation',
    status: { counts: { actionable: 3 } },
  }), { observedAt: OBSERVED_AT });
  assert.equal(notification.disposition, 'direct-notification');
  assert.match(notification.message, /Action required:/);
  assert.match(notification.message, /Reference:/);
  assertNoRawCodes(notification.message);
  assert.doesNotMatch(notification.message, /incomplete_generation|3 items/);
});

test('failed repair run is action-required without diagnostic leakage', () => {
  const notification = scheduledRepairNotification({
    ok: false,
    reason: 'child_crashed',
    stderr: 'Error: boom at /Users/andrew/private.js:1:1',
  }, { observedAt: OBSERVED_AT });
  assert.equal(notification.disposition, 'direct-notification');
  assert.match(notification.message, /Action required:/);
  assert.match(notification.message, /Reference:/);
  assertNoRawCodes(notification.message);
  assert.doesNotMatch(notification.message, /child_crashed|private\.js|boom/);
});

test('mixed safe holds and owner decisions prefer the owner interrupt once', () => {
  const notification = scheduledRepairNotification(healthy({
    reconciliation: { repaired: true, applied: [{ applied: true }] },
    attention: {
      raised: [
        { logicalId: 'hold-me', reasonCode: 'unsafe_source', fingerprint: 'f'.repeat(64) },
        { logicalId: 'decide-me', reasonCode: 'needs_owner_input', fingerprint: 'g'.repeat(64) },
      ],
      resolved: [{ logicalId: 'was-held', reasonCode: 'unsafe_source', fingerprint: 'h'.repeat(64) }],
    },
  }), { observedAt: OBSERVED_AT });
  assert.equal(notification.disposition, 'direct-notification');
  assertNoRawCodes(notification.message);
  assert.ok(notification.durableStatus.some((entry) => entry.kind === 'safe-hold'));
});

test('runner calls status only for an explicit convergence announcement', () => {
  let statusReads = 0;
  const normal = runScheduledRepair({
    configPath: '/not-read',
    repair: () => healthy(),
    readStatus: () => { statusReads += 1; return { pairs: [] }; },
    observedAt: OBSERVED_AT,
  });
  assert.equal(normal.message, 'NO_REPLY');
  assert.equal(statusReads, 0);

  const announced = runScheduledRepair({
    configPath: '/not-read',
    announceConvergence: true,
    repair: () => healthy(),
    readStatus: () => { statusReads += 1; return { pairs: [{ status: 'clean' }] }; },
    observedAt: OBSERVED_AT,
  });
  assert.match(announced.message, /1\/1 managed harness projection clean/);
  assert.equal(statusReads, 1);
});
