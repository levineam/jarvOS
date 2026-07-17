'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  HOST_ADAPTER_SCHEMA_VERSION,
  ORCHESTRATOR_SCHEMA_VERSION,
  REVIEW_ENGINE_SCHEMA_VERSION,
  TAKE_ISSUE_TO_DONE_STAGES,
  codingHostAdapterContract,
  createClaudeCodeHostAdapter,
  createClawpatchAutoreviewAdapter,
  createCodexHostAdapter,
  createCodingControlPlanePort,
  createCodingHostAdapter,
  createMemorySessionStateStore,
  runTakeIssueToDone,
} = require('../src/index.js');

function buildAdapters(calls, sessionState = createMemorySessionStateStore()) {
  return {
    sessionState,
    reviewEngine: createClawpatchAutoreviewAdapter({
      runner: async (payload) => {
        calls.push(payload.stage);
        return { status: 'passed', artifact: `${payload.stage}.json`, summary: payload.tool };
      },
    }),
    tracker: {
      async claimIssue() {
        calls.push('claim');
        return { status: 'claimed' };
      },
      async verifyAndClose(input = {}) {
        calls.push('verifyClose');
        if (input.pullRequest && /not-merged|OPEN/i.test(String(input.pullRequest.state || input.pullRequest.status || ''))) {
          return { status: 'deferred', reason: 'pull request not merged', ok: true };
        }
        return { status: 'closed', ok: true };
      },
    },
    git: {
      async createBranch(input) {
        calls.push('branch');
        return { status: 'created', branch: input.branch };
      },
    },
    fixer: {
      async fixAndRerun() {
        calls.push('fixRerun');
        return {
          status: 'passed',
          git: { clean: true, status: 'clean', worktreePath: '/tmp/test-worktree' },
        };
      },
    },
    pullRequest: {
      async openPullRequest() {
        calls.push('pullRequest');
        return { status: 'created', url: 'https://github.com/example/repo/pull/1', ok: true };
      },
    },
    postMerge: {
      async sweep() {
        calls.push('postMergeSweep');
        return { status: 'completed' };
      },
    },
  };
}

test('review engine ships generic clawpatch plus autoreview commands', async () => {
  const invocations = [];
  const adapter = createClawpatchAutoreviewAdapter({
    runner: async (payload) => {
      invocations.push(payload);
      return { status: 'passed', artifact: `${payload.stage}.json`, summary: payload.tool };
    },
  });

  const slice = await adapter.sliceReview({ baseRef: 'origin/main' });
  const holistic = await adapter.holisticReview({ baseRef: 'origin/main' });

  assert.equal(slice.schemaVersion, REVIEW_ENGINE_SCHEMA_VERSION);
  assert.equal(slice.stage, 'sliceReview');
  assert.equal(slice.tool, 'clawpatch');
  assert.equal(slice.status, 'passed');
  assert.equal(holistic.stage, 'holisticReview');
  assert.equal(holistic.tool, 'autoreview');
  assert.deepEqual(invocations.map((call) => call.command), [
    ['clawpatch', 'review', '--since', 'origin/main'],
    ['autoreview', '--mode', 'branch', '--base', 'origin/main'],
  ]);
  assert.ok(!JSON.stringify(invocations).includes('scripts/'));
});

test('orchestrator runs the full stage loop and checkpoints code thread state', async () => {
  const calls = [];
  const sessionState = createMemorySessionStateStore();
  const result = await runTakeIssueToDone({
    issue: { identifier: 'SUP-2214' },
    branch: 'SUP-2214/jarvos-coding-host-adapters',
    baseRef: 'origin/main',
  }, buildAdapters(calls, sessionState));

  assert.equal(result.schemaVersion, ORCHESTRATOR_SCHEMA_VERSION);
  assert.equal(result.status, 'completed');
  assert.equal(result.issueIdentifier, 'SUP-2214');
  assert.equal(result.branch, 'SUP-2214/jarvos-coding-host-adapters');
  assert.deepEqual(result.events.map((event) => event.stage), TAKE_ISSUE_TO_DONE_STAGES);
  assert.deepEqual(calls, TAKE_ISSUE_TO_DONE_STAGES);
  assert.equal(result.checkpoints.length, TAKE_ISSUE_TO_DONE_STAGES.length);
  assert.deepEqual(result.checkpoints.at(-1).codeThread, {
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/jarvos-coding-host-adapters',
    stage: 'verifyClose',
    lastDecision: 'closed',
    nextStep: 'complete',
  });
});

