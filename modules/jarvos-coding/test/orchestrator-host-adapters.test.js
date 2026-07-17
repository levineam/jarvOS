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
        return { status: 'passed' };
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
    { stage: 'fixRerun', result: { status: 'passed' } },
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

test('default host composition honors resumeFrom and skips completed lifecycle stages', async () => {
  const calls = [];
  const adapters = buildAdapters(calls);
  const host = createCodingHostAdapter('codex', { adapters });
  const checkpoint = {
    phase: 'pullRequest',
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/existing',
    pr: 'https://example.test/pr/99',
    pullRequest: { status: 'exists', url: 'https://example.test/pr/99', ok: true, merged: true },
  };

  const wrapped = await host.runTakeIssueToDone({
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/existing',
    resumeFrom: checkpoint,
  });

  assert.equal(wrapped.result.status, 'completed');
  assert.deepEqual(calls, ['postMergeSweep', 'verifyClose']);
  assert.equal(wrapped.result.continuity.resumedFromStageIndex, TAKE_ISSUE_TO_DONE_STAGES.indexOf('postMergeSweep'));
  assert.ok(wrapped.result.events.filter((event) => event.reattached).length >= 6);
  assert.equal(wrapped.result.events.find((event) => event.stage === 'pullRequest').result.url, 'https://example.test/pr/99');
});

test('control-plane default path resumes from checkpoint without re-running completed stages', async () => {
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

  assert.deepEqual(calls, ['pullRequest', 'postMergeSweep', 'verifyClose']);
  assert.equal(execution.status, 'completed');
  assert.equal(execution.submissionEvidence.verifyClose.status, 'closed');
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
