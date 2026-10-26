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
// phrases need the same clause-boundary and negation/quote guards as the
// bounded save/write directives below.
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

// A natural-language capture phrase is a request only when (1) it begins a clause and
// (2) the text is not itself a catalog of capture phrases. Text that names two or more
// capture phrases ("only explicit note:, make a note, save this, idea:") is discussing
// the capture feature, not issuing a request; the strict anchored `note:` / `idea:`
// prefixes remain the way to capture from such text. Both checks are linear scans:
// whitespace-heavy input must not cost quadratic time.
const DIRECTIVE_LEAD_INS = [
  'i want you to', "i'd like you to", 'go ahead and', 'could you', 'would you', 'will you', 'can you',
  'please', 'pls', 'just', 'also', 'and', 'so', 'okay', 'ok', 'yeah', 'hey', 'hi', 'now', 'then', 'jarvis', 'claude',
];
const MAX_DIRECTIVE_LEAD_INS = 6;
const LONGEST_LEAD_IN = Math.max(...DIRECTIVE_LEAD_INS.map((leadIn) => leadIn.length));
const NOT_A_SENTENCE_END = ['e.g.', 'i.e.', 'cf.'];

const NOTE_FAMILY_RE = new RegExp(
  `${[...GUARDED_NOTE_PATTERNS, ...BOUNDED_NATURAL_LANGUAGE_PATTERNS].map((pattern) => `(?:${pattern.source})`).join('|')}`,
  'gi',
);
const IDEA_FAMILY_RE = new RegExp(IDEA_CAPTURE_PATTERNS.map((pattern) => `(?:${pattern.source})`).join('|'), 'i');

// Two note-family phrases, or one note-family phrase plus an idea phrase, make a catalog. The
// strict `note:` / `idea:` prefixes are deliberately not counted: they are commands, not phrases.
// Idea phrases collectively count once: "I have an idea ... my idea is ..." is ordinary speech.
function namesSeveralCapturePhrases(source) {
  let found = IDEA_FAMILY_RE.test(source) ? 1 : 0;
  for (const unused of source.matchAll(NOTE_FAMILY_RE)) {
    found += 1;
    if (found >= 2) return true;
  }
  return false;
}

function isLetterOrDigit(ch) {
  return ch !== undefined && /[\p{L}\p{N}'’]/u.test(ch);
}

function trimTrailingBlanks(text, end) {
  let i = end;
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1;
  return i;
}

function endsWithListMarker(text, dotIndex) {
  let i = dotIndex;
  while (i > 0 && /\d/.test(text[i - 1])) i -= 1;
  if (i === dotIndex) return false;
  while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i -= 1;
  return i === 0 || text[i - 1] === '\n' || text[i - 1] === '\r';
}

function isClauseInitial(source, index) {
  const text = source.slice(0, index).replace(/(\p{L})’(?=\p{L})/gu, "$1'").replace(/[ \t\u00a0\u2000-\u200b]+/g, ' ');
  let end = text.length;
  for (let leadIns = 0; leadIns <= MAX_DIRECTIVE_LEAD_INS; leadIns += 1) {
    end = trimTrailingBlanks(text, end);
    if (end === 0) return true;
    const last = text[end - 1];
    if (last === '\n' || last === '\r') return true;
    if (last === '.' || last === '!' || last === '?') {
      if (last === '.' && endsWithListMarker(text, end - 1)) return false;
      const tail = text.slice(Math.max(0, end - 5), end).toLowerCase();
      return !NOT_A_SENTENCE_END.some((abbr) => tail.endsWith(abbr));
    }
    if (last === ',') end -= 1;
    const lower = text.slice(Math.max(0, end - LONGEST_LEAD_IN), end).toLowerCase();
    const leadIn = DIRECTIVE_LEAD_INS.find((candidate) => (
      lower.endsWith(candidate) && !isLetterOrDigit(text[end - candidate.length - 1])
    ));
    if (!leadIn) return false;
    end -= leadIn.length;
  }
  return false;
}

// Code-formatted text is an example, never a request: fenced blocks and lines indented by
// four spaces or a tab.
function inCodeContext(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  if (/^(?: {4}|\t)/.test(source.slice(lineStart, lineStart + 4))) return true;
  let fences = 0;
  for (let i = source.indexOf('```'); i !== -1 && i < index; i = source.indexOf('```', i + 3)) fences += 1;
  return fences % 2 === 1;
}

// Catalog check, placement, and the existing mention guards (quotes, negation,
// reported speech) on the first occurrence of each pattern.
function matchesGuarded(source, patterns) {
  const normalized = source.replace(/(\p{L})’(?=\p{L})/gu, "$1'");
  if (namesSeveralCapturePhrases(normalized)) return false;
  return patterns.some((pattern) => {
    const match = pattern.exec(normalized);
    return Boolean(match) && isClauseInitial(source, match.index) && !inCodeContext(source, match.index) && !isSuppressedMention(source, match);
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
  matchesGuarded,
};
