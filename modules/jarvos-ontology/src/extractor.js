/**
 * extractor.js — Detect ontology-relevant signals from text.
 *
 * Rewritten as ES module from clawd/scripts/ontology-extractor.js.
 * Accepts ontology dir as argument instead of hardcoded paths.
 * Exports extraction functions for programmatic use.
 */

import { readFileSync, existsSync } from 'fs';
import { appendToSection } from './writer.js';

// ─── Signal Definitions ────────────────────────────────────────────────────

export const SIGNAL_DEFS = [
  {
    type: 'belief',
    label: 'Belief',
    section: 'beliefs',
    patterns: [
      /I think\s+\S.{5,300}/gi,
      /I believe\s+\S.{5,300}/gi,
      /Reality is\s+\S.{5,300}/gi,
      /We are all\s+\S.{5,300}/gi,
      /The truth is\s+\S.{5,300}/gi,
    ],
  },
  {
    type: 'prediction',
    label: 'Prediction',
    section: 'predictions',
    patterns: [
      /I predict\s+\S.{5,300}/gi,
      /I bet\s+\S.{5,300}/gi,
      /By \d{4}[,.\s]\S.{5,300}/gi,
      /This will\s+\S.{5,300}/gi,
      /\S[\w\s]{2,40} will happen\b.{0,200}/gi,
    ],
  },
  {
    type: 'goal',
    label: 'Goal',
    section: 'goals',
    patterns: [
      /My goal is\s+\S.{5,300}/gi,
      /I want to\s+\S.{5,300}/gi,
      /We should build\s+\S.{5,300}/gi,
      /The mission is\s+\S.{5,300}/gi,
    ],
  },
  {
    type: 'mission',
    label: 'Mission',
    section: 'core-self',
    patterns: [
      /The point is\s+\S.{5,300}/gi,
      /What matters is\s+\S.{5,300}/gi,
      /Everything connects to\s+\S.{5,300}/gi,
      /We are here to\s+\S.{5,300}/gi,
    ],
  },
  {
    type: 'value',
    label: 'Value',
    section: 'core-self',
    patterns: [
      /I care about\s+\S.{5,300}/gi,
      /What's important is\s+\S.{5,300}/gi,
      /I value\s+\S.{5,300}/gi,
      /Never compromise on\s+\S.{5,300}/gi,
    ],
  },
  {
    type: 'project_change',
    label: 'Project Change',
    section: 'projects',
    patterns: [
      /We're stopping\s+\S.{5,300}/gi,
      /Kill\s+[\w][\w\s]{2,60}(?:\.|$)/gi,
      /[\w][\w\s]{2,60}\s+is abandoned\b.{0,200}/gi,
      /New project:\s*\S.{5,300}/gi,
    ],
  },
];

// ─── Skip patterns (metadata / system lines) ──────────────────────────────

