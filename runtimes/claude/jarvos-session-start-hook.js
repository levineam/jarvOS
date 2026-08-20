#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hydrate } = require('../../modules/jarvos-agent-context/src/index.js');
const {
  additionalContext,
  BRIDGE_COMMAND_ENV,
  hookSessionId,
  readHookInput,
  stewardshipAdapter,
} = require('./jarvos-session-turn-hook.js');

const DEFAULT_MAX_CHARS = 9500;
const MAX_ALLOWED_CHARS = 10000;
const LOG_PATH = path.join(os.homedir(), '.claude', 'jarvos-hydration.log');
const BRIDGE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLAUDE_SESSION_MAP_ROOT_ENV = 'JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT';

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

function isTrustedPathEntry(entry, uid, type) {
  let stat;
  try {
    stat = fs.lstatSync(entry);
  } catch {
    return null;
  }
  return (!stat.isSymbolicLink()
    && stat[type]()
    && (stat.uid === uid || stat.uid === 0)
    && (stat.mode & 0o022) === 0) ? stat : null;
}

function bridgeDirectory(command, searchPath) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (typeof searchPath !== 'string' || uid === null) return null;
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    const candidateStat = isTrustedPathEntry(candidate, uid, 'isFile');
    if (!candidateStat || (candidateStat.mode & 0o111) === 0) continue;

    let ancestor = path.resolve(directory);
    let trusted = true;
    while (true) {
      if (!isTrustedPathEntry(ancestor, uid, 'isDirectory')) {
        trusted = false;
        break;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (trusted) return directory;
  }
  return null;
}

function persistBridgeEnvironment(options = {}) {
  const env = options.env || process.env;
  const envFile = env.CLAUDE_ENV_FILE;
  const command = env[BRIDGE_COMMAND_ENV];
  const mapRoot = env[CLAUDE_SESSION_MAP_ROOT_ENV];
  if (!path.isAbsolute(envFile || '') || !BRIDGE_COMMAND.test(command || '') || !path.isAbsolute(mapRoot || '')) return false;

  let stat;
  try {
    stat = fs.statSync(envFile);
  } catch {
    return false;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || uid === null || stat.uid !== uid || (stat.mode & 0o077) !== 0) return false;
  const directory = bridgeDirectory(command, env.PATH);
  if (!directory) return false;

  const lines = [
    `export ${BRIDGE_COMMAND_ENV}=${shellQuote(command)}`,
    `export ${CLAUDE_SESSION_MAP_ROOT_ENV}=${shellQuote(mapRoot)}`,
    `export PATH=${shellQuote(directory)}:\"$PATH\"`,
  ];
  try {
    const current = fs.readFileSync(envFile, 'utf8');
    const missing = lines.filter((line) => !current.split(/\n/).includes(line));
    if (missing.length) fs.appendFileSync(envFile, `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${missing.join('\n')}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

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

function stewardshipContext(options = {}) {
  const input = stewardshipAdapter.nextTurnInput(options);
  return input.pendingInSessionInput && input.nextTurnInput ? additionalContext(input) : '';
}

async function startupHydration() {
  const result = await hydrate({ maxChars: hydrationMaxChars() });
  return result.markdown;
}

async function main(hookInput = readHookInput()) {
  try {
    persistBridgeEnvironment();
    const bridgeOptions = { sessionId: hookSessionId(hookInput) };
    stewardshipAdapter.startOrResume(bridgeOptions);
    emitLocalChangeInvalidation();
    const judgment = stewardshipContext(bridgeOptions);
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

module.exports = { CLAUDE_SESSION_MAP_ROOT_ENV, hydrationMaxChars, main, persistBridgeEnvironment, startupHydration, stewardshipAdapter, stewardshipContext };
