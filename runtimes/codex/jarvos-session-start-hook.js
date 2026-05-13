#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hydrate } = require('../../modules/jarvos-agent-context/src/index.js');

const DEFAULT_MAX_CHARS = 12000;
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

async function main() {
  try {
    const result = await hydrate({ maxChars: Number(process.env.JARVOS_HYDRATION_MAX_CHARS || DEFAULT_MAX_CHARS) });
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

main().catch((error) => {
  logFailure(error);
  writeJson({});
});
