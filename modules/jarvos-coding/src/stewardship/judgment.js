'use strict';

const JUDGMENT_ENVELOPE_VERSION = 'jarvos-stewardship-judgment.v1';
const JUDGMENT_STATES = Object.freeze(['accepted', 'delivered_in_session', 'acknowledged', 'answered', 'timed_out', 'delivered_fallback']);
const ABSOLUTE_PATH = /(?:^|[\s"'(=:])(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const FORBIDDEN = /(?:transcript|raw.?message|message.?body|credential|secret|token|password|api[_-]?key|agent.?mail|paperclip|beads|publication.?approval)/i;

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function opaque(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !ABSOLUTE_PATH.test(value); }
function label(value, max = 63) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value) && value.length <= max; }
function plain(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value) && !ABSOLUTE_PATH.test(value) && !SECRET_VALUE.test(value) && !/(?:paperclip|beads|agent\s*mail)/i.test(value); }
function exact(value, fields) { return object(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)); }
function deadline(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function safeKeys(value, path, errors) { if (!object(value)) return; for (const [key, child] of Object.entries(value)) { if (FORBIDDEN.test(key)) errors.push(`${path}.${key} is not public`); if (object(child)) safeKeys(child, `${path}.${key}`, errors); } }

function consistentJudgmentState(value) {
  const ids = value.eventIds;
  if (!exact(ids, ['delivery', 'acknowledgement', 'answer', 'timeout', 'fallback'])) return false;
  const present = (slot) => ids[slot] !== null;
  const hasAnswer = value.answer !== null;
  const prefixIsValid = !present('acknowledgement') || present('delivery');
  if (!prefixIsValid || present('answer') !== hasAnswer) return false;
  if (value.state === 'accepted') return !Object.values(ids).some(presentId) && !hasAnswer;
  if (value.state === 'delivered_in_session') return present('delivery') && !present('acknowledgement') && !present('answer') && !present('timeout') && !present('fallback');
  if (value.state === 'acknowledged') return present('delivery') && present('acknowledgement') && !present('answer') && !present('timeout') && !present('fallback');
  if (value.state === 'timed_out') return present('timeout') && !present('answer') && !present('fallback');
  if (value.state === 'delivered_fallback') return present('fallback') && !present('answer');
  if (value.state === 'answered') return hasAnswer && (present('fallback') || (present('delivery') && present('acknowledgement') && !present('timeout')));
  return false;
}

function presentId(id) { return id !== null; }

function validateJudgmentEnvelope(value) {
  const errors = [];
  const fields = ['version', 'judgmentId', 'sessionId', 'causalRunId', 'reconcileId', 'owner', 'prompt', 'choices', 'defaultChoiceId', 'acknowledgementDeadline', 'fallback', 'state', 'eventIds', 'answer'];
  if (!exact(value, fields)) return { ok: false, errors: ['judgment envelope has an invalid public shape'] };
  if (value.version !== JUDGMENT_ENVELOPE_VERSION) errors.push('judgment envelope has an invalid version');
  for (const field of ['judgmentId', 'sessionId', 'causalRunId', 'reconcileId', 'defaultChoiceId']) if (!opaque(value[field])) errors.push(`${field} must be opaque`);
  if (!exact(value.owner, ['harness', 'adapter']) || !label(value.owner?.harness) || !label(value.owner?.adapter)) errors.push('owner must have bounded harness and adapter labels');
  if (!plain(value.prompt, 280)) errors.push('prompt must be concise public plain text');
  if (!Array.isArray(value.choices) || value.choices.length < 2 || value.choices.length > 3) errors.push('choices must contain two or three options');
  else {
    const ids = new Set();
    for (const choice of value.choices) {
      if (!exact(choice, ['id', 'label', 'consequence']) || !opaque(choice.id) || !plain(choice.label, 60) || !plain(choice.consequence, 140)) errors.push('choice is invalid');
      ids.add(choice.id);
    }
    if (ids.size !== value.choices.length || !ids.has(value.defaultChoiceId)) errors.push('default choice must be one distinct choice');
  }
  if (!deadline(value.acknowledgementDeadline)) errors.push('acknowledgement deadline is invalid');
  if (!exact(value.fallback, ['channelKind']) || !label(value.fallback?.channelKind)) errors.push('fallback must name one public channel kind');
  if (!JUDGMENT_STATES.includes(value.state)) errors.push('judgment state is invalid');
  if (!exact(value.eventIds, ['delivery', 'acknowledgement', 'answer', 'timeout', 'fallback']) || Object.values(value.eventIds).some((id) => id !== null && !opaque(id))) errors.push('event IDs are invalid');
  if (value.answer !== null && (!exact(value.answer, ['choiceId']) || !value.choices?.some((choice) => choice.id === value.answer.choiceId))) errors.push('answer is invalid');
  if (!consistentJudgmentState(value)) errors.push('judgment state is inconsistent with its event history');
  safeKeys(value, 'judgment', errors);
  return { ok: errors.length === 0, errors };
}

function createJudgmentEnvelope(input = {}) {
  const value = {
    version: JUDGMENT_ENVELOPE_VERSION, judgmentId: input.judgmentId, sessionId: input.sessionId,
    causalRunId: input.causalRunId, reconcileId: input.reconcileId, owner: input.owner, prompt: input.prompt,
    choices: input.choices, defaultChoiceId: input.defaultChoiceId, acknowledgementDeadline: input.acknowledgementDeadline,
    fallback: input.fallback, state: 'accepted', eventIds: { delivery: null, acknowledgement: null, answer: null, timeout: null, fallback: null }, answer: null,
  };
  const result = validateJudgmentEnvelope(value); if (!result.ok) throw new Error(result.errors.join('; '));
  return Object.freeze(value);
}

function validEvent(event) {
  if (!object(event) || !['delivered_in_session', 'acknowledged', 'answered', 'timed_out', 'delivered_fallback'].includes(event.type) || !opaque(event.eventId)) return false;
  for (const field of ['judgmentId', 'sessionId', 'causalRunId', 'reconcileId']) if (!opaque(event[field])) return false;
  const allowed = new Set(['type', 'eventId', 'judgmentId', 'sessionId', 'causalRunId', 'reconcileId', 'choiceId', 'deliveryUnavailable']);
  if (Object.keys(event).some((key) => !allowed.has(key) || FORBIDDEN.test(key))) return false;
  if (event.choiceId !== undefined && !opaque(event.choiceId)) return false;
  return event.deliveryUnavailable === undefined || event.deliveryUnavailable === true;
}
function correlated(envelope, event) { return ['judgmentId', 'sessionId', 'causalRunId', 'reconcileId'].every((field) => envelope[field] === event[field]); }
function transition(envelope, state, slot, event, answer = envelope.answer) {
  return Object.freeze({ ...envelope, state, eventIds: { ...envelope.eventIds, [slot]: event.eventId }, answer });
}
function applyJudgmentEvent(envelope, event, { now = new Date().toISOString() } = {}) {
  const valid = validateJudgmentEnvelope(envelope); if (!valid.ok) return { ok: false, reason: 'invalid_envelope', envelope };
  if (!validEvent(event) || !correlated(envelope, event)) return { ok: false, reason: 'correlation_mismatch', envelope };
  if (envelope.state === 'answered') return { ok: false, reason: 'terminal_state', envelope };
  if (Object.values(envelope.eventIds).includes(event.eventId)) return { ok: false, reason: 'duplicate_event', envelope };
  const current = Date.parse(now); if (!Number.isFinite(current)) return { ok: false, reason: 'invalid_clock', envelope };
  if (event.type === 'delivered_in_session' && envelope.state === 'accepted') return { ok: true, envelope: transition(envelope, 'delivered_in_session', 'delivery', event) };
  if (event.type === 'acknowledged' && envelope.state === 'delivered_in_session') return { ok: true, envelope: transition(envelope, 'acknowledged', 'acknowledgement', event) };
  if (event.type === 'answered' && ['acknowledged', 'delivered_fallback'].includes(envelope.state)) {
    if (!envelope.choices.some((choice) => choice.id === event.choiceId)) return { ok: false, reason: 'invalid_choice', envelope };
    return { ok: true, envelope: transition(envelope, 'answered', 'answer', event, { choiceId: event.choiceId }) };
  }
  if (event.type === 'timed_out' && ['accepted', 'delivered_in_session', 'acknowledged'].includes(envelope.state)) {
    return current >= Date.parse(envelope.acknowledgementDeadline) ? { ok: true, envelope: transition(envelope, 'timed_out', 'timeout', event) } : { ok: false, reason: 'deadline_not_reached', envelope };
  }
  if (event.type === 'delivered_fallback' && ['accepted', 'delivered_in_session', 'acknowledged', 'timed_out'].includes(envelope.state)) {
    if (envelope.state !== 'timed_out' && event.deliveryUnavailable !== true && current < Date.parse(envelope.acknowledgementDeadline)) return { ok: false, reason: 'fallback_not_eligible', envelope };
    return { ok: true, envelope: transition(envelope, 'delivered_fallback', 'fallback', event) };
  }
  return { ok: false, reason: 'invalid_transition', envelope };
}

module.exports = { JUDGMENT_ENVELOPE_VERSION, JUDGMENT_STATES, applyJudgmentEvent, createJudgmentEnvelope, validateJudgmentEnvelope };
