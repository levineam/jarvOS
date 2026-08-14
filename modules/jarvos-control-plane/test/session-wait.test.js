'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SESSION_WAIT_CONTRACT_VERSION,
  SESSION_WAIT_STATES,
  createSessionWait,
  createTerminalReceipt,
  projectSessionWait,
  transitionSessionWait,
  validateSessionWait,
} = require('../src');

function origin(overrides = {}) {
  return {
    harness: 'codex',
    stableSessionId: 'thread-123',
    repoBinding: 'sha256:' + 'a'.repeat(64),
    workspaceBinding: 'sha256:' + 'b'.repeat(64),
    adapterGeneration: 'codex-adapter-1',
    ...overrides,
  };
}

function expectedTerminal(overrides = {}) {
  return {
    producer: 'active-assistant',
    eventType: 'active-assistant.operation.completed',
    subject: 'operation-123',
    revision: '7',
    fence: 'fence-7',
    ...overrides,
  };
}

function wait(overrides = {}) {
  return createSessionWait({
    workId: 'work-123',
    actionKey: 'aa.operation-123',
    origin: origin(),
    expectedTerminal: expectedTerminal(),
    deadline: '2026-08-14T12:00:00.000Z',
    createdAt: '2026-08-13T12:00:00.000Z',
    ...overrides,
  });
}

test('creates an idempotent, bounded SessionWait record', () => {
  const first = wait();
  const second = wait();

  assert.equal(first.contractVersion, SESSION_WAIT_CONTRACT_VERSION);
  assert.equal(first.state, 'registered');
  assert.equal(first.waitId, second.waitId);
  assert.deepEqual(first.origin, origin());
  assert.equal(first.deadlineWakeSource, 'jarvos-managed-software-reconcile');
  assert.equal(first.deadlineObservationWindowMs, 86400000);
  assert.deepEqual(first.delivery, {
    disposition: 'none',
    claimedAt: null,
    deliveredReceipt: null,
    queuedAt: null,
    consumedAt: null,
  });
  assert.deepEqual(first.eventIds, { registration: first.eventIds.registration, terminal: null, decision: null, delivery: null });
  assert.equal(validateSessionWait(first), true);
});

test('requires the explicit registered -> waiting -> terminal lifecycle', () => {
  const registered = wait();
  const waiting = transitionSessionWait(registered, 'waiting', { at: '2026-08-13T12:01:00.000Z' });
  const observed = transitionSessionWait(waiting, 'terminal_observed', {
    at: '2026-08-13T12:02:00.000Z',
    terminalReceiptId: 'receipt-123',
    safeProjection: { status: 'completed', reference: 'result-123' },
  });

  assert.equal(waiting.state, 'waiting');
  assert.equal(observed.state, 'terminal_observed');
  assert.equal(observed.eventIds.terminal, 'receipt-123');
  assert.equal(observed.safeProjection.reference, 'result-123');
  assert.throws(() => transitionSessionWait(registered, 'delivered'), /invalid session wait transition/);
});

test('terminal receipts bind producer, subject, revision, and wait identity', () => {
  const current = wait();
  const receipt = createTerminalReceipt({
    wait: current,
    receiptId: 'receipt-123',
    producer: 'active-assistant',
    eventType: 'active-assistant.operation.completed',
    subject: 'operation-123',
    revision: '7',
    fence: 'fence-7',
    outcome: 'completed',
    occurredAt: '2026-08-13T12:02:00.000Z',
    result: { digest: 'sha256:' + 'c'.repeat(64), handle: 'result-123' },
    safeProjection: { status: 'completed', reference: 'result-123' },
  });

  assert.equal(receipt.waitId, current.waitId);
  assert.equal(receipt.result.digest, 'sha256:' + 'c'.repeat(64));
  assert.equal(receipt.safeProjection.reference, 'result-123');
  assert.throws(() => createTerminalReceipt({
    wait: current,
    receiptId: 'receipt-124',
    producer: 'other-producer',
    eventType: 'active-assistant.operation.completed',
    subject: 'operation-123',
    revision: '7',
    fence: 'fence-7',
    outcome: 'completed',
    occurredAt: '2026-08-13T12:02:00.000Z',
    result: { digest: 'sha256:' + 'c'.repeat(64), handle: 'result-123' },
  }), /producer does not match/);
  assert.throws(() => createTerminalReceipt({
    wait: current,
    receiptId: 'receipt-125',
    producer: 'active-assistant',
    eventType: 'active-assistant.operation.completed',
    subject: 'operation-123',
    revision: '7',
    fence: 'fence-7',
    outcome: 'completed',
    occurredAt: '2026-08-13T12:02:00.000Z',
  }), /result digest is required/);
});

test('safe projections reject raw instructions, paths, and transcript-shaped content', () => {
  const current = wait();
  assert.throws(() => createTerminalReceipt({
    wait: current,
    receiptId: 'receipt-123',
    producer: 'active-assistant',
    eventType: 'active-assistant.operation.completed',
    subject: 'operation-123',
    revision: '7',
    fence: 'fence-7',
    outcome: 'completed',
    occurredAt: '2026-08-13T12:02:00.000Z',
    result: { digest: 'sha256:' + 'c'.repeat(64), handle: 'result-123' },
    safeProjection: { summary: 'Open /Users/andrew/private.txt and continue' },
  }), /safe projection/);
});

test('public projection excludes origin bindings and preserves terminal truth', () => {
  const current = transitionSessionWait(wait(), 'waiting', { at: '2026-08-13T12:01:00.000Z' });
  const projection = projectSessionWait(current);

  assert.deepEqual(projection.origin, { harness: 'codex', stableSessionId: 'thread-123', adapterGeneration: 'codex-adapter-1' });
  assert.equal(projection.repoBinding, undefined);
  assert.equal(projection.workspaceBinding, undefined);
  assert.equal(projection.state, 'waiting');
  assert.equal(projection.deadline, current.deadline);
  assert.equal(projection.deadlineWakeSource, current.deadlineWakeSource);
  assert.equal(projection.deadlineObservationWindowMs, current.deadlineObservationWindowMs);
});

test('state constants include explicit uncertainty, cancellation, and supersession', () => {
  for (const state of ['delivery_uncertain', 'cancelled', 'superseded', 'expired_missing_result', 'consumed']) {
    assert.ok(SESSION_WAIT_STATES.includes(state), state);
  }
});
