'use strict';

const { evaluateGoalAlignment } = require('../features/goal-alignment');

const TRIAGE_SCHEMA_VERSION = 'jarvos-coding-triage/v1';
const SUBMISSION_GATE_SCHEMA_VERSION = 'jarvos-coding-submission-gate/v1';
const ISSUE_BRANCH_LIFECYCLE_SCHEMA_VERSION = 'jarvos-coding-issue-branch-lifecycle/v1';
const CODING_MATURITY_STATES = Object.freeze([
  'experimental',
  'local-dogfood',
  'internal',
  'release-candidate',
  'stable',
]);
const ISSUE_BRANCH_LIFECYCLE_STATES = Object.freeze([
  'issue_intake',
  'worktree_created',
  'branch_created',
  'branch_pushed',
  'pull_request_open',
  'review_evidence_ready',
  'merge_eligible',
  'merged',
  'cleanup_verified',
  'tracker_closed',
]);
const ISSUE_BRANCH_LIFECYCLE_TRANSITIONS = Object.freeze([
  {
    from: 'issue_intake',
    to: 'worktree_created',
    gate: 'dedicated workspace exists for the issue and base branch',
  },
  {
    from: 'worktree_created',
    to: 'branch_created',
    gate: 'feature branch is created from the declared base and includes the issue identifier',
  },
  {
    from: 'branch_created',
    to: 'branch_pushed',
    gate: 'branch has a remote/upstream pointer or equivalent shareable ref',
  },
  {
    from: 'branch_pushed',
    to: 'pull_request_open',
    gate: 'durable review surface exists with a pull request URL or equivalent code-review URL',
  },
  {
    from: 'pull_request_open',
    to: 'review_evidence_ready',
    gate: 'structured holistic review, green checks, no unresolved actionable findings, and explicit hold status are recorded',
  },
  {
    from: 'review_evidence_ready',
    to: 'merge_eligible',
    gate: 'review evidence says the PR is mergeable and no human-only or sensitive-path hold is active',
  },
  {
    from: 'merge_eligible',
    to: 'merged',
    gate: 'merge commit, merged timestamp, or equivalent integration proof exists',
  },
  {
    from: 'merged',
    to: 'cleanup_verified',
    gate: 'local worktree/branch cleanup evidence is recorded or explicitly not applicable',
  },
  {
    from: 'cleanup_verified',
    to: 'tracker_closed',
    gate: 'tracker issue closeout references merge, review, and cleanup evidence',
  },
]);
const ISSUE_BRANCH_METADATA_REQUIREMENTS = Object.freeze([
  {
    key: 'issueIdentifier',
    role: 'durable tracker issue identifier that names the work',
  },
  {
    key: 'owner',
    role: 'person or agent accountable for the branch lifecycle',
  },
  {
    key: 'repo',
    role: 'repository slug, URL, or canonical repo id',
  },
  {
    key: 'baseBranch',
    role: 'declared base branch or ref used to create the work branch',
  },
  {
    key: 'worktreePath',
    role: 'dedicated local workspace path or equivalent execution checkout pointer',
  },
  {
    key: 'branch',
    role: 'issue-named feature branch, not main/master/HEAD',
  },
  {
    key: 'prUrl',
    role: 'durable pull request or equivalent code-review URL',
  },
  {
    key: 'reviewEvidence',
    role: 'structured local autoreview or equivalent review, green checks, mergeability, findings, and holds',
  },
  {
    key: 'cleanupEvidence',
    role: 'post-merge branch/worktree prune evidence or explicit not-applicable reason',
  },
]);
const SUBMISSION_GATE_PHASES = Object.freeze(['submit', 'complete']);
const SUBMISSION_GATE_STATUS_POLICIES = Object.freeze({
  branch_hygiene: Object.freeze(['clean', 'passed']),
  tests: Object.freeze(['passed']),
  clawpatch: Object.freeze(['passed', 'clean', 'completed']),
  autoreview: Object.freeze(['recorded', 'passed', 'approved', 'completed']),
  goal_alignment: Object.freeze(['aligned', 'passed', 'approved', 'completed']),
  pull_request: Object.freeze(['created', 'approved', 'passed']),
  paperclip_evidence: Object.freeze(['recorded', 'completed', 'passed']),
  post_merge_clawsweeper: Object.freeze(['completed', 'passed', 'not_applicable']),
});
const SUBMISSION_GATE_STAGES = Object.freeze([
  {
    key: 'issue_linkage',
    phase: 'submit',
    role: 'Tie every code change to a tracker issue before implementation starts.',
    evidence: 'issue.identifier or issue.id',
  },
  {
    key: 'branch_hygiene',
    phase: 'submit',
    role: 'Keep code work on an issue-named branch from the expected base with no unrelated dirty state.',
    evidence: 'git.branch, git.baseBranch, git.clean, git.intendedFiles',
  },
  {
    key: 'tests',
    phase: 'submit',
    role: 'Prove the changed behavior with targeted local or CI checks before review.',
    evidence: 'checks.tests[] with command/name and passed status',
  },
  {
    key: 'clawpatch',
    phase: 'submit',
    role: 'Run slice-scoped pre-submit review and fix loops before the pull request is opened.',
    evidence: 'checks.clawpatch.status and artifact or summary',
  },
  {
    key: 'autoreview',
    phase: 'submit',
    role: 'Capture a holistic AI branch review without replacing the pre-submit clawpatch gate.',
    evidence: 'checks.autoreview.status and artifact or summary',
  },
  {
    key: 'goal_alignment',
    phase: 'submit',
    role: 'Prove an AI reviewer compared the PR against the issue plan/goal before autonomous merge.',
    evidence: 'checks.goalAlignment.status and summary, artifact, or specific goal-clarity question',
  },
  {
    key: 'pull_request',
    phase: 'submit',
    role: 'Create a durable review surface for non-trivial code changes.',
    evidence: 'checks.pullRequest.url or checks.pullRequest.number with created/approved status',
  },
  {
    key: 'paperclip_evidence',
    phase: 'submit',
    role: 'Record commands, diff scope, PR link, and review artifacts on the tracker issue.',
    evidence: 'checks.paperclipEvidence.status and issue identifier',
  },
  {
    key: 'post_merge_clawsweeper',
    phase: 'complete',
    role: 'Run or explicitly defer post-merge clawsweeper so merged commits feed the follow-up queue.',
    evidence: 'checks.postMergeClawsweeper.status and artifact, summary, or not_applicable reason',
  },
]);

