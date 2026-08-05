'use strict';

const {
  TRACKER_SCHEMA_VERSION,
  POST_MERGE_SCHEMA_VERSION,
  createLivePaperclipTracker,
  createLivePostMergeSweep,
} = require('./paperclip-tracker');
const {
  createLiveClawpatchReviewEngine,
  createLiveClawpatchRunner,
  parseClawpatchCommand,
} = require('./clawpatch-review');
const {
  PULL_REQUEST_SCHEMA_VERSION,
  createLivePullRequest,
} = require('./pull-request');
const {
  BRANCH_SCHEMA_VERSION,
  createLiveGitBranch,
  resolveWorktreeRoot,
} = require('./branch');
const {
  HOLISTIC_REVIEW_SCHEMA_VERSION,
  createLiveHolisticReview,
} = require('./holistic-review');
const {
  FIXER_SCHEMA_VERSION,
  createLiveFixer,
} = require('./fixer');

const LIVE_ADAPTERS_SCHEMA_VERSION = 'jarvos-coding-live-adapters/v2';

// Stages whose clawd logic was the most coupled to pr-autopilot. As of SUP-2267
// all three are extracted into live adapters (branch.js, holistic-review.js,
// fixer.js); the constant is retained as documentation of the take-issue-to-done
// stages that wrap pr-autopilot's branch/worktree, review-bot, and fix-pass logic.
const COUPLED_STAGES = Object.freeze(['branch', 'holisticReview', 'fixRerun']);

/**
 * Assemble the FULL live coding adapter set for runTakeIssueToDone. Every stage is
 * a live adapter wrapping the corresponding clawd logic — no mocks:
 *   claim/verifyClose -> paperclip-pr-link
 *   branch            -> git worktree add (branch.js)
 *   sliceReview       -> clawpatch review (clawpatch-review.js)
 *   holisticReview    -> autoreview gate + pr-autopilot review bots (holistic-review.js)
 *   fixRerun          -> clawpatch primary fix pass + pr-autopilot runFixPass (fixer.js)
 *   pullRequest       -> gh (pull-request.js)
 *   postMergeSweep    -> paperclip-pr-link onPRMerged
 *
 * All live adapters accept injected dependencies (prLink module, gh/clawpatch
 * `run`, fix-pass fns) so tests can exercise them without network, git, or
 * subprocess access.
 */
function buildLiveCodingAdapters(options = {}) {
  const reviewEngine = options.reviewEngine || createLiveClawpatchReviewEngine({
    run: options.run,
    env: options.env,
    cwd: options.cwd,
    clawpatchCommand: options.clawpatchCommand,
  });

  // holisticReview wraps the engine's whole-branch autoreview gate plus
  // pr-autopilot's review-bot triggering (PR-scoped, no-op pre-PR).
  const holisticReview = options.holisticReview || createLiveHolisticReview({
    env: options.env,
    repo: options.repo,
    repoRootDir: options.repoRootDir,
    holisticGate: reviewEngine.holisticReview.bind(reviewEngine),
  });

  const tracker = options.tracker || createLivePaperclipTracker({
    prLink: options.prLink,
    claimComment: options.claimComment,
    closeComment: options.closeComment,
  });

  const postMerge = options.postMerge || createLivePostMergeSweep({
    prLink: options.prLink,
    repo: options.repo,
  });

  const pullRequest = options.pullRequest || createLivePullRequest({
    run: options.run,
    repo: options.repo,
    baseRef: options.baseRef,
    mergeMethod: options.mergeMethod,
    dryRun: options.dryRun,
  });

  const git = options.git || createLiveGitBranch({
    run: options.run,
    env: options.env,
    repoRootDir: options.repoRootDir,
    worktreeRoot: options.worktreeRoot,
  });

  const fixer = options.fixer || createLiveFixer({
    env: options.env,
    repo: options.repo,
    repoRootDir: options.repoRootDir,
    run: options.run,
  });

  return {
    schemaVersion: LIVE_ADAPTERS_SCHEMA_VERSION,
    reviewEngine: {
      sliceReview: reviewEngine.sliceReview.bind(reviewEngine),
      holisticReview,
    },
    tracker,
    postMerge,
    pullRequest,
    git,
    fixer,
    sessionState: options.sessionState || null,
  };
}

module.exports = {
  BRANCH_SCHEMA_VERSION,
  COUPLED_STAGES,
  FIXER_SCHEMA_VERSION,
  HOLISTIC_REVIEW_SCHEMA_VERSION,
  LIVE_ADAPTERS_SCHEMA_VERSION,
  POST_MERGE_SCHEMA_VERSION,
  PULL_REQUEST_SCHEMA_VERSION,
  TRACKER_SCHEMA_VERSION,
  buildLiveCodingAdapters,
  createLiveClawpatchReviewEngine,
  createLiveClawpatchRunner,
  createLiveGitBranch,
  createLiveHolisticReview,
  createLiveFixer,
  createLivePaperclipTracker,
  createLivePostMergeSweep,
  createLivePullRequest,
  parseClawpatchCommand,
  resolveWorktreeRoot,
};
