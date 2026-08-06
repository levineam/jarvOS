#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hydrate } = require('../../modules/jarvos-agent-context/src/index.js');
const { stewardshipAdapter } = require('./jarvos-session-turn-hook.js');

const DEFAULT_MAX_CHARS = 9500;
const MAX_ALLOWED_CHARS = 10000;
const LOG_PATH = path.join(os.homedir(), '.claude', 'jarvos-hydration.log');

function emitLocalChangeInvalidation() {
  // Session hydration must fail open; the producer is only a promptness hint.
  try {
    const producer = path.resolve(__dirname, '../../../../scripts/jarvos-local-change-event.js');
    if (!fs.existsSync(producer)) return;
    require('node:child_process').spawn(process.execPath, [producer, '--producer=runtime-session-entry', `--repo=${process.cwd()}`], {
      detached: true, stdio: 'ignore',
    }).unref();
  } catch {
    // Reconciliation reports missing/broken producer health separately.
  }
}

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
  const value = process.env.JARVOS_CLAUDE_HYDRATION_MAX_CHARS || process.env.JARVOS_HYDRATION_MAX_CHARS;
  if (!value) return DEFAULT_MAX_CHARS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CHARS;
  return Math.min(parsed, MAX_ALLOWED_CHARS);
}

async function main() {
  try {
    stewardshipAdapter.startOrResume();
    emitLocalChangeInvalidation();
    const result = await hydrate({ maxChars: hydrationMaxChars() });
    if (!result.markdown || !result.markdown.trim()) {
      writeJson({});
      return;
    }
    writeJson({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.markdown,
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

module.exports = { hydrationMaxChars, main, stewardshipAdapter };
