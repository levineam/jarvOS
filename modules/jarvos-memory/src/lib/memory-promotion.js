'use strict';

/**
 * memory-promotion.js — Local-first candidate review, promotion, and optional retrieval helpers.
 *
 * Converts raw secondbrain capture events into durable memory records stored as local files.
 *
 *   capture event (from secondbrain / session compaction)
 *       │
 *       ▼
 *   reviewCandidate()   ← decides whether the event meets the promotion threshold
 *       │ yes
 *       ▼
 *   promoteCandidate()  ← writes local record (MEMORY.md / decisions / lessons)
 *       │
 *       ▼
 *   promoted memory     ← canonical local file, readable by agents as workspace files
 *
 * Design notes (SUP-596 direction correction):
 * - Hindsight-backed server promotion (SUP-585) was superseded.
 * - OpenClaw 2026.4.9 native dreaming/diary covers session consolidation natively.
 * - jarvos-memory remains the curated, agent-readable file registry layer.
 * - Optional Hindsight recall helpers are retained for compatibility, but they are no longer
 *   the default promotion path.
 */

const {
  MEMORY_STAGES,
  SALIENCE_TO_MEMORY_CLASS,
  MEMORY_PROMOTION_THRESHOLD,
  CORE_MEMORY_CLASSES,
} = require('./memory-schema');

const { createMemoryRecord } = require('./memory-record');
const { HindsightAdapter } = require('./hindsight-adapter');
const { getHindsightConfig } = require('./memory-config');

function promotionContent(event = {}) {
  if (event.knowledgeUnit) return String(event.knowledgeUnit.text || '').trim();
  return String(event.content || event.text || event.knowledgeUnit?.text || '').trim();
}

function hasKnowledgeUnitEvidence(unit = {}) {
  return Array.isArray(unit.evidence)
    && unit.evidence.some((entry) => entry?.sourcePath || entry?.quote || entry?.bodySha256 || entry?.ref);
}

function isRawTranscriptSource(source = {}) {
  if (typeof source === 'string') return source === 'transcript' || source === 'raw-transcript';
  return source.type === 'transcript' || source.kind === 'transcript' || source.raw === true;
}

function isRawCaptureEvent(event = {}) {
  return String(event.schemaVersion || '') === '2.0'
    && event.source != null
    && !event.knowledgeUnit;
}

function reviewKnowledgeUnitCandidate(event = {}) {
  const unit = event.knowledgeUnit || {};
  const text = promotionContent(event);
  if (!text) {
    return { shouldPromote: false, memoryClass: null, reason: 'knowledgeUnit has no text to promote' };
  }
  if (isRawTranscriptSource(unit.source || event.source)) {
    return { shouldPromote: false, memoryClass: null, reason: 'raw transcript sources must be summarized into cited knowledge units before promotion' };
  }
  const eventText = String(event.content || event.text || '').trim();
  if (eventText && eventText !== text) {
    return { shouldPromote: false, memoryClass: null, reason: 'event text must match knowledgeUnit.text for source-backed promotion' };
  }
  if (!hasKnowledgeUnitEvidence(unit)) {
    return { shouldPromote: false, memoryClass: null, reason: 'knowledgeUnit promotion requires source evidence' };
  }
  if (unit.privacyDecision?.excludedFromPromotion || unit.privacyDecision?.tier === 'secret' || unit.privacyDecision?.tier === 'sensitive') {
    return { shouldPromote: false, memoryClass: null, reason: `knowledgeUnit privacy tier '${unit.privacyDecision?.tier || 'unknown'}' is not eligible for promotion` };
  }
  if (unit.downstreamEligibility?.memoryPromotion === false) {
    return { shouldPromote: false, memoryClass: null, reason: 'knowledgeUnit downstreamEligibility.memoryPromotion is false' };
  }

  const memoryClass = event.memoryClass || {
    claim: 'fact',
    summary: 'fact',
    preference: 'preference',
    decision: 'decision',
    lesson: 'lesson',
    project_state: 'project_state',
  }[unit.kind];

  if (!memoryClass || !CORE_MEMORY_CLASSES[memoryClass]) {
    return { shouldPromote: false, memoryClass: null, reason: `knowledgeUnit kind '${unit.kind || 'unknown'}' does not map to a memory class` };
  }

  return { shouldPromote: true, memoryClass, reason: `knowledgeUnit '${unit.id || '(no id)'} passed source and privacy gates` };
}

/**
 * Decide whether a capture event should be promoted to durable memory.
 *
 * Promotion criteria:
 *   - The event has a recognised salienceClass that maps to a memory class, OR
 *     it has an explicit memoryClass override.
 *   - The confidence score (if present) meets the MEMORY_PROMOTION_THRESHOLD.
 *
 * @param {object} event
 * @param {string} [event.salienceClass]  - Secondbrain salience class
 * @param {string} [event.memoryClass]    - Explicit override (bypasses salienceClass mapping)
 * @param {number} [event.confidence]     - Salience confidence 0.0–1.0
 * @param {string} [event.text]           - Captured text
 * @param {string} [event.content]        - Body override (takes priority over text)
 * @returns {{ shouldPromote: boolean, memoryClass: string|null, reason: string }}
 */
