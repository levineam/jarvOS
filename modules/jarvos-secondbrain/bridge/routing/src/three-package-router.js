#!/usr/bin/env node
/**
 * Three-package capture router for jarvOS.
 *
 * Routes capture events to up to three destinations:
 * 1. jarvos-secondbrain-journal (chronological record)
 * 2. jarvos-secondbrain-notes (durable searchable artifacts)
 * 3. jarvos-memory (compact recall records)
 *
 * This module wraps the existing keyword-capture-router and adds
 * memory routing on top. It is the entry point for the full capture flow.
 *
 * Input:
 * {
 *   "trigger": "idea|note|decision|preference|fact|lesson",
 *   "salienceClass": "idea|decision|belief_change|commitment|preference|factual_learning|lesson",
 *   "confidence": 0.0-1.0,
 *   "title": "Optional title",
 *   "text": "Captured text",
 *   "content": "Optional body override",
 *   "rationale": "Optional — why this matters (for decisions, lessons)",
 *   "frontmatter": { ... },
 *   "date": "YYYY-MM-DD"
 * }
 *
 * SUP-370
 */

'use strict';

const {
  createStorageAdapter,
} = require('../../../adapters');

function createUnavailableMemoryApi(loadError) {
  return {
    createMemoryRecord() {
      return {
        record: null,
        written: false,
        path: null,
        error: `@jarvos/memory is unavailable: ${loadError.message}`,
      };
    },
    checkMemoryDedup() {
      return { isDuplicate: false, existingPath: null, action: null };
    },
  };
}

function loadMemoryApi() {
  try {
    return require('@jarvos/memory');
  } catch (packageError) {
    try {
      return require('../../../../jarvos-memory/src');
    } catch {
      return createUnavailableMemoryApi(packageError);
    }
  }
}

const memoryApi = loadMemoryApi();

const createMemoryRecord = typeof memoryApi.createMemoryRecord === 'function'
  ? memoryApi.createMemoryRecord
  : () => ({
    record: null,
    written: false,
    path: null,
    error: 'createMemoryRecord is unavailable',
  });

const checkMemoryDedup = typeof memoryApi.checkMemoryDedup === 'function'
  ? memoryApi.checkMemoryDedup
  : () => ({ isDuplicate: false, existingPath: null, action: null });

const {
  SALIENCE_TO_MEMORY_CLASS,
  MEMORY_CONFIDENCE_THRESHOLD,
  DECISIONS_HEADING,
  REMEMBERED_HEADING,
  FLAGGED_HEADING,
  REVIEW_CONFIDENCE_MIN,
  REVIEW_CONFIDENCE_MAX,
  buildThreePackagePlan,
} = require('../../../packages/jarvos-ambient/src/routing');

const {
  resolveConfiguredHeading,
} = require('../../../packages/jarvos-secondbrain-journal/src/section-config');

function noteWriteSucceeded(note) {
  return Boolean(note) && note.written !== false && note.error == null;
}