test('host contract normalizes Claude Code and Codex aliases', () => {
  assert.deepEqual(codingHostAdapterContract('claude').drives, ['runTakeIssueToDone']);
  assert.equal(codingHostAdapterContract('claude').host, 'claude-code');
  assert.equal(codingHostAdapterContract('codex-cli').host, 'codex');
  assert.equal(codingHostAdapterContract('open-claw').host, 'openclaw');
});

function codingCommand(overrides = {}) {
  return {
    id: 'command-1',
    mutationClass: 'coding.take-issue-to-done',
    desiredGeneration: 'generation-1',
    resource: { machineId: 'machine-1', type: 'paperclip-issue', id: 'SUP-2214' },
    commandSpec: {
      operation: 'take-issue-to-done',
      arguments: { issueIdentifier: 'SUP-2214', branch: 'SUP-2214/control-plane' },
    },
    ...overrides,
  };
}

function fullStageEvents(overrides = {}) {
  return [
    { stage: 'claim', result: { status: 'claimed', ok: true } },
    { stage: 'branch', result: { status: 'created', branch: 'SUP-2214/control-plane', ok: true } },
    { stage: 'sliceReview', result: { status: 'passed', artifact: 'slice.json', summary: 'clawpatch' } },
    { stage: 'holisticReview', result: { status: 'passed', artifact: 'holistic.json', summary: 'autoreview' } },
    {
      stage: 'fixRerun',
      result: {
        status: 'passed',
        git: { clean: true, status: 'clean', worktreePath: '/tmp/test-worktree' },
      },
    },
    { stage: 'pullRequest', result: { status: 'created', url: 'https://example.test/pr/1', ok: true, ...(overrides.pullRequest || {}) } },
    { stage: 'postMergeSweep', result: { status: 'completed', ...(overrides.postMergeSweep || {}) } },
    { stage: 'verifyClose', result: { status: 'closed', ok: true, ...(overrides.verifyClose || {}) } },
  ];
}

function completedOrchestration(overrides = {}) {
  return {
    status: 'completed',
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/control-plane',
    baseRef: 'origin/main',
    checkpoints: [{
      schemaVersion: 'jarvos-session-state/v1',
      kind: 'code-thread',
      artifact: {
        kind: 'paperclip-issue',
        ref: 'SUP-2214',
        issueIdentifier: 'SUP-2214',
        branch: 'SUP-2214/control-plane',
        path: null,
        url: 'https://example.test/pr/1',
      },
      codeThread: {
        issueIdentifier: 'SUP-2214',
        branch: 'SUP-2214/control-plane',
        stage: 'verifyClose',
        lastDecision: 'closed',
        nextStep: 'complete',
      },
    }],
    events: fullStageEvents(overrides.eventOverrides || {}),
    ...overrides,
  };
}

test('control-plane port selects public hosts and returns canonical submission evidence', async () => {
  const seen = [];
  const port = createCodingControlPlanePort({
    host: 'openclaw',
    hostAdapter: { runTakeIssueToDone: async (input) => { seen.push(input); return completedOrchestration(); } },
  });
  const execution = await port.executeFenced(codingCommand(), { fence: 4, assertCurrentFence: () => true });
  const verification = await port.verify(codingCommand(), { execution });

  assert.equal(port.manifest.contractVersion, '1.0.0');
  assert.equal(execution.host, 'openclaw');
  assert.equal(execution.submissionEvidence.verifyClose.status, 'closed');
  assert.equal(execution.submissionGate.ready, true);
  assert.equal(verification.outcome, 'satisfied');
  assert.equal(seen[0].issueIdentifier, 'SUP-2214');
  assert.equal(typeof seen[0].controlPlane.assertCurrentFence, 'function');
});

