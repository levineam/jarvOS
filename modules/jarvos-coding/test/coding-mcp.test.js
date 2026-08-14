'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TOOLS, callTool, handle } = require('../scripts/jarvos-coding-mcp');

const DIGEST = 'a'.repeat(64);
const packet = { version: 'jarvos-implementation-packet/v1', planDigest: DIGEST, steps: [{ id: 'step_1', description: 'Implement bounded change', files: ['src/example.js'] }] };

function fixture() {
  const calls = [];
  const workflow = Object.fromEntries(['plan', 'acceptPlan', 'work', 'finish', 'status', 'resume'].map((operation) => [operation, async (input) => {
    calls.push([operation, input]);
    return { ok: true, status: 'succeeded', workRunId: input.workRunId, root: '/private/root', credential: 'secret=hidden' };
  }]));
  const runtime = {
    listRepositories: () => [{ repositoryId: 'repo_fixture', label: 'Fixture', agentSelectable: true }],
    health: () => ({ status: 'ok', root: '/private/root' }),
    resolveRequest(input) {
      assert.equal(input.repositoryId, 'repo_fixture');
      return { repositoryId: 'repo_fixture', subjectKey: 'repo_fixture:ORG-1', workRunId: input.workRunId || 'run_fixture', repository: { acceptancePolicy: { mode: 'human-evidence-required' } }, managedWorkflow: workflow };
    },
  };
  return { calls, options: { registryPath: '/host/registry.json', createRuntime: () => runtime, resolveOwnerAcceptance: ({ packetDigest }) => ({ source: 'owner-action-record', observedAt: '2026-08-14T00:00:00.000Z', planDigest: DIGEST, packetDigest }) } };
}
function result(response) { return JSON.parse(response.content[0].text); }

test('public coding MCP exposes only managed operations', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['jarvos_coding_plan', 'jarvos_coding_accept_plan', 'jarvos_coding_work', 'jarvos_coding_finish', 'jarvos_coding_status', 'jarvos_coding_resume', 'jarvos_coding_repositories', 'jarvos_coding_health']);
  assert.equal(TOOLS.some((tool) => /complete|compound/.test(tool.name)), false);
});

test('routes direct managed plan, acceptance, work, finish, status, and resume operations', async () => {
  const f = fixture(); const base = { repositoryId: 'repo_fixture', subjectKey: 'ORG-1', workRunId: 'run_fixture' };
  await callTool('jarvos_coding_plan', { ...base, input: { kind: 'issue', digest: DIGEST } }, f.options);
  await callTool('jarvos_coding_accept_plan', { ...base, planDigest: DIGEST, packet, artifact: { reference: 'artifact:plan_123456' } }, f.options);
  await callTool('jarvos_coding_work', { ...base, planDigest: DIGEST, packet }, f.options);
  await callTool('jarvos_coding_finish', { ...base, planDigest: DIGEST }, f.options);
  await callTool('jarvos_coding_status', base, f.options);
  const response = await callTool('jarvos_coding_resume', base, f.options);
  assert.deepEqual(f.calls.map(([operation]) => operation), ['plan', 'acceptPlan', 'work', 'finish', 'status', 'resume']);
  assert.equal(f.calls[1][1].acceptanceEvidence.source, 'owner-action-record');
  assert.equal(f.calls[3][1].issueIdentifier, 'ORG-1');
  assert.equal(f.calls[3][1].subjectKey, 'repo_fixture:ORG-1');
  assert.equal(JSON.stringify(result(response)).includes('/private/root'), false);
  assert.equal(JSON.stringify(result(response)).includes('secret=hidden'), false);
});

test('fails closed for malformed, unknown, and model-supplied authority input', async () => {
  const f = fixture(); const base = { repositoryId: 'repo_fixture', subjectKey: 'ORG-1' };
  await assert.rejects(() => callTool('jarvos_coding_status', { ...base, root: '/tmp/nope' }, f.options), /not allowed/);
  await assert.rejects(() => callTool('jarvos_coding_work', { ...base, planDigest: DIGEST, packet: { ...packet, credential: 'x' } }, f.options), /not allowed/);
  await assert.rejects(() => callTool('jarvos_coding_unknown', base, f.options), /Unknown tool/);
  await assert.rejects(() => callTool('jarvos_coding_plan', { ...base, input: { kind: 'issue', digest: 'bad' } }, f.options), /digest/);
});

test('public finish and resume consume owner learning actions without trusting caller flags', async () => {
  const f = fixture();
  const options = {
    ...f.options,
    resolveOwnerLearningAction: ({ action }) => ({ action, source: 'owner-action-record' }),
  };
  const base = { repositoryId: 'repo_fixture', subjectKey: 'ORG-1', workRunId: 'run_fixture' };
  await callTool('jarvos_coding_finish', { ...base, planDigest: DIGEST }, options);
  await callTool('jarvos_coding_resume', base, options);
  const finishInput = f.calls.find(([operation]) => operation === 'finish')[1];
  const resumeInput = f.calls.find(([operation]) => operation === 'resume')[1];
  assert.equal(finishInput.declineLearning, true);
  assert.equal(resumeInput.resetLearningRetry, true);
});

test('handles initialize, tools/list, and tools/call with JSON-RPC', async () => {
  const written = []; const original = process.stdout.write; process.stdout.write = (line) => { written.push(JSON.parse(line)); return true; };
  try {
    await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'jarvos_coding_repositories', arguments: {} } }, fixture().options);
  } finally { process.stdout.write = original; }
  assert.equal(written[0].result.serverInfo.name, 'jarvos-coding');
  assert.equal(written[1].result.tools.length, TOOLS.length);
  assert.equal(result(written[2].result).repositories[0].repositoryId, 'repo_fixture');
});
