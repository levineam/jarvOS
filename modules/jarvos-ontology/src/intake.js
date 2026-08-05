/**
 * intake.js — CaptureEvent intake adapter for jarvos-ontology.
 *
 * Accepts structured CaptureEvent objects from the stabilized secondbrain
 * contract (jarvos-secondbrain/bridge/routing/src/capture-contract.js) and
 * routes them to the correct ontology section based on salienceClass.
 *
 * This is the preferred integration path for downstream consumers.  It does NOT
 * run raw text through regex signal-detection — instead it trusts the upstream
 * classification already applied by the routing bridge and/or jarvos-memory.
 *
 * Salience class → ontology section mapping
 * ─────────────────────────────────────────
 *  belief_change   → beliefs     (belief type)
 *  lesson          → beliefs     (belief type, experiential)
 *  commitment      → goals       (goal type)
 *  idea            → goals       (goal type, exploratory)
 *  preference      → core-self   (value type)
 *  decision        → core-self   (value type, resolved)
 *  factual_learning → (skipped — factual notes are not personal ontology signals)
 *  nothing         → (skipped)
 *
 * Usage:
 *   import { ingestCaptureEvent, ingestMemoryResults } from './intake.js';
 *
 *   // From secondbrain routing output:
 *   const result = ingestCaptureEvent(captureEvent, '/path/to/ontology');
 *
 *   // From jarvos-memory recall output:
 *   const results = ingestMemoryResults(recallResults, '/path/to/ontology');
 */

import { readFileSync, existsSync } from 'fs';
import { appendToSection } from './writer.js';
import { textOverlap } from './extractor.js';

// ─── Salience → ontology mapping ──────────────────────────────────────────

/**
 * Maps CaptureEvent salienceClass values to ontology section names and signal labels.
 *
 * Only classes that carry personal ontology signal are included.
 * Omitted classes (factual_learning, nothing) are intentionally skipped.
 *
 * @type {Record<string, { section: string, label: string }>}
 */
export const SALIENCE_TO_ONTOLOGY = {
  belief_change:    { section: 'beliefs',   label: 'Belief change' },
  lesson:           { section: 'beliefs',   label: 'Lesson' },
  commitment:       { section: 'goals',     label: 'Commitment' },
  idea:             { section: 'goals',     label: 'Idea' },
  preference:       { section: 'core-self', label: 'Preference' },
  decision:         { section: 'core-self', label: 'Decision' },
};

/** Section file names used for duplicate checking. */
const SECTION_FILES = {
  beliefs:    '2-beliefs.md',
  predictions: '3-predictions.md',
  'core-self': '4-core-self.md',
  goals:      '5-goals.md',
  projects:   '6-projects.md',
};

// ─── Duplicate detection ───────────────────────────────────────────────────

/**
 * Check whether text is already present in the target section file.
 *
 * Uses the same Jaccard-like overlap check as extractor.routeSignals.
 *
 * @param {string} text - Text to check
 * @param {string} section - Section name
 * @param {string} ontologyDir - Path to ontology/ directory
 * @param {number} [threshold=0.6] - Overlap threshold for deduplication
 * @returns {boolean}
 */
function isDuplicate(text, section, ontologyDir, threshold = 0.6) {
  const fileName = SECTION_FILES[section];
  if (!fileName) return false;

  const filePath = `${ontologyDir}/${fileName}`;
  if (!existsSync(filePath)) return false;

  const existing = readFileSync(filePath, 'utf8');

  // Check against each dated entry line
  const entryLines = existing
    .split('\n')
    .filter(l => /^- \[\d{4}-\d{2}-\d{2}\]/.test(l.trim()));

  for (const line of entryLines) {
    if (textOverlap(text, line) >= threshold) return true;
  }

  return false;
}

function isRawTranscriptSource(source = {}) {
  if (typeof source === 'string') return source === 'transcript' || source === 'raw-transcript';
  return source.type === 'transcript' || source.kind === 'transcript' || source.raw === true;
}

function hasKnowledgeUnitEvidence(unit = {}) {
  return Array.isArray(unit.evidence)
    && unit.evidence.some(entry => entry?.sourcePath || entry?.quote || entry?.bodySha256 || entry?.ref);
}

