'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  JUDGMENT_ENVELOPE_VERSION,
  applyJudgmentEvent,
  createJudgmentEnvelope,
  validateJudgmentEnvelope,
} = require('../src');

const deadline = '2026-08-06T15:00:00.000Z';
function envelope(overrides = {}) {
  return createJudgmentEnvelope({
    judgmentId: 'judgment:one', sessionId: 'session:one', causalRunId: 'run:one', reconcileId: 'reconcile:one',
    owner: { harness: 'Future Harness', adapter: 'future-adapter' },
    prompt: 'This change needs a decision. Which safe next step should we take?',
    choices: [
      { id: 'keep', label: 'Keep it', consequence: 'Preserve the current work for review.' },
      { id: 'discard', label: 'Discard it', consequence: 'Stop this candidate without publishing it.' },
    ],
    defaultChoiceId: 'keep', acknowledgementDeadline: deadline, fallback: { channelKind: 'telegram' },
    ...overrides,
  });
}
function event(type, overrides = {}) {
  return { type, eventId: `event:${type}`, judgmentId: 'judgment:one', sessionId: 'session:one', causalRunId: 'run:one', reconcileId: 'reconcile:one', ...overrides };
}

test('active owning-session flow is correlated and advances exactly once', () => {
  const accepted = envelope();
  const delivered = applyJudgmentEvent(accepted, event('delivered_in_session'));
  const acknowledged = applyJudgmentEvent(delivered.envelope, event('acknowledged'));
  const answered = applyJudgmentEvent(acknowledged.envelope, event('answered', { choiceId: 'keep' }));
  assert.equal(accepted.version, JUDGMENT_ENVELOPE_VERSION);
  assert.equal(answered.ok, true); assert.equal(answered.envelope.state, 'answered');
  assert.equal(answered.envelope.answer.choiceId, 'keep');
  const duplicate = applyJudgmentEvent(answered.envelope, event('answered', { choiceId: 'keep' }));
  assert.deepEqual(duplicate, { ok: false, reason: 'terminal_state', envelope: answered.envelope });
});

test('offline or overdue work can use only the configured public fallback channel', () => {
  const accepted = envelope();
  const early = applyJudgmentEvent(accepted, event('delivered_fallback'), { now: '2026-08-06T14:00:00.000Z' });
  assert.equal(early.ok, false);
  const unavailable = applyJudgmentEvent(accepted, event('delivered_fallback', { deliveryUnavailable: true }));
  assert.equal(unavailable.envelope.state, 'delivered_fallback');
  const overdue = applyJudgmentEvent(accepted, event('timed_out'), { now: deadline });
  assert.equal(overdue.envelope.state, 'timed_out');
  assert.equal(applyJudgmentEvent(overdue.envelope, event('delivered_fallback')).envelope.state, 'delivered_fallback');
  assert.deepEqual(unavailable.envelope.fallback, { channelKind: 'telegram' });
});

test('a fallback-delivered judgment accepts one correlated answer, then becomes terminal', () => {
  const fallback = applyJudgmentEvent(envelope(), event('delivered_fallback', { deliveryUnavailable: true })).envelope;
  const answered = applyJudgmentEvent(fallback, event('answered', { choiceId: 'discard' }));
  assert.equal(answered.ok, true);
  assert.equal(answered.envelope.state, 'answered');
  assert.equal(answered.envelope.answer.choiceId, 'discard');
  assert.equal(applyJudgmentEvent(answered.envelope, event('answered', { eventId: 'event:competing-answer', choiceId: 'keep' })).reason, 'terminal_state');
  assert.equal(applyJudgmentEvent(answered.envelope, event('delivered_in_session', { eventId: 'event:late-in-session' })).reason, 'terminal_state');
});

test('mismatched, duplicate, invalid, and late race events fail closed without advancing', () => {
  const accepted = envelope();
  assert.equal(applyJudgmentEvent(accepted, event('delivered_in_session', { sessionId: 'session:other' })).ok, false);
  const delivered = applyJudgmentEvent(accepted, event('delivered_in_session')).envelope;
  assert.equal(applyJudgmentEvent(delivered, event('acknowledged', { eventId: 'event:delivered_in_session' })).reason, 'duplicate_event');
  assert.equal(applyJudgmentEvent(delivered, event('answered', { choiceId: 'keep' })).reason, 'invalid_transition');
  const acknowledged = applyJudgmentEvent(delivered, event('acknowledged')).envelope;
  assert.equal(applyJudgmentEvent(acknowledged, event('answered', { choiceId: 'nope' })).reason, 'invalid_choice');
  const timedOut = applyJudgmentEvent(acknowledged, event('timed_out'), { now: deadline }).envelope;
  assert.equal(applyJudgmentEvent(timedOut, event('answered', { choiceId: 'keep' })).ok, false);
});

test('public validation rejects private routing, paths, credentials, tracker authority, raw message bodies, and publication approval', () => {
  for (const change of [
    { fallback: { channelKind: 'telegram', address: '12345' } },
    { prompt: 'Open /Users/andrew/private.txt' },
    { credential: 'secret' },
    { agentMailToken: 'token' },
    { paperclipAuthority: 'write' },
    { rawMessageBody: 'private transcript' },
    { publicationApproval: true },
  ]) assert.equal(validateJudgmentEnvelope({ ...envelope(), ...change }).ok, false);
});

test('envelope permits a non-enumerated owning harness and three bounded choices', () => {
  const value = envelope({ owner: { harness: 'My Custom Harness', adapter: 'custom-v2' }, choices: [
    { id: 'one', label: 'One', consequence: 'First safe result.' },
    { id: 'two', label: 'Two', consequence: 'Second safe result.' },
    { id: 'three', label: 'Three', consequence: 'Third safe result.' },
  ], defaultChoiceId: 'one', fallback: { channelKind: 'discord' } });
  assert.equal(validateJudgmentEnvelope(value).ok, true);
});

test('validation rejects forged states without their required event history', () => {
  const accepted = envelope();
  for (const change of [
    { state: 'delivered_in_session' },
    { state: 'acknowledged' },
    { state: 'delivered_fallback' },
    { state: 'timed_out' },
    { state: 'answered' },
    { answer: { choiceId: 'keep' } },
    { eventIds: { ...accepted.eventIds, answer: 'event:forged-answer' } },
  ]) {
    const forged = { ...accepted, ...change };
    assert.equal(validateJudgmentEnvelope(forged).ok, false);
    assert.equal(applyJudgmentEvent(forged, event('answered', { choiceId: 'keep' })).reason, 'invalid_envelope');
  }
});
