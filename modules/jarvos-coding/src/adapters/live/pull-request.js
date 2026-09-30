'use strict';

const { run: defaultRun } = require('./run');

const PULL_REQUEST_SCHEMA_VERSION = 'jarvos-coding-live-pull-request/v1';
const DEFAULT_MERGE_METHOD = 'squash';
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Live pull request adapter wrapping the `gh` CLI.
 *
 * Create-vs-merge contract: clawd creates PRs implicitly by pushing the branch,
 * and pr-autopilot only *merges* (gh pr merge). The orchestrator's pullRequest
 * stage expects `openPullRequest` to yield a PR. We reconcile this by making
 * `openPullRequest` idempotent: it returns the existing branch PR when one is
 * already open (the push-created PR) and only runs `gh pr create` when none
 * exists. `merge` wraps pr-autopilot's mergePr command verbatim
 * (`gh pr merge <n> --repo <repo> --<method> --delete-branch`) so the existing
 * autopilot merge path is reused, not rewritten.
 */
function createLivePullRequest(options = {}) {
  const run = options.run || defaultRun;
  const repoOption = options.repo || process.env.PR_AUTOPILOT_REPO || null;
  const baseDefault = options.baseRef || 'main';
  const mergeMethod = options.mergeMethod || DEFAULT_MERGE_METHOD;
  const dryRun = Boolean(options.dryRun);

  function resolveRepo(input = {}) {
    return input.repo || repoOption;
  }

  function normalizeBase(ref) {
    return String(ref || baseDefault).replace(/^origin\//, '') || baseDefault;
  }

  /**
   * The integration target an existing pull request must have. It is the base
   * branch the branch stage resolved from the host-configured trusted base, or
   * otherwise this adapter's own configured base. The run's `baseRef` and any
   * reattachment pointer are never consulted: neither is proof of the target.
   */
  function trustedBaseFor(input = {}) {
    const evidence = input.branchResult;
    const verified = evidence
      && typeof evidence === 'object'
      && evidence.ok !== false
      && typeof evidence.baseCommit === 'string'
      && GIT_OBJECT_ID.test(evidence.baseCommit)
      && typeof evidence.baseBranch === 'string'
      && evidence.baseBranch;
    return verified ? evidence.baseBranch : normalizeBase();
  }

  // An existing pull request is only evidence when its live-read base is the
  // trusted target. A different or unreadable base fails the stage closed.
  function existingBaseFailure(repo, branch, pr, trustedBase) {
    const actualBase = typeof pr.baseRefName === 'string' ? pr.baseRefName : '';
    if (actualBase && actualBase === trustedBase) return null;
    return {
      schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
      status: 'failed',
      ok: false,
      reasonCode: actualBase ? 'pull_request_base_mismatch' : 'pull_request_base_unverified',
      reason: actualBase
        ? `existing pull request targets ${actualBase}, not the trusted base ${trustedBase}`
        : 'existing pull request base could not be read',
      repo,
      branch,
      number: pr.number,
      url: pr.url,
      state: pr.state,
      baseRefName: actualBase || null,
      expectedBaseRefName: trustedBase,
    };
  }

  function findPr(repo, ref, options = {}) {
    if (!ref) return null;
    const args = ['pr', 'view', String(ref), '--json', 'number,url,title,state,headRefName,baseRefName'];
    if (repo) args.push('--repo', repo);
    const result = run('gh', args, { allowFail: true, timeoutMs: 60000 });
    if (result.status !== 0) return null;
    const parsed = parseJson(result.stdout);
    if (!parsed || (options.openOnly && parsed.state !== 'OPEN')) return null;
    return parsed;
  }

  return {
    schemaVersion: PULL_REQUEST_SCHEMA_VERSION,

    async openPullRequest(input = {}) {
      const repo = resolveRepo(input);
      const branch = input.branch || input.headRefName;
      if (!branch) throw new Error('live openPullRequest requires a branch');

      const pointer = input.existingPullRequest || null;
      const pointerRef = pointer?.number || pointer?.url || null;
      const revalidated = pointerRef ? findPr(repo, pointerRef) : null;
      const trustedBase = trustedBaseFor(input);
      if (revalidated) {
        const baseFailure = existingBaseFailure(repo, branch, revalidated, trustedBase);
        if (baseFailure) return { ...baseFailure, reattached: true, liveConfirmed: true };
        const state = String(revalidated.state || '').toUpperCase();
        const status = state === 'MERGED' ? 'merged' : (state === 'OPEN' ? 'exists' : 'closed');
        return {
          schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
          status,
          state,
          ok: state === 'OPEN' || state === 'MERGED',
          repo,
          branch: revalidated.headRefName || branch,
          number: revalidated.number,
          url: revalidated.url,
          title: revalidated.title,
          baseRefName: revalidated.baseRefName,
          reattached: true,
          liveConfirmed: true,
        };
      }

      const existing = findPr(repo, branch, { openOnly: true });
      if (existing) {
        const baseFailure = existingBaseFailure(repo, branch, existing, trustedBase);
        if (baseFailure) return baseFailure;
        return {
          schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
          status: 'exists',
          ok: true,
          repo,
          branch,
          number: existing.number,
          url: existing.url,
          title: existing.title,
          state: existing.state,
          baseRefName: existing.baseRefName,
        };
      }

      const base = normalizeBase(input.baseRef || input.base);
      const title = input.title || input.issue?.title || `${input.issueIdentifier || branch}`;
      const body = input.body || `Automated PR for ${input.issueIdentifier || branch}.`;
      const args = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body];
      if (repo) args.push('--repo', repo);
      if (dryRun) {
        return {
          schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
          status: 'dry-run',
          ok: true,
          repo,
          branch,
          command: `gh ${args.join(' ')}`,
        };
      }

      const created = run('gh', args, { allowFail: true, timeoutMs: 120000 });
      if (created.status !== 0) {
        return {
          schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
          status: 'failed',
          ok: false,
          repo,
          branch,
          error: (created.stderr || created.stdout || '').trim(),
        };
      }

      // gh pr create prints the PR URL; re-read to resolve the number reliably.
      const url = (created.stdout || '').trim().split(/\s+/u).find((t) => /\/pull\/\d+/u.test(t)) || null;
      const opened = findPr(repo, branch, { openOnly: true });
      return {
        schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
        status: 'created',
        ok: true,
        repo,
        branch,
        number: opened?.number ?? null,
        url: opened?.url || url,
        title: opened?.title || title,
      };
    },

    async merge(input = {}) {
      const repo = resolveRepo(input);
      const prNumber = input.number || input.prNumber || input.pullRequest?.number;
      if (!repo) throw new Error('live merge requires a repo');
      if (!prNumber) throw new Error('live merge requires a pull request number');

      const method = input.mergeMethod || mergeMethod;
      const args = ['pr', 'merge', String(prNumber), '--repo', repo, `--${method}`, '--delete-branch'];
      if (dryRun || input.dryRun) {
        return {
          schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
          status: 'dry-run',
          ok: true,
          repo,
          number: prNumber,
          mergeMethod: method,
          command: `gh ${args.join(' ')}`,
        };
      }

      const result = run('gh', args, { allowFail: true, timeoutMs: 120000 });
      const merged = result.status === 0;
      return {
        schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
        status: merged ? 'merged' : 'failed',
        ok: merged,
        repo,
        number: prNumber,
        mergeMethod: method,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

module.exports = {
  DEFAULT_MERGE_METHOD,
  PULL_REQUEST_SCHEMA_VERSION,
  createLivePullRequest,
};
