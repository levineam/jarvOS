'use strict';

const path = require('path');
const fs = require('fs');
const { run: defaultRun } = require('./run');

const BRANCH_SCHEMA_VERSION = 'jarvos-coding-live-branch/v1';
const DEFAULT_WORKTREE_SUBDIR = 'worktrees';
const DEFAULT_TRUSTED_BASE_REF = 'origin/main';
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const REMOTE_TRACKING_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Resolve the root directory that holds per-branch worktrees. Mirrors the env
 * surface pr-autopilot uses (PR_AUTOPILOT_WORKTREE_ROOT / PR_AUTOPILOT_RUNTIME_ROOT)
 * so live runs land in the same place, but stays overridable for tests.
 */
function resolveWorktreeRoot(options = {}, env = process.env) {
  if (options.worktreeRoot) return path.resolve(options.worktreeRoot);
  if (env.PR_AUTOPILOT_WORKTREE_ROOT) return path.resolve(env.PR_AUTOPILOT_WORKTREE_ROOT);
  const runtimeRoot = env.PR_AUTOPILOT_RUNTIME_ROOT
    ? path.resolve(env.PR_AUTOPILOT_RUNTIME_ROOT)
    : path.join(env.HOME || process.cwd(), '.pr-autopilot');
  return path.join(runtimeRoot, DEFAULT_WORKTREE_SUBDIR);
}

function sanitizeForPath(value) {
  const cleaned = String(value || 'branch')
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return cleaned || 'branch';
}

function splitBaseRef(baseRef) {
  const ref = String(baseRef || 'origin/main');
  if (ref.includes('/')) {
    const [remote, ...rest] = ref.split('/');
    return { remote, branch: rest.join('/') };
  }
  return { remote: 'origin', branch: ref };
}

/**
 * Live git branch adapter wrapping `git worktree add` — the same coupling
 * pr-autopilot / pr-clawpatch-instrumentation use to get an isolated checkout for
 * a branch. Extracted as a *clean create*: this adapter only adds the worktree and
 * deliberately does NOT garbage-collect stale worktrees (that cleanup is a separate
 * concern owned by the caller / the fix-pass adapters), so it composes as a single
 * orchestrator stage.
 *
 * Injected deps (`run`, `mkdir`, `now`) keep it exercisable without touching git or
 * the filesystem in tests.
 */
function createLiveGitBranch(options = {}) {
  const run = options.run || defaultRun;
  const env = options.env || process.env;
  const repoRootDir = options.repoRootDir || env.CLAWD_ROOT || process.cwd();
  const worktreeRoot = resolveWorktreeRoot(options, env);
  const now = options.now || (() => Date.now());
  const mkdir = options.mkdir || ((dir) => fs.mkdirSync(dir, { recursive: true }));
  // The integration base is host configuration, never a per-run argument.
  const trustedBaseRef = options.baseRef || DEFAULT_TRUSTED_BASE_REF;

  /**
   * Base evidence for the delivery comparison: the commit the freshly fetched
   * trusted remote-tracking ref points at. A per-run base ref is not evidence
   * merely because it is a valid ref — `HEAD`, the branch itself, or any other
   * name that resolves to the branch head would diff as "no changes" — so a
   * requested base other than the configured one, a failed fetch, or an
   * unresolvable ref yields no base commit and therefore no observation.
   */
  function resolveTrustedBase(requestedBaseRef, fetched) {
    if (requestedBaseRef !== trustedBaseRef) return null;
    if (!REMOTE_TRACKING_REF.test(trustedBaseRef) || trustedBaseRef.includes('..')) return null;
    if (!fetched || fetched.status !== 0) return null;
    const resolved = run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${trustedBaseRef}^{commit}`], {
      cwd: repoRootDir,
      timeoutMs: 30000,
      allowFail: true,
    });
    const commit = resolved.status === 0 ? String(resolved.stdout || '').trim().toLowerCase() : '';
    return GIT_OBJECT_ID.test(commit) ? commit : null;
  }

  return {
    schemaVersion: BRANCH_SCHEMA_VERSION,

    async createBranch(input = {}) {
      const branch = input.branch || input.branchName;
      if (!branch) throw new Error('live createBranch requires a branch name');
      const baseRef = input.baseRef || trustedBaseRef;

      mkdir(worktreeRoot);
      const worktreeDir = path.join(worktreeRoot, `${sanitizeForPath(branch)}-${now()}`);

      // Fetch the base so the new worktree branches off the latest base ref.
      const { remote, branch: baseBranch } = splitBaseRef(baseRef);
      const fetched = run('git', ['fetch', remote, baseBranch], { cwd: repoRootDir, timeoutMs: 120000, allowFail: true });

      // Resolved once, from the fetched ref, for both a new branch and a
      // reattached existing branch. Null means the base is unverified.
      const baseCommit = resolveTrustedBase(baseRef, fetched);
      const baseEvidence = { baseCommit, baseBranch: baseCommit ? baseBranch : null };

      // Create a new branch in its own worktree off the base ref.
      const add = run('git', ['worktree', 'add', '-b', branch, worktreeDir, baseRef], {
        cwd: repoRootDir,
        timeoutMs: 120000,
        allowFail: true,
      });

      if (add.status === 0) {
        return {
          schemaVersion: BRANCH_SCHEMA_VERSION,
          status: 'created',
          mode: 'branch',
          ok: true,
          branch,
          baseRef,
          ...baseEvidence,
          worktreeDir,
        };
      }

      // The branch may already exist (e.g. a resumed run). Attach a worktree to
      // the existing branch — keeping its name meaningful for the later PR —
      // rather than failing the stage.
      const attach = run('git', ['worktree', 'add', worktreeDir, branch], {
        cwd: repoRootDir,
        timeoutMs: 120000,
        allowFail: true,
      });

      if (attach.status === 0) {
        return {
          schemaVersion: BRANCH_SCHEMA_VERSION,
          status: 'attached',
          mode: 'existing-branch',
          ok: true,
          branch,
          baseRef,
          ...baseEvidence,
          worktreeDir,
        };
      }

      return {
        schemaVersion: BRANCH_SCHEMA_VERSION,
        status: 'failed',
        ok: false,
        branch,
        baseRef,
        worktreeDir,
        error: (attach.stderr || attach.stdout || add.stderr || add.stdout || '').trim(),
      };
    },
  };
}

module.exports = {
  BRANCH_SCHEMA_VERSION,
  createLiveGitBranch,
  resolveWorktreeRoot,
};
