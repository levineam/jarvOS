'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OPERATOR_NOTIFICATION_TRANSPORT_VERSION,
  eventFor,
  scheduledRepairCliOutput,
  scheduledRepairMessage,
  scheduledRepairNotification,
  runScheduledRepair,
} = require('../src/scheduled-repair');
const { defaultConfig, saveConfig } = require('../src');

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
