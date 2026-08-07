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

function authoritativeLifecycleInput() {
  return {
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