test('control-plane port reattaches supplied branch and checkpoint after session loss', async () => {
  let input;
  const port = createCodingControlPlanePort({
    hostAdapter: { runTakeIssueToDone: async (next) => { input = next; return completedOrchestration(); } },
  });
  const checkpoint = { phase: 'pullRequest', issueIdentifier: 'SUP-2214', branch: 'SUP-2214/existing', pr: 'https://example.test/pr/1' };
  await port.executeFenced(codingCommand({ checkpoint, commandSpec: { operation: 'take-issue-to-done', arguments: { issueIdentifier: 'SUP-2214', branch: 'SUP-2214/existing' } } }), { fence: 1, assertCurrentFence: () => true });
  assert.equal(input.branch, 'SUP-2214/existing');
  assert.deepEqual(input.resumeFrom, checkpoint);
});

test('control-plane port forwards resumeFrom supplied in command arguments', async () => {
  let input;
  const port = createCodingControlPlanePort({
    hostAdapter: { runTakeIssueToDone: async (next) => { input = next; return completedOrchestration(); } },
  });
  const resumeFrom = {
    phase: 'pullRequest',
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/existing',
    pullRequest: { url: 'https://example.test/pr/1' },
  };
  await port.executeFenced(codingCommand({
    commandSpec: {
      operation: 'take-issue-to-done',
      arguments: { issueIdentifier: 'SUP-2214', branch: 'SUP-2214/existing', resumeFrom },
    },
  }), { fence: 1, assertCurrentFence: () => true });

  assert.deepEqual(input.resumeFrom, resumeFrom);
});

test('default host composition treats resumeFrom as reattachment hints and still runs all stages', async () => {
  const calls = [];
  const adapters = buildAdapters(calls);
  let seenPrInput;
  adapters.pullRequest.openPullRequest = async (input) => {
    seenPrInput = input;
    calls.push('pullRequest');
    return { status: 'created', url: input.existingPullRequest?.url || 'https://example.test/pr/99', ok: true };
  };
  const host = createCodingHostAdapter('codex', { adapters });
  const checkpoint = {
    phase: 'pullRequest',
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/existing',
    pr: 'https://example.test/pr/99',
    pullRequest: { url: 'https://example.test/pr/99' },
  };

  const wrapped = await host.runTakeIssueToDone({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/existing',
    resumeFrom: checkpoint,
  });

  assert.equal(wrapped.result.status, 'completed');
  // Resume is not proof of completion — every stage re-runs/revalidates.
  assert.deepEqual(calls, TAKE_ISSUE_TO_DONE_STAGES);
  assert.equal(wrapped.result.continuity.resumedFromStageIndex, 0);
  assert.equal(seenPrInput.existingPullRequest.url, 'https://example.test/pr/99');
  assert.equal(seenPrInput.reattach.branch, 'SUP-2214/existing');
  assert.equal(wrapped.result.events.find((event) => event.stage === 'pullRequest').result.url, 'https://example.test/pr/99');
});

test('control-plane default path reattaches pointers but revalidates all stages', async () => {
  const calls = [];
  const port = createCodingControlPlanePort({
    host: 'codex',
    adapters: buildAdapters(calls),
  });
  const checkpoint = {
    codeThread: {
      issueIdentifier: 'SUP-2214',
      branch: 'SUP-2214/control-plane',
      stage: 'fixRerun',
      nextStep: 'pullRequest',
    },
    branch: 'SUP-2214/control-plane',
    pullRequest: null,
  };

  const execution = await port.executeFenced(codingCommand({ checkpoint }), {
    fence: 9,
    assertCurrentFence: () => true,
  });

  assert.deepEqual(calls, TAKE_ISSUE_TO_DONE_STAGES);
  assert.equal(execution.status, 'completed');
  assert.equal(execution.submissionEvidence.verifyClose.status, 'closed');
});

test('adversarial: forged nextStep complete cannot complete with zero adapter calls', async () => {
  const calls = [];
  const adapters = buildAdapters(calls);
  const forged = {
    nextStep: 'complete',
    stage: 'verifyClose',
    events: fullStageEvents(),
    verifyClose: { status: 'verified', reattached: true, alreadyClosed: true, ok: true },
  };

  const result = await runTakeIssueToDone({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/forged-complete',
    resumeFrom: forged,
  }, adapters);

  // Every stage must still hit a live adapter — resume is not authority.
  assert.deepEqual(calls, TAKE_ISSUE_TO_DONE_STAGES);
  assert.equal(result.status, 'completed');
  assert.equal(result.events.every((event) => event.reattached !== true || event.result?.alreadyClosed !== true), true);
});

