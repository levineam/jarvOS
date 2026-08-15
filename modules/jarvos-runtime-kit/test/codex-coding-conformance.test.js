'use strict';

// Deterministic, clean-profile proof for the *public* coding MCP surface.
// The provider and tracker adapters are deliberately local doubles: this test
// does not claim that a hosted Codex/provider session was observed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const coding = require(path.join(ROOT, 'modules/jarvos-coding/src'));
const { handle } = require(path.join(ROOT, 'modules/jarvos-coding/scripts/jarvos-coding-mcp'));

const DIGEST = 'c'.repeat(64);
const RUN_ID = 'run_conformance_01';
const SUBJECT = 'CONFORM-1';
const packet = { version: 'jarvos-implementation-packet/v1', planDigest: DIGEST, summary: 'Apply the accepted fixture change.', steps: [{ id: 'step_01', description: 'Update the public fixture.', files: ['fixture.txt'] }] };

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function providerSnapshot() {
  const manifest = require(path.join(ROOT, 'modules/jarvos-coding/providers/compound-engineering.json'));
  return { id: manifest.id, version: manifest.version, pinDigest: manifest.source.contentDigest, harness: 'codex', adapterVersion: manifest.harnesses.codex.adapter, status: 'verified' };
}
function providerReceipt(invocation, operation) {
  return {
    version: 'jarvos-workflow-provider-receipt/v1', operation, status: 'succeeded',
    workRunId: invocation.workRunId, operationNonce: invocation.operationNonce, idempotencyKey: invocation.idempotencyKey,
    provider: invocation.provider, artifact: { kind: operation, reference: `artifact:${operation}_fixture_001`, path: `/var/lib/jarvos/${operation}.json`, digest: operation === 'plan' ? DIGEST : sha(operation) },
    planRevisionDigest: operation === 'plan' ? DIGEST : null,
    acceptedPlanDigest: operation === 'plan' ? null : DIGEST,
    publicLabel: `Fixture ${operation} receipt`, diagnostics: [],
  };
}
function successfulAdapters() {
  return {
    reviewEngine: {
      sliceReview: async () => ({ status: 'passed', artifact: 'slice.json', summary: 'fixture review' }),
      holisticReview: async () => ({ status: 'passed', artifact: 'holistic.json', summary: 'fixture review' }),
    },
    tracker: {
      claimIssue: async () => ({ status: 'claimed', ok: true, workReference: { authority: 'fixture', itemId: SUBJECT } }),
      verifyAndClose: async () => ({ status: 'closed', ok: true, liveConfirmed: true }),
    },
    git: { createBranch: async ({ branch }) => ({ status: 'created', branch, ok: true }) },
    fixer: { fixAndRerun: async () => ({ status: 'passed', ok: true, git: { clean: true, status: 'clean' } }) },
    pullRequest: { openPullRequest: async () => ({ status: 'created', url: 'https://example.test/pr/1', state: 'MERGED', ok: true }) },
    postMerge: { sweep: async () => ({ status: 'completed', ok: true }) },
  };
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coding-conformance-'));
  const repository = path.join(base, 'fixture-repository');
  const stateRoot = path.join(base, 'state');
  const worktreeRoot = path.join(base, 'worktrees');
  const codexHome = path.join(base, 'codex-home');
  const registryPath = path.join(base, 'registry.json');
  fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  run('git', ['init', '--initial-branch=main'], repository);
  run('git', ['config', 'user.email', 'fixture@example.test'], repository);
  run('git', ['config', 'user.name', 'Public Fixture'], repository);
  fs.writeFileSync(path.join(repository, 'fixture.txt'), 'fixture\n');
  run('git', ['add', 'fixture.txt'], repository);
  run('git', ['commit', '-m', 'fixture'], repository);
  const provisioned = coding.provisionRepository({ registryPath, repository: {
    publicLabel: 'Conformance fixture', agentSelectable: true, root: repository, stateRoot,
    worktreePolicy: { root: worktreeRoot }, tracker: { kind: 'fixture' },
    acceptancePolicy: { mode: 'human-evidence-required' }, providerEgressPolicy: { classes: ['plan'] }, credentialReferences: {},
    learning: { enabled: true }, learningPublicationTarget: 'fixture:learning',
  } });
  return { base, repository, stateRoot, worktreeRoot, codexHome, registryPath, repositoryId: provisioned.repository.repositoryId, nativeWorkCalls: 0, learningCalls: 0 };
}

