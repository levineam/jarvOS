'use strict';

// Pure helpers for the optional durable-work collection seam. A native
// lifecycle hook (Claude PostToolUse/Stop, or the Codex UserPromptSubmit turn
// boundary) asks the host bridge to collect durable work events for its own
// session. This module performs no I/O and holds no state:
//
// - extractCandidateRoots() inspects the harness hook input in memory only to
//   find explicit absolute repository roots (the hook cwd, and `cd <abs>` or
//   `git -C <abs>` targets in a Bash command). The command text is never
//   returned, logged, or persisted; only bounded absolute paths are, and those
//   are handed to the private bridge child through its transient environment.
// - validateCollectResponse() admits only the metadata-only bridge receipt
//   before a hook ever acts on it. Hooks never inject it into model context.

const path = require('node:path');

const DURABLE_WORK_COLLECT_CONTRACT = 'jarvos.durable-work-collect/v1';
const DURABLE_WORK_COLLECT_CAPABILITY = 'durableWorkCollect';
const SESSION_EVENT_ACTION = 'session-event';
const COLLECT_STATUSES = Object.freeze(['collected', 'none', 'skipped', 'unavailable']);
const COLLECT_TRIGGERS = Object.freeze(['post_tool_use', 'stop', 'turn_boundary']);
const COLLECT_FIELDS = Object.freeze([
  'contract', 'status', 'trigger', 'invocationRef', 'causalKeys', 'admitted', 'deduped', 'unattributed', 'rejected', 'receiptDigest',
]);
const COLLECT_TIMEOUT_MS = 2000;
const CANDIDATE_ROOTS_ENV = 'JARVOS_DURABLE_WORK_CANDIDATE_ROOTS';
const COLLECT_TRIGGER_ENV = 'JARVOS_DURABLE_WORK_TRIGGER';
const COLLECT_ENABLED_ENV = 'JARVOS_DURABLE_WORK_COLLECT';
const MAX_CANDIDATE_ROOTS = 4;
const MAX_ROOT_LENGTH = 1024;
const MAX_CAUSAL_KEYS = 16;
const MAX_COUNT = 1000;
const MAX_COMMAND_SCAN_CHARS = 16_384;

const CAUSAL_KEY = /^dwe_[a-f0-9]{32}$/;
const INVOCATION_REF = /^inv_[a-f0-9]{32}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
// Only commands that can plausibly change durable Git state or record a
// signed truth marker trigger collection after a tool call.
const COLLECT_COMMAND = /(?:^|[\s;&|(])(?:git|gh|jarvos-durable-work-mark)(?=\s|$)/;

function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeAbsoluteRoot(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ROOT_LENGTH || !path.isAbsolute(value)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f\x7f]/.test(value)) return null;
  if (value.split(/[\\/]+/).includes('..')) return null;
  return path.resolve(value);
}

function unquote(token) {
  if (token.length >= 2 && ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))) return token.slice(1, -1);
  return token;
}

