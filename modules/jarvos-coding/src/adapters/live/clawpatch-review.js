'use strict';

const { createClawpatchAutoreviewAdapter } = require('../../features/review-engine');
const { run: defaultRun } = require('./run');

const DEFAULT_CLAWPATCH_COMMAND = Object.freeze(['npx', '-y', 'clawpatch@0.2.0']);
const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Parse CLAWPATCH_COMMAND the same way clawd's pr-clawpatch-instrumentation does:
 * whitespace-split, falling back to the pinned clawpatch invocation.
 */
function parseClawpatchCommand(env = process.env) {
  const raw = (env.CLAWPATCH_COMMAND || '').trim();
  return raw ? raw.split(/\s+/u) : [...DEFAULT_CLAWPATCH_COMMAND];
}

/**
 * Build a live runner that shells out to the clawpatch binary. It mirrors clawd's
 * runClawpatchCommand contract: invoke `command[0] [...command.slice(1)]` with the
 * already-rendered review args, then normalize the exit code into the review
 * engine's pass/fail shape.
 */
function createLiveClawpatchRunner(options = {}) {
  const run = options.run || defaultRun;
  const timeoutMs = options.timeoutMs || DEFAULT_REVIEW_TIMEOUT_MS;
  const cwd = options.cwd;
  const env = options.env || process.env;

  return async function liveClawpatchRunner(payload = {}) {
    const command = Array.isArray(payload.command) ? payload.command : [];
    if (command.length === 0) {
      throw new Error('live clawpatch runner received an empty command');
    }
    const [executable, ...args] = command;
    const result = run(executable, args, {
      cwd,
      env,
      timeoutMs,
      allowFail: true,
    });

    const passed = result.status === 0;
    return {
      status: passed ? 'passed' : 'failed',
      summary: passed
        ? `clawpatch ${payload.stage} passed`
        : `clawpatch ${payload.stage} exited ${result.status}`,
      exitCode: result.status,
      raw: {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  };
}

/**
 * Live review engine wrapping clawpatch (sliceReview) + autoreview (holisticReview).
 * Only sliceReview is in scope for the clean-adapter extraction; holisticReview
 * remains available via the same command surface but is treated as a coupled
 * stage by the live adapter set.
 */
function createLiveClawpatchReviewEngine(options = {}) {
  const clawpatchCommand = options.clawpatchCommand || parseClawpatchCommand(options.env);
  return createClawpatchAutoreviewAdapter({
    name: options.name || 'live-clawpatch-autoreview',
    clawpatchCommand,
    autoreviewCommand: options.autoreviewCommand,
    runner: createLiveClawpatchRunner(options),
  });
}

module.exports = {
  DEFAULT_CLAWPATCH_COMMAND,
  createLiveClawpatchReviewEngine,
  createLiveClawpatchRunner,
  parseClawpatchCommand,
};