function isRawCaptureEvent(event = {}) {
  return String(event.schemaVersion || '') === '2.0'
    && event.source != null
    && !event.knowledgeUnit;
}

function knowledgeUnitRejectionReason(event = {}) {
  const unit = event.knowledgeUnit;
  if (!unit) return '';
  if (isRawTranscriptSource(unit.source || event.source)) {
    return 'raw transcript sources must be refined into cited knowledge units before ontology intake';
  }
  if (!hasKnowledgeUnitEvidence(unit)) {
    return 'knowledgeUnit ontology intake requires source evidence';
  }
  if (unit.privacyDecision?.excludedFromPromotion || unit.privacyDecision?.tier === 'secret' || unit.privacyDecision?.tier === 'sensitive') {
    return `knowledgeUnit privacy tier '${unit.privacyDecision?.tier || 'unknown'}' is not eligible for ontology intake`;
  }
  if (unit.downstreamEligibility?.ontologyPromotion !== true) {
    return 'knowledgeUnit downstreamEligibility.ontologyPromotion must be true';
  }
  return '';
}

// ─── Intake for a single CaptureEvent ─────────────────────────────────────

/**
 * Ingest a single CaptureEvent into the ontology.
 *
 * Validates the event, maps its salienceClass to an ontology section,
 * deduplicates against existing entries, and appends a dated entry.
 *
 * @param {object} event                    - CaptureEvent from secondbrain bridge
 * @param {string} [event.salienceClass]    - Upstream salience classification
 * @param {string} [event.text]             - Captured raw text
 * @param {string} [event.content]          - Body override (takes priority over text)
 * @param {string} [event.title]            - Optional short title / label
 * @param {string} [event.rationale]        - Why this is significant
 * @param {string} [event.date]             - ISO date (YYYY-MM-DD). Defaults to today.
 * @param {string} ontologyDir              - Absolute path to the ontology/ directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun]        - If true, simulate without writing
 * @param {number}  [options.dupThreshold]  - Similarity threshold for dedup (default 0.6)
 * @returns {IntakeResult}
 *
 * @typedef {object} IntakeResult
 * @property {'written'|'skipped'|'rejected'} outcome
 * @property {string} section     - Target section (or empty string if skipped/rejected)
 * @property {string} label       - Signal label (e.g. "Belief change")
 * @property {string} entry       - The formatted entry that was written (or would be)
 * @property {string} reason      - Human-readable explanation of the outcome
 * @property {boolean} dryRun
 */
export function ingestCaptureEvent(event = {}, ontologyDir, options = {}) {
  const dryRun = !!options.dryRun;
  const dupThreshold = options.dupThreshold ?? 0.6;

  if (isRawTranscriptSource(event.source)) {
    return {
      outcome: 'rejected',
      section: '',
      label: '',
      entry: '',
      reason: 'raw transcript sources must be refined into cited knowledge units before ontology intake',
      dryRun,
    };
  }

  if (isRawCaptureEvent(event)) {
    return {
      outcome: 'rejected',
      section: '',
      label: '',
      entry: '',
      reason: 'raw source-backed captures are not accepted by ontology intake',
      dryRun,
    };
  }

  const unitRejection = knowledgeUnitRejectionReason(event);
  if (unitRejection) {
    return {
      outcome: 'rejected',
      section: '',
      label: '',
      entry: '',
      reason: unitRejection,
      dryRun,
    };
  }

  // Resolve content
  const text = String(event.knowledgeUnit?.text || event.content || event.text || '').trim();
  const eventText = String(event.content || event.text || '').trim();
  if (event.knowledgeUnit && eventText && eventText !== text) {
    return {
      outcome: 'rejected',
      section: '',
      label: '',
      entry: '',
      reason: 'event text must match knowledgeUnit.text for ontology intake',
      dryRun,
    };
  }
  if (!text) {
    return {
      outcome: 'rejected',
      section: '',
      label: '',
      entry: '',
      reason: 'CaptureEvent has no text or content',
      dryRun,
    };
  }

  // Map salienceClass → section
  const salienceClass = event.salienceClass;
  const mapping = SALIENCE_TO_ONTOLOGY[salienceClass];
  if (!mapping) {
    return {
      outcome: 'skipped',
      section: '',
      label: '',
      entry: '',
      reason: salienceClass
        ? `salienceClass '${salienceClass}' does not map to an ontology section`
        : 'no salienceClass on event',
      dryRun,
    };
  }

  const { section, label } = mapping;

  // Build the entry text
  const display = event.title ? `${event.title}: ${text}` : text;
  const truncated = display.length > 350 ? display.slice(0, 347) + '...' : display;
  const entryContent = event.rationale
    ? `${label}: "${truncated}" — ${event.rationale}`
    : `${label}: "${truncated}"`;

  // Deduplicate
  if (isDuplicate(truncated, section, ontologyDir, dupThreshold)) {
    return {
      outcome: 'skipped',
      section,
      label,
      entry: entryContent,
      reason: 'duplicate — similar entry already in section',
      dryRun,
    };
  }

  // Write (or dry-run)
  const date = event.date || new Date().toISOString().slice(0, 10);
  let writeResult;
  try {
    writeResult = appendToSection(ontologyDir, section, entryContent, { date, dryRun });
  } catch (err) {
    return {
      outcome: 'rejected',
      section,
      label,
      entry: entryContent,
      reason: `write failed: ${err.message}`,
      dryRun,
    };
  }

  return {
    outcome: 'written',
    section,
    label,
    entry: writeResult.entry,
    reason: `appended to ${section}`,
    dryRun,
  };
}

