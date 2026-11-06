'use strict';

const { captureWithJarvos, captureFailureMessage } = require('./universal-capture');
const { parseHardCaptureCommand } = require('../../routing/src/keyword-capture-router');
const { SOURCE_TOOLS } = require('../../../packages/jarvos-ambient/src/intent/capture-contract');
const { normalizeJournalEntry } = require('../../provenance/src/content-origin-contract');

function buildSimpleCaptureEvent(input = {}) {
  const { kind, words, asked } = input;
  if (!['idea', 'journal', 'note'].includes(kind)) throw new Error('kind must be idea, journal, or note');
  if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('text must be a non-empty string');
  if (kind !== 'note' && input.title !== undefined) throw new Error('title is only used for notes');
  if (!['user', 'assistant', 'mixed'].includes(words)) throw new Error('words must be user, assistant, or mixed');
  if (!['explicit', 'accepted_offer'].includes(asked)) throw new Error('save only when the user asked or accepted an offer');
  if (typeof input.source !== 'string' || !input.source.trim()) throw new Error('source must be a non-empty string');
  for (const key of ['title', 'model']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  if (input.date !== undefined && (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)
    || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date)) {
    throw new Error('date must be a valid YYYY-MM-DD date');
  }
  // The universal path gives a leading hard command precedence over trigger.
  const command = parseHardCaptureCommand(input);
  if (command.matched && command.route !== kind) {
    throw new Error(`text starts with a ${command.route} command; remove that prefix or use kind "${command.route}"`);
  }
  // A journal bullet cannot hold block Markdown (lists, headings, quotes,
  // code fences) or tabs; say so up front instead of failing after dispatch.
  // Check the words that will actually be written: after a matching
  // "Journal:"/"Idea:" prefix is removed, the rest must still be a valid bullet.
  if (command.matched && !command.content) throw new Error('text has a command prefix but nothing to save');
  if (kind !== 'note') {
    try { normalizeJournalEntry(`- ${command.matched ? command.content : input.text.trim()}`); } catch {
      throw new Error('this text has lists, headings, quotes, code or tabs, which a journal bullet cannot hold; save it with kind "note" to keep the formatting, or as plain sentences');
    }
  }
  const source = input.source.trim();
  const model = input.model?.trim() || 'unknown';
  return {
    trigger: kind,
    text: input.text.trim(),
    source: SOURCE_TOOLS.includes(source) || /^custom:[a-z0-9][a-z0-9-]*$/i.test(source)
      ? source : { tool: 'other', label: source },
    captureMode: 'prompted',
    verbatim: true,
    frontmatter: { capture_asked: asked },
    ...(kind === 'idea' ? { substantive: false } : {}),
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    ...(input.date !== undefined ? { date: input.date } : {}),
    content_origin: words === 'user' ? 'unknown' : words,
    content_origin_basis: { user: 'unknown', assistant: 'assistant_generated', mixed: 'mixed_composition' }[words],
    ...(words === 'user' ? {} : {
      content_origin_drafting: [{
        kind: words === 'assistant' ? 'assistant_draft' : 'assistant_edit',
        harness: source,
        model,
        model_evidence: model === 'unknown' ? 'unknown' : 'declared',
      }],
    }),
  };
}

const ACKNOWLEDGED = new Set(['committed', 'already_satisfied']);
const PENDING = new Set(['saved_locally_sync_pending', 'deferred']);

// A queued or locally saved write may still land, or (when only the journal
// file's creation was queued) may not: it is neither "saved" nor "not saved".
// Promise nothing; ask for a check, which avoids both loss and duplicates.
function isPendingOnly(result) {
  const artifacts = result?.artifactReceipt?.artifacts || [];
  const open = artifacts.filter((artifact) => !ACKNOWLEDGED.has(artifact.outcome));
  return open.length > 0 && open.every((artifact) => PENDING.has(artifact.outcome));
}

function simpleCapture(input, options = {}) {
  const event = buildSimpleCaptureEvent(input);
  const { capture = captureWithJarvos, ...captureOptions } = options;
  const result = capture(event, captureOptions);
  const ok = result.ok === true;
  const kind = input.kind;
  const when = input.date ? `for ${input.date}` : "today's";
  let message;
  const artifacts = result?.artifactReceipt?.artifacts || [];
  const noteSaved = kind === 'note' && artifacts.some((a) => a.kind === 'note' && ACKNOWLEDGED.has(a.outcome));
  if (!ok && noteSaved) {
    // The note exists; only its journal link is unconfirmed. Saying "not
    // saved" would invite a duplicate note.
    const notesWhere = input.date ? `Notes for ${input.date}` : "today's Notes";
    message = `Saved the note "${result.note?.title || input.title || 'untitled'}", but its link from ${notesWhere} is not confirmed (${captureFailureMessage(result)}). Do not save the note again.`;
  } else if (!ok && isPendingOnly(result)) message = 'Not confirmed yet: the vault has not confirmed this save, and it may still be waiting. Check whether it is there before saving it again.';
  else if (!ok) message = `Not saved: ${captureFailureMessage(result)}`;
  else if (kind === 'note') {
    // Claim the journal link only when a journal write was acknowledged; link
    // policy may skip it (for example, operational notes).
    const linked = artifacts.some((a) => a.kind === 'journal' && ACKNOWLEDGED.has(a.outcome));
    message = linked
      ? `Saved as the note "${result.note.title}", linked from ${input.date ? `Notes for ${input.date}` : "today's Notes"}.`
      : `Saved as the note "${result.note.title}".`;
  }
  else message = input.date
    ? `Saved to ${kind === 'idea' ? 'Ideas' : 'Journal'} ${when}.`
    : `Saved to ${when} ${kind === 'idea' ? 'Ideas' : 'Journal'}.`;
  return { ok, kind, message: message.replace(/[\r\n\u2028\u2029]+/g, ' '), result };
}

module.exports = { buildSimpleCaptureEvent, simpleCapture };
