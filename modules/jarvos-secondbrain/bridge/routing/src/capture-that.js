#!/usr/bin/env node
/**
 * "capture that" / "save that" — retroactive capture command.
 *
 * When the user says "capture that", this module identifies the most recent
 * substantive content in the conversation and routes it through the full
 * three-package router (journal + notes + memory as applicable).
 *
 * Input:
 * {
 *   "command": "capture that" | "save that",
 *   "recentMessages": [
 *     { "role": "user", "content": "..." },
 *     { "role": "assistant", "content": "..." },
 *     ...
 *   ],
 *   "date": "YYYY-MM-DD",
 *   "hint": "Optional hint about what to capture"
 * }
 *
 * The module scans recentMessages backwards to find the most recent
 * substantive content, then runs it through the three-package router.
 *
 * SUP-370
 */

'use strict';

const {
  applyThreePackagePlan,
  buildThreePackagePlan,
  previewRouting,
} = require('./three-package-router');

const {
  classifyMessage,
} = require('./salience-detector');

// Minimum content length to consider substantive
const MIN_CONTENT_LENGTH = 20;

// Maximum messages to look back
const MAX_LOOKBACK = 10;

// Patterns that indicate the message IS the capture command, not content
const CAPTURE_COMMAND_PATTERNS = [
  /^\s*capture\s+that\b/i,
  /^\s*save\s+that\b/i,
  /^\s*write\s+that\s+down\b/i,
  /^\s*remember\s+this\b/i,
  /^\s*note\s+that\b/i,
];

/**
 * Check if a message is the capture command itself (not capturable content).
 */
function isCaptureCommand(text) {
  const trimmed = String(text || '').trim();
  return CAPTURE_COMMAND_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Score a message's "capturability" — how likely it contains substantive content.
 */
function scoreCapturability(message) {
  const text = String(message.content || '').trim();
  if (!text || text.length < MIN_CONTENT_LENGTH) return 0;
  if (isCaptureCommand(text)) return 0;

  let score = 0;

  // Longer messages are more likely to be substantive
  if (text.length >= 200) score += 3;
  else if (text.length >= 100) score += 2;
  else if (text.length >= 40) score += 1;

  // Assistant messages with structure are good candidates
  if (message.role === 'assistant') {
    if (text.includes('\n')) score += 1;
    if (/^#+\s/m.test(text)) score += 1; // has headings
    if (/^[-*]\s/m.test(text)) score += 1; // has lists
    if (/```/.test(text)) score += 1; // has code blocks
  }

  // User messages with decisions, ideas, or explicit content
  if (message.role === 'user') {
    const classification = classifyMessage(text);
    if (classification.salienceClass !== 'nothing') {
      score += 2;
      if (classification.confidence >= 0.8) score += 1;
    }
  }

  return score;
}

/**
 * Find the best content to capture from recent messages.
 *
 * Strategy: scan backwards, score each message, pick the highest-scoring
 * non-command message. Prefer the message immediately before the capture
 * command if it's substantive.
 */
function findBestCapture(recentMessages = []) {
  const messages = recentMessages.slice(-MAX_LOOKBACK);

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const score = scoreCapturability(msg);

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) {
    return null;
  }

  return {
    message: messages[bestIdx],
    index: bestIdx,
    score: bestScore,
  };
}

/**
 * Extract a title from the captured content.
 */
function extractTitle(content, maxLength = 80) {
  const lines = String(content || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // If first line looks like a heading, use it
  const heading = lines.find((l) => /^#+\s/.test(l));
  if (heading) {
    return heading.replace(/^#+\s+/, '').slice(0, maxLength);
  }

  // Use the first substantive line
  const firstLine = lines[0] || '';
  return firstLine.slice(0, maxLength).replace(/[.。!?]+$/, '') || 'Captured content';
}

/**
 * Execute "capture that" — find the best recent content and route it.
 *
 * @param {object} input - { command, recentMessages, date, hint }
 * @param {object} [options] - Passed through to applyThreePackagePlan
 * @returns {{ captured: boolean, title: string, content: string, routing: object, error: string|null }}
 */
function captureThat(input = {}, options = {}) {
  const recentMessages = input.recentMessages || [];
  const date = input.date || undefined;
  const hint = input.hint || '';

  if (recentMessages.length === 0) {
    return {
      captured: false,
      title: '',
      content: '',
      routing: null,
      error: 'No recent messages to capture from',
    };
  }

  const best = findBestCapture(recentMessages);
  if (!best) {
    return {
      captured: false,
      title: '',
      content: '',
      routing: null,
      error: 'No substantive content found in recent messages',
    };
  }

  const content = String(best.message.content || '').trim();
  const title = hint || extractTitle(content);

  // Classify the content to determine memory routing
  const classification = classifyMessage(content);

  // Build the capture event for the three-package router
  const captureEvent = {
    trigger: 'note', // "capture that" always creates a note
    title,
    text: content,
    date,
    salienceClass: classification.salienceClass !== 'nothing' ? classification.salienceClass : undefined,
    confidence: classification.confidence,
    substantive: true,
  };

  const routing = applyThreePackagePlan(captureEvent, options);

  return {
    captured: true,
    title,
    content: content.slice(0, 500), // truncate for the response
    sourceRole: best.message.role,
    salienceClass: classification.salienceClass,
    confidence: classification.confidence,
    routing,
    error: null,
  };
}

/**
 * Preview what "capture that" would do without writing anything.
 */
function previewCaptureThat(input = {}) {
  const recentMessages = input.recentMessages || [];
  const hint = input.hint || '';

  if (recentMessages.length === 0) {
    return { found: false, error: 'No recent messages' };
  }

  const best = findBestCapture(recentMessages);
  if (!best) {
    return { found: false, error: 'No substantive content found' };
  }

  const content = String(best.message.content || '').trim();
  const title = hint || extractTitle(content);
  const classification = classifyMessage(content);

  const preview = previewRouting({
    trigger: 'note',
    title,
    text: content,
    date: input.date,
    salienceClass: classification.salienceClass !== 'nothing' ? classification.salienceClass : undefined,
    confidence: classification.confidence,
    substantive: true,
  });

  return {
    found: true,
    title,
    contentPreview: content.slice(0, 200),
    sourceRole: best.message.role,
    classification,
    routing: preview,
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

    const mode = process.argv.includes('--preview') ? 'preview' : 'capture';

    try {
      if (mode === 'preview') {
        console.log(JSON.stringify(previewCaptureThat(parsed), null, 2));
      } else {
        const result = captureThat(parsed);
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });
}

module.exports = {
  captureThat,
  previewCaptureThat,
  findBestCapture,
  extractTitle,
  isCaptureCommand,
  scoreCapturability,
};

if (require.main === module) {
  main();
}