function reviewCandidate(event = {}) {
  if (event.knowledgeUnit) {
    return reviewKnowledgeUnitCandidate(event);
  }

  if (isRawTranscriptSource(event.source)) {
    return { shouldPromote: false, memoryClass: null, reason: 'raw transcript sources must be summarized into cited knowledge units before promotion' };
  }

  if (isRawCaptureEvent(event)) {
    return { shouldPromote: false, memoryClass: null, reason: 'raw source-backed captures must promote through cited knowledgeUnit references' };
  }

  const text = promotionContent(event);
  if (!text) {
    return { shouldPromote: false, memoryClass: null, reason: 'no content to promote' };
  }

  // Explicit memoryClass override, caller knows exactly what class this is
  if (event.memoryClass) {
    if (!CORE_MEMORY_CLASSES[event.memoryClass]) {
      return {
        shouldPromote: false,
        memoryClass: null,
        reason: `unknown memoryClass: ${event.memoryClass}`,
      };
    }
    return { shouldPromote: true, memoryClass: event.memoryClass, reason: 'explicit memoryClass' };
  }

  // salienceClass → memory class mapping
  const salienceClass = event.salienceClass;
  if (!salienceClass) {
    return { shouldPromote: false, memoryClass: null, reason: 'no salienceClass or memoryClass provided' };
  }

  const memoryClass = SALIENCE_TO_MEMORY_CLASS[salienceClass];
  if (!memoryClass) {
    return { shouldPromote: false, memoryClass: null, reason: `salienceClass '${salienceClass}' does not map to a memory class` };
  }

  // Confidence gate (skip check if no confidence provided, treat as passing)
  if (event.confidence != null) {
    const confidence = Number(event.confidence);
    if (isNaN(confidence) || confidence < MEMORY_PROMOTION_THRESHOLD) {
      return {
        shouldPromote: false,
        memoryClass: null,
        reason: `confidence ${event.confidence} below threshold ${MEMORY_PROMOTION_THRESHOLD}`,
      };
    }
  }

  return { shouldPromote: true, memoryClass, reason: `salienceClass '${salienceClass}' maps to '${memoryClass}'` };
}

/**
 * Promote a capture event to durable local memory.
 *
 * @param {object} event                      - CaptureEvent from secondbrain or direct call
 * @param {string} [event.salienceClass]
 * @param {string} [event.memoryClass]
 * @param {number} [event.confidence]
 * @param {string} [event.text]
 * @param {string} [event.content]
 * @param {string} [event.rationale]
 * @param {string} [event.source]
 * @param {string} [event.noteRef]
 * @param {string} [event.supersedes]
 * @returns {PromotionResult}
 *
 * @typedef {object} PromotionResult
 * @property {string}      stage
 * @property {string|null} memoryClass
 * @property {object|null} record
 * @property {boolean}     written
 * @property {string|null} path
 * @property {string}      reason
 * @property {string|null} error
 */
function promoteCandidate(event = {}) {
  const review = reviewCandidate(event);

  if (!review.shouldPromote) {
    return {
      stage: MEMORY_STAGES.REJECTED,
      memoryClass: null,
      record: null,
      written: false,
      path: null,
      reason: review.reason,
      error: null,
    };
  }

  const content = promotionContent(event);
  const unit = event.knowledgeUnit || null;
  const result = createMemoryRecord({
    class: review.memoryClass,
    content,
    rationale: event.rationale,
    source: event.source || unit?.source?.path || unit?.source?.type,
    noteRef: event.noteRef || unit?.source?.path,
    confidence: event.confidence || unit?.confidence,
    supersedes: event.supersedes,
  });

  if (result.error) {
    return {
      stage: MEMORY_STAGES.REJECTED,
      memoryClass: review.memoryClass,
      record: null,
      written: false,
      path: null,
      reason: 'createMemoryRecord failed',
      error: result.error,
    };
  }

  return {
    stage: MEMORY_STAGES.PROMOTED,
    memoryClass: review.memoryClass,
    record: result.record,
    written: result.written,
    path: result.path,
    reason: review.reason,
    error: null,
  };
}

/**
 * Recall relevant memories from Hindsight.
 *
 * Compatibility helper only. Promotion is now local-first; callers that still use
 * Hindsight directly can continue to degrade gracefully through this wrapper.
 *
 * @param {string} query                - What to search for
 * @param {HindsightAdapter} [adapter]  - Optional adapter (created from env if omitted)
 * @returns {Promise<RecallResult>}
 *
 * @typedef {object} RecallResult
 * @property {string[]}    results      - Retrieved memory strings (may be empty)
 * @property {boolean}     hindsightOk  - Whether Hindsight was available and responded
 * @property {string|null} error
 */
async function recallMemory(query, adapter) {
  const hindsightAdapter = adapter || new HindsightAdapter(getHindsightConfig());
  const available = await hindsightAdapter.ping();

  if (!available) {
    return {
      results: [],
      hindsightOk: false,
      error: 'Hindsight not available',
    };
  }

  const result = await hindsightAdapter.recall(query);
  return {
    results: result.results,
    hindsightOk: !result.error,
    error: result.error,
  };
}

/**
 * Reflect on a question using all memories stored in Hindsight.
 *
 * Compatibility helper only. This preserves the optional retrieval surface without
 * making Hindsight the canonical promotion path.
 *
 * @param {string} query                - The question to reflect on
 * @param {HindsightAdapter} [adapter]  - Optional adapter
 * @returns {Promise<ReflectResult>}
 *
 * @typedef {object} ReflectResult
 * @property {string|null} text         - Synthesized answer (null if Hindsight unavailable)
 * @property {boolean}     hindsightOk
 * @property {string|null} error
 */
async function reflectOnMemory(query, adapter) {
  const hindsightAdapter = adapter || new HindsightAdapter(getHindsightConfig());
  const available = await hindsightAdapter.ping();

  if (!available) {
    return {
      text: null,
      hindsightOk: false,
      error: 'Hindsight not available',
    };
  }

  const result = await hindsightAdapter.reflect(query);
  return {
    text: result.text,
    hindsightOk: !result.error,
    error: result.error,
  };
}

module.exports = {
  reviewKnowledgeUnitCandidate,
  reviewCandidate,
  promoteCandidate,
  recallMemory,
  reflectOnMemory,
};
