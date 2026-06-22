#!/usr/bin/env node
/**
 * concept-title.js — generate concept-first, durable note titles at capture time.
 *
 * Captures arrive without a title. Per the "Knowledge Base Note Naming and Wiki-Link
 * Maintenance Research" note, a good title is a concept-first retrieval handle
 * ("would this still be a good wiki-link in six months?"), NOT a chat fragment like
 * "Also, I don't know if we should bundle this...".
 *
 * Strategy: ask a local model (Ollama, default) for a concise concept title, then
 * validate it; if the model is unavailable or returns something unusable, fall back
 * to a deterministic heuristic so capture never fails. The author's note BODY is
 * never touched — this only produces a title/metadata.
 *
 * Privacy: defaults to a LOCAL model (no note content leaves the machine), matching
 * the optimizer's sensitivity posture.
 */

'use strict';

const TRIGGER_PREFIXES = [
  /^\s*note\s*[:\-]\s*/i,
  /^\s*idea\s*[:\-]\s*/i,
  /^\s*todo\s*[:\-]\s*/i,
  /^\s*fyi\s*[:\-]\s*/i,
  /^\s*remember (?:that|to)\s+/i,
  /^\s*capture (?:this|that)\s*[:\-]?\s*/i,
  /^\s*i (?:have an idea|just thought|was thinking)\b[:\-,]?\s*/i,
];

// Openers that signal a conversational fragment rather than a concept title.
const FRAGMENT_OPENERS = new Set([
  'also', 'actually', 'so', 'well', 'um', 'uh', 'hmm', 'btw', 'anyway',
  'ok', 'okay', 'oh', 'quick', 'just', 'i', 'and', 'but', 'maybe',
]);

const DEFAULT_MAX_LEN = 80;

function collapseWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripTriggers(text) {
  let out = collapseWhitespace(text);
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of TRIGGER_PREFIXES) {
      const next = out.replace(re, '');
      if (next !== out) { out = next; changed = true; }
    }
  }
  return out.trim();
}

/** Deterministic fallback: first clause of the (trigger-stripped) text, cleaned + capped. */
function heuristicTitle(text, { maxLen = DEFAULT_MAX_LEN } = {}) {
  const stripped = stripTriggers(text);
  if (!stripped) return '';
  // First sentence/clause.
  const firstLine = stripped.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || stripped;
  const clause = firstLine.split(/(?<=[.!?])\s|;\s|—\s| - /)[0] || firstLine;
  let title = collapseWhitespace(clause).replace(/[.,;:!?\s]+$/, '');
  if (title.length > maxLen) title = `${title.slice(0, maxLen).replace(/\s+\S*$/, '')}…`;
  return title;
}

/** Flag titles that read like raw chat fragments or are otherwise low-quality. */
function isChatFragmentTitle(title, { maxLen = DEFAULT_MAX_LEN } = {}) {
  const t = collapseWhitespace(title);
  if (!t) return true;
  if (t.length > maxLen) return true;
  if (/[.!?]$/.test(t) && t.split(' ').length > 8) return true; // a sentence, not a title
  const firstWord = t.toLowerCase().replace(/[^a-z0-9].*$/, '');
  return FRAGMENT_OPENERS.has(firstWord);
}

function buildTitlePrompt(text) {
  return [
    'You write concise, concept-first titles for knowledge-base notes.',
    'Rules: 3-7 words, title-case, name the concept (not the conversation),',
    'no quotes, no trailing punctuation, no preamble — output ONLY the title.',
    '',
    'Text:',
    collapseWhitespace(text).slice(0, 1200),
    '',
    'Title:',
  ].join('\n');
}

/** Clean a raw model response into a candidate title. */
function cleanModelTitle(raw) {
  let t = String(raw || '').trim();
  t = t.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^(?:title|note title)\s*[:\-]\s*/i, ''); // "Title:" preamble first
  t = t.replace(/^["'`]+|["'`]+$/g, '');         // then surrounding quotes
  t = t.replace(/[.\s]+$/, '');                  // then trailing period/space
  return collapseWhitespace(t);
}

/** Default local LLM: Ollama generate (no content leaves the machine). */
async function ollamaGenerate(prompt, { model = 'gemma:latest', endpoint = 'http://localhost:11434' } = {}) {
  const res = await fetch(`${endpoint}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return data.response;
}

/**
 * Generate a concept-first title. Returns { title, source }.
 * source: 'llm' | 'heuristic' | 'fallback-empty'
 * Never throws — capture must not fail on titling.
 */
async function generateConceptTitle(text, options = {}) {
  const { llm = ollamaGenerate, maxLen = DEFAULT_MAX_LEN, now = () => new Date() } = options;
  const body = collapseWhitespace(text);
  if (!body) {
    return { title: `Captured note ${now().toISOString().slice(0, 16).replace('T', ' ')}`, source: 'fallback-empty' };
  }

  try {
    const raw = await llm(buildTitlePrompt(body), options);
    const candidate = cleanModelTitle(raw);
    if (candidate && candidate.length <= maxLen && !isChatFragmentTitle(candidate, { maxLen })) {
      return { title: candidate, source: 'llm' };
    }
  } catch {
    // fall through to heuristic
  }

  const heuristic = heuristicTitle(body, { maxLen });
  return { title: heuristic || body.slice(0, maxLen), source: 'heuristic' };
}

module.exports = {
  TRIGGER_PREFIXES,
  FRAGMENT_OPENERS,
  DEFAULT_MAX_LEN,
  stripTriggers,
  heuristicTitle,
  isChatFragmentTitle,
  buildTitlePrompt,
  cleanModelTitle,
  ollamaGenerate,
  generateConceptTitle,
};
