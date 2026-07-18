'use strict';

const path = require('path');
const { run: defaultRun } = require('./run');

const FIXER_SCHEMA_VERSION = 'jarvos-coding-live-fixer/v1';

// Primary-fix-pass statuses that mean "this approach bowed out — try the
// pr-autopilot coding-agent fix pass instead" (lock busy, doctor/preflight fail,
// no clawpatch fixes produced).
const FALLBACK_STATUSES = new Set(['fallback_needed', 'primary_fix_skipped']);
// Statuses that represent a genuine fix-pass failure (not a clean pass / no-op).
const FAILURE_STATUSES = new Set([
  'failed',
  'gate_failed',
  'fix_exec_failed',
  'push_failed',
  'no_staged_changes',
]);

function defaultClawdRoot(env = process.env) {
  return env.CLAWD_ROOT
    ? path.resolve(env.CLAWD_ROOT)
    : path.resolve(__dirname, '..', '..', '..', '..');
}

function defaultClawpatchPrimaryFixPass(env = process.env) {
  const mod = require(path.join(defaultClawdRoot(env), 'scripts', 'lib', 'pr-clawpatch-instrumentation.js'));
  return mod.runClawpatchPrimaryFixPass;
}

function defaultAutopilotFixPass(env = process.env) {
  const mod = require(path.join(defaultClawdRoot(env), 'scripts', 'pr-autopilot.js'));
  return mod.runFixPass;
}

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

function normalizeFixResult(source, raw) {
  const status = String(raw?.status || raw?.action || 'unknown');
  return {
    schemaVersion: FIXER_SCHEMA_VERSION,
    stage: 'fixRerun',
    source,
    status,
    ok: !FAILURE_STATUSES.has(status),
    raw: raw || null,
  };
}

/**
 * Live fix-and-rerun adapter. Wraps the two coding-agent fix paths pr-autopilot
 * runs after a review requests changes — without rewriting either:
 *
 *  - Primary: pr-clawpatch-instrumentation `runClawpatchPrimaryFixPass`
 *    (clawpatch map→review→fix in an isolated worktree, gate, then push).
 *  - Fallback: pr-autopilot `runFixPass` (Codex/Claude coding-agent fix pass,
 *    push gate, then push) — only invoked when the primary path bows out.
 *
 * Both are lazily required and injectable, so jarvos-coding stays importable
 * without the clawd scripts and tests can drive the path selection with fakes.
 *
 * The orchestrator's fixRerun stage runs before the PR is opened, so without a PR
 * number + head ref there is nothing to fix-and-push yet: the adapter returns a
 * clean `skipped` (not a mock placeholder).
 */
function createLiveFixer(options = {}) {
  const env = options.env || process.env;
  const repo = options.repo || env.PR_AUTOPILOT_REPO || null;
  const repoRootDir = options.repoRootDir || defaultClawdRoot(env);
  const primaryFixPass = options.primaryFixPass
    || ((payload) => defaultClawpatchPrimaryFixPass(env)(payload, env));
  const autopilotFixPass = options.autopilotFixPass
    || ((payload) => defaultAutopilotFixPass(env)(payload));
  const enableAutopilotFallback = options.enableAutopilotFallback !== false;
  const run = options.run || defaultRun;

  function inspectGit(input = {}) {
    const cwd = input.worktreeDir || input.branchResult?.worktreeDir || null;
    if (!cwd) {
      return {
        clean: false,
        status: 'missing',
        reason: 'post-fix worktree path unavailable',
      };
    }
    const result = run('git', ['status', '--porcelain'], {
      cwd,
      timeoutMs: 30000,
      allowFail: true,
    });
    const clean = result.status === 0 && !String(result.stdout || '').trim();
    return {
      clean,
      status: clean ? 'clean' : 'dirty',
      worktreePath: cwd,
      exitCode: result.status,
    };
  }

  return {
    schemaVersion: FIXER_SCHEMA_VERSION,

    async fixAndRerun(input = {}) {
      const pr = prShapeFromInput(input);
      if (!pr.number || !pr.headRefName) {
        const git = inspectGit(input);
        return {
          schemaVersion: FIXER_SCHEMA_VERSION,
          stage: 'fixRerun',
          source: 'none',
          status: 'skipped',
          ok: true,
          reasonCode: 'pre_pr_no_fix_context',
          reason: 'no pull request in context (number + head ref required for a fix pass)',
          git,
        };
      }

      const primary = primaryFixPass({ repoRootDir, repo, pr, runId: input.runId });
      const primaryResult = {
        ...normalizeFixResult('clawpatch-primary', primary),
        git: inspectGit(input),
      };

      if (!FALLBACK_STATUSES.has(primaryResult.status) || !enableAutopilotFallback) {
        return primaryResult;
      }

      // Primary bowed out — run the pr-autopilot coding-agent fix pass.
      const opts = input.opts || { repo, codexTimeoutMin: input.codexTimeoutMin || 30 };
      const analysis = input.analysis || input.reviews || {};
      const fallback = autopilotFixPass({ repoRootDir, pr, analysis, opts });
      return {
        ...normalizeFixResult('pr-autopilot', fallback),
        git: inspectGit(input),
        primary: primaryResult,
      };
    },
  };
}

module.exports = {
  FIXER_SCHEMA_VERSION,
  FALLBACK_STATUSES,
  FAILURE_STATUSES,
  createLiveFixer,
};