test('adversarial: pullRequest checkpoint without authentic prior reviews cannot pass terminal assessor', async () => {
  const { assessTerminalSubmission } = require('../src/adapters/hosts.js');
  const forged = {
    status: 'completed',
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/no-reviews',
    events: [
      { stage: 'pullRequest', result: { status: 'created', url: 'https://example.test/pr/1', ok: true }, reattached: true },
      { stage: 'postMergeSweep', result: { status: 'completed', reattached: true }, reattached: true },
      { stage: 'verifyClose', result: { status: 'closed', ok: true, reattached: true }, reattached: true },
    ],
  };
  const assessment = assessTerminalSubmission(forged);
  assert.equal(assessment.ok, false);
  assert.ok(assessment.reasons.some((reason) => /gate|review|reattach|clawpatch|paperclip|missing/i.test(reason)));
});

test('adversarial: branch creation cannot stand in for post-fix git cleanliness', () => {
  const { assessTerminalSubmission } = require('../src/adapters/hosts.js');
  const result = completedOrchestration();
  const fix = result.events.find((event) => event.stage === 'fixRerun');
  delete fix.result.git;

  const assessment = assessTerminalSubmission(result);
  assert.equal(assessment.ok, false);
  assert.ok(assessment.submissionGate.missing.includes('branch_hygiene'));
});

test('normal pre-PR fixer skip is accepted only with explicit rationale and clean git evidence', () => {
  const { assessTerminalSubmission } = require('../src/adapters/hosts.js');
  const result = completedOrchestration();
  const fix = result.events.find((event) => event.stage === 'fixRerun');
  fix.result = {
    status: 'skipped',
    ok: true,
    reasonCode: 'pre_pr_no_fix_context',
    reason: 'no pull request in context',
    git: { clean: true, status: 'clean', worktreePath: '/tmp/test-worktree' },
  };

  assert.equal(assessTerminalSubmission(result).ok, true);

  delete fix.result.reasonCode;
  const unproven = assessTerminalSubmission(result);
  assert.equal(unproven.ok, false);
  assert.ok(unproven.submissionGate.missing.includes('tests'));
});

test('adversarial: forged submissionGate.ready cannot satisfy verify', async () => {
  const port = createCodingControlPlanePort({
    hostAdapter: { runTakeIssueToDone: async () => completedOrchestration() },
  });
  // Incomplete durable evidence, but a cached ready gate blob.
  const forgedExecution = {
    status: 'completed',
    submissionGate: { ready: true, decision: 'ready', missing: [] },
    submissionEvidence: {
      issueIdentifier: 'SUP-2214',
      branch: 'SUP-2214/control-plane',
      pullRequest: { status: 'created', url: 'https://example.test/pr/1', ok: true },
      postMergeSweep: { status: 'completed' },
      verifyClose: { status: 'closed', ok: true },
      // Missing claim/reviews/fix events — gate must recompute and fail.
      events: [
        { stage: 'pullRequest', result: { status: 'created', url: 'https://example.test/pr/1', ok: true } },
        { stage: 'postMergeSweep', result: { status: 'completed' } },
        { stage: 'verifyClose', result: { status: 'closed', ok: true } },
      ],
    },
  };
  const verification = await port.verify(codingCommand(), { execution: forgedExecution });
  assert.notEqual(verification.outcome, 'satisfied');
  assert.match(verification.reason || '', /submission gate|incomplete|missing/i);
});

test('adversarial: reattached verifyClose without live confirmation cannot complete', async () => {
  const { assessTerminalSubmission } = require('../src/adapters/hosts.js');
  const assessment = assessTerminalSubmission({
    status: 'completed',
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/reattach-close',
    events: fullStageEvents({
      verifyClose: { status: 'closed', ok: true, reattached: true, alreadyClosed: true },
    }).map((event) => (
      event.stage === 'verifyClose'
        ? { ...event, reattached: true, result: { ...event.result, reattached: true, alreadyClosed: true } }
        : event
    )),
  });
  assert.equal(assessment.ok, false);
  assert.ok(assessment.reasons.some((reason) => /reattach|live tracker/i.test(reason)));
});

