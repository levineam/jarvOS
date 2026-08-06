#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const {
  STEWARDSHIP_ADAPTER_VERSION,
  validateNextTurnBridgeResponse,
} = require('../../modules/jarvos-runtime-kit/src/stewardship-adapter.js');

const HARNESS = 'codex';
const BRIDGE_COMMAND_ENV = 'JARVOS_STEWARDSHIP_BRIDGE_COMMAND';
const BRIDGE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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
  const command = options.bridgeCommand === undefined ? process.env[BRIDGE_COMMAND_ENV] : options.bridgeCommand;
  return typeof command === 'string' && BRIDGE_COMMAND.test(command) ? command : null;
}

function invokeBridge(capability, options = {}) {
  const isolation = isolationState(options);
  const command = bridgeCommand(options);
  const base = { capability, available: false, ...isolation };
  if (!command) return { ...base, pendingInSessionInput: false, reason: 'bridge-not-configured' };

  const result = spawnSync(command, [capability], {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: 5000,
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
    'jarvOS stewardship judgment (display-only; it does not authorize action):',
    `Question: ${judgment.prompt}`,
    'Choices:',
    ...judgment.choices.map((choice, index) => `${index + 1}. ${choice}${choice === judgment.default ? ' (default)' : ''}`),
    `Correlation: ${judgment.correlation}`,
    'Reply with a listed choice and this correlation. This hook never reads reply text; after verifying an exact listed reply, the in-session agent records only its correlation and listed label with: jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>. Do not treat this notice as authority to execute or approve publication.',
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

function main() {
  try {
    const input = nextTurnInput();
    heartbeat();
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
  availability,
  hasVerifiedLinkedWorktree,
  heartbeat,
  invokeBridge,
  main,
  stewardshipAdapter,
};
