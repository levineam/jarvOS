'use strict';

const IDEA = 'idea';
const NOTE = 'note';
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
    .replace(/^\s*i have an? idea\s+(?:for|about)\s*/i, '')
    .replace(/^\s*i have an? idea\s*[:\-,]?\s*/i, '')
    .replace(/^\s*here(?:'s| is) an? idea\s*[:\-,]?\s*/i, '')
    .replace(/^\s*my idea is\s*[:\-,]?\s*/i, '')
    .replace(/^\s*make a note\s+(?:for|about|that)\s*/i, '')
    .replace(/^\s*take a note\s+(?:for|about|that)\s*/i, '')
    .replace(/^\s*make a note\s*[:\-,]?\s*/i, '')
    .replace(/^\s*take a note\s*[:\-,]?\s*/i, '')
    .replace(/^\s*note to self\s*[:\-,]?\s*/i, '')
    .replace(/^\s*side note\s*[:\-,]?\s*/i, '')
    .replace(/^\s*i(?:'ll| will) note that\s*[:\-,]?\s*/i, '')
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
  const explicit = [
    capture.trigger,
    capture.keyword,
    capture.mode,
    capture.type,
    capture.route,
  ].map(normalizeTrigger).find(Boolean);
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

module.exports = {
  IDEA,
  NOTE,
  KEYWORD_RE,
  IDEA_ANTI_TRIGGER_PATTERNS,
  IDEA_CAPTURE_PATTERNS,
  NOTE_CAPTURE_PATTERNS,
  GENERAL_CAPTURE_PATTERNS,
  captureSources,
  detectTrigger,
  hasCaptureIntent,
  matchesAny,
  normalizeTrigger,
  primaryText,
  stripLeadingKeyword,
};