function normalizeMaturity(value, fallback) {
  return CODING_MATURITY_STATES.includes(value) ? value : fallback;
}

function codingLifecyclePolicy(options = {}) {
  const moduleMaturity = normalizeMaturity(options.moduleMaturity, 'experimental');
  const adapterMaturity = normalizeMaturity(options.adapterMaturity, 'local-dogfood');

  return {
    moduleMaturity,
    adapterMaturity,
    states: CODING_MATURITY_STATES,
    policy: {
      releaseIntake: 'fail-closed-when-release-intake-is-invalid',
      publicApi: 'export-only-supported-boundary',
      adapterBoundary: 'trackers-map-to-portable-triage-shape',
      submissionGate: 'agent-agnostic-pr-first-review-before-completion',
      executionEntrypoint: 'workflow-execution-for-all-ai-personalities',
    },
  };
}

function releaseGateState(releaseFit = {}) {
  if (releaseFit.classification === 'invalid-config') {
    return {
      state: 'blocked',
      reasons: releaseFit.reasons?.length
        ? releaseFit.reasons
        : ['release intake configuration is invalid'],
    };
  }

  return { state: 'open', reasons: [] };
}

function normalizeSubmissionGatePhase(value) {
  return SUBMISSION_GATE_PHASES.includes(value) ? value : 'submit';
}

function evidencePassed(value, allowedStatuses = ['passed']) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return allowedStatuses.includes(value);
  if (!value || typeof value !== 'object') return false;

  if (typeof value.ok === 'boolean') return value.ok;
  if (typeof value.passed === 'boolean') return value.passed;
  if (typeof value.clean === 'boolean') return value.clean;
  if (typeof value.created === 'boolean') return value.created;
  if (typeof value.recorded === 'boolean') return value.recorded;
  if (typeof value.completed === 'boolean') return value.completed;
  if (typeof value.status === 'string') return allowedStatuses.includes(value.status);
  if (typeof value.state === 'string') return allowedStatuses.includes(value.state);

  return false;
}

function hasIssueLinkage(input = {}) {
  const issue = input.issue || {};
  return Boolean(issue.identifier || issue.id || input.issueIdentifier || input.issueId);
}

