#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  STEWARDSHIP_ADAPTER_VERSION,
  validateNextTurnBridgeResponse,
} = require('../../modules/jarvos-runtime-kit/src/stewardship-adapter.js');
const {
  envelopeHasContent: projectsContextRefreshHasContent,
  validateEnvelope: validateProjectsContextRefreshEnvelope,
} = require('../../modules/jarvos-runtime-kit/src/projects-context-refresh.js');

const HARNESS = 'claude-code';
const BRIDGE_COMMAND_ENV = 'JARVOS_STEWARDSHIP_BRIDGE_COMMAND';
const CLAUDE_SESSION_ID_ENV = 'JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID';
const BRIDGE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_BRIDGE_TIMEOUT_MS = 5000;
// projectsContextStart/Refresh are hard, single-shot deadlines: a hung or
// slow bridge must never block session start or a user turn. There is no
// retry and no background timer -- a timeout simply fails open.
const BRIDGE_CAPABILITY_TIMEOUT_MS = Object.freeze({
  projectsContextStart: 2000,
  projectsContextRefresh: 250,
});

function gitOutput(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

// Native worktree support is a capability, not proof that the current session
// is isolated. A primary checkout (or a non-Git directory) stays on the
// managed-launcher path until a linked-worktree root is observed.
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

function suppliedInputValue(input, key) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, key)) return { supplied: false };
  return { supplied: true, value: input[key] };
}

function transcriptSessionId(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !value.endsWith('.jsonl')) return null;
  const match = path.basename(value).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : null;
}

// Claude supplies the session UUID under different field spellings across its
// hook paths.  A transcript basename is a narrowly-scoped fallback, never a
// general path-derived identity.  Conflicting inputs fail closed.
function hookSessionId(input) {
  const sessionId = suppliedInputValue(input, 'session_id');
  const camelSessionId = suppliedInputValue(input, 'sessionId');
  const transcriptPath = suppliedInputValue(input, 'transcript_path');
  const identities = [];

  for (const candidate of [sessionId, camelSessionId]) {
    if (!candidate.supplied) continue;
    if (typeof candidate.value !== 'string' || !CLAUDE_SESSION_ID.test(candidate.value)) return null;
    identities.push(candidate.value);
  }
  if (transcriptPath.supplied) {
    const transcriptId = transcriptSessionId(transcriptPath.value);
    if (!transcriptId) return null;
    identities.push(transcriptId);
  }
  if (identities.length === 0 || identities.some((identity) => identity !== identities[0])) return null;
  return identities[0];
}

function bridgeEnvironment(options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  const sessionId = options.sessionId === undefined ? hookSessionId(options.hookInput) : options.sessionId;
  if (typeof sessionId === 'string' && CLAUDE_SESSION_ID.test(sessionId)) env[CLAUDE_SESSION_ID_ENV] = sessionId;
  return env;
}

function invokeBridge(capability, options = {}) {
  const isolation = isolationState(options);
  const command = bridgeCommand(options);
  const base = { capability, available: false, ...isolation };
  if (!command) return { ...base, pendingInSessionInput: false, reason: 'bridge-not-configured' };
  const env = bridgeEnvironment(options);
  const sessionId = options.sessionId === undefined ? env[CLAUDE_SESSION_ID_ENV] : options.sessionId;
  if (typeof sessionId !== 'string' || !CLAUDE_SESSION_ID.test(sessionId)) {
    return { ...base, pendingInSessionInput: false, reason: 'bridge-unavailable' };
  }

  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const result = spawnSyncImpl(command, [capability], {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: BRIDGE_CAPABILITY_TIMEOUT_MS[capability] || DEFAULT_BRIDGE_TIMEOUT_MS,
    env,
  });
  if (capability === 'projectsContextStart' || capability === 'projectsContextRefresh') {
    // Invalid, timed out, nonzero, or unavailable all fail open the same way:
    // no stale or unproven Projects markdown ever reaches model-visible output.
    if (!result || result.error || result.status !== 0) return { ...base, envelope: null, reason: 'bridge-unavailable' };
    let response;
    try {
      response = JSON.parse(result.stdout || '{}');
    } catch {
      return { ...base, envelope: null, reason: 'bridge-unavailable' };
    }
    const validated = validateProjectsContextRefreshEnvelope(response);
    if (!validated.ok) return { ...base, envelope: null, reason: 'bridge-unavailable' };
    return { ...base, envelope: response, reason: undefined };
  }
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
function projectsContextStart(options) { return invokeBridge('projectsContextStart', options); }
function projectsContextRefresh(options) { return invokeBridge('projectsContextRefresh', options); }

const stewardshipAdapter = {
  version: STEWARDSHIP_ADAPTER_VERSION,
  harness: HARNESS,
  // This describes native worktree support. Call availability() before
  // treating an individual session as isolated.
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

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return {};
    const input = JSON.parse(raw);
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  } catch {
    return {};
  }
}

function main(input = readHookInput()) {
  try {
    const sessionId = hookSessionId(input);
    if (!sessionId) {
      writeJson({});
      return;
    }
    const bridgeOptions = { sessionId };
    // Exactly one refresh call per turn boundary; a timeout, invalid, or
    // unavailable result continues the turn with no injection and no retry.
    const refresh = projectsContextRefresh(bridgeOptions);
    const nextInput = nextTurnInput(bridgeOptions);
    heartbeat(bridgeOptions);
    const contexts = [];
    if (projectsContextRefreshHasContent(refresh.envelope)) contexts.push(refresh.envelope.markdown);
    if (nextInput.pendingInSessionInput && nextInput.nextTurnInput) contexts.push(additionalContext(nextInput));
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
  BRIDGE_CAPABILITY_TIMEOUT_MS,
  CLAUDE_SESSION_ID_ENV,
  additionalContext,
  availability,
  bridgeEnvironment,
  hasVerifiedLinkedWorktree,
  heartbeat,
  hookSessionId,
  invokeBridge,
  projectsContextStart,
  projectsContextRefresh,
  main,
  readHookInput,
  stewardshipAdapter,
};
