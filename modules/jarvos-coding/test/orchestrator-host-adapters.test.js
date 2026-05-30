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
