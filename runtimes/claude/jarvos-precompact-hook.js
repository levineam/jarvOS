#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// Deliberately NOT required at module scope. PreCompact's only output channel is
// block/allow, so a throw during load exits non-zero with no payload -- the one
// thing this hook promises it cannot do. A failed or missing import must degrade
// to a clean no-op, never to a blocked compaction.
function lazyDeps() {
  return {
    writeSessionThread: require('../../modules/jarvos-agent-context/src/index.js').writeSessionThread,
    readHookInput: require('./jarvos-session-turn-hook.js').readHookInput,
    hookSessionId: require('./jarvos-session-turn-hook.js').hookSessionId,
  };
}

// mechanicalSummary is exported and called directly by tests, so it cannot rely on a
// caller having loaded the deps. Resolve the session id defensively: an unavailable
// id degrades the checkpoint, it does not fail it.
function safeSessionId(input) {
  try {
    return lazyDeps().hookSessionId(input);
  } catch {
    return null;
  }
}

// The session-thread writer defaults to a 30s lock wait. Compaction must not be
// held that long for a best-effort checkpoint; a contended lock means skip, not stall.
const SESSION_THREAD_LOCK_TIMEOUT_MS = 400;

const LOG_PATH = path.join(os.homedir(), '.claude', 'jarvos-hydration.log');

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function logFailure(error) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      `${new Date().toISOString()} ${error.stack || error.message || String(error)}\n`,
      'utf8',
    );
  } catch {
    // PreCompact hooks must fail open.
  }
}

function gitOutput(cwd, args) {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.status === 0 ? String(result.stdout || '').trim() : '';
  } catch {
    return '';
  }
}

function mechanicalSummary(input = {}) {
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : process.cwd();
  const trigger = input.trigger === 'manual' || input.trigger === 'auto' ? input.trigger : 'unknown';
  const sessionId = safeSessionId(input);
  const branch = gitOutput(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = gitOutput(cwd, ['rev-parse', '--short', 'HEAD']);
  const porcelain = gitOutput(cwd, ['status', '--porcelain']);
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;

  const lines = [
    `Pre-compaction flush (${trigger}).`,
    `cwd: ${cwd}`,
  ];
  if (branch) lines.push(`branch: ${branch}`);
  if (head) lines.push(`HEAD: ${head}`);
  lines.push(`dirty paths: ${dirty}`);
  if (sessionId) lines.push(`session: ${sessionId}`);
  return lines.join('\n');
}

function isPreCompactInput(input) {
  return input.hook_event_name === 'PreCompact'
    || input.trigger === 'manual'
    || input.trigger === 'auto';
}

function main(hookInput) {
  try {
    const { writeSessionThread, readHookInput } = lazyDeps();
    const input = hookInput === undefined ? readHookInput() : hookInput;
    if (isPreCompactInput(input)) {
      writeSessionThread({
        host: 'claude-code',
        actor: 'claude-code',
        event: 'pre-compaction',
        summary: mechanicalSummary(input),
        lockTimeoutMs: SESSION_THREAD_LOCK_TIMEOUT_MS,
      });
    }
  } catch (error) {
    logFailure(error);
  }
  writeJson({});
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    logFailure(error);
    try {
      writeJson({});
    } catch {
      // PreCompact must never block compaction.
    }
  }
}

module.exports = { main, mechanicalSummary };
