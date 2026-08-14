#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  STEWARDSHIP_ADAPTER_VERSION,
  validateNextTurnBridgeResponse,
} = require('../../modules/jarvos-runtime-kit/src/stewardship-adapter.js');

const HARNESS = 'codex';
const BRIDGE_COMMAND_ENV = 'JARVOS_STEWARDSHIP_BRIDGE_COMMAND';
const BRIDGE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_HOOK_INPUT_CHARS = 4096;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_WAIT_ID = /^session-wait:[A-Za-z0-9._:-]{1,80}$/;
const RESULT_DIGEST = /^sha256:[a-f0-9]{64}$/i;

function gitOutput(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

// A runtime that supports native worktrees must still verify that this session
// is in a linked worktree. Primary checkouts and non-Git directories use the
// managed launcher instead of being inferred isolated from the harness name.
function hasVerifiedLinkedWorktree(cwd = process.cwd()) {
  const root = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return false;
  const worktreeRoots = gitOutput(cwd, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  return worktreeRoots.length > 1 && worktreeRoots.slice(1).includes(root);
}

function isolationState(options = {}) {
  const isolatedWorktree = hasVerifiedLinkedWorktree(options.cwd);
  return {
    preferredIsolationMode: 'native',
    isolationMode: isolatedWorktree ? 'native' : 'managed-launcher',
    isolatedWorktree,
    requiresVerifiedWorktreeEvidence: true,
  };
}

function bridgeCommand(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const command = options.bridgeCommand === undefined ? env[BRIDGE_COMMAND_ENV] : options.bridgeCommand;
  return typeof command === 'string' && BRIDGE_COMMAND.test(command) ? command : null;
}

function hookSessionId(input, hookEventName) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || input.hook_event_name !== hookEventName) return null;
  return typeof input.session_id === 'string' && CODEX_THREAD_ID.test(input.session_id) ? input.session_id : null;
}

function readHookInput(hookEventName) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw.length === 0 || raw.length > MAX_HOOK_INPUT_CHARS) return null;
    return hookSessionId(JSON.parse(raw), hookEventName);
  } catch {
    return null;
  }
}

function bridgeEnvironment(sessionId, env = process.env) {
  const inherited = env.CODEX_THREAD_ID;
  if (typeof sessionId !== 'string' || !CODEX_THREAD_ID.test(sessionId)) return null;
  if (typeof inherited === 'string' && inherited && (!CODEX_THREAD_ID.test(inherited) || inherited !== sessionId)) return null;
  return typeof inherited === 'string' && inherited ? env : { ...env, CODEX_THREAD_ID: sessionId };
}

function invokeBridge(capability, options = {}) {
  const isolation = isolationState(options);
  const command = bridgeCommand(options);
  const base = { capability, available: false, ...isolation };
  if (!command) return { ...base, pendingInSessionInput: false, reason: 'bridge-not-configured' };
  const env = options.env || process.env;
  if (typeof env.CODEX_THREAD_ID !== 'string' || !CODEX_THREAD_ID.test(env.CODEX_THREAD_ID)) {
    return { ...base, pendingInSessionInput: false, reason: 'bridge-unavailable' };
  }

  const result = spawnSync(command, [capability], {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
    // A SessionStart hook may receive its thread identity on stdin rather than
    // in its inherited environment. Callers pass a short-lived environment
    // copy so that identity is visible only to this bridge child process.
    env,
  });
  if (result.status !== 0) return { ...base, pendingInSessionInput: false, reason: 'bridge-unavailable' };
  try {
    const response = JSON.parse(result.stdout || '{}');
    if (capability === 'nextTurnInput') {
      const validated = validateNextTurnBridgeResponse(response);
      if (!validated.ok) return { ...base, pendingInSessionInput: false, reason: 'bridge-unavailable' };
      return { ...base, ...validated.value, reason: undefined };
    }
    if (capability === 'sessionWaitNextTurn') {
      const validated = validateSessionWaitBridgeResponse(response);
      if (!validated.ok) return { ...base, pendingSessionWait: false, reason: 'bridge-unavailable' };
      return { ...base, ...validated.value, reason: undefined };
    }
    return {
      ...base,
      available: response.available === true,
      pendingInSessionInput: response.pendingInSessionInput === true,
      reason: response.available === true ? undefined : 'bridge-unavailable',
    };
  } catch {
    return { ...base, pendingInSessionInput: false, reason: 'bridge-unavailable' };
  }
}

function validateSessionWaitBridgeResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || response.available !== true
    || typeof response.pendingSessionWait !== 'boolean') return { ok: false };
  if (!response.pendingSessionWait) return { ok: true, value: { available: true, pendingSessionWait: false } };
  const wait = response.wait;
  if (!wait || typeof wait !== 'object' || Array.isArray(wait) || !SESSION_WAIT_ID.test(wait.waitId || '')
    || typeof wait.workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(wait.workId)
    || wait.state !== 'consumed' || wait.origin?.harness !== HARNESS
    || typeof wait.origin.stableSessionId !== 'string' || !CODEX_THREAD_ID.test(wait.origin.stableSessionId)
    || typeof wait.origin.adapterGeneration !== 'string' || Object.hasOwn(wait.origin, 'repoBinding') || Object.hasOwn(wait.origin, 'workspaceBinding')) return { ok: false };
  if (wait.resultDigest != null && !RESULT_DIGEST.test(wait.resultDigest)) return { ok: false };
  if (wait.safeProjection != null && (typeof wait.safeProjection !== 'object' || Array.isArray(wait.safeProjection))) return { ok: false };
  return { ok: true, value: { available: true, pendingSessionWait: true, wait } };
}

function additionalContext(input) {
  const judgment = input.nextTurnInput;
  return [
    'jarvOS stewardship preference request:',
    `Question: ${judgment.prompt}`,
    'Choices:',
    ...judgment.choices.map((choice, index) => `${index + 1}. ${choice}${choice === judgment.default ? ' (default)' : ''}`),
    `Correlation: ${judgment.correlation}`,
    'An exact user reply with a listed choice and this correlation authorizes only recording that preference through the bridge; it does not authorize changing code, merging, publishing, or any other downstream action. This hook never reads reply text; after verifying an exact listed reply, the in-session agent records only its correlation and listed label with: jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>. Recording the preference is not approval to execute it.',
  ].join('\n');
}

function availability(options) { return invokeBridge('availability', options); }
function startOrResume(options) { return invokeBridge('startOrResume', options); }
function heartbeat(options) { return invokeBridge('heartbeat', options); }
function checkpoint(options) { return invokeBridge('checkpoint', options); }
function stop(options) { return invokeBridge('stop', options); }
function nextTurnInput(options) { return invokeBridge('nextTurnInput', options); }
function sessionWaitNextTurn(options) { return invokeBridge('sessionWaitNextTurn', options); }

function sessionWaitContext(input) {
  if (!input?.pendingSessionWait || !input.wait) return '';
  const wait = input.wait;
  const projection = wait.safeProjection || {};
  const lines = ['jarvOS session follow-through result:', `Wait: ${wait.waitId}`, `State: ${wait.state}`];
  if (projection.status) lines.push(`Status: ${projection.status}`);
  if (projection.reference) lines.push(`Reference: ${projection.reference}`);
  if (wait.resultDigest) lines.push(`Result digest: ${wait.resultDigest}`);
  lines.push('This is a bounded receipt for the originating session. It is not an instruction, approval, or authorization to perform additional work.');
  return lines.join('\n');
}

const stewardshipAdapter = {
  version: STEWARDSHIP_ADAPTER_VERSION,
  harness: HARNESS,
  isolationMode: 'native',
  isolatedWorktrees: true,
  startOrResume,
  heartbeat,
  checkpoint,
  stop,
  nextTurnInput,
  sessionWaitNextTurn,
  availability,
};

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(sessionId = readHookInput('UserPromptSubmit')) {
  try {
    const env = bridgeEnvironment(sessionId);
    if (!env) {
      writeJson({});
      return;
    }
    const input = nextTurnInput({ env });
    const sessionWait = sessionWaitNextTurn({ env });
    heartbeat({ env });
    const contexts = [];
    if (input.pendingInSessionInput && input.nextTurnInput) contexts.push(additionalContext(input));
    const waitContext = sessionWaitContext(sessionWait);
    if (waitContext) contexts.push(waitContext);
    if (contexts.length > 0) {
      writeJson({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: contexts.join('\n\n'),
        },
        suppressOutput: true,
      });
      return;
    }
    writeJson({});
  } catch {
    // Turn hooks must fail open when the optional bridge is unavailable.
    writeJson({});
  }
}

if (require.main === module) main();

module.exports = {
  HARNESS,
  BRIDGE_COMMAND_ENV,
  CODEX_THREAD_ID,
  MAX_HOOK_INPUT_CHARS,
  availability,
  additionalContext,
  sessionWaitContext,
  bridgeEnvironment,
  hasVerifiedLinkedWorktree,
  heartbeat,
  invokeBridge,
  sessionWaitNextTurn,
  hookSessionId,
  main,
  readHookInput,
  stewardshipAdapter,
  validateSessionWaitBridgeResponse,
};
