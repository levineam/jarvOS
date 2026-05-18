#!/usr/bin/env node
/**
 * Keyword-triggered capture routing for jarvos-secondbrain.
 *
 * Rules:
 * - idea => append to the journal Ideas section; if substantive, also create a note
 * - note => always create a standalone note and link it in the journal Notes section
 * - medium-confidence capture intent => append to the journal Flagged section
 * - non-capture conversation => no-op
 *
 * Input (stdin):
 * {
 *   "trigger": "idea|note",
 *   "title": "Optional title",
 *   "text": "Captured text",
 *   "content": "Optional body override",
 *   "frontmatter": { ... },
 *   "date": "YYYY-MM-DD",
 *   "substantive": true
 * }
 */

'use strict';

const {
  createStorageAdapter,
  FLAGGED_HEADING,
  IDEAS_HEADING,
  NOTES_HEADING,
} = require('../../../adapters');
const {
  IDEA_PARKING,
  JOURNAL_ENTRY,
  NOTE_CREATION,
  SKILL_CONTRACTS,
} = require('./skill-contracts.js');

const IDEA = 'idea';
const NOTE = 'note';
const FLAGGED = 'flagged';
const KEYWORD_RE = /^\s*(idea|note)\s*[:\-]\s*/i;
const IDEA_ANTI_TRIGGER_PATTERNS = [
  /\bno idea\b/i,
  /\bnot a good idea\b/i,
  /\bwhat(?:'s| is) the idea\b/i,
  /\bany idea\b/i,
];
const IDEA_CAPTURE_PATTERNS = [
  /\bi have an? idea\b/i,
  /\bhere(?:'s| is) an? idea\b/i,
  /\bmy idea is\b/i,
  /\ban? idea\s+(?:for|about)\b/i,
  /^\s*idea\s*[:\-]/i,
];
const NOTE_CAPTURE_PATTERNS = [
  /^\s*note\s*[:\-]/i,
  /\bnote to self\b/i,
  /\bside note\b/i,
  /\bi(?:'ll| will) note that\b/i,
  /\bmake a note\b/i,
  /\bmake an? note\b/i,
  /\btake a note\b/i,
  /\bremember this note\b/i,
];
const GENERAL_CAPTURE_PATTERNS = [
  /\bcapture\b/i,
  /\bsave (?:this|that)\b/i,
  /\bwrite (?:this|that) down\b/i,
  /\bfor later reference\b/i,
  /\bremember this\b/i,
];

function normalizeTrigger(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  return trimmed === IDEA || trimmed === NOTE ? trimmed : null;
}

function stripLeadingKeyword(text) {
  return String(text || '')
    .replace(KEYWORD_RE, '')
    .replace(/^\s*i have an? idea(?:\s+(?:about|for))?\s*[:\-,]?\s*/i, '')
    .replace(/^\s*here(?:'s| is) an? idea(?:\s+(?:about|for))?\s*[:\-,]?\s*/i, '')
    .replace(/^\s*my idea is\s*[:\-,]?\s*/i, '')
    .replace(/^\s*note to self\s*[:\-,]?\s*/i, '')
    .replace(/^\s*side note\s*[:\-,]?\s*/i, '')
    .replace(/^\s*i(?:'ll| will) note that\s*[:\-,]?\s*/i, '')
    .replace(/^\s*make an? note(?:\s+(?:about|for))?\s*[:\-,]?\s*/i, '')
    .replace(/^\s*make a note(?:\s+(?:about|for))?\s*[:\-,]?\s*/i, '')
    .replace(/^\s*take a note(?:\s+(?:about|for))?\s*[:\-,]?\s*/i, '')
    .trim();
}

function primaryText(capture = {}) {
  const source = capture.content ?? capture.text ?? capture.body ?? '';
  return stripLeadingKeyword(source);
}

function captureSources(capture = {}) {
  return [capture.title, capture.text, capture.content, capture.body]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function detectTrigger(capture = {}) {
  const explicit = [
    capture.trigger,
    capture.keyword,
    capture.mode,
    capture.type,
    capture.route,
  ].map(normalizeTrigger).find(Boolean);
  if (explicit) return explicit;

  const sources = captureSources(capture);
  for (const source of sources) {
    const match = source.match(KEYWORD_RE);
    if (match) return normalizeTrigger(match[1]);
    if (matchesAny(source, NOTE_CAPTURE_PATTERNS)) return NOTE;
    if (!matchesAny(source, IDEA_ANTI_TRIGGER_PATTERNS) && matchesAny(source, IDEA_CAPTURE_PATTERNS)) {
      return IDEA;
    }
  }

  return null;
}

function hasCaptureIntent(capture = {}) {
  const explicit = [capture.trigger, capture.keyword, capture.mode, capture.type, capture.route]
    .map(normalizeTrigger)
    .find(Boolean);
  if (explicit) return true;

  const sources = captureSources(capture);
  for (const source of sources) {
    if (source.match(KEYWORD_RE)) return true;
    if (matchesAny(source, NOTE_CAPTURE_PATTERNS)) return true;
    if (!matchesAny(source, IDEA_ANTI_TRIGGER_PATTERNS) && matchesAny(source, IDEA_CAPTURE_PATTERNS)) {
      return true;
    }
    if (matchesAny(source, GENERAL_CAPTURE_PATTERNS)) return true;
  }

  return false;
}

function classifyCaptureIntent(capture = {}) {
  const detectedTrigger = detectTrigger(capture);
  const captureIntent = hasCaptureIntent(capture);

  if (!captureIntent) {
    return {
      route: null,
      detectedTrigger,
      confidence: 'low',
      reviewRequired: false,
      skillIds: [],
      reason: 'no-capture-intent',
    };
  }

  if (detectedTrigger === IDEA) {
    return {
      route: IDEA,
      detectedTrigger,
      confidence: 'high',
      reviewRequired: false,
      skillIds: [IDEA_PARKING],
      reason: 'explicit-idea-capture',
    };
  }

  if (detectedTrigger === NOTE) {
    return {
      route: NOTE,
      detectedTrigger,
      confidence: 'high',
      reviewRequired: false,
      skillIds: [NOTE_CREATION, JOURNAL_ENTRY],
      reason: 'explicit-note-capture',
    };
  }

  return {
    route: FLAGGED,
    detectedTrigger,
    confidence: 'medium',
    reviewRequired: true,
    skillIds: [JOURNAL_ENTRY],
    reason: 'ambiguous-capture-for-review',
  };
}

function inferTitle(capture = {}, fallbackPrefix = 'Captured Note') {
  const explicit = String(capture.title || '').trim();
  if (explicit) return stripLeadingKeyword(explicit);

  const text = primaryText(capture)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';

  if (text) {
    return text.slice(0, 80).trim().replace(/[.。!?]+$/, '');
  }

  return `${fallbackPrefix} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
}

function ideaJournalLine(capture = {}, noteTitle = '') {
  const title = String(capture.title || '').trim();
  const summary = primaryText(capture);

  if (noteTitle) {
    const details = summary && summary !== noteTitle ? ` — ${summary}` : '';
    return `- [[${noteTitle}]]${details}`;
  }

  if (title && summary && title !== summary) {
    return `- ${title} — ${summary}`;
  }
  return `- ${summary || title || 'Untitled idea'}`;
}

function flaggedJournalLine(capture = {}) {
  const text = primaryText(capture);
  const title = String(capture.title || '').trim();
  const summary = text || title || 'Untitled capture';
  return `- [ ] ${summary} _(review before filing)_`;
}

function buildNoteContent(capture = {}, route = NOTE) {
  const text = primaryText(capture);
  if (text) return text;
  if (route === IDEA) return 'Captured from idea routing.';
  return 'Captured note.';
}

function isSubstantiveIdea(capture = {}) {
  if (typeof capture.substantive === 'boolean') return capture.substantive;

  const text = primaryText(capture);
  const nonEmptyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (String(capture.title || '').trim()) return true;
  if (nonEmptyLines.length >= 2) return true;
  if (text.length >= 140) return true;
  if (/\b(?:because|connects?|relates?|depends on|similar to|linked to|searchable)\b/i.test(text)) return true;
  return false;
}

function buildRoutingPlan(capture = {}) {
  const classification = classifyCaptureIntent(capture);
  const detectedTrigger = classification.detectedTrigger;
  const date = String(capture.date || '').trim() || undefined;

  if (!classification.route) {
    return {
      route: null,
      detectedTrigger,
      confidence: classification.confidence,
      reviewRequired: classification.reviewRequired,
      reason: classification.reason,
      skillIds: classification.skillIds,
      defaultedToNoteBias: false,
      ignored: true,
      date,
      journalSection: null,
      journalLine: null,
      createNote: false,
      noteTitle: '',
      noteContent: '',
      noteFrontmatter: null,
    };
  }

  const route = classification.route;

  if (route === FLAGGED) {
    return {
      route,
      detectedTrigger,
      confidence: classification.confidence,
      reviewRequired: classification.reviewRequired,
      reason: classification.reason,
      skillIds: classification.skillIds,
      defaultedToNoteBias: false,
      ignored: false,
      date,
      journalSection: FLAGGED_HEADING,
      journalLine: flaggedJournalLine(capture),
      createNote: false,
      noteTitle: '',
      noteContent: '',
      noteFrontmatter: null,
    };
  }

  if (route === IDEA) {
    const substantive = isSubstantiveIdea(capture);
    const noteTitle = substantive ? inferTitle(capture, 'Idea') : '';
    return {
      route,
      detectedTrigger,
      confidence: classification.confidence,
      reviewRequired: classification.reviewRequired,
      reason: classification.reason,
      skillIds: classification.skillIds,
      defaultedToNoteBias: false,
      ignored: false,
      date,
      journalSection: IDEAS_HEADING,
      journalLine: ideaJournalLine(capture, noteTitle),
      createNote: substantive,
      noteTitle,
      noteContent: substantive ? buildNoteContent(capture, IDEA) : '',
      noteFrontmatter: substantive
        ? {
            type: 'draft',
            source: 'idea-capture',
            trigger: IDEA,
            created_from: date ? `journal/${date}` : 'journal',
          }
        : null,
    };
  }

  const noteTitle = inferTitle(capture, 'Captured Note');
  return {
    route: NOTE,
    detectedTrigger,
    confidence: classification.confidence,
    reviewRequired: classification.reviewRequired,
    reason: classification.reason,
    skillIds: classification.skillIds,
    defaultedToNoteBias: false,
    ignored: false,
    date,
    journalSection: NOTES_HEADING,
    journalLine: `- [[${noteTitle}]]`,
    createNote: true,
    noteTitle,
    noteContent: buildNoteContent(capture, NOTE),
    noteFrontmatter: {
      type: 'draft',
      source: detectedTrigger ? 'note-capture' : 'default-note-bias',
      trigger: detectedTrigger || NOTE,
      created_from: date ? `journal/${date}` : 'journal',
    },
  };
}

function dispatchCaptureToSkills(capture = {}, options = {}) {
  const adapter = options.adapter || createStorageAdapter(options);
  const plan = buildRoutingPlan(capture);
  const date = plan.date;
  const result = {
    plan,
    journalEntry: null,
    note: null,
    noteLink: null,
  };

  if (plan.ignored) {
    return result;
  }

  if (plan.createNote) {
    result.note = adapter.writeNote({
      title: plan.noteTitle,
      content: plan.noteContent,
      frontmatter: {
        ...(capture.frontmatter || {}),
        ...(plan.noteFrontmatter || {}),
      },
    });
  }

  if (plan.journalSection && plan.journalLine) {
    result.journalEntry = adapter.appendLineToJournalSection({
      heading: plan.journalSection,
      line: plan.journalLine,
      date,
    });
    result.noteLink = result.journalEntry;
  } else {
    adapter.ensureJournal({ date });
  }

  return result;
}

function applyRoutingPlan(capture = {}, options = {}) {
  return dispatchCaptureToSkills(capture, options);
}

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let parsed = {};
    try {
      parsed = input.trim() ? JSON.parse(input) : {};
    } catch (error) {
      console.error(JSON.stringify({ error: 'Invalid JSON input', detail: error.message }));
      process.exit(1);
    }

    try {
      const result = applyRoutingPlan(parsed);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });
}

module.exports = {
  IDEA,
  NOTE,
  FLAGGED,
  KEYWORD_RE,
  IDEA_ANTI_TRIGGER_PATTERNS,
  IDEA_CAPTURE_PATTERNS,
  NOTE_CAPTURE_PATTERNS,
  GENERAL_CAPTURE_PATTERNS,
  SKILL_CONTRACTS,
  applyRoutingPlan,
  buildNoteContent,
  buildRoutingPlan,
  classifyCaptureIntent,
  detectTrigger,
  dispatchCaptureToSkills,
  flaggedJournalLine,
  hasCaptureIntent,
  ideaJournalLine,
  inferTitle,
  isSubstantiveIdea,
  primaryText,
  stripLeadingKeyword,
};

if (require.main === module) {
  main();
}