test('adversarial: reattached review results require live confirmation', () => {
  const { assessTerminalSubmission } = require('../src/adapters/hosts.js');
  const result = completedOrchestration();
  for (const stage of ['sliceReview', 'holisticReview']) {
    const event = result.events.find((row) => row.stage === stage);
    event.result = { ...event.result, reattached: true, status: 'passed', ok: true };
    event.reattached = true;
  }

  const assessment = assessTerminalSubmission(result);
  assert.equal(assessment.ok, false);
  assert.ok(assessment.submissionGate.missing.includes('clawpatch'));
  assert.ok(assessment.submissionGate.missing.includes('autoreview'));

  for (const stage of ['sliceReview', 'holisticReview']) {
    result.events.find((row) => row.stage === stage).result.liveConfirmed = true;
  }
  assert.equal(assessTerminalSubmission(result).ok, true);
});

test('adversarial: unmerged post-merge skip cannot satisfy completion', () => {
  const { assessTerminalSubmission } = require('../src/adapters/hosts.js');
  const result = completedOrchestration({
    eventOverrides: {
      postMergeSweep: {
        status: 'skipped',
        reason: 'pull request not merged',
        ok: true,
      },
      verifyClose: { status: 'verified', ok: true, liveConfirmed: true },
    },
  });

  const assessment = assessTerminalSubmission(result);
  assert.equal(assessment.ok, false);
  assert.ok(assessment.submissionGate.missing.includes('post_merge_clawsweeper'));
});

test('adversarial: a referenced PR with a failed or closed status cannot satisfy completion', () => {
  const { assessTerminalSubmission } = require('../src/adapters/hosts.js');
  for (const status of ['failed', 'closed']) {
    const result = completedOrchestration({
      eventOverrides: {
        pullRequest: { status, url: 'https://example.test/pr/1' },
      },
    });
    const pullRequest = result.events.find((event) => event.stage === 'pullRequest').result;
    delete pullRequest.ok;

    const assessment = assessTerminalSubmission(result);
    assert.equal(assessment.ok, false, status);
    assert.ok(assessment.submissionGate.missing.includes('pull_request'), status);
  }
});

test('control-plane verifier fails closed for deferred, failed, and incomplete close evidence', async () => {
  const port = createCodingControlPlanePort({
    hostAdapter: {
      runTakeIssueToDone: async () => completedOrchestration({
        status: 'completed',
        eventOverrides: { verifyClose: { status: 'deferred', reason: 'pull request not merged', ok: true } },
      }),
    },
  });

  // execute must fail closed even if host reports completed while close is deferred
  await assert.rejects(
    () => port.executeFenced(codingCommand({ id: 'deferred-close' }), { fence: 1, assertCurrentFence: () => true }),
    /deferred|not a successful terminal close|submission gate|did not complete/i,
  );

  const deferredExecution = {
    status: 'completed',
    submissionEvidence: {
      issueIdentifier: 'SUP-2214',
      branch: 'SUP-2214/control-plane',
      pullRequest: { status: 'created', url: 'https://example.test/pr/1' },
      postMergeSweep: { status: 'completed' },
      verifyClose: { status: 'deferred', reason: 'pull request not merged', ok: true },
      events: fullStageEvents({ verifyClose: { status: 'deferred', reason: 'pull request not merged', ok: true } }),
    },
  };
  const deferred = await port.verify(codingCommand(), { execution: deferredExecution });
  assert.notEqual(deferred.outcome, 'satisfied');
  assert.match(deferred.reason || '', /deferred|terminal|gate/i);

  const failedExecution = {
    status: 'completed',
    submissionEvidence: {
      issueIdentifier: 'SUP-2214',
      branch: 'SUP-2214/control-plane',
      pullRequest: { status: 'failed', ok: false },
      postMergeSweep: null,
      verifyClose: { status: 'failed', ok: false },
      events: fullStageEvents({
        pullRequest: { status: 'failed', ok: false },
        verifyClose: { status: 'failed', ok: false },
      }),
    },
  };
  const failed = await port.verify(codingCommand(), { execution: failedExecution });
  assert.equal(failed.outcome, 'failed');
});

