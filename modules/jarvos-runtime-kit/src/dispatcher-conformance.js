'use strict';

const { spawnSync } = require('child_process');
const { STEWARDSHIP_ACTIONS } = require('./stewardship-bootstrap.js');

// Declarations and advertisements are different things. An adapter *declaring*
// the ABI must list it exactly and in order -- that is a contract statement, and
// stewardship-bootstrap validates it with an ordered comparison. A dispatcher
// *advertising* what it implements is a capability set: order carries no meaning,
// and a dispatcher supporting more than this checkout's contract knows about is
// forward-compatible, not broken. Requiring exact equality here would fail a
// strictly better dispatcher every time the two halves ship out of step -- which
// is the situation an additively extended ABI exists to allow.
function missingActions(advertised, required) {
  if (!Array.isArray(advertised)) return null;
  return required.filter((action) => !advertised.includes(action));
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

// A dispatcher can legitimately block: the real one fences itself while a runtime
// promotion is in flight. Without a bound, checking one mid-transition hangs the
// caller with no output and no diagnostic, so a stall is reported as a failure to
// answer rather than waited on indefinitely.
const PROBE_TIMEOUT_MS = 10000;

function runDispatcher(binPath, args, { spawn, env, timeout } = {}) {
  const runner = typeof spawn === 'function' ? spawn : spawnSync;
  try {
    const result = runner(binPath, args, {
      encoding: 'utf8',
      env: env || process.env,
      timeout: typeof timeout === 'number' ? timeout : PROBE_TIMEOUT_MS,
    });
    // An injected spawn may return nothing; treat that as a failure to answer
    // rather than dereferencing undefined and breaking the never-throws contract.
    return result || { error: new Error('dispatcher produced no spawn result') };
  } catch (error) {
    return { error };
  }
}

/**
 * Check a dispatcher binary against the versioned stewardship action ABI.
 *
 * What a pass means, precisely: the binary ADVERTISES every action in
 * STEWARDSHIP_ACTIONS, and it REJECTS an unknown action without emitting a
 * receipt. It does NOT mean the binary implements those actions. Proving that
 * would require invoking them, and the probe is the only action specified
 * side-effect-free -- dispatching session-start or bridge from a checker would
 * itself break the contract being checked.
 *
 * So a dispatcher that copies the action list into its receipt while its
 * dispatch switch still lacks one of them passes here. That is the same
 * advertised-but-not-implemented shape this checker exists to surface, one level
 * down, and it is why the installer does not treat a pass as permission to
 * assume anything at runtime: the hook it registers is wrapped to fail open.
 * Behavioural proof belongs to the implementation's own suite, where invoking a
 * real action against a fixture runtime is legitimate.
 *
 * Side-effect-free: only the probe and one deliberately unknown action are
 * spawned, and nothing the binary owns is mutated.
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

  const probeFailed = probeResult.status !== 0;
  if (probeFailed) {
    errors.push(`dispatcher provenance-probe must exit 0, got ${probeResult.status}`);
  }
  const parsed = tryParseReceipt(probeResult.stdout);
  if (!parsed) {
    errors.push('dispatcher provenance-probe stdout did not parse as a JSON receipt');
  } else {
    const missing = missingActions(parsed.actions, STEWARDSHIP_ACTIONS);
    if (missing === null) {
      errors.push('dispatcher provenance-probe receipt is missing the actions advertisement');
    } else if (missing.length > 0) {
      errors.push(`dispatcher does not implement ${JSON.stringify(missing)}; its advertisement is ${JSON.stringify(parsed.actions)}`);
    }
  }
  // Only a receipt from a probe that actually succeeded is safe to hand back: a
  // caller reading result.receipt.actions for capability gating must not act on
  // an advertisement the dispatcher itself reported as failed.
  const receipt = probeFailed ? null : parsed;

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
