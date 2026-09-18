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
const NEGATION_LEADIN_RE = /\b(?:do\s*not|don'?t|never|won'?t|stop|please\s+don'?t)\b(?:\s+(?:ever|actually|please))*\s*$/i;

// Quoted or reported speech ("The phrase \"make a note\" appears in the
// docs", "He told me to \"save this\" as an example", "She said \"make a
// note about the build\" during standup.") mentions the words without
// issuing the directive. The matched phrase must sit right after an opening
// quote mark, and the matching closing quote mark must appear somewhere
// later in the same sentence — the quoted span can extend past the matched
// phrase itself (e.g. the quote closes after "about the build").
const QUOTE_OPEN_RE = /(["'“‘])\s*$/;
const QUOTE_PAIRS = { '"': '"', "'": "'", '“': '”', '‘': '’' };

function explicitCallerTrigger(capture = {}) {
  return [capture.trigger, capture.keyword, capture.mode, capture.type, capture.route]
    .map(normalizeTrigger)
    .find(Boolean) || null;
}

// True when the matched phrase opens right after a quote mark and the
// matching close mark appears later in the same sentence — a quoted or
// reported mention, not a live directive.
function isQuotedMention(before, after) {
  const openMatch = before.match(QUOTE_OPEN_RE);
  if (!openMatch) return false;
  const closeChar = QUOTE_PAIRS[openMatch[1]];
  const sentenceEnd = after.search(/[.!?\n]/);
  const window = sentenceEnd === -1 ? after : after.slice(0, sentenceEnd + 1);
  return window.includes(closeChar);
}

// A directive match is suppressed — treated as declined or merely mentioned,
// not requested — when it is immediately preceded by a negation lead-in, or
// wrapped in quote marks as a quoted/reported mention.
function isSuppressedMention(source, match) {
  const before = source.slice(0, match.index);
  const after = source.slice(match.index + match[0].length);
  return NEGATION_LEADIN_RE.test(before) || isQuotedMention(before, after);
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