function runtimeFor(f, behavior = {}) {
  const snapshot = providerSnapshot();
  const nativeAdapter = {
    plan: async () => ({ artifact: 'native-plan' }),
    reconcileWork: async () => ({ safe: true, reasonCode: 'fixture-reconciled' }),
    work: async () => {
      f.nativeWorkCalls += 1;
      const worktree = path.join(f.worktreeRoot, RUN_ID);
      if (!fs.existsSync(worktree)) run('git', ['worktree', 'add', '-b', `coding/${RUN_ID}`, worktree, 'HEAD'], f.repository);
      return { artifact: 'native-work' };
    },
  };
  const managedWorkflow = {
    providerSnapshot: snapshot,
    providerAdapter: {
      plan: async (invocation) => providerReceipt(invocation, 'plan'),
      // A deterministic provider-boundary outage forces the tested public
      // native fallback while preserving the run identity.
      work: async () => { throw new Error('fixture provider unavailable'); },
      compound: async (invocation) => { f.learningCalls += 1; return providerReceipt(invocation, 'compound'); },
    },
  };
  const runtime = coding.createCodexRuntime({ registryPath: f.registryPath, nativeAdapter, managedWorkflow });
  const context = runtime.resolveRequest({ repositoryId: f.repositoryId, subjectKey: SUBJECT, workRunId: RUN_ID });
  const workflow = context.managedWorkflow;
  // The public MCP accepts no model-controlled verification inputs. The test
  // harness supplies bounded, public adapter doubles behind that boundary.
  return {
    ...runtime,
    resolveRequest(input) {
      const resolved = runtime.resolveRequest(input);
      const bound = (method) => (value) => workflow[method]({ ...value, canonicalWorktree: resolved.canonicalWorktree });
      return {
        ...resolved,
        managedWorkflow: {
          ...workflow,
          plan: bound('plan'), acceptPlan: bound('acceptPlan'), work: bound('work'),
          status: bound('status'), resume: bound('resume'),
          finish: (finishInput) => {
            const adapters = successfulAdapters();
            if (behavior.deferredFinish) adapters.tracker.verifyAndClose = async () => ({ status: 'deferred', ok: true });
            return workflow.finish({ ...finishInput, canonicalWorktree: resolved.canonicalWorktree, nonRoutine: true }, adapters);
          },
        },
      };
    },
  };
}

async function rpc(message, options) {
  const output = [];
  const original = process.stdout.write;
  process.stdout.write = (line) => { output.push(JSON.parse(line)); return true; };
  try { await handle(message, options); } finally { process.stdout.write = original; }
  assert.equal(output.length, 1);
  return output[0];
}
async function tool(f, name, argumentsValue, behavior = {}) {
  const response = await rpc({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: argumentsValue } }, { registryPath: f.registryPath, createRuntime: () => runtimeFor(f, behavior) });
  assert.ok(response.result, response.error?.message);
  return JSON.parse(response.result.content[0].text);
}

function receiptValidation(receipt, revision) {
  const requiredOperations = ['initialize', 'tools/list', 'plan', 'accept-plan', 'work', 'finish', 'status', 'resume'];
  const missing = requiredOperations.filter((operation) => !receipt.operations.includes(operation));
  if (receipt.schemaVersion !== 'jarvos-codex-coding-lifecycle-conformance/v1') return 'schemaVersion is invalid';
  if (receipt.jarvosRevision !== revision) return 'receipt revision is stale';
  if (missing.length) return `missing operations: ${missing.join(', ')}`;
  if (receipt.restart?.sameRun !== true || receipt.restart?.sameWorktree !== true) return 'restart proof is incomplete';
  if (receipt.verification?.authoritative !== true || receipt.finalizer?.automatic !== true) return 'status-only completion is not accepted';
  return null;
}

