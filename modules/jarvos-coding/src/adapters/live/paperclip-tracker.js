'use strict';

const path = require('path');

const TRACKER_SCHEMA_VERSION = 'jarvos-coding-live-tracker/v1';
const POST_MERGE_SCHEMA_VERSION = 'jarvos-coding-live-post-merge/v1';

const DEFAULT_PR_LINK_RELATIVE = path.join('scripts', 'lib', 'paperclip-pr-link.js');

/**
 * Lazily resolve clawd's paperclip-pr-link module. Kept lazy (not a top-level
 * require) so jarvos-coding stays importable when the clawd scripts are absent
 * (e.g. once this package is ported into the public repo). Callers inject their
 * own `prLink` in tests and never touch the real module.
 */
function defaultPrLink() {
  const root = process.env.CLAWD_ROOT
    ? path.resolve(process.env.CLAWD_ROOT)
    : path.resolve(__dirname, '..', '..', '..', '..');
  return require(path.join(root, DEFAULT_PR_LINK_RELATIVE));
}

function resolvePrLink(prLink) {
  if (prLink) return prLink;
  return defaultPrLink();
}

function issueIdentifierOf(input = {}) {
  return input.issue?.identifier || input.issueIdentifier || null;
}

/**
 * Live tracker adapter wrapping paperclip-pr-link's getIssueByIdentifier +
 * transitionIssue. Provides the orchestrator's claimIssue (start of work) and
 * verifyAndClose (final close) stages against the real Paperclip API.
 */
function createLivePaperclipTracker(options = {}) {
  const prLink = resolvePrLink(options.prLink);
  const claimStatus = options.claimStatus || 'in_progress';
  const closeStatus = options.closeStatus || 'done';

  return {
    schemaVersion: TRACKER_SCHEMA_VERSION,

    async claimIssue(input = {}) {
      const identifier = issueIdentifierOf(input);
      if (!identifier) throw new Error('live tracker claimIssue requires an issue identifier');

      const issue = prLink.getIssueByIdentifier(identifier);
      if (!issue) {
        return { schemaVersion: TRACKER_SCHEMA_VERSION, status: 'not_found', identifier, ok: false };
      }
      if (issue.status === claimStatus) {
        return {
          schemaVersion: TRACKER_SCHEMA_VERSION,
          status: 'claimed',
          identifier,
          issueId: issue.id,
          alreadyClaimed: true,
          ok: true,
        };
      }

      const result = prLink.transitionIssue(identifier, claimStatus, options.claimComment);
      return {
        schemaVersion: TRACKER_SCHEMA_VERSION,
        status: result.ok ? 'claimed' : 'failed',
        identifier,
        issueId: issue.id,
        from: issue.status,
        to: claimStatus,
        ok: Boolean(result.ok),
        error: result.error || null,
      };
    },

    async verifyAndClose(input = {}) {
      const identifier = issueIdentifierOf(input);
      if (!identifier) throw new Error('live tracker verifyAndClose requires an issue identifier');

      const issue = prLink.getIssueByIdentifier(identifier);
      if (!issue) {
        return { schemaVersion: TRACKER_SCHEMA_VERSION, status: 'not_found', identifier, ok: false };
      }
      // The post-merge sweep may already have closed the issue; verify first.
      if (issue.status === closeStatus) {
        return {
          schemaVersion: TRACKER_SCHEMA_VERSION,
          status: 'verified',
          identifier,
          issueId: issue.id,
          alreadyClosed: true,
          ok: true,
        };
      }

      const comment = options.closeComment
        || `[jarvos-coding] verifyAndClose: closing ${identifier} after merge of ${input.pullRequest?.url || input.branch || 'branch'}.`;
      const result = prLink.transitionIssue(identifier, closeStatus, comment);
      return {
        schemaVersion: TRACKER_SCHEMA_VERSION,
        status: result.ok ? 'closed' : 'failed',
        identifier,
        issueId: issue.id,
        from: issue.status,
        to: closeStatus,
        ok: Boolean(result.ok),
        error: result.error || null,
      };
    },
  };
}

/**
 * True only when there is positive evidence the pull request has merged.
 * onPRMerged transitions linked issues to done, so the sweep must never fire on
 * an open PR. Accepts an explicit `merged` flag (on the input or the pullRequest)
 * or a merged state/status (the live merge adapter returns `status: 'merged'`).
 */
function isPullRequestMerged(input, pullRequest) {
  if (input.merged === true || pullRequest.merged === true) return true;
  const state = String(pullRequest.state ?? pullRequest.status ?? '').toLowerCase();
  return state === 'merged';
}

/**
 * Live post-merge sweep adapter wrapping paperclip-pr-link's onPRMerged, which
 * scans the merged PR's title/body/branch for SUP-NN identifiers and transitions
 * linked issues to done.
 */
function createLivePostMergeSweep(options = {}) {
  const prLink = resolvePrLink(options.prLink);
  const defaultRepo = options.repo || process.env.PR_AUTOPILOT_REPO || null;

  return {
    schemaVersion: POST_MERGE_SCHEMA_VERSION,

    async sweep(input = {}) {
      const pullRequest = input.pullRequest || {};
      const repo = pullRequest.repo || input.repo || defaultRepo;
      const prNumber = pullRequest.number || pullRequest.prNumber || input.prNumber;

      if (!repo || !prNumber) {
        return {
          schemaVersion: POST_MERGE_SCHEMA_VERSION,
          status: 'skipped',
          reason: 'missing repo or pull request number',
          actions: [],
        };
      }

      // Guard: onPRMerged closes linked issues. The orchestrator's pullRequest
      // stage runs openPullRequest (which yields an OPEN PR), so without proof of
      // a merge this must be a no-op to avoid prematurely closing issues whose PR
      // is still open. The real close then happens out-of-band via pr-autopilot's
      // onPRMerged hook when the PR actually merges, or once a merge result is fed
      // through here.
      if (!isPullRequestMerged(input, pullRequest)) {
        return {
          schemaVersion: POST_MERGE_SCHEMA_VERSION,
          status: 'skipped',
          reason: 'pull request not merged',
          repo,
          prNumber,
          actions: [],
        };
      }

      const actions = prLink.onPRMerged({
        repo,
        prNumber,
        title: pullRequest.title || input.title || '',
        body: pullRequest.body || input.body || '',
        branch: pullRequest.branch || input.branch || '',
        mergeMethod: pullRequest.mergeMethod || input.mergeMethod,
      });

      return {
        schemaVersion: POST_MERGE_SCHEMA_VERSION,
        status: 'completed',
        repo,
        prNumber,
        actions: Array.isArray(actions) ? actions : [],
      };
    },
  };
}

module.exports = {
  POST_MERGE_SCHEMA_VERSION,
  TRACKER_SCHEMA_VERSION,
  createLivePaperclipTracker,
  createLivePostMergeSweep,
};
