'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  DEFAULT_REVIEW_COMMANDS,
  createCodingOrchestrator,
  createDefaultReviewEngine,
  reviewPassed,
} = require('../src/index.js');

function driverRecorder(calls) {
  return {
    issueDriver: {
      async claim(input) {
        calls.push(`claim:${input.issueId}`);
        return { identifier: input.issueId, status: 'in_progress' };
      },
      async close(input) {
        calls.push(`close:${input.issueId}`);
        return { identifier: input.issueId, status: 'done' };
      },
    },
    branchDriver: {
      async createBranch(input) {
        calls.push(`branch:${input.branchName}`);
        return { name: input.branchName };
      },
    },
    pullRequestDriver: {
      async open(input) {
        calls.push(`pr:${input.branchName}`);
        return { url: `https://example.test/pull/${input.issueId}` };
      },
      async waitForMerge(input) {
        calls.push(`merge:${input.issueId}`);
        return { ok: true, sha: 'abc123' };
      },
    },
    postMergeDriver: {
      async sweep(input) {
        calls.push(`sweep:${input.issueId}`);
        return { ok: true };
      },
    },
    verificationDriver: {
      async verify(input) {
        calls.push(`verify:${input.issueId}`);
        return { ok: true };
      },
    },
  };
}

test('orchestrator runs claim to close and returns an audit trail', async () => {
  const calls = [];
  const reviewEngine = {
    async sliceReview(input) {
      calls.push(`slice:${input.iteration}`);
      return { ok: true, findings: [], summary: 'slice clean' };
    },
    async holisticReview(input) {
      calls.push(`holistic:${input.iteration}`);
      return { ok: true, findings: [], summary: 'holistic clean' };
    },
  };

  const orchestrator = createCodingOrchestrator(Object.assign({
    reviewEngine,
  }, driverRecorder(calls)));

  const result = await orchestrator.runTakeIssueToDone({
    issueId: 'SUP-2213',
    branchName: 'SUP-2213/orchestrator-review-engine',
    definitionOfDone: 'review evidence, PR, sweep, verification',
  });

  assert.equal(result.ok, true);
  assert.equal(result.closedIssue.status, 'done');
  assert.deepEqual(calls, [
    'claim:SUP-2213',
    'branch:SUP-2213/orchestrator-review-engine',
    'slice:0',
    'holistic:0',
    'pr:SUP-2213/orchestrator-review-engine',
    'merge:SUP-2213',
    'sweep:SUP-2213',
    'verify:SUP-2213',
    'close:SUP-2213',
  ]);
  assert.ok(result.auditTrail.some((event) => event.stage === 'sliceReview' && event.type === 'stage.completed'));
  assert.ok(result.auditTrail.some((event) => event.stage === 'closeIssue' && event.type === 'stage.completed'));
});

test('orchestrator fixes blocking review findings then reruns reviews', async () => {
  const calls = [];
  let sliceAttempts = 0;
  const reviewEngine = {
    async sliceReview(input) {
      calls.push(`slice:${input.iteration}`);
      sliceAttempts += 1;
      if (sliceAttempts === 1) {
        return {
          ok: false,
          findings: [{ severity: 'high', message: 'missing test' }],
          summary: 'slice blocked',
        };
      }
      return { ok: true, findings: [], summary: 'slice clean' };
    },
    async holisticReview(input) {
      calls.push(`holistic:${input.iteration}`);
      return { ok: true, findings: [], summary: 'holistic clean' };
    },
  };

  const orchestrator = createCodingOrchestrator(Object.assign({
    reviewEngine,
    fixDriver: {
      async fixAndRerun(input) {
        calls.push(`fix:${input.iteration}:${input.blockingFindings.length}`);
        return { ok: true, summary: 'tests added' };
      },
    },
  }, driverRecorder(calls)));

  const result = await orchestrator.runTakeIssueToDone({
    issueId: 'SUP-2213',
    branchName: 'SUP-2213/orchestrator-review-engine',
    maxFixCycles: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reviewCycles.length, 2);
  assert.equal(result.reviewCycles[0].passed, false);
  assert.equal(result.reviewCycles[1].passed, true);
  assert.ok(calls.indexOf('fix:0:1') > calls.indexOf('holistic:0'));
  assert.ok(calls.indexOf('slice:1') > calls.indexOf('fix:0:1'));
});

test('default review engine invokes generic clawpatch and autoreview commands', async () => {
  const invocations = [];
  const reviewEngine = createDefaultReviewEngine({
    runner: async (command, args) => {
      invocations.push({ command, args });
      return {
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, findings: [], summary: `${command} passed` }),
        stderr: '',
      };
    },
  });

  const slice = await reviewEngine.sliceReview({
    issueId: 'SUP-2213',
    branchName: 'SUP-2213/orchestrator-review-engine',
    definitionOfDone: 'done',
  });
  const holistic = await reviewEngine.holisticReview({
    issueId: 'SUP-2213',
    branchName: 'SUP-2213/orchestrator-review-engine',
  });

  assert.equal(reviewPassed(slice), true);
  assert.equal(reviewPassed(holistic), true);
  assert.equal(invocations[0].command, 'clawpatch');
  assert.equal(invocations[1].command, 'autoreview');
  assert.ok(invocations[0].args.includes('--issue'));
  assert.ok(invocations[0].args.includes('SUP-2213'));
  assert.ok(!JSON.stringify(DEFAULT_REVIEW_COMMANDS).includes('/Users/andrew/clawd/scripts'));
  assert.ok(!JSON.stringify(DEFAULT_REVIEW_COMMANDS).includes('scripts/'));
});

test('review command failure overrides optimistic json output', async () => {
  const reviewEngine = createDefaultReviewEngine({
    runner: async () => ({
      ok: false,
      exitCode: 1,
      stdout: JSON.stringify({ ok: true, findings: [], summary: 'looks clean' }),
      stderr: 'review command failed',
    }),
  });

  const result = await reviewEngine.sliceReview({ issueId: 'SUP-2213' });
  assert.equal(reviewPassed(result), false);
  assert.equal(result.ok, false);
  assert.equal(result.raw.exitCode, 1);
});
