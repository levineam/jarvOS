#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('os');
const path = require('path');
const { hydrate } = require('../../modules/jarvos-agent-context/src/index.js');
const {
  additionalContext,
  bridgeEnvironment,
  hookSessionId,
  MAX_HOOK_INPUT_CHARS,
  readHookInput,
  sessionWaitContext,
  stewardshipAdapter,
} = require('./jarvos-session-turn-hook.js');

const DEFAULT_MAX_CHARS = 12000;
const MAX_ALLOWED_CHARS = 50000;
const LOG_PATH = path.join(os.homedir(), '.codex', 'jarvos-hydration.log');

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
    // Startup hooks must fail open.
  }
}

function hydrationMaxChars() {
  const value = process.env.JARVOS_HYDRATION_MAX_CHARS;
  if (!value) return DEFAULT_MAX_CHARS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(parsed, MAX_ALLOWED_CHARS);
}

function stewardshipContext(options = {}) {
  const input = stewardshipAdapter.nextTurnInput(options);
  const sessionWait = stewardshipAdapter.sessionWaitNextTurn(options);
  const contexts = [];
  if (input.pendingInSessionInput && input.nextTurnInput) contexts.push(additionalContext(input));
  const waitContext = sessionWaitContext(sessionWait);
  if (waitContext) contexts.push(waitContext);
  return contexts.join('\n\n');
}

function sessionStartInput(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_HOOK_INPUT_CHARS) return null;
  try { return hookSessionId(JSON.parse(raw), 'SessionStart'); } catch { return null; }
}

function readSessionStartInput() {
  return readHookInput('SessionStart');
}

async function startupHydration() {
  const result = await hydrate({ maxChars: hydrationMaxChars() });
  return result.markdown;
}

async function main() {
  try {
    const env = bridgeEnvironment(readSessionStartInput());
    const judgment = env
      ? (stewardshipAdapter.startOrResume({ env }), stewardshipAdapter.sessionWaitBind({ env }), stewardshipContext({ env }))
      : '';
    let hydration = '';
    try {
      hydration = await startupHydration();
    } catch (error) {
      logFailure(error);
    }
    const context = [judgment, hydration].filter((value) => typeof value === 'string' && value.trim()).join('\n\n');
    if (!context) {
      writeJson({});
      return;
    }
    writeJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
      suppressOutput: true,
    });
  } catch (error) {
    logFailure(error);
    writeJson({});
  }
}

if (require.main === module) {
  main().catch((error) => {
    logFailure(error);
    writeJson({});
  });
}

module.exports = {
  bridgeEnvironment,
  hydrationMaxChars,
  main,
  readSessionStartInput,
  startupHydration,
  sessionStartInput,
  stewardshipAdapter,
  stewardshipContext,
};
