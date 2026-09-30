'use strict';

const path = require('path');
const fs = require('fs');
const { run: defaultRun } = require('./run');

const BRANCH_SCHEMA_VERSION = 'jarvos-coding-live-branch/v1';
const DEFAULT_WORKTREE_SUBDIR = 'worktrees';
const DEFAULT_TRUSTED_BASE_REF = 'origin/main';
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
// `<remote>/<branch>` with plain path segments only: no `+`, `:`, leading dash,
// empty segment, or `..`, so it can never read to Git as a refspec or an option.
const REMOTE_TRACKING_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

/**
 * Normalize the host-configured integration base to a remote-tracking ref. A
 * bare branch (`release`, the form the pull-request adapter also accepts) means
 * `origin/release`. Returns null when the configuration is not a safe ref.
 */
function normalizeTrustedBaseRef(configured) {
  if (configured !== undefined && configured !== null && typeof configured !== 'string') return null;
  const value = configured || DEFAULT_TRUSTED_BASE_REF;
  const ref = value.includes('/') ? value : `origin/${value}`;
  return REMOTE_TRACKING_REF.test(ref) && !ref.includes('..') ? ref : null;
}

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
  // Null when the configuration itself is not a safe remote-tracking ref.
  const trustedBaseRef = normalizeTrustedBaseRef(options.baseRef);

  // A run may only name the host's base: the normalized ref, or the exact
  // string the host configured. Anything else — `HEAD`, the branch itself, a
  // refspec, an option-like string — is refused rather than handed to Git.
  function requestsTrustedBase(requested) {
    if (!trustedBaseRef) return false;
    if (requested === undefined || requested === null || requested === '') return true;
    return requested === trustedBaseRef || requested === options.baseRef;
  }

  /**
   * Base evidence for the delivery comparison: the commit the freshly fetched
   * trusted remote-tracking ref points at. A failed fetch or an unresolvable
   * ref yields no base commit and therefore no observation.
   */
  function resolveTrustedBase(fetched) {
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

      // Decided before any effect: no directory, fetch, or worktree is touched
      // for a base the host did not configure or for unsafe host configuration.
      if (!requestsTrustedBase(input.baseRef)) {
        return {
          schemaVersion: BRANCH_SCHEMA_VERSION,
          status: 'failed',
          ok: false,
          reasonCode: trustedBaseRef ? 'base_ref_untrusted' : 'trusted_base_ref_invalid',
          branch,
          baseRef: trustedBaseRef,
          baseCommit: null,
          baseBranch: null,
          worktreeDir: null,
          error: trustedBaseRef
            ? `requested base is not the host-configured base ${trustedBaseRef}`
            : 'host-configured base is not a safe remote-tracking ref',
        };
      }
      const baseRef = trustedBaseRef;

      mkdir(worktreeRoot);
      const worktreeDir = path.join(worktreeRoot, `${sanitizeForPath(branch)}-${now()}`);

      // Fetch the base so the new worktree branches off the latest base ref.
      const { remote, branch: baseBranch } = splitBaseRef(baseRef);
      const fetched = run('git', ['fetch', remote, baseBranch], { cwd: repoRootDir, timeoutMs: 120000, allowFail: true });

      // Resolved once, from the fetched ref, for both a new branch and a
      // reattached existing branch. Null means the base is unverified.
      const baseCommit = resolveTrustedBase(fetched);
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
