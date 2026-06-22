'use strict';

const DECISION_PATTERNS = [
  /\b(?:i(?:'ve|'m| have| am)?|we(?:'ve|'re| have| are)?|let(?:'s| us))\s+(?:decided?|go(?:ing)? with|chose?n?|pick(?:ed|ing)?|commit(?:ted|ting)? to)\b/i,
  /\b(?:the )?decision is\b/i,
  /\b(?:we(?:'re| are)? going|i(?:'m| am)? going) (?:to|with)\b/i,
  /\binstead of\b.*\b(?:we(?:'ll| will)|i(?:'ll| will)|let(?:'s| us))\b/i,
  /\bfinal(?:ly|ized)?\s+(?:chose|picked|went with|decided)\b/i,
];

const PREFERENCE_PATTERNS = [
  /\bi (?:prefer|like|want|need|don(?:'t| not) (?:like|want))\b/i,
  /\b(?:always|never|from now on)\b/i,
  /\b(?:my preference is|i(?:'d| would) rather)\b/i,
  /\bdefault(?:s)? (?:to|should be)\b/i,
  /\b(?:please (?:always|never)|stop (?:doing|using)|keep (?:doing|using))\b/i,
];

const IDEA_PATTERNS = [
  /\bwhat if\b/i,
  /\bwhat about\b/i,
  /\bhow about\b/i,
  /\bi(?:'ve| have) been thinking\b/i,
  /\bhere(?:'s| is) (?:a|an|my) (?:thought|idea|concept)\b/i,
  /\bwouldn(?:'t| not) it be (?:cool|great|nice|interesting)\b/i,
  /\bcould we\b/i,
  /\bmaybe we (?:should|could|can)\b/i,
  /\bi wonder if\b/i,
];

const BELIEF_CHANGE_PATTERNS = [
  /\bi(?:(?:'ve| have))? changed my mind\b/i,
  /\bi (?:no longer|don(?:'t| not) (?:think|believe))\b/i,
  /\b(?:actually|on reflection|on second thought)\b.*\b(?:i think|i believe|it seems)\b/i,
  /\bi(?:'m| am) (?:now|starting to) (?:think|believe|realize)\b/i,
  /\b(?:i was wrong|my assumption was)\b/i,
  /\bturns out\b/i,
];

const COMMITMENT_PATTERNS = [
  /\bi(?:'ll| will) (?:do|send|handle|take care|get|make|fix|finish)\b/i,
  /\bpromise(?:d)?\b/i,
  /\bi owe (?:you|them|him|her)\b/i,
  /\b(?:deadline|due|by (?:end of|tomorrow|monday|tuesday|wednesday|thursday|friday))\b/i,
  /\bi(?:'m| am) (?:on it|handling it)\b/i,
];

const FACTUAL_LEARNING_PATTERNS = [
  /\bi (?:just )?(?:learned|found out|discovered|realized)\b/i,
  /\b(?:TIL|FYI|heads up|did you know)\b/i,
  /\bit turns out (?:that)?\b/i,
  /\b(?:apparently|evidently)\b/i,
  /\bthe (?:answer|solution|fix|cause|reason) (?:is|was)\b/i,
];

const LESSON_PATTERNS = [
  /\bnever (?:again|do (?:that|this))\b/i,
  /\blesson learned\b/i,
  /\b(?:mistake|error|bug|failure)\b.*\b(?:was|because|caused by)\b/i,
  /\bnext time\b.*\b(?:should|will|must|need to)\b/i,
  /\b(?:note to self|remember to|don(?:'t| not) forget)\b/i,
  /\b(?:the (?:fix|workaround|solution) is)\b/i,
  /\b(?:root cause|postmortem|retrospective)\b/i,
];

const QUESTION_PATTERNS = [
  /^(?:what|how|why|when|where|who|which|can|could|should|would|is|are|do|does|did|has|have)\b/i,
  /\?$/,
];

const CASUAL_PATTERNS = [
  /^(?:ok|okay|sure|thanks|thx|lol|haha|yeah|yep|nope|no|yes|hi|hey|hello|bye|gm|gn)\b/i,
  /^(?:sounds good|got it|makes sense|fair enough)\b/i,
];

function matchCount(text, patterns) {
  return patterns.filter((pattern) => pattern.test(text)).length;
}

function classifyMessage(text) {
  const normalized = String(text || '').trim();
  if (!normalized || normalized.length < 8) {
    return { salienceClass: 'nothing', confidence: 1.0, signals: ['too_short'] };
  }

  if (matchCount(normalized, CASUAL_PATTERNS) > 0 && normalized.length < 40) {
    return { salienceClass: 'nothing', confidence: 0.9, signals: ['casual'] };
  }

  const scores = {
    decision: matchCount(normalized, DECISION_PATTERNS),
    preference: matchCount(normalized, PREFERENCE_PATTERNS),
    idea: matchCount(normalized, IDEA_PATTERNS),
    belief_change: matchCount(normalized, BELIEF_CHANGE_PATTERNS),
    commitment: matchCount(normalized, COMMITMENT_PATTERNS),
    factual_learning: matchCount(normalized, FACTUAL_LEARNING_PATTERNS),
    lesson: matchCount(normalized, LESSON_PATTERNS),
  };

  const entries = Object.entries(scores).filter(([, score]) => score > 0);
  if (entries.length === 0) {
    if (matchCount(normalized, QUESTION_PATTERNS) > 0) {
      return { salienceClass: 'nothing', confidence: 0.85, signals: ['question_only'] };
    }
    return { salienceClass: 'nothing', confidence: 0.6, signals: ['no_signal_match'] };
  }

  entries.sort((a, b) => b[1] - a[1]);
  const [topClass, topScore] = entries[0];
  const signals = entries.map(([salienceClass, score]) => `${salienceClass}:${score}`);

  let confidence;
  if (topScore >= 3) confidence = 0.95;
  else if (topScore >= 2) confidence = 0.85;
  else if (topScore === 1 && entries.length === 1) confidence = 0.7;
  else confidence = 0.55;

  if (normalized.length > 200 && topScore >= 2) {
    confidence = Math.min(1.0, confidence + 0.05);
  }

  if (matchCount(normalized, QUESTION_PATTERNS) > 0) {
    confidence = Math.max(0.3, confidence - 0.15);
  }

  return { salienceClass: topClass, confidence, signals };
}

function detectSalience(capture = {}) {
  const text = [capture.text, capture.content, capture.body, capture.title]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');

  const classification = classifyMessage(text);

  if (capture.salienceClass) {
    return {
      ...classification,
      salienceClass: capture.salienceClass,
      keywordOverride: false,
    };
  }

  return {
    ...classification,
    keywordOverride: false,
  };
}

module.exports = {
  classifyMessage,
  detectSalience,
  DECISION_PATTERNS,
  PREFERENCE_PATTERNS,
  IDEA_PATTERNS,
  BELIEF_CHANGE_PATTERNS,
  COMMITMENT_PATTERNS,
  FACTUAL_LEARNING_PATTERNS,
  LESSON_PATTERNS,
  QUESTION_PATTERNS,
  CASUAL_PATTERNS,
  matchCount,
};
