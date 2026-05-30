'use strict';

const TRIAGE_SCHEMA_VERSION = 'jarvos-coding-triage/v1';
const SUBMISSION_GATE_SCHEMA_VERSION = 'jarvos-coding-submission-gate/v1';
const CODING_MATURITY_STATES = Object.freeze([
  'experimental',
  'local-dogfood',
  'internal',
  'release-candidate',
  'stable',
]);
const SUBMISSION_GATE_PHASES = Object.freeze(['submit', 'complete']);
const SUBMISSION_GATE_STATUS_POLICIES = Object.freeze({
  branch_hygiene: Object.freeze(['clean', 'passed']),
  tests: Object.freeze(['passed']),
  clawpatch: Object.freeze(['passed', 'clean', 'completed']),
  autoreview: Object.freeze(['recorded', 'passed', 'approved', 'completed']),
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
    role: 'Capture an automated reviewer signal without replacing the pre-submit clawpatch gate.',
    evidence: 'checks.autoreview.status and artifact or summary',
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
    requiredTracker: 'issue',
    branchPolicy: 'issue-named-branch-from-current-main-or-declared-base',
    reviewPolicy: 'clawpatch-before-pr-autoreview-as-separate-signal',
    completionPolicy: 'pull-request-merge-then-post-merge-clawsweeper-or-explicit-deferral',
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
  SUBMISSION_GATE_PHASES,
  SUBMISSION_GATE_SCHEMA_VERSION,
  SUBMISSION_GATE_STAGES,
  TRIAGE_SCHEMA_VERSION,
  codingLifecyclePolicy,
  evaluateSubmissionGate,
  releaseGateState,
  submissionGateContract,
};