function branchMentionsIssue(branch, input = {}) {
  const issue = input.issue || {};
  const identifier = issue.identifier || input.issueIdentifier;
  if (!identifier || !branch) return false;
  return String(branch).toLowerCase().includes(String(identifier).toLowerCase());
}

function branchIsIssueNamed(branch, identifier) {
  if (!branch || !identifier) return false;
  if (/^(main|master|HEAD)$/i.test(String(branch).trim())) return false;
  const escaped = String(identifier).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^0-9]|$)`, 'i').test(String(branch));
}

function hasBranchHygiene(input = {}) {
  const git = input.git || {};
  const clean = git.clean === true || evidencePassed(git.status, SUBMISSION_GATE_STATUS_POLICIES.branch_hygiene);
  const hasBranch = Boolean(git.branch);
  const hasBase = Boolean(git.baseBranch || git.upstream || git.baseRef);
  const issueNamed = git.issueNamed === true || branchMentionsIssue(git.branch, input);
  const hasIntendedScope = Array.isArray(git.intendedFiles) && git.intendedFiles.length > 0;
  return clean && hasBranch && hasBase && issueNamed && hasIntendedScope;
}

function hasPassingTests(input = {}) {
  const tests = input.checks?.tests;
  if (Array.isArray(tests)) {
    return tests.length > 0
      && tests.every((test) => evidencePassed(test, SUBMISSION_GATE_STATUS_POLICIES.tests));
  }
  return evidencePassed(tests, SUBMISSION_GATE_STATUS_POLICIES.tests);
}

function hasPullRequest(input = {}) {
  const pr = input.checks?.pullRequest || input.pullRequest;
  if (!pr || typeof pr !== 'object') return false;
  const hasReference = Boolean(pr.url || pr.number || pr.id);
  return hasReference && evidencePassed(pr, SUBMISSION_GATE_STATUS_POLICIES.pull_request);
}

function lifecycleValuePresent(value) {
  if (Array.isArray(value)) return value.some(lifecycleValuePresent);
  if (value && typeof value === 'object') return Object.values(value).some(lifecycleValuePresent);
  return String(value || '').trim().length > 0;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim?.() !== '');
}

function normalizeIssueBranchMetadata(input = {}) {
  const issue = input.issue || {};
  const git = input.git || {};
  const repo = input.repo || input.repository || {};
  const pullRequest = input.pullRequest || input.pr || {};
  const cleanupEvidence = input.cleanupEvidence || input.cleanup || {};

  return {
    issueIdentifier: firstValue(issue.identifier, issue.id, input.issueIdentifier, input.issueId),
    owner: firstValue(input.owner, input.assignee, issue.owner, issue.assignee, input.ownerAgent, input.ownerUser),
    repo: firstValue(repo.slug, repo.url, repo.name, repo.id, input.repo, input.repository),
    baseBranch: firstValue(git.baseBranch, git.baseRef, input.baseBranch, input.baseRef),
    worktreePath: firstValue(git.worktreePath, input.worktreePath, input.workspacePath, input.checkoutPath),
    branch: firstValue(git.branch, input.branch, input.branchName),
    prUrl: firstValue(pullRequest.url, pullRequest.htmlUrl, pullRequest.reviewUrl, input.prUrl),
    reviewEvidence: input.reviewEvidence || input.review || input.checks?.reviewEvidence || null,
    cleanupEvidence,
  };
}

function issueBranchLifecycleContract() {
  return {
    schemaVersion: ISSUE_BRANCH_LIFECYCLE_SCHEMA_VERSION,
    scope: 'portable-ai-operating-system',
    trackerPolicy: 'generic-issue-before-branch',
    branchPolicy: 'issue-named-feature-branch-from-declared-base',
    reviewPolicy: 'local-autoreview-or-equivalent-structured-review-before-merge',
    closeoutPolicy: 'merge-then-cleanup-then-tracker-close',
    states: ISSUE_BRANCH_LIFECYCLE_STATES.map((state) => ({ key: state })),
    transitions: ISSUE_BRANCH_LIFECYCLE_TRANSITIONS.map((transition) => ({ ...transition })),
    metadata: ISSUE_BRANCH_METADATA_REQUIREMENTS.map((requirement) => ({ ...requirement })),
    reviewEvidenceSchema: {
      holisticReview: 'local autoreview or equivalent structured full-branch/PR review with passed/clean/approved/completed status',
      checks: 'green CI, tests, build, lint, or equivalent required checks',
      mergeability: 'mergeable/clean/allowed/ready state from the PR host or equivalent merge gate',
      unresolvedActionableFindings: 'zero unresolved actionable findings, or all actionable findings marked resolved',
      holds: 'explicit human-only and sensitive-path hold fields; active holds block merge eligibility',
    },
  };
}

function reviewStatusPassed(value, allowedStatuses = ['passed', 'clean', 'approved', 'completed', 'success', 'green']) {
  if (value === true) return true;
  if (!value) return false;
  if (typeof value === 'string') return allowedStatuses.includes(value.toLowerCase());
  if (typeof value !== 'object') return false;
  if (typeof value.ok === 'boolean') return value.ok;
  if (typeof value.passed === 'boolean') return value.passed;
  if (typeof value.clean === 'boolean') return value.clean;
  if (typeof value.completed === 'boolean') return value.completed;
  if (typeof value.approved === 'boolean') return value.approved;
  if (typeof value.status === 'string') return allowedStatuses.includes(value.status.toLowerCase());
  if (typeof value.state === 'string') return allowedStatuses.includes(value.state.toLowerCase());
  return false;
}

function mergeEvidencePresent(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    return ['true', 'merged', 'complete', 'completed', 'success'].includes(value.trim().toLowerCase());
  }
  if (typeof value !== 'object') return false;
  if (typeof value.merged === 'boolean') return value.merged;
  if (typeof value.status === 'string') return mergeEvidencePresent(value.status);
  if (typeof value.state === 'string') return mergeEvidencePresent(value.state);
  return false;
}

function clearHold(value) {
  if (value === false) return true;
  if (!value) return false;
  if (typeof value === 'string') {
    return ['none', 'inactive', 'cleared', 'not_applicable', 'not-applicable'].includes(value.toLowerCase());
  }
  if (typeof value !== 'object') return false;
  if (value.active === false) return true;
  if (value.required === false) return true;
  if (value.blocking === false) return true;
  return reviewStatusPassed(value, ['none', 'inactive', 'cleared', 'not_applicable', 'not-applicable']);
}

function reviewFindingsClear(reviewEvidence = {}) {
  if (reviewEvidence.noUnresolvedActionableFindings === true) return true;
  if (reviewEvidence.unresolvedActionableFindings === 0) return true;
  if (Array.isArray(reviewEvidence.findings)) {
    return reviewEvidence.findings.every((finding) => (
      finding.actionable !== true
      || finding.resolved === true
      || ['resolved', 'fixed', 'not_actionable', 'not-actionable'].includes(String(finding.status || '').toLowerCase())
    ));
  }
  return false;
}

function evaluateIssueBranchReviewEvidence(input = {}) {
  const reviewEvidence = input.reviewEvidence || input.review || {};
  const pullRequest = input.pullRequest || input.pr || {};
  const checks = reviewEvidence.checks || input.checks?.ci || pullRequest.checks;
  const holisticReview = reviewEvidence.localAutoreview
    || reviewEvidence.autoreview
    || reviewEvidence.holisticReview
    || reviewEvidence.equivalentReview;
  const mergeability = reviewEvidence.mergeability || pullRequest.mergeability || pullRequest.mergeable;
  const humanOnlyHold = reviewEvidence.humanOnlyHold
    ?? reviewEvidence.holds?.humanOnly
    ?? reviewEvidence.holds?.humanOnlyHold;
  const sensitivePathHold = reviewEvidence.sensitivePathHold
    ?? reviewEvidence.holds?.sensitivePath
    ?? reviewEvidence.holds?.sensitivePathHold;

  const structuredReview = reviewStatusPassed(holisticReview);
  const greenChecks = reviewStatusPassed(checks);
  const findingsClear = reviewFindingsClear(reviewEvidence);
  const explicitHumanHoldClear = clearHold(humanOnlyHold);
  const explicitSensitiveHoldClear = clearHold(sensitivePathHold);
  const mergeable = reviewStatusPassed(mergeability, ['mergeable', 'clean', 'allowed', 'ready', 'passed', 'green', 'success']);
  const missing = [];
  const blockers = [];

  if (!structuredReview) missing.push('holisticReview');
  if (!greenChecks) missing.push('checks');
  if (!findingsClear) missing.push('unresolvedActionableFindings');
  if (!explicitHumanHoldClear) missing.push('humanOnlyHold');
  if (!explicitSensitiveHoldClear) missing.push('sensitivePathHold');
  if (!mergeable) missing.push('mergeability');

  if (humanOnlyHold && !explicitHumanHoldClear) blockers.push('human_only_hold');
  if (sensitivePathHold && !explicitSensitiveHoldClear) blockers.push('sensitive_path_hold');
  if (!findingsClear) blockers.push('unresolved_actionable_findings');

  return {
    ok: missing.length === 0,
    reviewEvidenceReady: structuredReview
      && greenChecks
      && findingsClear
      && explicitHumanHoldClear
      && explicitSensitiveHoldClear
      && mergeable,
    mergeable,
    mergeEligible: structuredReview
      && greenChecks
      && findingsClear
      && explicitHumanHoldClear
      && explicitSensitiveHoldClear
      && mergeable,
    missing,
    blockers,
  };
}

function cleanupVerified(cleanupEvidence = {}) {
  if (!cleanupEvidence || typeof cleanupEvidence !== 'object') return false;
  if (cleanupEvidence.notApplicable === true && cleanupEvidence.reason) return true;
  return reviewStatusPassed(cleanupEvidence, ['completed', 'passed', 'verified', 'pruned', 'cleaned', 'not_applicable']);
}

function evaluateIssueBranchLifecycle(input = {}) {
  const metadata = normalizeIssueBranchMetadata(input);
  const pullRequest = input.pullRequest || input.pr || {};
  const tracker = input.tracker || input.issue || {};
  const metadataMissing = ISSUE_BRANCH_METADATA_REQUIREMENTS
    .map((requirement) => requirement.key)
    .filter((key) => !lifecycleValuePresent(metadata[key]));
  const hasMetadata = (key) => lifecycleValuePresent(metadata[key]);
  const issueIntake = Boolean(
    hasMetadata('issueIdentifier')
      && hasMetadata('owner')
      && hasMetadata('repo')
      && hasMetadata('baseBranch'),
  );
  const worktreeCreated = issueIntake && hasMetadata('worktreePath');
  const branchCreated = worktreeCreated && branchIsIssueNamed(metadata.branch, metadata.issueIdentifier);
  const branchPushed = branchCreated && Boolean(
    input.git?.pushed
      || input.git?.upstream
      || input.git?.remote
      || input.branchPushed
      || input.remoteRef,
  );
  const pullRequestOpen = branchPushed && hasMetadata('prUrl');
  const review = evaluateIssueBranchReviewEvidence({
    ...input,
    reviewEvidence: metadata.reviewEvidence,
  });
  const reviewEvidenceReady = pullRequestOpen && review.reviewEvidenceReady;
  const mergeEligible = pullRequestOpen && review.mergeEligible;
  const merged = mergeEligible && Boolean(
    mergeEvidencePresent(pullRequest.merged)
      || pullRequest.mergeCommit
      || pullRequest.mergeCommitSha
      || input.mergeEvidence?.commit
      || input.mergeEvidence?.mergedAt
      || mergeEvidencePresent(input.mergeEvidence),
  );
  const cleanup = cleanupVerified(metadata.cleanupEvidence);
  const cleanupReady = merged && cleanup;
  const trackerClosed = cleanupReady && reviewStatusPassed(tracker, ['done', 'closed', 'completed']);
  const milestones = {
    issue_intake: issueIntake,
    worktree_created: worktreeCreated,
    branch_created: branchCreated,
    branch_pushed: branchPushed,
    pull_request_open: pullRequestOpen,
    review_evidence_ready: reviewEvidenceReady,
    merge_eligible: mergeEligible,
    merged,
    cleanup_verified: cleanupReady,
    tracker_closed: trackerClosed,
  };
  const currentState = [...ISSUE_BRANCH_LIFECYCLE_STATES]
    .reverse()
    .find((state) => milestones[state]) || 'missing_issue_intake';

  return {
    schemaVersion: ISSUE_BRANCH_LIFECYCLE_SCHEMA_VERSION,
    currentState,
    mergeEligible,
    closeoutReady: trackerClosed,
    missingMetadata: metadataMissing,
    reviewEvidence: review,
    missing: [
      ...metadataMissing,
      ...review.missing.map((key) => `reviewEvidence.${key}`),
    ],
    blockers: review.blockers,
    milestones,
  };
}

function hasPaperclipEvidence(input = {}) {
  const evidence = input.checks?.paperclipEvidence || input.paperclipEvidence;
  return hasIssueLinkage(input)
    && evidencePassed(evidence, SUBMISSION_GATE_STATUS_POLICIES.paperclip_evidence);
}

function stageSatisfied(stageKey, input = {}) {
  const checks = input.checks || {};
  switch (stageKey) {
    case 'issue_linkage':
      return hasIssueLinkage(input);
    case 'branch_hygiene':
      return hasBranchHygiene(input);
    case 'tests':
      return hasPassingTests(input);
    case 'clawpatch':
      return evidencePassed(checks.clawpatch, SUBMISSION_GATE_STATUS_POLICIES.clawpatch);
    case 'autoreview':
      return evidencePassed(checks.autoreview, SUBMISSION_GATE_STATUS_POLICIES.autoreview);
    case 'goal_alignment':
      return evaluateGoalAlignment({
        issue: input.issue,
        goal: input.goal,
        planDocuments: input.planDocuments,
        linkedPlans: input.linkedPlans,
        pullRequest: input.pullRequest || input.pr,
        files: input.files,
        diffSummary: input.diffSummary,
        goalAlignment: checks.goalAlignment,
      }).mergeAllowed;
    case 'pull_request':
      return hasPullRequest(input);
    case 'paperclip_evidence':
      return hasPaperclipEvidence(input);
    case 'post_merge_clawsweeper':
      return evidencePassed(
        checks.postMergeClawsweeper,
        SUBMISSION_GATE_STATUS_POLICIES.post_merge_clawsweeper,
      );
    default:
      return false;
  }
}

function submissionGateContract(options = {}) {
  const phase = normalizeSubmissionGatePhase(options.phase);
  const includedPhases = phase === 'complete' ? SUBMISSION_GATE_PHASES : ['submit'];

  return {
    schemaVersion: SUBMISSION_GATE_SCHEMA_VERSION,
    phase,
    agentScope: 'agent-agnostic',
    personalityScope: 'all-ai-personalities',
    requiredTracker: 'issue',
    executionEntrypoint: 'workflow-execution',
    branchPolicy: 'issue-named-branch-from-current-main-or-declared-base',
    reviewPolicy: 'clawpatch-before-pr-autoreview-goal-alignment-as-separate-signals',
    equivalentPolicy: 'equivalent-gates-must-document-pre-pr-slice-review-holistic-review-goal-alignment-and-post-merge-audit',
    completionPolicy: 'pull-request-merge-then-post-merge-clawsweeper-or-defined-equivalent',
    stages: SUBMISSION_GATE_STAGES.filter((stage) => includedPhases.includes(stage.phase)),
  };
}

function evaluateSubmissionGate(input = {}, options = {}) {
  const contract = submissionGateContract(options);
  const stages = contract.stages.map((stage) => ({
    ...stage,
    status: stageSatisfied(stage.key, input) ? 'passed' : 'missing',
  }));
  const missing = stages.filter((stage) => stage.status !== 'passed');

  return {
    schemaVersion: SUBMISSION_GATE_SCHEMA_VERSION,
    phase: contract.phase,
    agentScope: contract.agentScope,
    ready: missing.length === 0,
    decision: missing.length === 0 ? 'ready' : 'blocked',
    missing: missing.map((stage) => stage.key),
    stages,
  };
}

module.exports = {
  CODING_MATURITY_STATES,
  ISSUE_BRANCH_LIFECYCLE_SCHEMA_VERSION,
  ISSUE_BRANCH_LIFECYCLE_STATES,
  ISSUE_BRANCH_LIFECYCLE_TRANSITIONS,
  ISSUE_BRANCH_METADATA_REQUIREMENTS,
  SUBMISSION_GATE_PHASES,
  SUBMISSION_GATE_SCHEMA_VERSION,
  SUBMISSION_GATE_STAGES,
  TRIAGE_SCHEMA_VERSION,
  codingLifecyclePolicy,
  evaluateIssueBranchLifecycle,
  evaluateSubmissionGate,
  issueBranchLifecycleContract,
  releaseGateState,
  submissionGateContract,
};