// ─── Intake for jarvos-memory recall results ───────────────────────────────

/**
 * Ingest an array of recalled memory strings from jarvos-memory into the
 * ontology.  Each string is treated as a raw promoted memory with no
 * salienceClass, so only strings that include a recognisable salienceClass
 * tag are routed.  Use this as a lightweight bridge after a recallMemory()
 * call.
 *
 * For full structured ingestion, use ingestCaptureEvent() directly instead.
 *
 * @param {string[]} memoryStrings       - Results from recallMemory().results
 * @param {string}   ontologyDir         - Path to ontology/ directory
 * @param {object}   [options]
 * @param {string}   [options.date]      - ISO date for entries
 * @param {boolean}  [options.dryRun]
 * @returns {MemoryIngestSummary}
 *
 * @typedef {object} MemoryIngestSummary
 * @property {IntakeResult[]} results
 * @property {number} written
 * @property {number} skipped
 * @property {number} rejected
 */
export function ingestMemoryResults(memoryStrings = [], ontologyDir, options = {}) {
  const results = memoryStrings.map(str => {
    // Memory strings from Hindsight may include a leading class tag like
    // "[belief_change] ..." — try to extract it.
    const tagMatch = str.match(/^\[([a-z_]+)\]\s*/);
    const salienceClass = tagMatch ? tagMatch[1] : undefined;
    const text = tagMatch ? str.slice(tagMatch[0].length).trim() : str.trim();

    return ingestCaptureEvent(
      { salienceClass, text, date: options.date },
      ontologyDir,
      options,
    );
  });

  return {
    results,
    written:  results.filter(r => r.outcome === 'written').length,
    skipped:  results.filter(r => r.outcome === 'skipped').length,
    rejected: results.filter(r => r.outcome === 'rejected').length,
  };
}

// ─── Batch intake ──────────────────────────────────────────────────────────

/**
 * Ingest an array of CaptureEvents in one call.
 *
 * @param {object[]} events   - Array of CaptureEvent objects
 * @param {string}   ontologyDir
 * @param {object}   [options]
 * @returns {BatchIntakeResult}
 *
 * @typedef {object} BatchIntakeResult
 * @property {IntakeResult[]} results
 * @property {number} written
 * @property {number} skipped
 * @property {number} rejected
 * @property {boolean} dryRun
 */
export function ingestCaptureEvents(events = [], ontologyDir, options = {}) {
  const results = events.map(event => ingestCaptureEvent(event, ontologyDir, options));

  return {
    results,
    written:  results.filter(r => r.outcome === 'written').length,
    skipped:  results.filter(r => r.outcome === 'skipped').length,
    rejected: results.filter(r => r.outcome === 'rejected').length,
    dryRun:   !!options.dryRun,
  };
}
