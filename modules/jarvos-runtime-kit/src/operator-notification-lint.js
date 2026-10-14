'use strict';

const MAX_MESSAGE_CHARS = 2000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function addMessageError(errors, code, message) {
  errors.push({ code, message });
}

function messageInput(input) {
  if (typeof input === 'string') return { message: input, freshness: null };
  if (!isObject(input)) return null;
  return { message: input.message, freshness: input.freshness || null };
}

function lintOperatorMessage(input) {
  const errors = [];
  const normalized = messageInput(input);
  if (!normalized || typeof normalized.message !== 'string') {
    addMessageError(errors, 'message-required', 'operator message must be a string or an object with a message string');
    return { ok: false, errors };
  }
  const message = normalized.message.trim();
  if (!message) addMessageError(errors, 'message-empty', 'operator message must not be empty');
  if (message.length > MAX_MESSAGE_CHARS) addMessageError(errors, 'message-too-long', `operator message must not exceed ${MAX_MESSAGE_CHARS} characters`);
  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(message)) addMessageError(errors, 'internal-code', 'operator message must not expose snake_case internal codes');
  if (/(?:^|[\s(])(?:~\/|\/(?:Users|home|var|tmp|etc|private)(?:\/|\b))/.test(message)) addMessageError(errors, 'absolute-path', 'operator message must not expose an absolute path');
  if (/(?:\b(?:Error|TypeError|ReferenceError):|\bTraceback\b|\bat\s+\S+\s*\([^)]*:\d+:\d+\)|\bat\s+\S+:\d+:\d+)/.test(message)) addMessageError(errors, 'stack-text', 'operator message must not expose stack-like text');
  if (/\b[a-f0-9]{7,40}\b/i.test(message)) addMessageError(errors, 'source-sha', 'operator message must not expose a bare source SHA');

  const mentionsAttention = /\bneeds (?:attention|input)\b/i.test(message);
  const hasConcreteAction = /\bAction required:\s*[^.\n]{3,}/i.test(message);
  const hasExplicitNoAction = /\bNo action (?:is )?needed(?: from you)?\b/i.test(message);
  if (mentionsAttention && !hasConcreteAction && !hasExplicitNoAction) addMessageError(errors, 'ambiguous-attention', 'needs attention/input must include a concrete action or explicit no-action statement');

  const lanes = {
    published: /\b(?:currently )?published\b/i.test(message),
    approvalReady: /\b(?:approval[- ]ready|ready for (?:(?:Andrew'?s )?review)|proposed .* passed checks)\b/i.test(message),
    future: /\b(?:future work|future milestone|remains future)\b/i.test(message),
  };
  if (Object.values(lanes).filter(Boolean).length > 1 && (!lanes.published || !lanes.approvalReady || !lanes.future)) addMessageError(errors, 'release-lanes-conflated', 'release messages that mention multiple lanes must distinguish published, approval-ready, and future work');
  if (/\b(?:future work|future milestone|future release).{0,80}\b(?:approval[- ]ready|ready for (?:(?:Andrew'?s )?review)|passed checks)\b/i.test(message)) addMessageError(errors, 'release-lanes-conflated', 'future work must not be described as approval-ready');
  if (/\b(?:future (?:work|milestone|release).{0,60}(?:failed|failure|unable|could not).{0,30}publish|(?:failed|failure|unable|could not).{0,30}publish.{0,60}future (?:work|milestone|release))\b/i.test(message)) addMessageError(errors, 'future-publication-failure', 'future-lane incompleteness must not be described as a publication failure');
  if (['stale', 'unknown'].includes(normalized.freshness) && /\b(?:currently published|ready for (?:Andrew'?s )?review|approval[- ]ready|passed checks)\b/i.test(message)) addMessageError(errors, 'stale-release-claim', 'stale or unknown observations must not claim current publication or review readiness');
  return { ok: errors.length === 0, errors, message };
}

function lintOperatorMessages(inputs) {
  if (!Array.isArray(inputs)) return { ok: false, errors: [{ code: 'messages-required', message: 'operator messages must be an array' }], results: [] };
  const results = inputs.map((input, index) => ({ index, ...lintOperatorMessage(input) }));
  return { ok: results.every((result) => result.ok), errors: results.flatMap((result) => result.errors.map((error) => ({ index: result.index, ...error }))), results };
}

module.exports = { MAX_MESSAGE_CHARS, lintOperatorMessage, lintOperatorMessages };
