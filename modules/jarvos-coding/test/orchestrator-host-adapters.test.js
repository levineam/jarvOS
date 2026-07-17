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
      async verifyAndClose() {
        calls.push('verifyClose');
        return { status: 'closed' };
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
        return { status: 'created', url: 'https://github.com/example/repo/pull/1' };
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

function completedOrchestration(overrides = {}) {
  return {
    status: 'completed',
    issueIdentifier: 'SUP-2214',
    branch: 'SUP-2214/control-plane',
    checkpoints: [{ codeThread: { stage: 'verifyClose', nextStep: 'complete' } }],
    events: [
      { stage: 'pullRequest', result: { status: 'created', url: 'https://example.test/pr/1' } },
      { stage: 'postMergeSweep', result: { status: 'completed' } },
      { stage: 'verifyClose', result: { status: 'closed' } },
    ],
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
  assert.equal(verification.outcome, 'satisfied');
  assert.equal(seen[0].issueIdentifier, 'SUP-2214');
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