const SKIP_PATTERNS = [
  /^— (Written|Edited) by/,
  /^\*\*Status:\*\*/,
  /^\*\*Source:\*\*/,
  /^\*\*Quote:\*\*/,
  /^\*\*Confidence:\*\*/,
  /^\*\*Timeframe:\*\*/,
  /^\*\*Note:\*\*/,
  /^\*\*Reason:\*\*/,
  /^- \*\*(Status|Source|Quote|Confidence|Timeframe):\*\*/,
  /^\d{2}:\d{2} ET:/,
  /^\[.*\] OpenClaw runtime context/,
  /^Pre-compaction memory flush/,
  /^Continue where you left off/,
  /^Stats: runtime/,
  /^Action:/,
  /^\|.*\|.*\|/,
  /^```/,
  /^#+ /,
];

function shouldSkipLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return SKIP_PATTERNS.some(re => re.test(trimmed));
}

// ─── Text utilities ────────────────────────────────────────────────────────

function cleanSignalText(raw) {
  return raw
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '');
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function keywordSet(text) {
  return new Set(normalizeText(text).split(/\s+/).filter(w => w.length > 4));
}

/**
 * Jaccard-like overlap. Returns 0–1.
 */
export function textOverlap(a, b) {
  const setA = keywordSet(a);
  const setB = keywordSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.max(setA.size, setB.size);
}

// ─── Candidate line extraction ─────────────────────────────────────────────

/**
 * Extract candidate lines from raw text content.
 * Handles two formats:
 *   1. Daily memory summaries → full content, filtered
 *   2. Session logs (user: blocks) → only user messages
 *
 * @param {string} content - Raw file content
 * @param {object} [options]
 * @param {boolean} [options.isSessionLog] - Whether this is a session log (user:/assistant: format)
 * @returns {string[]} Candidate text lines
 */
export function extractCandidateLines(content, options = {}) {
  const lines = content.split('\n');
  const candidates = [];

  if (options.isSessionLog) {
    let inUserBlock = false;
    let blockLines = [];

    const flushBlock = () => {
      if (blockLines.length > 0) {
        const text = blockLines.join(' ').trim();
        if (
          !text.startsWith('[') &&
          !text.startsWith('Pre-compaction') &&
          !text.startsWith('Continue where') &&
          !text.startsWith('Conversation info') &&
          text.length > 10
        ) {
          candidates.push(text);
        }
        blockLines = [];
      }
      inUserBlock = false;
    };

    for (const line of lines) {
      if (line.startsWith('user: ')) {
        flushBlock();
        inUserBlock = true;
        blockLines.push(line.slice(6).trim());
      } else if (line.startsWith('assistant: ') || line.startsWith('system: ')) {
        flushBlock();
      } else if (inUserBlock) {
        blockLines.push(line);
      }
    }
    flushBlock();
  } else {
    let inCodeBlock = false;
    for (const line of lines) {
      if (line.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
      if (inCodeBlock) continue;
      if (shouldSkipLine(line)) continue;

      const cleaned = line.replace(/^[-*>]+\s*/, '').replace(/\*\*/g, '').trim();
      if (cleaned.length > 10) candidates.push(cleaned);
    }
  }

  return candidates;
}

// ─── Signal extraction ─────────────────────────────────────────────────────

/**
 * Extract ontology signals from an array of text lines.
 *
 * @param {string[]} lines - Candidate text lines
 * @param {string} [date] - Date string for attribution
 * @returns {Signal[]} Detected signals
 */
export function extractSignalsFromLines(lines, date) {
  const signals = [];
  const seenTexts = new Set();

  for (const line of lines) {
    for (const def of SIGNAL_DEFS) {
      let matched = false;
      for (const pattern of def.patterns) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (!match) continue;

        let raw = line.length <= 400 ? line : match[0];
        const text = cleanSignalText(raw);
        if (text.length < 15) continue;

        const truncated = text.length > 350 ? text.slice(0, 347) + '...' : text;
        const dedupeKey = `${def.type}:${normalizeText(truncated).slice(0, 80)}`;
        if (seenTexts.has(dedupeKey)) continue;
        seenTexts.add(dedupeKey);

        signals.push({
          type: def.type,
          label: def.label,
          section: def.section,
          text: truncated,
          date: date || new Date().toISOString().slice(0, 10),
        });

        matched = true;
        break;
      }
      if (matched) break; // first matching def per line wins
    }
  }

  return signals;
}

/**
 * High-level: extract signals from raw text.
 *
 * @param {string} text - Raw text to scan
 * @param {object} [options]
 * @param {boolean} [options.isSessionLog]
 * @param {string} [options.date]
 * @returns {Signal[]}
 */
export function extractSignals(text, options = {}) {
  const lines = extractCandidateLines(text, options);
  return extractSignalsFromLines(lines, options.date);
}

/**
 * Route extracted signals to ontology files.
 *
 * Checks for duplicates against existing content before appending.
 *
 * @param {Signal[]} signals
 * @param {string} dir - Path to ontology/ directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @param {number} [options.dupThreshold] - Similarity threshold (0-1). Default 0.6.
 * @returns {RoutingResult}
 */
export function routeSignals(signals, dir, options = {}) {
  const threshold = options.dupThreshold ?? 0.6;
  const added = [];
  const skipped = [];

  for (const signal of signals) {
    // Check for duplicates in target section
    const sectionFile = {
      'beliefs': '2-beliefs.md',
      'predictions': '3-predictions.md',
      'goals': '5-goals.md',
      'core-self': '4-core-self.md',
      'projects': '6-projects.md',
    }[signal.section];

    if (!sectionFile) {
      skipped.push({ ...signal, reason: 'unknown-section' });
      continue;
    }

    const filePath = `${dir}/${sectionFile}`;
    let isDuplicate = false;

    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8');
      // Check extracted entry lines
      const entryLines = existing.split('\n').filter(l => /^- \[\d{4}-\d{2}-\d{2}\]/.test(l.trim()));
      for (const line of entryLines) {
        if (textOverlap(signal.text, line) >= threshold) {
          isDuplicate = true;
          break;
        }
      }
      // Also check full section for very high overlap
      if (!isDuplicate && textOverlap(signal.text, existing) >= 0.8) {
        isDuplicate = true;
      }
    }

    if (isDuplicate) {
      skipped.push({ ...signal, reason: 'duplicate' });
      continue;
    }

    const entryText = `Quote from Andrew: "${signal.text}"`;
    const result = appendToSection(dir, signal.section, entryText, {
      date: signal.date,
      dryRun: options.dryRun,
    });

    added.push({ ...signal, entry: result.entry });
  }

  return {
    added,
    skipped,
    dryRun: !!options.dryRun,
    totalSignals: signals.length,
    addedCount: added.length,
    skippedCount: skipped.length,
  };
}
