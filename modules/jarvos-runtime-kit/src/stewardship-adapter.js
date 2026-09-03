'use strict';

const STEWARDSHIP_ADAPTER_VERSION = 'jarvos-stewardship-adapter.v1';
const ISOLATION_MODES = ['native', 'managed-launcher'];
const REQUIRED_LIFECYCLE_CAPABILITIES = ['startOrResume', 'heartbeat', 'checkpoint', 'stop', 'nextTurnInput'];
const HARNESS_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NEXT_TURN_INPUT_KEYS = ['choices', 'correlation', 'default', 'prompt'];
const MAX_PROMPT_CHARS = 600;
const MAX_CHOICE_CHARS = 160;
const MAX_CORRELATION_CHARS = 128;
const CORRELATION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_PUBLIC_TEXT = /(?:[\r\n\u0000-\u001f\u007f\u2028\u2029]|(?:^|[\s("'`])(?:\/|~\/|[A-Za-z]:[\\/])|https?:\/\/|file:\/\/|\\\\|\bsk-[A-Za-z0-9_-]{16,}\b|\b(?:api[ _-]?key|secret|password|token|credential|bearer)\b|\b(?:paperclip|beads|agent mail|transcript)\b|\b(?:issue|ticket)\s*(?:#|:)?\s*\d+\b|\b(?:private[- ]?router|local[- ]?route|route target)\b)/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isPublicText(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && /[A-Za-z]/.test(value)
    && !FORBIDDEN_PUBLIC_TEXT.test(value);
}

// This portable contract deliberately accepts only what a coding-session hook
// may display. It is not a command, routing, or publication-approval envelope.
function validateNextTurnInput(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, NEXT_TURN_INPUT_KEYS)) {
    return { ok: false, errors: ['next-turn input must contain only prompt, choices, default, and correlation'] };
  }
  if (!isPublicText(input.prompt, MAX_PROMPT_CHARS)) {
    return { ok: false, errors: ['next-turn input prompt must be bounded public plain text'] };
  }
  if (!Array.isArray(input.choices) || input.choices.length < 2 || input.choices.length > 3
    || input.choices.some((choice) => !isPublicText(choice, MAX_CHOICE_CHARS))
    || new Set(input.choices).size !== input.choices.length) {
    return { ok: false, errors: ['next-turn input choices must be 2-3 distinct bounded public strings'] };
  }
  if (!isPublicText(input.default, MAX_CHOICE_CHARS) || !input.choices.includes(input.default)) {
    return { ok: false, errors: ['next-turn input default must be one of the choices'] };
  }
  if (typeof input.correlation !== 'string' || input.correlation.length > MAX_CORRELATION_CHARS
    || !CORRELATION_IDENTIFIER.test(input.correlation) || FORBIDDEN_PUBLIC_TEXT.test(input.correlation)) {
    return { ok: false, errors: ['next-turn input correlation must be a bounded opaque identifier'] };
  }
  return { ok: true, value: input };
}

function validateNextTurnBridgeResponse(response) {
  if (!isPlainObject(response)) return { ok: false, errors: ['next-turn bridge response must be an object'] };
  if (response.available !== true || typeof response.pendingInSessionInput !== 'boolean') {
    return { ok: false, errors: ['next-turn bridge response must declare availability and pending input state'] };
  }
  if (!response.pendingInSessionInput) {
    return hasExactKeys(response, ['available', 'pendingInSessionInput'])
      ? { ok: true, value: { available: true, pendingInSessionInput: false } }
      : { ok: false, errors: ['quiet next-turn bridge response must not carry extra fields'] };
  }
  const input = validateNextTurnInput({
    prompt: response.prompt,
    choices: response.choices,
    default: response.default,
    correlation: response.correlation,
  });
  if (!hasExactKeys(response, ['available', 'choices', 'correlation', 'default', 'pendingInSessionInput', 'prompt']) || !input.ok) {
    return { ok: false, errors: input.errors || ['next-turn bridge response contains unsupported fields'] };
  }
  return { ok: true, value: { available: true, pendingInSessionInput: true, nextTurnInput: input.value } };
}

function validateStewardshipAdapter(adapter = {}) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return { ok: false, errors: ['stewardship adapter must be an object'] };
  if (adapter.version !== STEWARDSHIP_ADAPTER_VERSION) errors.push(`adapter.version must be ${STEWARDSHIP_ADAPTER_VERSION}`);
  if (typeof adapter.harness !== 'string' || !HARNESS_IDENTIFIER.test(adapter.harness)) errors.push('adapter.harness must be a bounded identifier');
  if (!ISOLATION_MODES.includes(adapter.isolationMode)) errors.push(`adapter.isolationMode must be one of: ${ISOLATION_MODES.join(', ')}`);
  if (adapter.isolatedWorktrees !== true) errors.push('adapter must provide isolated worktrees');
  for (const capability of REQUIRED_LIFECYCLE_CAPABILITIES) {
    if (typeof adapter[capability] !== 'function') errors.push(`adapter must implement ${capability}`);
  }
  if (adapter.preEditObservation !== undefined && typeof adapter.preEditObservation !== 'function') {
    errors.push('adapter.preEditObservation must be a function when provided');
  }
  return { ok: errors.length === 0, errors };
}

function assertStewardshipAdapter(adapter) {
  const result = validateStewardshipAdapter(adapter);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return adapter;
}

module.exports = {
  CORRELATION_IDENTIFIER,
  HARNESS_IDENTIFIER,
  ISOLATION_MODES,
  MAX_CHOICE_CHARS,
  MAX_CORRELATION_CHARS,
  MAX_PROMPT_CHARS,
  REQUIRED_LIFECYCLE_CAPABILITIES,
  STEWARDSHIP_ADAPTER_VERSION,
  assertStewardshipAdapter,
  validateNextTurnBridgeResponse,
  validateNextTurnInput,
  validateStewardshipAdapter,
};
