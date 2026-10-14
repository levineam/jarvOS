#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  STEWARDSHIP_ADAPTER_VERSION,
  validateNextTurnBridgeResponse,
} = require('../../modules/jarvos-runtime-kit/src/stewardship-adapter.js');

const HARNESS = 'codex';
const BRIDGE_COMMAND_ENV = 'JARVOS_STEWARDSHIP_BRIDGE_COMMAND';
const MAX_HOOK_INPUT_CHARS = 4096;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRUSTED_GIT = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'git.exe')
  : '/usr/bin/git';

function gitOutput(cwd, args) {
  const result = spawnSync(TRUSTED_GIT, ['-C', cwd, ...args], { encoding: 'utf8' });
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

function unverifiedIsolationState() {
  return {
    preferredIsolationMode: 'native',
    isolationMode: 'managed-launcher',
    isolatedWorktree: false,
    requiresVerifiedWorktreeEvidence: true,
  };
}

function bridgeCommand(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const command = options.bridgeCommand === undefined ? env[BRIDGE_COMMAND_ENV] : options.bridgeCommand;
  return typeof command === 'string' && path.isAbsolute(command) ? command : null;
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
  const command = bridgeCommand(options);
  if (!command) return { capability, available: false, ...unverifiedIsolationState(), pendingInSessionInput: false, reason: 'bridge-not-configured' };
  const base = { capability, available: false, ...isolationState(options) };
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
    heartbeat({ env });
    if (input.pendingInSessionInput && input.nextTurnInput) {
      writeJson({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: additionalContext(input),
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
  bridgeEnvironment,
  hasVerifiedLinkedWorktree,
  heartbeat,
  invokeBridge,
  hookSessionId,
  main,
  readHookInput,
  stewardshipAdapter,
};
