'use strict';

const {
  changeCounts,
  classifyCheckoutKind,
  getCurrentBranch,
  hasLocalWork,
  inspectRepository,
  summarizeRepoState,
} = require('../../worktree-ownership');

const RUNTIME_CHECKOUT_PREFLIGHT_SCHEMA_VERSION = 'jarvos-coding-runtime-checkout-preflight/v1';

function normalizePath(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function isSameOrChildPath(candidate = '', parent = '') {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedParent = normalizePath(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

function uniqueList(items = []) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function expectedUpstream(remote = 'origin', baseBranch = 'main') {
  return `${remote}/${baseBranch}`;
}

function buildRuntimePreflightDecision(base, details = {}) {
  const decision = details.decision || (base.ok ? 'continue' : 'block');
  const safeToExecute = details.safeToExecute ?? (base.ok && decision === 'continue');
  return {
    schemaVersion: RUNTIME_CHECKOUT_PREFLIGHT_SCHEMA_VERSION,
    ok: Boolean(base.ok),
    severity: base.severity || (base.ok ? 'ok' : 'error'),
    state: base.state || base.reason || 'unknown',
    reason: base.reason || base.state || 'unknown',
    decision,
    safeToExecute,
    branch: details.branch || null,
    baseBranch: details.baseBranch || 'main',
    remote: details.remote || 'origin',
    baseRef: details.baseRef || expectedUpstream(details.remote || 'origin', details.baseBranch || 'main'),
    checkoutRole: details.checkoutRole || 'unknown_checkout',
    checkoutKind: details.checkoutKind || details.repoState?.checkoutKind || 'unknown_checkout',
    repo: details.repo || '',
    repoState: details.repoState || {},
    message: base.message || details.userMessage || 'Runtime checkout preflight could not classify this checkout.',
    userMessage: details.userMessage || base.message || 'Runtime checkout preflight could not classify this checkout.',
    recommendedAction: details.recommendedAction || base.message || 'Inspect the checkout before running automation.',
    evidence: details.evidence || [],
  };
}

function classifyRuntimeCheckoutRole(repo = '', repoState = {}, options = {}) {
  const protectedDevCheckouts = uniqueList(options.protectedDevCheckouts || options.devCheckoutPaths || []);
  const runtimeCheckoutMarkers = uniqueList(options.runtimeCheckoutMarkers || options.executionCheckoutMarkers || []);
  const checkoutKind = repoState.checkoutKind || classifyCheckoutKind(repo, options);

  if (protectedDevCheckouts.some((devPath) => isSameOrChildPath(repo, devPath))) {
    return 'dev_checkout';
  }

  if (checkoutKind === 'root_checkout' && options.protectRootCheckouts !== false) {
    return 'dev_checkout';
  }

  if (runtimeCheckoutMarkers.some((marker) => String(repo || '').includes(marker))) {
    return 'runtime_checkout';
  }

  if (checkoutKind === 'temporary_worktree') {
    return 'runtime_checkout';
  }

  return checkoutKind === 'unknown_checkout' ? 'unknown_checkout' : checkoutKind;
}

function runtimeCheckoutPreflight(input = {}, options = {}) {
  const repo = normalizePath(input.repo || options.repo || '');
  const baseBranch = String(options.baseBranch || input.baseBranch || 'main').trim();
  const remote = String(options.remote || input.remote || 'origin').trim();
  const baseRef = expectedUpstream(remote, baseBranch);
  const branch = String(input.branch || input.repoState?.branch || '').trim();
  const repoState = {
    checkoutKind: classifyCheckoutKind(repo, options),
    trackedChanges: [],
    untrackedFiles: [],
    nestedDirtyRepos: [],
    conflicts: [],
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    ...(input.repoState || {}),
  };
  const counts = changeCounts(repoState);
  const stateSummary = summarizeRepoState(repoState);
  const checkoutRole = classifyRuntimeCheckoutRole(repo, repoState, options);
  const details = {
    branch,
    baseBranch,
    remote,
    baseRef,
    checkoutRole,
    checkoutKind: repoState.checkoutKind,
    repo,
    repoState,
  };

  if (!branch) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'unknown_checkout_state',
      reason: 'missing_branch',
      message: 'Runtime checkout preflight could not determine the current branch.',
    }, {
      ...details,
      decision: 'block',
      recommendedAction: 'Stop and inspect git branch detection before running automation.',
    });
  }

  if (counts.conflicts || counts.nested) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'unsafe_checkout',
      reason: counts.conflicts ? 'conflicted_checkout' : 'nested_dirty_repo',
      message: `Runtime checkout is unsafe: ${stateSummary}.`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: counts.conflicts
        ? 'Resolve merge conflicts in a human-owned checkout before running automation.'
        : 'Resolve or assign nested repository changes before running automation.',
      evidence: [`state: ${stateSummary}`],
    });
  }

  if (checkoutRole === 'dev_checkout') {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: hasLocalWork(repoState) ? 'warn' : 'info',
      state: 'dev_checkout_preserve',
      reason: 'protected_dev_checkout',
      message: `Protected dev/state checkout detected${stateSummary === 'clean' ? '' : ` with ${stateSummary}`}.`,
    }, {
      ...details,
      decision: 'preserve',
      safeToExecute: false,
      recommendedAction: `Create or reuse a separate runtime execution checkout from ${baseRef}; do not reset or clean this dev/state workspace.`,
      evidence: [`checkoutRole: ${checkoutRole}`, `state: ${stateSummary}`],
    });
  }

  if (branch !== baseBranch) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'wrong_runtime_branch',
      reason: 'wrong_branch',
      message: `Runtime execution checkout must be on ${baseBranch}, not "${branch}".`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: `Switch automation to a clean runtime checkout tracking ${baseRef}.`,
      evidence: [`branch: ${branch}`],
    });
  }

  if (!repoState.upstream) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'missing_origin_main_tracking',
      reason: 'missing_upstream',
      message: `Runtime execution checkout must track ${baseRef}.`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: `Configure the runtime checkout so ${baseBranch} tracks ${baseRef}, then rerun preflight.`,
    });
  }

  if (repoState.upstream !== baseRef) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'wrong_runtime_upstream',
      reason: 'wrong_upstream',
      message: `Runtime execution checkout must track ${baseRef}, not ${repoState.upstream}.`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: `Recreate or retarget the runtime checkout from ${baseRef}.`,
      evidence: [`upstream: ${repoState.upstream}`],
    });
  }

  if (repoState.upstreamGone) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'missing_origin_main',
      reason: 'upstream_gone',
      message: `Runtime execution checkout upstream is gone: ${baseRef}.`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: `Fetch ${remote} and recreate the runtime checkout from ${baseRef}.`,
    });
  }

  if (counts.ahead && counts.behind) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'divergent_checkout',
      reason: 'branch_diverged',
      message: `Runtime execution checkout has diverged from ${baseRef}: ${stateSummary}.`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: `Stop automation and rebuild the runtime checkout from ${baseRef}; do not merge or reset shared workspaces blindly.`,
      evidence: [`ahead: ${counts.ahead}`, `behind: ${counts.behind}`],
    });
  }

  if (counts.ahead) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'runtime_checkout_has_local_commits',
      reason: 'checkout_ahead',
      message: `Runtime execution checkout has local commits not on ${baseRef}: ${stateSummary}.`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: `Preserve or publish the local commits elsewhere, then recreate the runtime checkout from ${baseRef}.`,
      evidence: [`ahead: ${counts.ahead}`],
    });
  }

  if (counts.behind) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'warn',
      state: 'behind_origin_main',
      reason: 'checkout_behind',
      message: `Runtime execution checkout is behind ${baseRef}: ${stateSummary}.`,
    }, {
      ...details,
      decision: 'cleanup',
      safeToExecute: false,
      recommendedAction: `Run a fetch plus fast-forward-only update in the runtime checkout, then rerun preflight.`,
      evidence: [`behind: ${counts.behind}`],
    });
  }

  if (hasLocalWork(repoState)) {
    return buildRuntimePreflightDecision({
      ok: false,
      severity: 'error',
      state: 'dirty_runtime_checkout',
      reason: 'dirty_checkout',
      message: `Runtime execution checkout has local work: ${stateSummary}.`,
    }, {
      ...details,
      decision: 'block',
      recommendedAction: `Preserve or discard the runtime checkout's local work deliberately, then recreate or rerun from clean ${baseRef}.`,
      evidence: [`state: ${stateSummary}`],
    });
  }

  return buildRuntimePreflightDecision({
    ok: true,
    severity: 'ok',
    state: 'clean_origin_main_runtime_checkout',
    reason: 'clean_origin_main_runtime_checkout',
    message: `Runtime checkout is clean, on ${baseBranch}, and tracking ${baseRef}.`,
  }, {
    ...details,
    decision: 'continue',
    safeToExecute: true,
    recommendedAction: 'Continue with automation execution.',
    evidence: [`state: ${stateSummary}`],
  });
}

function inspectRuntimeCheckout(repo, options = {}) {
  const branchResult = getCurrentBranch(repo);
  const repoState = inspectRepository(repo, {}, options);
  return runtimeCheckoutPreflight({
    repo,
    branch: branchResult.ok ? branchResult.branch : '',
    repoState,
  }, options);
}

module.exports = {
  RUNTIME_CHECKOUT_PREFLIGHT_SCHEMA_VERSION,
  classifyRuntimeCheckoutRole,
  inspectRuntimeCheckout,
  runtimeCheckoutPreflight,
};