// Command-derived roots: explicit absolute `cd <dir>` and `git -C <dir>`
// targets only. Relative, home-relative, variable, and substituted targets
// are ignored rather than guessed.
function commandRoots(command) {
  if (typeof command !== 'string' || !command) return [];
  const text = command.slice(0, MAX_COMMAND_SCAN_CHARS);
  const roots = [];
  const patterns = [
    /(?:^|[\s;&|(])cd\s+("[^"\n]*"|'[^'\n]*'|[^\s;&|)]+)/g,
    /(?:^|[\s;&|(])git\s+-C\s+("[^"\n]*"|'[^'\n]*'|[^\s;&|)]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const target = unquote(match[1]);
      if (/[$`*?]/.test(target)) continue;
      const root = safeAbsoluteRoot(target);
      if (root) roots.push(root);
    }
  }
  return roots;
}

function hookCommand(input) {
  const toolInput = isPlainObject(input?.tool_input) ? input.tool_input : null;
  return toolInput && typeof toolInput.command === 'string' ? toolInput.command : null;
}

// Returns bounded, deduplicated absolute candidate roots in precedence order:
// command-explicit roots first (a Bash-internal `cd` into a repository that
// the hook cwd never sees), then the harness-reported hook cwd.
function extractCandidateRoots(input, { cwd } = {}) {
  const roots = [];
  if (isPlainObject(input)) roots.push(...commandRoots(hookCommand(input)));
  const hookCwd = safeAbsoluteRoot(isPlainObject(input) ? input.cwd : null);
  if (hookCwd) roots.push(hookCwd);
  const fallback = safeAbsoluteRoot(cwd);
  if (fallback) roots.push(fallback);
  return [...new Set(roots)].slice(0, MAX_CANDIDATE_ROOTS);
}

// Decides whether a lifecycle event warrants a (bounded) collection call.
// Stop and turn boundaries always collect; a PostToolUse collects only after a
// Bash command that could have changed durable Git state or recorded a marker.
function collectTrigger(input) {
  if (!isPlainObject(input)) return null;
  const event = input.hook_event_name;
  if (event === 'Stop' || event === 'SubagentStop') return 'stop';
  if (event === 'UserPromptSubmit') return 'turn_boundary';
  if (event !== 'PostToolUse' || input.tool_name !== 'Bash') return null;
  const command = hookCommand(input);
  return command && COLLECT_COMMAND.test(command.slice(0, MAX_COMMAND_SCAN_CHARS)) ? 'post_tool_use' : null;
}

function encodeCandidateRoots(roots) {
  const safe = Array.isArray(roots) ? roots.map(safeAbsoluteRoot).filter(Boolean).slice(0, MAX_CANDIDATE_ROOTS) : [];
  return JSON.stringify(safe);
}

function decodeCandidateRoots(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_CANDIDATE_ROOTS * (MAX_ROOT_LENGTH + 4) + 2) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.map(safeAbsoluteRoot).filter(Boolean))].slice(0, MAX_CANDIDATE_ROOTS) : [];
  } catch (_) {
    return [];
  }
}

function count(value, field, errors) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COUNT) errors.push(`${field} must be a bounded non-negative integer`);
}

function validateCollectResponse(response) {
  const errors = [];
  if (!isPlainObject(response) || !hasExactKeys(response, COLLECT_FIELDS)) {
    return { ok: false, errors: [`collect response must contain only: ${COLLECT_FIELDS.join(', ')}`] };
  }
  if (response.contract !== DURABLE_WORK_COLLECT_CONTRACT) errors.push(`contract must be ${DURABLE_WORK_COLLECT_CONTRACT}`);
  if (!COLLECT_STATUSES.includes(response.status)) errors.push(`status must be one of: ${COLLECT_STATUSES.join(', ')}`);
  if (response.trigger !== null && !COLLECT_TRIGGERS.includes(response.trigger)) errors.push('trigger is unsupported');
  if (response.invocationRef !== null && (typeof response.invocationRef !== 'string' || !INVOCATION_REF.test(response.invocationRef))) {
    errors.push('invocationRef must be null or an invocation reference');
  }
  if (!Array.isArray(response.causalKeys) || response.causalKeys.length > MAX_CAUSAL_KEYS
    || response.causalKeys.some((key) => typeof key !== 'string' || !CAUSAL_KEY.test(key))
    || new Set(response.causalKeys).size !== response.causalKeys.length) {
    errors.push('causalKeys must be a bounded list of unique causal keys');
  }
  for (const field of ['admitted', 'deduped', 'unattributed', 'rejected']) count(response[field], field, errors);
  if (response.receiptDigest !== null && (typeof response.receiptDigest !== 'string' || !SHA256_HEX.test(response.receiptDigest))) {
    errors.push('receiptDigest must be null or a sha256 digest');
  }
  if (response.status === 'collected' && (response.invocationRef === null || response.receiptDigest === null)) {
    errors.push('collected responses require invocationRef and receiptDigest');
  }
  if (response.status === 'unavailable' && Array.isArray(response.causalKeys) && response.causalKeys.length) {
    errors.push('unavailable responses cannot carry causal keys');
  }
  return { ok: errors.length === 0, errors };
}

function unavailableCollectResponse(trigger = null) {
  return {
    contract: DURABLE_WORK_COLLECT_CONTRACT,
    status: 'unavailable',
    trigger: COLLECT_TRIGGERS.includes(trigger) ? trigger : null,
    invocationRef: null,
    causalKeys: [],
    admitted: 0,
    deduped: 0,
    unattributed: 0,
    rejected: 0,
    receiptDigest: null,
  };
}

module.exports = {
  CANDIDATE_ROOTS_ENV,
  COLLECT_ENABLED_ENV,
  COLLECT_FIELDS,
  COLLECT_STATUSES,
  COLLECT_TIMEOUT_MS,
  COLLECT_TRIGGER_ENV,
  COLLECT_TRIGGERS,
  DURABLE_WORK_COLLECT_CAPABILITY,
  DURABLE_WORK_COLLECT_CONTRACT,
  MAX_CANDIDATE_ROOTS,
  SESSION_EVENT_ACTION,
  collectTrigger,
  decodeCandidateRoots,
  encodeCandidateRoots,
  extractCandidateRoots,
  unavailableCollectResponse,
  validateCollectResponse,
};
