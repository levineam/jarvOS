'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const {
  ISSUE_BRANCH_LIFECYCLE_SCHEMA_VERSION,
  evaluateIssueBranchLifecycle,
  evaluateSubmissionGate,
  issueBranchLifecycleContract,
  submissionGateContract,
} = require('../src');

function deliveryEvidence(identifier) {
  const headCommit = 'a'.repeat(40);
  const digest = 'd'.repeat(64);
  const changedFiles = [`docs/plans/${identifier}.md`, 'modules/jarvos-coding/README.md', 'modules/jarvos-coding/src/lifecycle/policy.js'];
  return {
    deliveryTrace: {
      schemaVersion: 'jarvos-coding-delivery-trace/v1',
      workIdentifier: identifier,
      plan: { path: changedFiles[0], digest },
      docImpact: { decision: 'affected', docs: [changedFiles[1]] },
      implementation: { headCommit, changedFiles },
      proof: [{
        kind: 'behavioral',
        level: 'source',
        criterion: 'Closeout requires the plan, documentation, implementation, and proof path.',
        claim: 'The supported lifecycle submits with a verified source trace.',
        command: 'node --test modules/jarvos-coding/test/lifecycle-policy.test.js',
        observation: 'The focused lifecycle cases passed at this head.',
        status: 'passed',
        headCommit,
      }],
    },
    deliveryObservation: { headCommit, changedFiles, plan: { digest, mentionsWorkIdentifier: true } },
  };
}

function authoritativeLifecycleInput() {
  return {
    ...deliveryEvidence('SUP-2138'),
    workIdentity: { identifier: 'SUP-2138' },
    owner: 'codex',
    repo: { slug: 'levineam/jarvOS' },
    git: {
      branch: 'SUP-2138/record-only',
      baseBranch: 'main',
      worktreePath: 'worktree:SUP-2138',
      pushed: true,
      clean: true,
      intendedFiles: ['modules/jarvos-coding/src/lifecycle/policy.js'],
    },
    pullRequest: {
      url: 'https://example.test/pr/1',
      merged: true,
      mergeability: 'mergeable',
    },
    reviewEvidence: {
      autoreview: { status: 'passed' },
      checks: { status: 'passed' },
      unresolvedActionableFindings: 0,
      humanOnlyHold: false,
      sensitivePathHold: false,
    },
    cleanupEvidence: { status: 'verified' },
    checks: {
      tests: { status: 'passed' },
      clawpatch: { status: 'passed' },
      autoreview: { status: 'recorded' },
      goalAlignment: { status: 'aligned' },
      pullRequest: { status: 'created', url: 'https://example.test/pr/1' },
    },
    goal: 'Keep Paperclip record-only',
  };
}

test('Paperclip absence does not block supported lifecycle closeout or submission', () => {
  const input = authoritativeLifecycleInput();
  const lifecycle = evaluateIssueBranchLifecycle(input);
  const submission = evaluateSubmissionGate(input);

  assert.equal(lifecycle.closeoutReady, true);
  assert.equal(ISSUE_BRANCH_LIFECYCLE_SCHEMA_VERSION, 'jarvos-coding-issue-branch-lifecycle/v2');
  assert.equal(lifecycle.schemaVersion, 'jarvos-coding-issue-branch-lifecycle/v2');
  assert.equal(lifecycle.currentState, 'cleanup_verified');
  assert.deepEqual(lifecycle.trackerProjection, {
    eligible: true,
    recorded: false,
    authority: 'none',
  });
  assert.equal(submission.ready, true);
  assert.equal(submission.schemaVersion, 'jarvos-coding-submission-gate/v3');
  assert.equal(submission.missing.includes('paperclip_evidence'), false);
});

test('a Paperclip handoff can record projection status but cannot change lifecycle authority', () => {
  const withoutProjection = evaluateIssueBranchLifecycle(authoritativeLifecycleInput());
  const withProjection = evaluateIssueBranchLifecycle({
    ...authoritativeLifecycleInput(),
    tracker: { status: 'closed', source: 'paperclip' },
    paperclipEvidence: { status: 'recorded', issueIdentifier: 'SUP-2138' },
  });

  assert.equal(withProjection.closeoutReady, withoutProjection.closeoutReady);
  assert.equal(withProjection.mergeEligible, withoutProjection.mergeEligible);
  assert.equal(withProjection.trackerProjection.recorded, true);
  assert.equal(withProjection.trackerProjection.authority, 'none');
});

test('supported contracts name Git and Agent Mail as authority and tracker records as optional', () => {
  const lifecycle = issueBranchLifecycleContract();
  const submission = submissionGateContract();

  assert.deepEqual(lifecycle.authority, {
    code: 'git',
    coordination: 'agent-mail',
    trackerProjection: 'optional-one-way',
  });
  assert.equal(lifecycle.closeoutPolicy.includes('optional non-authoritative projection'), true);
  assert.equal(submission.codeAuthority, 'git');
  assert.equal(submission.coordinationAuthority, 'agent-mail');
  assert.equal(submission.trackerProjection, 'optional-one-way-after-authoritative-outcome');
});

test('submission fails closed when branch claims are not backed by a durable work identity', () => {
  const input = authoritativeLifecycleInput();
  delete input.workIdentity;
  input.git.branch = 'feature/no-work-id';
  input.git.issueNamed = true;

  const submission = evaluateSubmissionGate(input);

  assert.equal(submission.ready, false);
  assert.equal(submission.missing.includes('issue_linkage'), true);
  assert.equal(submission.missing.includes('branch_hygiene'), true);
});

test('branch hygiene derives issue naming instead of trusting a caller claim', () => {
  const input = authoritativeLifecycleInput();
  input.git.branch = 'feature/unrelated-change';
  input.git.issueNamed = true;

  const submission = evaluateSubmissionGate(input);

  assert.equal(submission.ready, false);
  assert.equal(submission.missing.includes('issue_linkage'), false);
  assert.equal(submission.missing.includes('branch_hygiene'), true);
});
