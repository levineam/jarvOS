'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { scheduledRepairMessage, runScheduledRepair } = require('../src/scheduled-repair');

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

test('new transitions and repairs produce one redacted message', () => {
  const message = scheduledRepairMessage(healthy({
    reconciliation: { repaired: true, applied: [{ applied: true }, { applied: false }] },
    attention: {
      raised: [
        { logicalId: 'private-name', reasonCode: 'review_required' },
        { logicalId: 'another-private-name', reasonCode: 'review_required' },
      ],
      resolved: [{ logicalId: 'old-private-name', reasonCode: 'old_reason' }],
    },
  }));
  assert.match(message, /2 new items need review: review_required \(2\)/);
  assert.match(message, /1 prior item resolved/);
  assert.match(message, /1 managed projection repaired/);
  assert.doesNotMatch(message, /private-name|another-private-name|old-private-name/);
});

test('untrusted reason text is replaced instead of entering a notification', () => {
  const message = scheduledRepairMessage(healthy({
    attention: { raised: [{ reasonCode: 'private value\nsecond line' }], resolved: [] },
  }));
  assert.match(message, /needs_owner_input \(1\)/);
  assert.doesNotMatch(message, /private value|second line/);
});

test('incomplete inventory fails closed with an actionable count', () => {
  const message = scheduledRepairMessage(healthy({
    mutationDenied: true,
    reason: 'incomplete_generation',
    status: { counts: { actionable: 3 } },
  }));
  assert.match(message, /inventory was incomplete/);
  assert.match(message, /3 items require review/);
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
