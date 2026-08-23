'use strict';

const { spawnSync } = require('child_process');
const { STEWARDSHIP_ACTIONS } = require('./stewardship-bootstrap.js');

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function tryParseReceipt(stdout) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (_) {
    return null;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

function runDispatcher(binPath, args, { spawn, env } = {}) {
  const runner = typeof spawn === 'function' ? spawn : spawnSync;
  try {
    return runner(binPath, args, { encoding: 'utf8', env: env || process.env });
  } catch (error) {
    return { error };
  }
}

/**
 * Check whether the dispatcher binary at binPath conforms to the versioned
 * stewardship action ABI (STEWARDSHIP_ACTIONS). Side-effect-free: this only
 * spawns the binary with the side-effect-free provenance-probe action and a
 * deliberately unknown action, and never mutates anything the binary owns.
 *
 * extraArgs are appended to both invocations. A real dispatcher needs flags
 * like --selector/--staging-root to resolve a runtime before it can answer a
 * probe at all, so a checker unable to pass them could only ever test fakes.
 *
 * Never throws: a missing, non-executable, or misbehaving binary is reported
 * as an error entry, not an exception.
 */
function checkDispatcher(binPath, options = {}) {
  const harness = options.harness || 'claude';
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const { spawn, env } = options;
  const errors = [];

  if (typeof binPath !== 'string' || binPath.length === 0) {
    return { ok: false, errors: ['dispatcher binPath must be a non-empty string'], receipt: null };
  }

  const probeArgs = ['--harness', harness, '--action', 'provenance-probe', ...extraArgs];
  const probeResult = runDispatcher(binPath, probeArgs, { spawn, env });
  if (probeResult.error) {
    return { ok: false, errors: [`dispatcher provenance-probe failed to spawn: ${probeResult.error.message}`], receipt: null };
  }

  let receipt = null;
  if (probeResult.status !== 0) {
    errors.push(`dispatcher provenance-probe must exit 0, got ${probeResult.status}`);
  }
  receipt = tryParseReceipt(probeResult.stdout);
  if (!receipt) {
    errors.push('dispatcher provenance-probe stdout did not parse as a JSON receipt');
  } else if (!Array.isArray(receipt.actions)) {
    errors.push('dispatcher provenance-probe receipt is missing the actions advertisement');
  } else if (!sameStrings(receipt.actions, STEWARDSHIP_ACTIONS)) {
    errors.push(`dispatcher provenance-probe receipt.actions must equal ${JSON.stringify(STEWARDSHIP_ACTIONS)} in order, got ${JSON.stringify(receipt.actions)}`);
  }

  const rejectArgs = ['--harness', harness, '--action', 'not-a-real-action', ...extraArgs];
  const rejectResult = runDispatcher(binPath, rejectArgs, { spawn, env });
  if (rejectResult.error) {
    errors.push(`dispatcher unknown-action probe failed to spawn: ${rejectResult.error.message}`);
  } else {
    if (rejectResult.status === 0) {
      errors.push('dispatcher accepted an unknown action (exit 0); a conforming dispatcher must reject unknown actions');
    }
    if (tryParseReceipt(rejectResult.stdout)) {
      errors.push('dispatcher emitted a parseable receipt while rejecting an unknown action; a rejection must not emit a receipt');
    }
  }

  return { ok: errors.length === 0, errors, receipt };
}

module.exports = { checkDispatcher };