test('control-plane port fails closed for unavailable hosts, stale fences, supersession, and failed submission', async () => {
  const unavailable = createCodingControlPlanePort({ hostAdapter: { runTakeIssueToDone: null } });
  await assert.rejects(() => unavailable.executeFenced(codingCommand(), { fence: 1, assertCurrentFence: () => true }));

  let calls = 0;
  const port = createCodingControlPlanePort({ hostAdapter: { runTakeIssueToDone: async () => { calls += 1; return completedOrchestration(); } } });
  await assert.rejects(() => port.executeFenced(codingCommand(), { fence: 2, assertCurrentFence: () => { throw new Error('stale_fence'); } }), /stale_fence/);
  assert.equal(calls, 0);
  await assert.rejects(() => port.executeFenced(codingCommand({ id: 'superseded' }), { fence: 3, assertCurrentFence: () => { throw new Error('superseded'); } }), /superseded/);

  const failed = createCodingControlPlanePort({ hostAdapter: { runTakeIssueToDone: async () => ({ status: 'failed' }) } });
  await assert.rejects(() => failed.executeFenced(codingCommand({ id: 'failed-submission' }), { fence: 4, assertCurrentFence: () => true }), /did not complete/);
});

test('control-plane port fails closed when submission gate evidence is incomplete', async () => {
  const port = createCodingControlPlanePort({
    hostAdapter: {
      runTakeIssueToDone: async () => ({
        status: 'completed',
        issueIdentifier: 'SUP-2214',
        branch: 'SUP-2214/control-plane',
        events: [
          { stage: 'pullRequest', result: { status: 'created', url: 'https://example.test/pr/1' } },
          { stage: 'verifyClose', result: { status: 'closed', ok: true } },
        ],
      }),
    },
  });
  await assert.rejects(
    () => port.executeFenced(codingCommand({ id: 'gate-incomplete' }), { fence: 5, assertCurrentFence: () => true }),
    /submission gate|did not complete/i,
  );
});

test('duplicate control-plane dispatch returns the original evidence without a second PR lifecycle run', async () => {
  let invocations = 0;
  const port = createCodingControlPlanePort({
    hostAdapter: { runTakeIssueToDone: async () => { invocations += 1; return completedOrchestration(); } },
  });
  const context = { fence: 8, assertCurrentFence: () => true };
  const first = await port.executeFenced(codingCommand(), context);
  const second = await port.executeFenced(codingCommand(), context);
  assert.equal(invocations, 1);
  assert.strictEqual(second, first);
});

test('completed command cache returns before fence assertion on redelivery', async () => {
  let invocations = 0;
  let fenceCalls = 0;
  const port = createCodingControlPlanePort({
    hostAdapter: {
      runTakeIssueToDone: async () => {
        invocations += 1;
        return completedOrchestration();
      },
    },
  });

  const first = await port.executeFenced(codingCommand({ id: 'cache-before-fence' }), {
    fence: 1,
    assertCurrentFence: () => {
      fenceCalls += 1;
      return true;
    },
  });
  assert.equal(invocations, 1);
  assert.ok(fenceCalls >= 1);

  const fenceCallsAfterFirst = fenceCalls;
  const second = await port.executeFenced(codingCommand({ id: 'cache-before-fence' }), {
    fence: 1,
    assertCurrentFence: () => {
      fenceCalls += 1;
      throw new Error('stale_fence');
    },
  });
  assert.equal(invocations, 1);
  assert.strictEqual(second, first);
  // Cache hit must not call assertCurrentFence (redelivery after lease release).
  assert.equal(fenceCalls, fenceCallsAfterFirst);
});