function routingConformance(receipt, corpus, revision) {
  const managed = corpus?.classes?.filter((entry) => entry.kind === 'managed-intent') || [];
  const controls = corpus?.classes?.filter((entry) => entry.kind === 'control') || [];
  const errors = [];
  if (corpus?.schemaVersion !== 'jarvos-codex-coding-routing-prompts/v1') errors.push('prompt corpus schema is invalid');
  if (managed.length < 1 || controls.length < 1) errors.push('prompt corpus must include managed and control classes');
  for (const entry of managed) {
    if (!Array.isArray(entry.prompts) || entry.prompts.length < 10) errors.push(`${entry.id} has fewer than 10 prompts`);
    if (entry.minimumPrompts !== 10 || entry.minimumSelectionRate !== 0.9) errors.push(`${entry.id} does not declare the 90% threshold`);
  }
  for (const entry of controls) {
    if (!Array.isArray(entry.prompts) || entry.prompts.length < 10) errors.push(`${entry.id} has fewer than 10 prompts`);
    if (entry.minimumPrompts !== 10 || entry.maximumFalseManagedRunClaims !== 0) errors.push(`${entry.id} does not declare the zero-false threshold`);
  }
  if (receipt?.schemaVersion !== 'jarvos-codex-coding-routing-conformance/v1') errors.push('routing receipt schema is invalid');
  if (receipt?.jarvosRevision !== revision) errors.push('routing receipt is stale');
  if (receipt?.promptCorpus?.digest !== sha(stableJson(corpus))) errors.push('routing receipt prompt digest is stale');
  if (receipt?.directInvocation?.status !== 'passed') errors.push('deterministic direct invocation is not proven');
  const naturalRoutingClaimAllowed = receipt?.status === 'passed'
    && errors.length === 0
    && managed.every((entry) => {
      const result = receipt.results?.find((candidate) => candidate.classId === entry.id);
      return result && result.promptCount >= entry.minimumPrompts && result.selected / result.promptCount >= entry.minimumSelectionRate;
    })
    && controls.every((entry) => {
      const result = receipt.results?.find((candidate) => candidate.classId === entry.id);
      return result && result.promptCount >= entry.minimumPrompts && result.falseManagedRunClaims === 0;
    });
  return { errors, naturalRoutingClaimAllowed };
}

