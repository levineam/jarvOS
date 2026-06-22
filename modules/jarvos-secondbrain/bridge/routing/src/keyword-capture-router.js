#!/usr/bin/env node
/**
 * Keyword-triggered capture routing for jarvos-secondbrain.
 *
 * Rules:
 * - idea => append a plain bullet to the journal Ideas section
 * - note => always create a standalone note and link it in the journal Notes section
 * - default capture intent => bias toward standalone notes
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
} = require('../../../adapters');

const {
  IDEA,
  NOTE,
  KEYWORD_RE,
  IDEA_ANTI_TRIGGER_PATTERNS,
  IDEA_CAPTURE_PATTERNS,
  NOTE_CAPTURE_PATTERNS,
  GENERAL_CAPTURE_PATTERNS,
  detectTrigger,
  hasCaptureIntent,
  stripLeadingKeyword,
  primaryText,
} = require('../../../packages/jarvos-ambient/src/intent/keyword-capture-router');

const {
  buildNoteContent,
  buildRoutingPlan,
  ideaJournalLine,
  inferTitle,
  isSubstantiveIdea,
} = require('../../../packages/jarvos-ambient/src/routing');

function applyRoutingPlan(capture = {}, options = {}) {
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
    const actualNoteTitle = result.note?.title;
    const journalLine = actualNoteTitle && plan.noteTitle
      ? plan.journalLine.replace(`[[${plan.noteTitle}]]`, `[[${actualNoteTitle}]]`)
      : plan.journalLine;
    result.journalEntry = adapter.appendLineToJournalSection({
      heading: plan.journalSection,
      line: journalLine,
      date,
    });
    result.noteLink = result.journalEntry;
  } else {
    adapter.ensureJournal({ date });
  }

  return result;
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
  KEYWORD_RE,
  IDEA_ANTI_TRIGGER_PATTERNS,
  IDEA_CAPTURE_PATTERNS,
  NOTE_CAPTURE_PATTERNS,
  GENERAL_CAPTURE_PATTERNS,
  applyRoutingPlan,
  buildNoteContent,
  buildRoutingPlan,
  detectTrigger,
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
