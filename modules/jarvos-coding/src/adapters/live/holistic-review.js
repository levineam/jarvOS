'use strict';

const path = require('path');

const HOLISTIC_REVIEW_SCHEMA_VERSION = 'jarvos-coding-live-holistic-review/v1';

/**
 * Resolve clawd's repo root. Kept lazy (only used inside the default dep factory)
 * so jarvos-coding stays importable when the clawd scripts are absent.
 */
function defaultClawdRoot(env = process.env) {
  return env.CLAWD_ROOT
    ? path.resolve(env.CLAWD_ROOT)
    : path.resolve(__dirname, '..', '..', '..', '..');
}

function defaultAutopilotModule(env = process.env) {
  return require(path.join(defaultClawdRoot(env), 'scripts', 'pr-autopilot.js'));
}

/**
 * Shape an orchestrator stage input into the `pr` object pr-autopilot's review
 * functions expect. In the take-issue-to-done flow the holisticReview stage runs
 * pre-PR, so number/headRefName may be absent — callers only get PR-scoped review
 * triggering once a PR number is in context.
 */
function prShapeFromInput(input = {}) {
  const pr = input.pr || input.pullRequest || {};
  const baseRefName = pr.baseRefName
    || (input.baseRef ? String(input.baseRef).replace(/^origin\//u, '') : null);
  return {
    ...pr,
    number: pr.number || pr.prNumber || input.prNumber || null,
    headRefName: pr.headRefName || input.branch || input.headRefName || null,
    baseRefName,
  };
}

/**
 * Live holistic review adapter. Two responsibilities, mirroring pr-autopilot:
 *
 *  1. Holistic gate — runs the whole-branch autoreview pass. The clean live
 *     clawpatch/autoreview engine already exposes this as `holisticReview`
 *     (`autoreview --mode branch --base <baseRef>`); it is injected here as
 *     `holisticGate` so the gate and the bot-triggering share one engine.
 *  2. Review-bot triggering — once a PR exists, wraps pr-autopilot's
 *     `triggerReviewBots` (which itself runs `tryMichaelReview` first to conserve
 *     Codex credits, then posts @codex / @coderabbitai triggers). Lazily required
 *     and injectable so tests never shell out.
 */
function createLiveHolisticReview(options = {}) {
  const env = options.env || process.env;
  const repoDefault = options.repo || env.PR_AUTOPILOT_REPO || null;
  const repoRootDir = options.repoRootDir || defaultClawdRoot(env);
  const holisticGate = options.holisticGate || null;
  const triggerReviewBots = options.triggerReviewBots
    || ((repo, prNumber, state, opts, rootDir, pr) =>
      defaultAutopilotModule(env).triggerReviewBots(repo, prNumber, state, opts, rootDir, pr));

  return async function holisticReview(input = {}) {
    const repo = input.repo || repoDefault;
    const pr = prShapeFromInput(input);
    const prScoped = Boolean(repo && pr.number);

    const gate = typeof holisticGate === 'function'
      ? await holisticGate({
        baseRef: input.baseRef,
        base: input.base,
        branch: input.branch,
        issueIdentifier: input.issueIdentifier,
        sliceReview: input.sliceReview,
      })
      : null;

    let reviewBots = null;
    if (prScoped) {
      const opts = input.opts || { repo, dryRun: Boolean(input.dryRun) };
      const state = input.state || {};
      reviewBots = triggerReviewBots(repo, pr.number, state, opts, repoRootDir, pr);
    }

    const gateStatus = gate ? (gate.status || (gate.ok === false ? 'failed' : 'passed')) : 'passed';

    return {
      schemaVersion: HOLISTIC_REVIEW_SCHEMA_VERSION,
      stage: 'holisticReview',
      tool: 'autoreview',
      status: gateStatus,
      ok: gateStatus !== 'failed',
      prScoped,
      gate,
      michaelReview: reviewBots ? reviewBots.michaelReview || null : null,
      reviewBots,
    };
  };
}

module.exports = {
  HOLISTIC_REVIEW_SCHEMA_VERSION,
  createLiveHolisticReview,
};