function applyStoragePlan(plan, capture = {}, options = {}) {
  const adapter = options.adapter || createStorageAdapter(options);
  const date = plan.date;
  const result = {
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
    let journalLine = plan.journalLine;
    if (
      result.note
      && result.note.title
      && plan.noteTitle
      && journalLine === `- [[${plan.noteTitle}]]`
    ) {
      journalLine = `- [[${result.note.title}]]`;
    }

    // Invariant (SUP-1900): never write a note wiki-link into the journal unless the
    // note was actually written to disk. A failed or misrouted note write must NOT
    // leave a dangling [[link]] with no backing note. Fail closed.
    const isNoteWikiLink = plan.createNote && /^\s*-\s*\[\[/.test(journalLine);
    // Trust the adapter's write result: link only if the note write was not an
    // explicit failure. (The adapter is authoritative for its own vault within this
    // call; cross-vault/cross-runtime drift is covered by the integrity sweep + WS7.)
    const noteWritten = noteWriteSucceeded(result.note);

    if (isNoteWikiLink && !noteWritten) {
      result.noteLinkSkipped = {
        reason: 'note_not_written',
        plannedLine: journalLine,
        notePath: result.note ? (result.note.path || null) : null,
      };
    } else {
      // Resolve the plan's (default) heading to the currently-configured one, so a
      // renamed/reordered section in journal-module.json is honored by the capture
      // path — not just the renderer (WS0 config-driven sections).
      result.journalEntry = adapter.appendLineToJournalSection({
        heading: resolveConfiguredHeading(plan.journalSection),
        line: journalLine,
        date,
      });
      result.noteLink = result.journalEntry;
    }
  } else {
    adapter.ensureJournal({ date });
  }

  return result;
}

/**
 * Apply the full three-package routing plan.
 *
 * 1. Apply keyword routing (journal + notes)
 * 2. If memory routing is indicated, create the memory record
 * 3. If a note was created, link it in the memory record
 */
function applyThreePackagePlan(capture = {}, options = {}) {
  const plan = buildThreePackagePlan(capture);

  // Step 1: Apply keyword routing (journal + notes)
  const keywordResult = applyStoragePlan(plan, capture, options);

  // Step 2: Apply memory routing
  let memoryResult = null;
  if (plan.routeToMemory && plan.memoryParams) {
    const dedupResult = checkMemoryDedup(plan.memoryParams.content, plan.memoryParams.class);
    plan.memoryDedup = dedupResult;
    if (dedupResult && dedupResult.isDuplicate) {
      return {
        plan: {
          ...plan,
          routeToMemory: false,
        },
        journal: keywordResult.journalEntry,
        note: keywordResult.note,
        noteLink: keywordResult.noteLink,
        memory: null,
      };
    }

    const params = { ...plan.memoryParams };

    // If a note was persisted, add the reference.
    if (noteWriteSucceeded(keywordResult.note)) {
      params.noteRef = keywordResult.note.title || keywordResult.note.path || undefined;
    }

    memoryResult = createMemoryRecord(params);
  }

  return {
    plan,
    journal: keywordResult.journalEntry,
    note: keywordResult.note,
    noteLink: keywordResult.noteLink,
    memory: memoryResult,
  };
}

/**
 * Convenience: detect the full routing intent from a raw message.
 *
 * Returns which packages would receive the capture and whether
 * memory routing would fire, without actually writing anything.
 */
function previewRouting(capture = {}) {
  const plan = buildThreePackagePlan(capture);
  return {
    wouldCapture: !plan.ignored,
    journal: !plan.ignored,
    notes: plan.createNote,
    memory: plan.routeToMemory,
    salienceClass: plan.salienceClass,
    memoryClass: plan.memoryClass,
    confidence: plan.confidence,
    trigger: plan.detectedTrigger,
    dedup: plan.memoryDedup,
    workIntake: Boolean(plan.workIntake),
    skillInvocations: plan.skillInvocations.map((invocation) => invocation.skillId),
  };
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

    const mode = process.argv.includes('--preview') ? 'preview' : 'apply';

    try {
      if (mode === 'preview') {
        console.log(JSON.stringify(previewRouting(parsed), null, 2));
      } else {
        const result = applyThreePackagePlan(parsed);
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });
}

module.exports = {
  SALIENCE_TO_MEMORY_CLASS,
  MEMORY_CONFIDENCE_THRESHOLD,
  DECISIONS_HEADING,
  REMEMBERED_HEADING,
  FLAGGED_HEADING,
  REVIEW_CONFIDENCE_MIN,
  REVIEW_CONFIDENCE_MAX,
  applyStoragePlan,
  applyThreePackagePlan,
  buildThreePackagePlan,
  noteWriteSucceeded,
  previewRouting,
};

if (require.main === module) {
  main();
}