test('target-fenced final side effects assert fence at mutation stage boundaries', async () => {
  const fenceLog = [];
  let live = true;
  const adapters = buildAdapters([]);
  const originalOpen = adapters.pullRequest.openPullRequest;
  adapters.pullRequest.openPullRequest = async (input) => {
    fenceLog.push(['enter-pullRequest', Boolean(input.assertCurrentFence), input.fence]);
    assert.equal(typeof input.assertCurrentFence, 'function');
    input.assertCurrentFence();
    return originalOpen(input);
  };
  adapters.postMerge.sweep = async (input) => {
    fenceLog.push(['enter-postMergeSweep', Boolean(input.assertCurrentFence), input.fence]);
    input.assertCurrentFence();
    return { status: 'completed' };
  };
  adapters.tracker.verifyAndClose = async (input) => {
    fenceLog.push(['enter-verifyClose', Boolean(input.assertCurrentFence), input.fence]);
    input.assertCurrentFence();
    return { status: 'closed', ok: true };
  };

  const port = createCodingControlPlanePort({ host: 'codex', adapters });
  await port.executeFenced(codingCommand({ id: 'fence-boundaries' }), {
    fence: 42,
    assertCurrentFence: () => {
      if (!live) throw new Error('stale_fence');
      fenceLog.push(['assert', 42]);
      return true;
    },
  });

  assert.ok(fenceLog.some((entry) => entry[0] === 'enter-pullRequest' && entry[2] === 42));
  assert.ok(fenceLog.some((entry) => entry[0] === 'enter-postMergeSweep'));
  assert.ok(fenceLog.some((entry) => entry[0] === 'enter-verifyClose'));

  // Mid-flight supersession fails closed before later mutation stages.
  live = true;
  let hitVerify = false;
  const calls = [];
  const adversarial = buildAdapters(calls);
  adversarial.pullRequest.openPullRequest = async (input) => {
    live = false;
    input.assertCurrentFence(); // still current at entry...
    return { status: 'created', url: 'https://example.test/pr/2', ok: true };
  };
  adversarial.postMerge.sweep = async (input) => {
    // orchestrator re-asserts fence after stage; supersession should surface
    return { status: 'completed' };
  };
  adversarial.tracker.verifyAndClose = async () => {
    hitVerify = true;
    return { status: 'closed', ok: true };
  };
  const supersedePort = createCodingControlPlanePort({ host: 'codex', adapters: adversarial });
  await assert.rejects(
    () => supersedePort.executeFenced(codingCommand({ id: 'mid-flight-supersede' }), {
      fence: 7,
      assertCurrentFence: () => {
        if (!live) throw new Error('stale_fence');
        return true;
      },
    }),
    /stale_fence/,
  );
  assert.equal(hitVerify, false);
});

test('orchestrator reports deferred when verifyClose defers unmerged work', async () => {
  const calls = [];
  const adapters = buildAdapters(calls);
  adapters.pullRequest.openPullRequest = async () => ({ status: 'created', url: 'https://example.test/pr/3', state: 'OPEN', ok: true });
  adapters.tracker.verifyAndClose = async () => ({ status: 'deferred', reason: 'pull request not merged', ok: true });
  const result = await runTakeIssueToDone({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/deferred',
  }, adapters);
  assert.equal(result.status, 'deferred');
});

test('Claude Code host adapter registers MCP and skill surfaces then invokes orchestrator', async () => {
  const calls = [];
  const registrations = [];
  const adapter = createClaudeCodeHostAdapter({
    adapters: buildAdapters(calls),
    registry: {
      async registerMcpTool(tool) {
        registrations.push(['mcp', tool.name, typeof tool.handler]);
        return { ok: true, name: tool.name };
      },
      async registerSkill(skill) {
        registrations.push(['skill', skill.name, skill.invokes]);
        return { ok: true, name: skill.name };
      },
    },
  });

  const registered = await adapter.register();
  const result = await adapter.runTakeIssueToDone({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/claude-code',
  });

  assert.equal(registered.schemaVersion, HOST_ADAPTER_SCHEMA_VERSION);
  assert.equal(registered.host, 'claude-code');
  assert.deepEqual(registrations, [
    ['mcp', 'jarvos_coding_take_issue_to_done', 'function'],
    ['skill', 'jarvos-coding', 'jarvos_coding_take_issue_to_done'],
  ]);
  assert.equal(result.host, 'claude-code');
  assert.equal(result.result.status, 'completed');
  assert.deepEqual(calls, TAKE_ISSUE_TO_DONE_STAGES);
});

test('Codex host adapter can build runtime adapters lazily from each request', async () => {
  const calls = [];
  const adapter = createCodexHostAdapter({
    adapters: async (input, context) => {
      assert.equal(context.host, 'codex');
      assert.equal(input.issueIdentifier, 'SUP-2214');
      return buildAdapters(calls);
    },
  });

  assert.equal(adapter.host, 'codex');
  assert.equal(adapter.mcpTool.name, 'jarvos_coding_take_issue_to_done');

  const result = await adapter.runTakeIssueToDone({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/codex',
  });

  assert.equal(result.host, 'codex');
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, TAKE_ISSUE_TO_DONE_STAGES);
});
