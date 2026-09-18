'use strict';

/**
 * Pure capture-authorization predicate (SUP-3981).
 *
 * A message never earns permission to create a durable note, journal backlink,
 * or memory record from salience/confidence alone. This module answers exactly
 * one question — is there explicit durable-capture intent? — and nothing else.
 * It performs no writes and imports no storage adapters.
 */

const {
  IDEA,
  NOTE,
  JOURNAL,
  captureSources,
  detectTrigger,
  matchesAny,
  normalizeTrigger,
  parseHardCaptureCommand,
} = require('./keyword-capture-router');

// Bounded save/write-down directives only. A bare "capture" mention, or a bare
// "remember this"/"for later reference" aside, is deliberately excluded — a
// message that merely discusses capture, or a passing remark, must not by
// itself grant permission to create a durable artifact.
const BOUNDED_NATURAL_LANGUAGE_PATTERNS = [
  /\bsave (?:this|that)\b/i,
  /\bwrite (?:this|that) down\b/i,
];

// An explicit negation right before the directive verb ("do not save this",
// "never write that down") means the speaker is declining capture, not
// requesting it — the bounded pattern above must not fire in that case.
const NEGATED_NATURAL_LANGUAGE_RE = /\b(?:do\s*not|don'?t|never|won'?t|stop|please\s+don'?t)\s+(?:save|write)\b/i;

function explicitCallerTrigger(capture = {}) {
  return [capture.trigger, capture.keyword, capture.mode, capture.type, capture.route]
    .map(normalizeTrigger)
    .find(Boolean) || null;
}

function hasBoundedNaturalLanguageIntent(capture = {}) {
  return captureSources(capture).some((source) => (
    matchesAny(source, BOUNDED_NATURAL_LANGUAGE_PATTERNS) && !NEGATED_NATURAL_LANGUAGE_RE.test(source)
  ));
}

/**
 * @param {object} capture
 * @returns {{ authorized: boolean, source: 'hard_command'|'caller_trigger'|'keyword_trigger'|'natural_language'|null, trigger: 'idea'|'note'|'journal'|null }}
 */
function authorizeCapture(capture = {}) {
  const hardCommand = parseHardCaptureCommand(capture);
  if (hardCommand.matched && hardCommand.disposition === 'capture') {
    return { authorized: true, source: 'hard_command', trigger: hardCommand.route };
  }
  if (hardCommand.matched && hardCommand.disposition === 'needs_input') {
    return { authorized: false, source: null, trigger: null };
  }

  const callerTrigger = explicitCallerTrigger(capture);
  if (callerTrigger) {
    return { authorized: true, source: 'caller_trigger', trigger: callerTrigger };
  }

  const keywordTrigger = detectTrigger(capture);
  if (keywordTrigger) {
    return { authorized: true, source: 'keyword_trigger', trigger: keywordTrigger };
  }

  if (hasBoundedNaturalLanguageIntent(capture)) {
    return { authorized: true, source: 'natural_language', trigger: NOTE };
  }

  return { authorized: false, source: null, trigger: null };
}

module.exports = {
  IDEA,
  NOTE,
  JOURNAL,
  authorizeCapture,
};
