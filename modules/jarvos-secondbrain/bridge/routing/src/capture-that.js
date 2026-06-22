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
  extractTitle,
  findBestCapture,
  classifyMessage,
  isCaptureCommand,
  messageContent,
  scoreCapturability,
} = require('../../../packages/jarvos-ambient/src/intent');

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

  const content = messageContent(best.message);
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

  const content = messageContent(best.message);
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
  messageContent,
  scoreCapturability,
};

if (require.main === module) {
  main();
}
