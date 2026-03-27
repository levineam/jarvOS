#!/usr/bin/env node
/**
 * Three-package capture router for JarvOS.
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
  buildRoutingPlan: buildKeywordPlan,
  applyRoutingPlan: applyKeywordPlan,
  detectTrigger,
  hasCaptureIntent,
  primaryText,
  IDEA,
  NOTE,
} = require('./keyword-capture-router');

const {
  createMemoryRecord,
  checkMemoryDedup,
} = require('../../../../jarvos-memory/src/lib/memory-record');

// Salience class → memory class mapping
const SALIENCE_TO_MEMORY_CLASS = {
  decision: 'decision',
  belief_change: 'fact',
  preference: 'preference',
  factual_learning: 'fact',
  lesson: 'lesson',
};

// Minimum confidence for memory promotion
const MEMORY_CONFIDENCE_THRESHOLD = 0.8;

// Journal section headings for memory-related captures
const DECISIONS_HEADING = '## ✅ Decisions';
const REMEMBERED_HEADING = '## 🧠 Remembered';

/**
 * Build a three-package routing plan from a capture event.
 *
 * Extends the keyword routing plan with memory routing decisions.
 */
function buildThreePackagePlan(capture = {}) {
  const keywordPlan = buildKeywordPlan(capture);

  const salienceClass = capture.salienceClass || null;
  const confidence = typeof capture.confidence === 'number' ? capture.confidence : null;
  const memoryClass = salienceClass ? SALIENCE_TO_MEMORY_CLASS[salienceClass] : null;

  // Salience-driven captures can override the keyword "ignored" flag.
  // If salience detects a high-confidence signal, we still route even
  // if no keyword trigger was present.
  const salienceOverridesIgnored = Boolean(
    salienceClass
    && salienceClass !== 'nothing'
    && confidence !== null
    && confidence >= MEMORY_CONFIDENCE_THRESHOLD,
  );

  // If keyword layer ignored the capture but salience says it's important,
  // force the journal + notes routing for the keyword plan
  if (keywordPlan.ignored && salienceOverridesIgnored) {
    const text = primaryText(capture);
    const title = String(capture.title || text.split(/\r?\n/)[0] || '').slice(0, 80).trim();
    keywordPlan.ignored = false;
    keywordPlan.route = NOTE;
    keywordPlan.defaultedToNoteBias = true;
    keywordPlan.journalSection = salienceClass === 'decision' ? DECISIONS_HEADING : '## 📝 Notes';
    keywordPlan.journalLine = title ? `- [[${title}]]` : `- ${text.slice(0, 120)}`;
    keywordPlan.createNote = true;
    keywordPlan.noteTitle = title || `Captured ${salienceClass} ${new Date().toISOString().slice(0, 16)}`;
    keywordPlan.noteContent = text;
    keywordPlan.noteFrontmatter = {
      type: 'draft',
      source: 'salience-capture',
      salience_class: salienceClass,
      confidence,
      created_from: capture.date ? `journal/${capture.date}` : 'journal',
    };
  }

  // Determine if we should route to memory
  const shouldRouteToMemory = Boolean(
    memoryClass
    && confidence !== null
    && confidence >= MEMORY_CONFIDENCE_THRESHOLD
    && !keywordPlan.ignored,
  );

  // Memory record params (built but not written yet)
  const memoryParams = shouldRouteToMemory ? {
    class: memoryClass,
    content: capture.title || primaryText(capture).slice(0, 200),
    rationale: capture.rationale || undefined,
    source: capture.date ? `journal/${capture.date}` : 'journal',
    confidence,
  } : null;

  // Dedup check
  let dedupResult = null;
  if (memoryParams) {
    dedupResult = checkMemoryDedup(memoryParams.content, memoryParams.class);
  }

  return {
    ...keywordPlan,

    // Memory routing
    routeToMemory: shouldRouteToMemory && (!dedupResult || !dedupResult.isDuplicate),
    memoryClass,
    memoryParams,
    memoryDedup: dedupResult,

    // Salience metadata
    salienceClass,
    confidence,
  };
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
  const keywordResult = applyKeywordPlan(capture, options);

  // Step 2: Apply memory routing
  let memoryResult = null;
  if (plan.routeToMemory && plan.memoryParams) {
    const params = { ...plan.memoryParams };

    // If a note was created, add the reference
    if (keywordResult.note) {
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
  applyThreePackagePlan,
  buildThreePackagePlan,
  previewRouting,
};

if (require.main === module) {
  main();
}
