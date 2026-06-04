'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Run a command and return a normalized { status, stdout, stderr, error } result.
 *
 * Mirrors the contract of scripts/pr-autopilot.js `run` so live adapters that
 * extract clawd command logic behave identically: status is the numeric exit
 * code (1 when spawn errors), stdout/stderr are strings, and a missing binary or
 * non-zero exit throws unless `allowFail` is set.
 */
function run(cmd, args = [], options = {}) {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer || DEFAULT_MAX_BUFFER,
    input: options.input,
    env: options.env,
  });

  const out = {
    status: typeof res.status === 'number' ? res.status : (res.error ? 1 : 0),
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };

  if (out.error && !options.allowFail) {
    throw new Error(`${cmd} failed to execute: ${out.error.message}`);
  }
  if (!options.allowFail && out.status !== 0) {
    const detail = String(out.stderr || out.stdout || '').slice(0, 400);
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${out.status}): ${detail}`);
  }

  return out;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  run,
};
