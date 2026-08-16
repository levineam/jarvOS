'use strict';

/**
 * Bounded outbound-message lint for operator-facing text and fixtures.
 * Guidance lives in the operator-communication skill; this module is the
 * deterministic enforcement surface for codes, paths, stacks, ambiguous
 * actions, and release-state authoring mistakes.
 */

const SNAKE_CODE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g;
const ABSOLUTE_PATH = /(?:^|[\s"'`(])(\/(?:Users|home|var|tmp|private|opt|etc|root)\/\S+|\/Users\/\S+|~\/\S+|file:\/\/\S+)/g;
const WINDOWS_PATH = /(?:^|[\s"'`(])([A-Za-z]:\\(?:[^\s"'`)]+))/g;
const STACK_LIKE = /(?:^\s*at\s+\S+\s+\([^)]+\)\s*$)|(?:Error:\s.+\n\s+at\s+)/m;
const STACK_FRAME = /^\s*at\s+\S+/m;
const BARE_SHA = /\b[0-9a-f]{7,40}\b/i;
const RECEIPTISH = /\b(?:receipt|run|event)[_-]?id\b\s*[:=]\s*\S+/i;
const AMBIGUOUS_ATTENTION = /\bneeds\s+(?:attention|input|review)\b/i;
const ACTION_CUE = /\b(?:please|reply|confirm|approve|choose|decide|open|run|send|review|provide|set|enable|disable|restart|merge|sign\s*off)\b/i;
const NO_ACTION_CUE = /\b(?:no action(?:\s+needed|\s+required)?|nothing for you to do|no user action|automatically(?:\s+held|\s+retrying)?|will retry|staying quiet)\b/i;
const RELEASE_FAILURE_FUTURE = /\b(?:future|v?\d+\.\d+\.\d+)\b[^.!?\n]{0,80}\b(?:publication failure|failed to publish|publish(?:ed)? failed)\b/i;

const ALLOWED_SNAKE = new Set([
  'no_reply',
  // common English compounds that are not event codes
  'plain_english',
]);

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function findSnakeCodes(text) {
  const hits = [];
  for (const match of String(text).matchAll(SNAKE_CODE)) {
    const token = match[0];
    if (ALLOWED_SNAKE.has(token)) continue;
    // Allow semantic versions adjacent patterns already excluded by regex.
    // Allow template placeholders like what_happened only if explicitly listed? reject.
    hits.push(token);
  }
  return unique(hits);
}

function findPaths(text) {
  const hits = [];
  for (const match of String(text).matchAll(ABSOLUTE_PATH)) hits.push(match[1] || match[0].trim());
  for (const match of String(text).matchAll(WINDOWS_PATH)) hits.push(match[1] || match[0].trim());
  return unique(hits.map((value) => value.trim()));
}

function hasStack(text) {
  const value = String(text);
  return STACK_LIKE.test(value) || STACK_FRAME.test(value);
}

function hasBareSha(text) {
  const value = String(text);
  if (!BARE_SHA.test(value)) return false;
  // Allow SHA when freshness/context words appear nearby in the same sentence.
  const sentences = value.split(/(?<=[.!?])\s+/);
  return sentences.some((sentence) => {
    if (!BARE_SHA.test(sentence)) return false;
    const explains = /\b(?:establishes|observed|as of|freshness|current checkout|source commit)\b/i.test(sentence);
    return !explains;
  });
}

function ambiguousAction(text) {
  const value = String(text);
  if (!AMBIGUOUS_ATTENTION.test(value)) return false;
  if (ACTION_CUE.test(value) && /\b(?:andrew|owner|you)\b/i.test(value)) return false;
  if (NO_ACTION_CUE.test(value)) return false;
  // concrete action patterns: "Reply with X", "Approve the 0.8.0 release"
  if (/\b(?:reply with|approve the|choose whether|decide if|open the|provide the)\b/i.test(value)) return false;
  return true;
}

function releaseAuthoringIssues(text, options = {}) {
  const value = String(text);
  const issues = [];
  const releaseMode = options.mode === 'release' || options.release === true
    || /\b(?:published|release candidate|future (?:lane|milestone)|v\d+\.\d+\.\d+)\b/i.test(value);
  if (!releaseMode) return issues;

  if (RELEASE_FAILURE_FUTURE.test(value)) {
    issues.push('future_lane_marked_publication_failure');
  }

  const staleCue = /\b(?:stale|unknown observation|observation missing|not observed|last seen days ago)\b/i.test(value);
  const currentOrReady = /\b(?:currently published|ready for(?: Andrew'?s)? review|ready to publish)\b/i.test(value);
  if (staleCue && currentOrReady) {
    issues.push('current_or_ready_from_stale_observation');
  }

  if (/\bmain@[0-9a-f]{7,}\b/i.test(value) && !/\b(?:establishes|observed|as of)\b/i.test(value)) {
    issues.push('bare_commit_in_release_text');
  }

  if (/\b(?:is published and ready|published candidate|candidate is published|future .* is currently published)\b/i.test(value)) {
    issues.push('conflated_release_states');
  }

  return issues;
}

function lintOperatorMessage(text, options = {}) {
  if (typeof text !== 'string') {
    return { ok: false, errors: ['message must be a string'], findings: {} };
  }
  const findings = {
    snakeCaseCodes: findSnakeCodes(text),
    absolutePaths: findPaths(text),
    stackLike: hasStack(text),
    bareCommit: options.allowBareSha ? false : hasBareSha(text),
    receiptLeak: RECEIPTISH.test(text),
    ambiguousAction: ambiguousAction(text),
    releaseIssues: releaseAuthoringIssues(text, options),
    missingActionGuidance: false,
  };

  // Action guidance: if message is non-empty and not explicitly quiet, require action or no-action.
  const trimmed = text.trim();
  if (trimmed && !NO_ACTION_CUE.test(trimmed) && !ACTION_CUE.test(trimmed) && !/\b(?:no action|nothing to do)\b/i.test(trimmed)) {
    // Allow pure informational four-question blocks that include "Your action:" slot.
    if (!/\b(?:your action|action required|must act|no user action)\b/i.test(trimmed)) {
      // Only flag when attention-ish or failure-ish language is present.
      if (/\b(?:failed|blocked|error|warning|degraded|attention|input|broken)\b/i.test(trimmed)) {
        findings.missingActionGuidance = true;
      }
    }
  }

  const errors = [];
  for (const code of findings.snakeCaseCodes) errors.push(`raw_internal_code:${code}`);
  for (const p of findings.absolutePaths) errors.push(`absolute_path:${p}`);
  if (findings.stackLike) errors.push('stack_like_text');
  if (findings.bareCommit) errors.push('bare_commit');
  if (findings.receiptLeak) errors.push('receipt_or_run_id_leak');
  if (findings.ambiguousAction) errors.push('ambiguous_action');
  if (findings.missingActionGuidance) errors.push('missing_action_guidance');
  for (const issue of findings.releaseIssues) errors.push(issue);

  return { ok: errors.length === 0, errors, findings };
}

function lintOperatorMessages(messages, options = {}) {
  const results = (messages || []).map((entry, index) => {
    if (typeof entry === 'string') return { index, ...lintOperatorMessage(entry, options) };
    const text = entry?.text ?? entry?.body ?? entry?.message ?? '';
    const localOptions = { ...options, ...(entry?.options || {}), mode: entry?.mode || options.mode };
    return { index, id: entry?.id || null, ...lintOperatorMessage(text, localOptions) };
  });
  return {
    ok: results.every((result) => result.ok),
    results,
    errors: results.flatMap((result) => (result.errors || []).map((error) => `messages[${result.index}]:${error}`)),
  };
}

module.exports = {
  lintOperatorMessage,
  lintOperatorMessages,
  findSnakeCodes,
  findPaths,
};
