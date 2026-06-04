'use strict';

const { run: defaultRun } = require('./run');

const PULL_REQUEST_SCHEMA_VERSION = 'jarvos-coding-live-pull-request/v1';
const DEFAULT_MERGE_METHOD = 'squash';

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

  function findExistingPr(repo, branch) {
    if (!branch) return null;
    const args = ['pr', 'view', branch, '--json', 'number,url,title,state,headRefName'];
    if (repo) args.push('--repo', repo);
    const result = run('gh', args, { allowFail: true, timeoutMs: 60000 });
    if (result.status !== 0) return null;
    const parsed = parseJson(result.stdout);
    if (!parsed || parsed.state !== 'OPEN') return null;
    return parsed;
  }

  return {
    schemaVersion: PULL_REQUEST_SCHEMA_VERSION,

    async openPullRequest(input = {}) {
      const repo = resolveRepo(input);
      const branch = input.branch || input.headRefName;
      if (!branch) throw new Error('live openPullRequest requires a branch');

      const existing = findExistingPr(repo, branch);
      if (existing) {
        return {
          schemaVersion: PULL_REQUEST_SCHEMA_VERSION,
          status: 'exists',
          ok: true,
          repo,
          branch,
          number: existing.number,
          url: existing.url,
          title: existing.title,
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
      const opened = findExistingPr(repo, branch);
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
