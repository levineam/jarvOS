#!/usr/bin/env node
'use strict';

// Optional Claude Code lifecycle collector for durable work events. Setup
// registers this hook for PostToolUse and Stop only when the selected
// stewardship dispatcher advertises the optional `session-event` action.
//
// The hook never injects model context and always fails open: every path --
// no bridge, no session, a timeout, a nonzero exit, or an invalid response --
// writes `{}` and exits 0. It inspects the hook input in memory only to find
// explicit absolute repository roots; command text, tool output, and prompts
// are never logged, persisted, or passed to the bridge.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  CANDIDATE_ROOTS_ENV,
  COLLECT_TIMEOUT_MS,
  COLLECT_TRIGGER_ENV,
  DURABLE_WORK_COLLECT_CAPABILITY,
  collectTrigger,
  encodeCandidateRoots,
  extractCandidateRoots,
  validateCollectResponse,
} = require('../../modules/jarvos-runtime-kit/src/durable-work-collect.js');
const {
  BRIDGE_COMMAND_ENV,
  CLAUDE_SESSION_ID_ENV,
  hookSessionId,
} = require('./jarvos-session-turn-hook.js');

const HARNESS = 'claude-code';
const BRIDGE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// PostToolUse input carries the tool response. Read a bounded prefix only;
// an oversized input simply fails open.
const MAX_HOOK_INPUT_BYTES = 256 * 1024;

function readHookInput() {
  try {
    const buffer = Buffer.alloc(MAX_HOOK_INPUT_BYTES + 1);
    let length = 0;
    let retries = 0;
    for (;;) {
      let read;
      try {
        read = fs.readSync(0, buffer, length, buffer.length - length, null);
      } catch (error) {
        // A non-blocking stdin may briefly report EAGAIN; never spin forever.
        if (error && error.code === 'EAGAIN' && retries < 200) {
          retries += 1;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          continue;
        }
        throw error;
      }
      if (read === 0) break;
      length += read;
      if (length > MAX_HOOK_INPUT_BYTES) return null;
    }
    const raw = buffer.subarray(0, length).toString('utf8').trim();
    if (!raw) return null;
    const input = JSON.parse(raw);
    return input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  } catch {
    return null;
  }
}

function bridgeCommand(options = {}) {
  const env = options.env || process.env;
  const command = options.bridgeCommand === undefined ? env[BRIDGE_COMMAND_ENV] : options.bridgeCommand;
  return typeof command === 'string' && BRIDGE_COMMAND.test(command) ? command : null;
}

// One bounded bridge call. Returns the validated metadata-only receipt, or
// null when collection is unavailable for any reason.
function collect(input, options = {}) {
  const trigger = collectTrigger(input);
  if (!trigger || trigger === 'turn_boundary') return { collected: false, reason: 'not-a-collect-event', response: null };
  const sessionId = hookSessionId({
    ...(Object.hasOwn(input, 'session_id') ? { session_id: input.session_id } : {}),
    ...(Object.hasOwn(input, 'transcript_path') ? { transcript_path: input.transcript_path } : {}),
  });
  if (!sessionId) return { collected: false, reason: 'session-unavailable', response: null };
  const command = bridgeCommand(options);
  if (!command) return { collected: false, reason: 'bridge-not-configured', response: null };
  // Only harness-reported roots count. The process cwd is deliberately not a
  // fallback: a managed dispatcher runs this hook from its selected runtime,
  // which is never the session's working repository.
  const roots = extractCandidateRoots(input);
  if (!roots.length) return { collected: false, reason: 'no-candidate-root', response: null };
  const env = {
    ...(options.env || process.env),
    [CLAUDE_SESSION_ID_ENV]: sessionId,
    [COLLECT_TRIGGER_ENV]: trigger,
    [CANDIDATE_ROOTS_ENV]: encodeCandidateRoots(roots),
  };
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  let result;
  try {
    result = spawnSyncImpl(command, [DURABLE_WORK_COLLECT_CAPABILITY], {
      cwd: options.cwd || process.cwd(),
      encoding: 'utf8',
      timeout: COLLECT_TIMEOUT_MS,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { collected: false, reason: 'bridge-unavailable', response: null };
  }
  if (!result || result.error || result.status !== 0) return { collected: false, reason: 'bridge-unavailable', response: null };
  let response;
  try {
    response = JSON.parse(result.stdout || '{}');
  } catch {
    return { collected: false, reason: 'bridge-unavailable', response: null };
  }
  if (!validateCollectResponse(response).ok) return { collected: false, reason: 'bridge-unavailable', response: null };
  return { collected: response.status === 'collected', reason: undefined, response };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(input = readHookInput(), options = {}) {
  try {
    if (input) collect(input, options);
  } catch {
    // Collection is best-effort metadata capture; it never blocks a tool call
    // or a stop, and it never surfaces an error to the model.
  }
  writeJson({});
}

if (require.main === module) main();

module.exports = {
  HARNESS,
  MAX_HOOK_INPUT_BYTES,
  collect,
  main,
  readHookInput,
};