test('clean-profile public MCP lifecycle is deterministic, gated, recoverable, and public-safe', async () => {
  const f = fixture();
  try {
    const options = { registryPath: f.registryPath, createRuntime: () => runtimeFor(f) };
    const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, options);
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, options);
    assert.equal(initialized.result.serverInfo.name, 'jarvos-coding');
    assert.ok(listed.result.tools.some((entry) => entry.name === 'jarvos_coding_finish'));

    const base = { repositoryId: f.repositoryId, subjectKey: SUBJECT, workRunId: RUN_ID };
    const planned = await tool(f, 'jarvos_coding_plan', { ...base, input: { kind: 'fixture', digest: DIGEST } });
    assert.equal(planned.workRunId, RUN_ID);
    const denied = await tool(f, 'jarvos_coding_accept_plan', { ...base, planDigest: DIGEST, packet });
    assert.equal(denied.status, 'awaiting-plan-acceptance');

    coding.recordOwnerAction({ registryPath: f.registryPath, repositoryId: f.repositoryId, action: 'accept-plan', runId: RUN_ID, revision: DIGEST, packetDigest: sha(JSON.stringify(packet)) });
    const accepted = await tool(f, 'jarvos_coding_accept_plan', { ...base, planDigest: DIGEST, packet, artifact: { reference: 'artifact:plan_fixture_001' } });
    assert.equal(accepted.ok, true);
    const worked = await tool(f, 'jarvos_coding_work', { ...base, planDigest: DIGEST, packet });
    assert.equal(worked.route, 'native-fallback');
    assert.equal(worked.workRunId, RUN_ID);
    assert.equal(f.nativeWorkCalls, 1);

    const finished = await tool(f, 'jarvos_coding_finish', { ...base, planDigest: DIGEST });
    assert.equal(finished.primaryCompletion, 'completed');
    assert.equal(finished.verification.status, 'completed');
    assert.equal(finished.learning.learningStatus, 'captured');
    assert.equal(f.learningCalls, 1);

    const resumed = await tool(f, 'jarvos_coding_resume', base);
    const status = await tool(f, 'jarvos_coding_status', base);
    assert.equal(resumed.workRunId, RUN_ID);
    assert.equal(status.primaryCompletion, 'completed');
    assert.equal(f.learningCalls, 1, 'restart/resume must not publish learning twice');
    assert.equal(f.nativeWorkCalls, 1, 'restart must not create a duplicate native worktree');
    assert.equal(run('git', ['worktree', 'list', '--porcelain'], f.repository).match(/^worktree /gm).length, 2);
    assert.match(run('git', ['branch', '--list', `coding/${RUN_ID}`], f.repository), new RegExp(`^[*+] coding/${RUN_ID}$`));

    const publicState = JSON.stringify(status);
    assert.doesNotMatch(publicState, new RegExp(f.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(publicState, /credential|secret|token/i);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});

test('receipt contract fails closed for stale, incomplete, and status-only claims', () => {
  const receipt = require(path.join(ROOT, 'runtimes/codex/coding-lifecycle-conformance.json'));
  assert.equal(receiptValidation(receipt, receipt.jarvosRevision), null);
  assert.match(receiptValidation({ ...receipt, jarvosRevision: '0'.repeat(40) }, receipt.jarvosRevision), /stale/);
  assert.match(receiptValidation({ ...receipt, operations: ['plan'] }, receipt.jarvosRevision), /missing operations/);
  assert.match(receiptValidation({ ...receipt, verification: { authoritative: false }, finalizer: { automatic: true } }, receipt.jarvosRevision), /status-only/);
  assert.doesNotMatch(JSON.stringify(receipt), /\/Users\/|clawd|Bearer\s|api[_-]?key|token\s*[:=]|secret\s*[:=]/i);
});

test('routing conformance keeps natural claims behind current live evidence while preserving direct invocation', () => {
  const corpus = require(path.join(ROOT, 'runtimes/codex/coding-conformance-prompts.json'));
  const receipt = require(path.join(ROOT, 'runtimes/codex/coding-routing-conformance.json'));
  const current = routingConformance(receipt, corpus, receipt.jarvosRevision);
  assert.deepEqual(current.errors, []);
  assert.equal(current.naturalRoutingClaimAllowed, false, 'an unavailable live receipt cannot support natural-routing claims');
  assert.equal(receipt.directInvocation.status, 'passed', 'deterministic direct invocation remains a separately proven claim');

  assert.match(routingConformance({ ...receipt, jarvosRevision: '0'.repeat(40) }, corpus, receipt.jarvosRevision).errors.join('\n'), /stale/);
  assert.match(routingConformance({ ...receipt, status: 'unavailable', promptCorpus: { ...receipt.promptCorpus, digest: '0'.repeat(64) } }, corpus, receipt.jarvosRevision).errors.join('\n'), /prompt digest/);
  const shortened = { ...corpus, classes: corpus.classes.map((entry) => entry.id === 'plan' ? { ...entry, prompts: entry.prompts.slice(0, 9) } : entry) };
  assert.match(routingConformance(receipt, shortened, receipt.jarvosRevision).errors.join('\n'), /fewer than 10 prompts|prompt digest/);
  assert.doesNotMatch(JSON.stringify({ corpus, receipt }), /\/Users\/|clawd|Bearer\s|api[_-]?key|token\s*[:=]|secret\s*[:=]/i);
});

test('incomplete public finish does not publish a learning', async () => {
  const f = fixture();
  try {
    const base = { repositoryId: f.repositoryId, subjectKey: SUBJECT, workRunId: RUN_ID };
    await tool(f, 'jarvos_coding_plan', { ...base, input: { kind: 'fixture', digest: DIGEST } });
    coding.recordOwnerAction({ registryPath: f.registryPath, repositoryId: f.repositoryId, action: 'accept-plan', runId: RUN_ID, revision: DIGEST, packetDigest: sha(JSON.stringify(packet)) });
    await tool(f, 'jarvos_coding_accept_plan', { ...base, planDigest: DIGEST, packet, artifact: { reference: 'artifact:plan_fixture_001' } });
    const finished = await tool(f, 'jarvos_coding_finish', { ...base, planDigest: DIGEST }, { deferredFinish: true });
    assert.equal(finished.primaryCompletion, 'deferred');
    assert.equal(finished.learning.status, 'not-eligible');
    assert.equal(f.learningCalls, 0);
  } finally { fs.rmSync(f.base, { recursive: true, force: true }); }
});
