#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
const ACTIVE_STATUSES = new Set(['backlog', 'todo', 'in_progress', 'in_review', 'blocked']);
const MAIN_BRANCHES = new Set(['main', 'master']);
const DEFAULT_WORKTREE_MARKERS = ['/clawd-worktrees/'];
const DEFAULT_TEMPORARY_WORKTREE_MARKERS = ['/pr-autopilot/worktrees/'];

function normalizePath(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });

  return {
    ok: (result.status ?? 1) === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function getCurrentBranch(repo) {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  if (!result.ok || !result.stdout) {
    return { ok: false, error: result.stderr || 'could not determine current git branch' };
  }
  return { ok: true, branch: result.stdout };
}

function parseBranchStatusHeader(header = '') {
  const text = String(header || '').trim();
  if (!text.startsWith('## ')) return {};
  const body = text.slice(3);
  const bracketMatch = body.match(/\[(.+)]$/);
  const bracket = bracketMatch ? bracketMatch[1] : '';
  const branchPart = bracketMatch ? body.slice(0, bracketMatch.index).trim() : body.trim();
  const upstreamGone = /\bgone\b/i.test(bracket);
  const aheadMatch = bracket.match(/ahead\s+(\d+)/i);
  const behindMatch = bracket.match(/behind\s+(\d+)/i);
  const upstreamMatch = branchPart.match(/^(.+?)\.\.\.(.+)$/);
  const branch = upstreamMatch ? upstreamMatch[1] : branchPart;
  const upstream = upstreamMatch ? upstreamMatch[2] : null;

  return {
    branch,
    upstream,
    upstreamGone,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function parseStatusLine(line = '') {
  const text = String(line || '');
  if (!text || text.startsWith('## ')) return null;
  const code = text.slice(0, 2);
  const file = text.slice(3).trim();
  if (!file) return null;

  return {
    code,
    file,
    untracked: code === '??',
    ignored: code === '!!',
    nestedDirty: code !== '??' && /[m?]/.test(code),
    conflict: /U/.test(code) || ['AA', 'DD'].includes(code),
    tracked: code !== '??' && code !== '!!' && !/[m?]/.test(code),
  };
}

function parseGitStatus(output = '') {
  const lines = String(output || '').split(/\r?\n/).filter(Boolean);
  const header = parseBranchStatusHeader(lines.find((line) => line.startsWith('## ')) || '');
  const entries = lines.map(parseStatusLine).filter(Boolean);

  return {
    ...header,
    trackedChanges: entries.filter((entry) => entry.tracked).map((entry) => entry.file),
    untrackedFiles: entries.filter((entry) => entry.untracked).map((entry) => entry.file),
    nestedDirtyRepos: entries.filter((entry) => entry.nestedDirty).map((entry) => entry.file),
    conflicts: entries.filter((entry) => entry.conflict).map((entry) => entry.file),
    rawEntries: entries,
  };
}

function uniqueList(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function classifyCheckoutKind(repo = '', options = {}) {
  const resolved = normalizePath(repo);
  const rootCheckouts = new Set((options.rootCheckouts || []).map(normalizePath).filter(Boolean));
  const issueMarkers = options.issueWorktreeMarkers || DEFAULT_WORKTREE_MARKERS;
  const temporaryMarkers = options.temporaryWorktreeMarkers || DEFAULT_TEMPORARY_WORKTREE_MARKERS;

  if (rootCheckouts.has(resolved)) return 'root_checkout';
  if (issueMarkers.some((marker) => resolved.includes(marker))) return 'issue_worktree';
  if (temporaryMarkers.some((marker) => resolved.includes(marker))) return 'temporary_worktree';
  return 'unknown_checkout';
}

function inspectRepository(repo, overrides = {}, options = {}) {
  const status = runGit(['status', '--porcelain=v1', '--branch', '--untracked-files=all'], repo);
  if (!status.ok) {
    return {
      ok: false,
      checkoutKind: classifyCheckoutKind(repo, options),
      error: status.stderr || 'could not inspect git status',
      trackedChanges: [],
      untrackedFiles: [],
      nestedDirtyRepos: [],
      conflicts: [],
      ahead: 0,
      behind: 0,
      upstreamGone: false,
      ...overrides,
    };
  }

  const parsed = parseGitStatus(status.stdout);
  const shortStatus = runGit(['status', '--short', '--branch'], repo);
  const shortParsed = shortStatus.ok ? parseGitStatus(shortStatus.stdout) : { nestedDirtyRepos: [] };
  const nestedDirtyRepos = uniqueList([
    ...(parsed.nestedDirtyRepos || []),
    ...(shortParsed.nestedDirtyRepos || []),
  ]);
  const nestedSet = new Set(nestedDirtyRepos);

  return {
    ok: true,
    checkoutKind: classifyCheckoutKind(repo, options),
    trackedChanges: [],
    untrackedFiles: [],
    nestedDirtyRepos: [],
    conflicts: [],
    ahead: 0,
    behind: 0,
    upstreamGone: false,
    ...parsed,
    trackedChanges: (parsed.trackedChanges || []).filter((file) => !nestedSet.has(file)),
    nestedDirtyRepos,
    ...overrides,
  };
}

function extractIssueIdentifier(branch) {
  const match = String(branch || '').match(/(?:^|[^A-Z0-9])SUP[-_/]?(\d+)(?=$|[^0-9])/i);
  return match ? `SUP-${match[1]}` : null;
}

function normalizeStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function changeCounts(repoState = {}) {
  const tracked = Array.isArray(repoState.trackedChanges) ? repoState.trackedChanges.length : 0;
  const untracked = Array.isArray(repoState.untrackedFiles) ? repoState.untrackedFiles.length : 0;
  const nested = Array.isArray(repoState.nestedDirtyRepos) ? repoState.nestedDirtyRepos.length : 0;
  const conflicts = Array.isArray(repoState.conflicts) ? repoState.conflicts.length : 0;
  const ahead = Number(repoState.ahead || 0);
  const behind = Number(repoState.behind || 0);
  return { tracked, untracked, nested, conflicts, ahead, behind };
}

function hasLocalWork(repoState = {}) {
  const counts = changeCounts(repoState);
  return counts.tracked > 0 || counts.untracked > 0 || counts.ahead > 0;
}

function summarizeRepoState(repoState = {}) {
  const counts = changeCounts(repoState);
  const bits = [];
  if (counts.tracked) bits.push(`${counts.tracked} tracked change${counts.tracked === 1 ? '' : 's'}`);
  if (counts.untracked) bits.push(`${counts.untracked} untracked file${counts.untracked === 1 ? '' : 's'}`);
  if (counts.nested) bits.push(`${counts.nested} nested dirty repo${counts.nested === 1 ? '' : 's'}`);
  if (counts.conflicts) bits.push(`${counts.conflicts} conflicted path${counts.conflicts === 1 ? '' : 's'}`);
  if (counts.ahead || counts.behind) bits.push(`${counts.ahead} ahead/${counts.behind} behind`);
  if (repoState.upstreamGone) bits.push('upstream gone');
  return bits.join(', ') || 'clean';
}

function buildDecision(base, details = {}) {
  const decision = details.decision || 'block';
  const safeToProceed = details.safeToProceed ?? decision === 'continue';
  const recommendedAction = details.recommendedAction || base.message || 'Inspect the checkout before continuing.';
  const userMessage = details.userMessage || recommendedAction;
  return {
    ...base,
    decision,
    owner: details.owner || base.identifier || base.issueIdentifier || 'workspace_owner',
    issueIdentifier: details.issueIdentifier ?? base.identifier ?? null,
    recommendedAction,
    safeToProceed,
    userMessage,
    checkoutKind: details.checkoutKind,
    repoState: details.repoState,
  };
}

function classifyWorktreeOwnership({ branch, issue = null, lookup = 'ok', strict = false, repoState = {} }) {
  const branchName = String(branch || '').trim();
  const stateSummary = summarizeRepoState(repoState);
  const counts = changeCounts(repoState);
  const checkoutKind = repoState.checkoutKind || 'unknown_checkout';

  if (!branchName) {
    return buildDecision({
      ok: false,
      severity: 'error',
      reason: 'missing_branch',
      message: 'Could not determine the current branch.',
    }, {
      decision: 'block',
      owner: 'workspace_owner',
      recommendedAction: 'Stop and inspect git branch detection before coding in this checkout.',
      userMessage: 'Could not determine the current branch; coding ownership is blocked until the checkout is inspected.',
      checkoutKind,
      repoState,
    });
  }

  if (MAIN_BRANCHES.has(branchName)) {
    if (counts.conflicts || counts.nested) {
      return buildDecision({
        ok: false,
        severity: 'error',
        branch: branchName,
        reason: counts.conflicts ? 'conflicted_worktree' : 'nested_dirty_repo',
        message: `Main checkout is not clean: ${stateSummary}.`,
      }, {
        decision: 'block',
        owner: 'workspace_owner',
        recommendedAction: 'Resolve conflicts or nested repository changes before starting new coding work.',
        userMessage: `Main checkout is blocked by ${stateSummary}. Resolve that ownership first.`,
        checkoutKind,
        repoState,
      });
    }

    if (counts.ahead && counts.behind) {
      return buildDecision({
        ok: false,
        severity: 'error',
        branch: branchName,
        reason: 'branch_diverged',
        message: `Main checkout has diverged from upstream: ${stateSummary}.`,
      }, {
        decision: 'block',
        owner: 'workspace_owner',
        recommendedAction: 'Reconcile local and upstream main before starting new coding work.',
        userMessage: `Main has diverged (${counts.ahead} ahead/${counts.behind} behind); reconcile it before proceeding.`,
        checkoutKind,
        repoState,
      });
    }

    if (hasLocalWork(repoState)) {
      return buildDecision({
        ok: false,
        severity: 'error',
        branch: branchName,
        reason: checkoutKind === 'root_checkout' ? 'dirty_root_checkout' : 'dirty_main_checkout',
        message: `Main checkout has local work: ${stateSummary}.`,
      }, {
        decision: 'preserve',
        owner: 'workspace_owner',
        recommendedAction: 'Preserve or move the local work into an issue branch/worktree before unrelated coding.',
        userMessage: `Main has local work (${stateSummary}); preserve it before starting unrelated work.`,
        checkoutKind,
        repoState,
      });
    }

    if (counts.behind || repoState.upstreamGone) {
      return buildDecision({
        ok: false,
        severity: 'warn',
        branch: branchName,
        reason: repoState.upstreamGone ? 'upstream_gone' : 'branch_behind',
        message: `Main checkout needs cleanup: ${stateSummary}.`,
      }, {
        decision: 'cleanup',
        owner: 'workspace_owner',
        safeToProceed: false,
        recommendedAction: 'Refresh the main checkout from origin before starting new coding work.',
        userMessage: `Main needs cleanup (${stateSummary}); refresh it before proceeding.`,
        checkoutKind,
        repoState,
      });
    }

    return buildDecision({
      ok: true,
      severity: 'ok',
      branch: branchName,
      reason: 'main_branch',
      message: `Branch hygiene OK: ${branchName} is a main branch.`,
    }, {
      decision: 'continue',
      owner: 'workspace_owner',
      recommendedAction: 'Continue; the main checkout is clean.',
      userMessage: `Branch hygiene OK: ${branchName} is clean and ready.`,
      checkoutKind,
      repoState,
    });
  }

  if (branchName === 'HEAD') {
    return buildDecision({
      ok: !strict,
      severity: strict ? 'error' : 'warn',
      branch: branchName,
      reason: 'detached_head',
      message: 'Detached HEAD is not an intentional issue branch.',
    }, {
      decision: strict ? 'block' : 'cleanup',
      owner: 'workspace_owner',
      safeToProceed: !strict,
      recommendedAction: 'Create or switch to an issue branch before coding.',
      userMessage: 'Detached HEAD has no Paperclip owner; create or switch to an issue branch before coding.',
      checkoutKind,
      repoState,
    });
  }

  const identifier = extractIssueIdentifier(branchName);
  if (!identifier) {
    const decision = hasLocalWork(repoState) ? 'preserve' : 'cleanup';
    return buildDecision({
      ok: !strict,
      severity: strict ? 'error' : 'warn',
      branch: branchName,
      reason: 'missing_issue_identifier',
      message: `Branch "${branchName}" does not include a SUP issue identifier.`,
    }, {
      decision: strict && decision === 'cleanup' ? 'block' : decision,
      owner: 'workspace_owner',
      safeToProceed: !strict && !hasLocalWork(repoState),
      recommendedAction: hasLocalWork(repoState)
        ? 'Preserve the local work, then rename or recreate the branch with a Paperclip issue identifier.'
        : 'Rename or recreate the branch with a Paperclip issue identifier.',
      userMessage: `Branch "${branchName}" has no Paperclip owner (${stateSummary}).`,
      checkoutKind,
      repoState,
    });
  }

  if (!issue) {
    const decision = hasLocalWork(repoState) || repoState.upstreamGone ? 'preserve' : 'cleanup';
    return buildDecision({
      ok: !strict,
      severity: strict ? 'error' : 'warn',
      branch: branchName,
      identifier,
      reason: lookup === 'missing_config' ? 'paperclip_config_missing' : 'paperclip_issue_unknown',
      message: `Could not verify ${identifier} in Paperclip (${lookup}).`,
    }, {
      decision: strict ? 'block' : decision,
      owner: identifier,
      issueIdentifier: identifier,
      safeToProceed: !strict && decision === 'cleanup',
      recommendedAction: `Verify ${identifier} in Paperclip before continuing in this checkout.`,
      userMessage: `Branch "${branchName}" points at ${identifier}, but Paperclip verification failed (${lookup}); ${stateSummary}.`,
      checkoutKind,
      repoState,
    });
  }

  const status = normalizeStatus(issue.status);
  if (TERMINAL_STATUSES.has(status)) {
    return buildDecision({
      ok: false,
      severity: 'error',
      branch: branchName,
      identifier,
      issueStatus: status,
      issueTitle: issue.title || '',
      reason: 'terminal_issue_branch',
      message: `Branch "${branchName}" belongs to ${identifier}, but that issue is ${status}. Park or branch local changes, then return to main before unrelated work.`,
    }, {
      decision: 'park',
      owner: identifier,
      issueIdentifier: identifier,
      recommendedAction: `Park or preserve this checkout for ${identifier}, then return to a clean main or active issue worktree.`,
      userMessage: `Branch "${branchName}" belongs to terminal issue ${identifier} (${status}); park it before unrelated work.`,
      checkoutKind,
      repoState,
    });
  }

  if (!ACTIVE_STATUSES.has(status)) {
    return buildDecision({
      ok: !strict,
      severity: strict ? 'error' : 'warn',
      branch: branchName,
      identifier,
      issueStatus: status || 'unknown',
      issueTitle: issue.title || '',
      reason: 'unknown_issue_status',
      message: `Branch "${branchName}" maps to ${identifier}, but Paperclip status "${status || 'unknown'}" is not recognized as active.`,
    }, {
      decision: strict ? 'block' : 'cleanup',
      owner: identifier,
      issueIdentifier: identifier,
      safeToProceed: !strict,
      recommendedAction: `Confirm ${identifier} status before continuing in this checkout.`,
      userMessage: `Branch "${branchName}" maps to ${identifier}, but status "${status || 'unknown'}" is not recognized.`,
      checkoutKind,
      repoState,
    });
  }

  if (counts.conflicts || counts.nested) {
    return buildDecision({
      ok: false,
      severity: 'error',
      branch: branchName,
      identifier,
      issueStatus: status,
      issueTitle: issue.title || '',
      reason: counts.conflicts ? 'conflicted_worktree' : 'nested_dirty_repo',
      message: `Branch "${branchName}" maps to ${identifier}, but checkout ownership is blocked: ${stateSummary}.`,
    }, {
      decision: 'block',
      owner: identifier,
      issueIdentifier: identifier,
      recommendedAction: counts.conflicts
        ? 'Resolve merge conflicts before continuing coding work.'
        : 'Resolve or assign the nested repository changes before continuing coding work.',
      userMessage: `Branch "${branchName}" is owned by ${identifier}, but ${stateSummary}; resolve that before proceeding.`,
      checkoutKind,
      repoState,
    });
  }

  if (counts.ahead && counts.behind) {
    return buildDecision({
      ok: false,
      severity: 'error',
      branch: branchName,
      identifier,
      issueStatus: status,
      issueTitle: issue.title || '',
      reason: 'branch_diverged',
      message: `Branch "${branchName}" maps to ${identifier}, but it has diverged: ${stateSummary}.`,
    }, {
      decision: 'block',
      owner: identifier,
      issueIdentifier: identifier,
      recommendedAction: `Reconcile ${identifier}'s branch with upstream before continuing.`,
      userMessage: `${identifier} branch has diverged (${counts.ahead} ahead/${counts.behind} behind); reconcile it before proceeding.`,
      checkoutKind,
      repoState,
    });
  }

  if (repoState.upstreamGone) {
    const decision = hasLocalWork(repoState) ? 'preserve' : 'cleanup';
    return buildDecision({
      ok: false,
      severity: decision === 'preserve' ? 'error' : 'warn',
      branch: branchName,
      identifier,
      issueStatus: status,
      issueTitle: issue.title || '',
      reason: hasLocalWork(repoState) ? 'upstream_gone_with_local_work' : 'upstream_gone',
      message: `Branch "${branchName}" maps to ${identifier}, but upstream is gone: ${stateSummary}.`,
    }, {
      decision,
      owner: identifier,
      issueIdentifier: identifier,
      recommendedAction: hasLocalWork(repoState)
        ? `Preserve ${identifier}'s local work before deleting or recreating the branch.`
        : `Clean up the gone upstream branch for ${identifier}.`,
      userMessage: `${identifier} branch upstream is gone (${stateSummary}); ${hasLocalWork(repoState) ? 'preserve the local work' : 'clean up the branch'} before proceeding.`,
      checkoutKind,
      repoState,
    });
  }

  if (counts.behind) {
    return buildDecision({
      ok: false,
      severity: 'warn',
      branch: branchName,
      identifier,
      issueStatus: status,
      issueTitle: issue.title || '',
      reason: 'branch_behind',
      message: `Branch "${branchName}" maps to ${identifier}, but is behind upstream: ${stateSummary}.`,
    }, {
      decision: 'cleanup',
      owner: identifier,
      issueIdentifier: identifier,
      recommendedAction: `Update ${identifier}'s branch from upstream before continuing.`,
      userMessage: `${identifier} branch is behind upstream (${stateSummary}); update it before proceeding.`,
      checkoutKind,
      repoState,
    });
  }

  if (hasLocalWork(repoState)) {
    return buildDecision({
      ok: false,
      severity: 'warn',
      branch: branchName,
      identifier,
      issueStatus: status,
      issueTitle: issue.title || '',
      reason: 'active_issue_local_work',
      message: `Branch "${branchName}" maps to active Paperclip issue ${identifier}, with local work: ${stateSummary}.`,
    }, {
      decision: 'preserve',
      owner: identifier,
      issueIdentifier: identifier,
      recommendedAction: `Continue only if this local work belongs to ${identifier}; otherwise preserve it before switching tasks.`,
      userMessage: `${identifier} owns this branch, and local work exists (${stateSummary}). Preserve it before unrelated work.`,
      checkoutKind,
      repoState,
    });
  }

  return buildDecision({
    ok: true,
    severity: 'ok',
    branch: branchName,
    identifier,
    issueStatus: status,
    issueTitle: issue.title || '',
    reason: 'active_issue_branch',
    message: `Branch hygiene OK: "${branchName}" maps to active Paperclip issue ${identifier} (${status}).`,
  }, {
    decision: 'continue',
    owner: identifier,
    issueIdentifier: identifier,
    recommendedAction: `Continue work on ${identifier}.`,
    userMessage: `Branch hygiene OK: "${branchName}" maps to active Paperclip issue ${identifier} (${status}).`,
    checkoutKind,
    repoState,
  });
}

function evaluateBranchHygiene({ branch, issue = null, lookup = 'ok', strict = false, repoState = {} }) {
  return classifyWorktreeOwnership({ branch, issue, lookup, strict, repoState });
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_TEMPORARY_WORKTREE_MARKERS,
  DEFAULT_WORKTREE_MARKERS,
  buildDecision,
  changeCounts,
  classifyCheckoutKind,
  classifyWorktreeOwnership,
  evaluateBranchHygiene,
  extractIssueIdentifier,
  getCurrentBranch,
  hasLocalWork,
  inspectRepository,
  parseGitStatus,
  runGit,
  summarizeRepoState,
};
