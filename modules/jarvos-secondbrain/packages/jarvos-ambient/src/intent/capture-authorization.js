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
  KEYWORD_RE,
  IDEA_ANTI_TRIGGER_PATTERNS,
  IDEA_CAPTURE_PATTERNS,
  captureSources,
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

// Natural-language "note" directives. Unlike the strict `note:` prefix
// (anchored, so quoting or negating it already breaks the anchor), these
// phrases can appear anywhere mid-sentence, so every one of them needs the
// same negation/quote guard as the bounded save/write directives below.
const GUARDED_NOTE_PATTERNS = [
  /\bmake a note\b/i,
  /\btake a note\b/i,
  /\bnote to self\b/i,
  /\bi(?:'ll| will) note that\b/i,
  /\bremember this note\b/i,
];

// An explicit negation right before the directive verb ("do not save this",
// "never write that down", "don't make a note") means the speaker is
// declining capture, not requesting it. A few adverbs (ever, actually,
// please) may sit between the negator and the directive without weakening
// the negation ("do not ever save this", "don't actually make a note").
const NEGATION_LEADIN_RE = /\b(?:do(?:es)?\s*not|did\s*not|don['’]?t|didn['’]?t|never|won['’]?t|stop|please\s+don['’]?t)\b(?:\s+(?:ever|actually|please|really|just|even))*\s*$/i;

// Quoted or reported speech ("The phrase \"make a note\" appears in the
// docs", "He told me to \"save this\" as an example", "The doc says \"I
// have an idea for redesigning this\" as an example quote.") mentions the
// words without issuing the directive. Detection is span-aware: every quote
// mark in the sentence is tracked to build actual open/close spans, and a
// candidate match is a quoted mention whenever it falls inside a span —
// even when the match does not begin immediately after the opening quote
// mark, e.g. a second, later pattern matching further into an
// already-quoted phrase ("an idea for" inside "...says \"I have an idea for
// redesigning this\"..."). Apostrophes flanked by letters on both sides
// ("don't", "here's") are contractions, not quote marks, and are never
// treated as span delimiters.
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’' };

function explicitCallerTrigger(capture = {}) {
  return [capture.trigger, capture.keyword, capture.mode, capture.type, capture.route]
    .map(normalizeTrigger)
    .find(Boolean) || null;
}

function isContractionApostrophe(text, index) {
  const prev = text[index - 1];
  const next = text[index + 1];
  return Boolean(prev) && Boolean(next) && /[A-Za-z]/.test(prev) && /[A-Za-z]/.test(next);
}

// Every quoted span [openIndex, closeIndex] (indices relative to `sentence`)
// whose open and close marks both appear within the sentence.
function findQuotedSpans(sentence) {
  const spans = [];
  const openIndex = { '"': -1, "'": -1, '`': -1 };
  const openStack = { '“': [], '‘': [] };
  for (let i = 0; i < sentence.length; i += 1) {
    const ch = sentence[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === "'" && isContractionApostrophe(sentence, i)) continue;
      if (openIndex[ch] === -1) {
        openIndex[ch] = i;
      } else {
        spans.push({ start: openIndex[ch], end: i });
        openIndex[ch] = -1;
      }
      continue;
    }
    if (ch === '“') { openStack['“'].push(i); continue; }
    if (ch === '‘' && !isContractionApostrophe(sentence, i)) { openStack['‘'].push(i); continue; }
    if (ch === '”' && openStack['“'].length) {
      spans.push({ start: openStack['“'].pop(), end: i });
      continue;
    }
    if (ch === '’' && openStack['‘'].length && !isContractionApostrophe(sentence, i)) {
      spans.push({ start: openStack['‘'].pop(), end: i });
    }
  }
  return spans;
}

// True when the matched phrase falls inside a quoted span opened earlier and
// closed later in the same sentence — a quoted or reported mention, not a
// live directive.
function isQuotedMention(source, match) {
  const relStart = match.index;
  const relEnd = match.index + match[0].length;
  // Scan the whole source, not a punctuation-bounded sentence. A closing
  // quote after an interior period ("...conversation.") must still count.
  return findQuotedSpans(source).some((span) => span.start < relStart && span.end >= relEnd);
}

// A directive match is suppressed — treated as declined or merely mentioned,
// not requested — when it is immediately preceded by a negation lead-in, or
// wrapped in quote marks as a quoted/reported mention.
const REPORTED_SPEECH_LEADIN_RE = /\b(?:(?:he|she|they|someone|somebody)\s+)?(?:said|says|told me|told us|asked me|asked us)(?:\s+to)?\s*$/i;
const INCIDENTAL_LEADIN_RE = /\b(?:how to|rejected|rejecting|discussed|discussing)\s+$/i;

function isSuppressedMention(source, match) {
  const before = source.slice(0, match.index);
  return NEGATION_LEADIN_RE.test(before)
    || REPORTED_SPEECH_LEADIN_RE.test(before)
    || INCIDENTAL_LEADIN_RE.test(before)
    || isQuotedMention(source, match);
}

// True when any pattern in the list matches the source outside a negation
// lead-in or quoted/reported mention — the shared guard applied to every
// unanchored natural-language pattern `authorizeCapture` considers.
function matchesGuarded(source, patterns) {
  return patterns.some((pattern) => {
    const match = pattern.exec(source);
    return Boolean(match) && !isSuppressedMention(source, match);
  });
}

function hasBoundedNaturalLanguageIntent(capture = {}) {
  return captureSources(capture).some((source) => matchesGuarded(source, BOUNDED_NATURAL_LANGUAGE_PATTERNS));
}

// Mirrors keyword-capture-router's detectTrigger, but applies the
// negation/quote guard to every unanchored natural-language "note"/"idea"
// phrase instead of trusting any unanchored match blindly. The strict
// `idea:`/`note:` prefix is anchored, so quoting or negating it already
// breaks the anchor and needs no separate guard.
function detectKeywordTrigger(capture = {}) {
  for (const source of captureSources(capture)) {
    const strict = source.match(KEYWORD_RE);
    if (strict) return normalizeTrigger(strict[1]);

    if (matchesGuarded(source, GUARDED_NOTE_PATTERNS)) return NOTE;

    if (!matchesAny(source, IDEA_ANTI_TRIGGER_PATTERNS) && matchesGuarded(source, IDEA_CAPTURE_PATTERNS)) {
      return IDEA;
    }
  }
  return null;
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

  const keywordTrigger = detectKeywordTrigger(capture);
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
