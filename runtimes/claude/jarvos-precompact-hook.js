#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeSessionThread } = require('../../modules/jarvos-agent-context/src/index.js');
const { hookSessionId, readHookInput } = require('./jarvos-session-turn-hook.js');

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
  const sessionId = hookSessionId(input);
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

function main(hookInput = readHookInput()) {
  try {
    if (isPreCompactInput(hookInput)) {
      writeSessionThread({
        host: 'claude-code',
        actor: 'claude-code',
        event: 'pre-compaction',
        summary: mechanicalSummary(hookInput),
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
