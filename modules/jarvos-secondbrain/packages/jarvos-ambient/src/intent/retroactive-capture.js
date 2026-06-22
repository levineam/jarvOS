'use strict';

const { classifyMessage } = require('./salience-detector');

const MIN_CONTENT_LENGTH = 20;
const MAX_LOOKBACK = 10;
const CAPTURE_COMMAND_PATTERNS = [
  /^\s*capture\s+that\b/i,
  /^\s*save\s+that\b/i,
  /^\s*write\s+that\s+down\b/i,
  /^\s*remember\s+this\b/i,
  /^\s*note\s+that\b/i,
];

function isCaptureCommand(text) {
  const trimmed = String(text || '').trim();
  return CAPTURE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function messageContent(message = {}) {
  return String(message.content ?? message.text ?? message.body ?? '').trim();
}

function scoreCapturability(message = {}) {
  const text = messageContent(message);
  if (!text || text.length < MIN_CONTENT_LENGTH) return 0;
  if (isCaptureCommand(text)) return 0;

  let score = 0;

  if (text.length >= 200) score += 3;
  else if (text.length >= 100) score += 2;
  else if (text.length >= 40) score += 1;

  if (message.role === 'assistant') {
    if (text.includes('\n')) score += 1;
    if (/^#+\s/m.test(text)) score += 1;
    if (/^[-*]\s/m.test(text)) score += 1;
    if (/```/.test(text)) score += 1;
  }

  if (message.role === 'user') {
    const classification = classifyMessage(text);
    if (classification.salienceClass !== 'nothing') {
      score += 2;
      if (classification.confidence >= 0.8) score += 1;
    }
  }

  return score;
}

function findBestCapture(recentMessages = []) {
  const messages = recentMessages.slice(-MAX_LOOKBACK);

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const score = scoreCapturability(messages[i]);
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

function extractTitle(content, maxLength = 80) {
  const lines = String(content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const heading = lines.find((line) => /^#+\s/.test(line));
  if (heading) {
    return heading.replace(/^#+\s+/, '').slice(0, maxLength);
  }

  const firstLine = lines[0] || '';
  return firstLine.slice(0, maxLength).replace(/[.。!?]+$/, '') || 'Captured content';
}

module.exports = {
  CAPTURE_COMMAND_PATTERNS,
  MAX_LOOKBACK,
  MIN_CONTENT_LENGTH,
  extractTitle,
  findBestCapture,
  isCaptureCommand,
  messageContent,
  scoreCapturability,
};
