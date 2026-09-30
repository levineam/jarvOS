'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DELIVERY_TRACE_SCHEMA_VERSION,
  buildLiveCodingAdapters,
  buildMcpToolDescriptor,
  createClawpatchAutoreviewAdapter,
  createCodexHostAdapter,
  createCodingControlPlanePort,
  createLiveFixer,
  createLiveGitBranch,
  createLivePullRequest,
  createManagedCodingWorkflow,
  createMemoryWorkRunStore,
  evaluateDeliveryTrace,
  evaluateSubmissionGate,
  observePlan,
  validateSubmissionEvidence,
} = require('../src');

const manifest = require('../providers/compound-engineering.json');

const IDENTIFIER = 'SUP-4029';
const BRANCH = 'SUP-4029/delivery-trace';
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const PLAN_PATH = 'docs/plans/2026-09-30-SUP-4029-approval-doc-trace.md';
const PLAN_TEXT = '# SUP-4029 — approved plan to documentation, implementation, and proof\n';
const README = 'modules/jarvos-coding/README.md';
const SOURCE = 'modules/jarvos-coding/src/lifecycle/policy.js';
const SOURCE_ONLY_CLAIMS = { source: 'proven', installed: 'not-claimed', live: 'not-claimed' };

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// What the host reads from Git after the fix stage. Never caller-declared.
function observation(overrides = {}) {
  return {
    headCommit: HEAD,
    changedFiles: [PLAN_PATH, README, SOURCE],
    plan: { digest: sha256(PLAN_TEXT), mentionsWorkIdentifier: true },
    ...overrides,
  };
}

function behavioralProof(overrides = {}) {
  return {
    kind: 'behavioral',
    level: 'source',
    criterion: 'A completion claim fails closed when the plan, documentation, implementation, and proof path is absent or stale.',
    claim: 'Trace-less terminal completion is blocked and a valid source trace completes.',
    command: 'node --test modules/jarvos-coding/test/delivery-trace.test.js',
    observation: 'The focused cases failed before the change and passed at this head.',
    status: 'passed',
    headCommit: HEAD,
    ...overrides,
  };
}

function genericProof() {
  return [
    { kind: 'tests', level: 'source', command: 'npm test', status: 'passed', headCommit: HEAD },
    { kind: 'review', level: 'source', artifact: 'autoreview.json', status: 'passed', headCommit: HEAD },
  ];
}

// What the agent declares. Pointer-only: paths, digests, and commit ids.
function trace(overrides = {}) {
  return {
    schemaVersion: 'jarvos-coding-delivery-trace/v1',
    workIdentifier: IDENTIFIER,
    plan: { path: PLAN_PATH, digest: sha256(PLAN_TEXT) },
    docImpact: { decision: 'affected', docs: [README] },
    implementation: { headCommit: HEAD, changedFiles: [PLAN_PATH, README, SOURCE] },
    proof: [behavioralProof()],
    ...overrides,
  };
}

const BROKEN_LINKS = [
  ['no trace', { trace: null }, 'delivery_trace_missing'],
  ['a tracker URL is the only plan link', { trace: trace({ plan: { url: 'https://paperclip.example/SUP/issues/SUP-4029', approvalRef: 'approved' } }) }, 'plan_missing'],
  ['the plan path escapes the repository', { trace: trace({ plan: { path: '../plans/SUP-4029.md', digest: sha256(PLAN_TEXT) } }) }, 'plan_missing'],
  ['the trace names other work', { trace: trace({ workIdentifier: 'SUP-3981' }) }, 'plan_identity_mismatch'],
  ['the linked plan belongs to other work', { observed: observation({ plan: { digest: sha256(PLAN_TEXT), mentionsWorkIdentifier: false } }) }, 'plan_identity_mismatch'],
  ['the plan changed after its digest was pinned', { observed: observation({ plan: { digest: sha256(`${PLAN_TEXT}edited\n`), mentionsWorkIdentifier: true } }) }, 'plan_stale'],
  ['the plan differs from the accepted managed revision', { observed: observation({ acceptedPlanDigest: 'c'.repeat(64) }) }, 'plan_stale'],
  ['the documentation decision is omitted', { trace: trace({ docImpact: undefined }) }, 'doc_impact_missing'],
  ['the no-doc decision has a placeholder reason', { trace: trace({ docImpact: { decision: 'none', reason: 'n/a' } }) }, 'doc_impact_reason_missing'],
  ['an affected doc is absent from the observed change', { trace: trace({ docImpact: { decision: 'affected', docs: ['docs/architecture/doctor-health-modules.md'] } }) }, 'doc_not_updated'],
  ['the Git head moved after the trace', { observed: observation({ headCommit: OTHER_HEAD }) }, 'implementation_stale'],
  ['the declared files differ from Git', { observed: observation({ changedFiles: [PLAN_PATH, README, SOURCE, 'modules/jarvos-coding/src/adapters/hosts.js'] }) }, 'implementation_mismatch'],
  ['only generic tests and review are recorded', { trace: trace({ proof: genericProof() }) }, 'behavioral_proof_missing'],
  ['the behavioral proof ran at another commit', { trace: trace({ proof: [behavioralProof({ headCommit: OTHER_HEAD })] }) }, 'proof_stale'],
  ['there is no authentic Git observation', { observed: null }, 'observation_unavailable'],
];

test('delivery trace blocks each broken link for its own reason', () => {
  for (const [name, given, reason] of BROKEN_LINKS) {
    const result = evaluateDeliveryTrace(
      Object.hasOwn(given, 'trace') ? given.trace : trace(),
      { identifier: IDENTIFIER, observed: Object.hasOwn(given, 'observed') ? given.observed : observation() },
    );
    assert.equal(result.ok, false, name);
    assert.ok(result.reasons.includes(reason), `${name}: ${JSON.stringify(result.reasons)}`);
  }
});

test('a valid source trace passes, including a specific no-doc-impact decision', () => {
  const affected = evaluateDeliveryTrace(trace(), { identifier: IDENTIFIER, observed: observation() });
  assert.equal(DELIVERY_TRACE_SCHEMA_VERSION, 'jarvos-coding-delivery-trace/v1');
  assert.deepEqual([affected.ok, affected.reasons], [true, []]);

  const sourceOnly = [PLAN_PATH, SOURCE];
  const noDocImpact = evaluateDeliveryTrace(trace({
    docImpact: { decision: 'none', reason: 'Internal gate mapping only; no exported name, option, or documented behavior changes.' },
    implementation: { headCommit: HEAD, changedFiles: sourceOnly },
  }), { identifier: IDENTIFIER, observed: observation({ changedFiles: sourceOnly }) });
  assert.deepEqual([noDocImpact.ok, noDocImpact.reasons], [true, []]);

  assert.deepEqual(observePlan(PLAN_TEXT, IDENTIFIER), { digest: sha256(PLAN_TEXT), mentionsWorkIdentifier: true });
  assert.equal(observePlan('# SUP-3981 plan\n', IDENTIFIER).mentionsWorkIdentifier, false);
});

test('source proof never promotes installed or live claims', () => {
  const context = { identifier: IDENTIFIER, observed: observation() };
  assert.deepEqual(evaluateDeliveryTrace(trace(), context).claims, SOURCE_ONLY_CLAIMS);

  const overclaimed = evaluateDeliveryTrace(trace({ proof: [behavioralProof(), behavioralProof({ level: 'live' })] }), context);
  assert.equal(overclaimed.ok, false);
  assert.ok(overclaimed.reasons.includes('proof_level_unsupported'), JSON.stringify(overclaimed.reasons));
  assert.notEqual(overclaimed.claims.live, 'proven');
});

test('tracker data cannot change the delivery decision', () => {
  const context = { identifier: IDENTIFIER, observed: observation() };
  const unavailable = { tracker: { ok: false, status: 'unavailable' }, paperclipEvidence: { ok: false, status: 'unavailable' } };
  const approved = { tracker: { status: 'done', approved: true }, paperclipEvidence: { status: 'recorded', issueIdentifier: IDENTIFIER } };

  assert.deepEqual(
    evaluateDeliveryTrace(trace({ plan: { path: PLAN_PATH, digest: sha256(PLAN_TEXT), approvalRef: 'https://paperclip.example/SUP/issues/SUP-4029' } }), { ...context, ...unavailable }),
    evaluateDeliveryTrace(trace(), context),
  );
  assert.deepEqual(evaluateDeliveryTrace(null, { ...context, ...approved }), evaluateDeliveryTrace(null, context));
});

function handoffEvidence(extra = {}) {
  return {
    workIdentity: { identifier: IDENTIFIER },
    branch: BRANCH,
    tests: { status: 'passed' },
    clawpatch: { status: 'passed' },
    autoreview: { status: 'recorded' },
    goalAlignment: { status: 'aligned' },
    pullRequest: { status: 'created', url: 'https://example.test/pr/4029' },
    ...extra,
  };
}

function policyInput(extra = {}) {
  return {
    workIdentity: { identifier: IDENTIFIER },
    git: { branch: BRANCH, baseBranch: 'origin/main', clean: true, intendedFiles: [SOURCE] },
    checks: {
      tests: [{ command: 'npm test', status: 'passed' }],
      clawpatch: { status: 'passed' },
      autoreview: { status: 'recorded' },
      goalAlignment: { status: 'aligned' },
      pullRequest: { status: 'created', url: 'https://example.test/pr/4029' },
    },
    goal: 'Retain the plan, documentation, implementation, and proof path.',
    ...extra,
  };
}

test('both submission checks reject green tests and review that lack a behavioral delivery trace', () => {
  for (const [name, deliveryTrace] of [['no trace', undefined], ['generic proof only', trace({ proof: genericProof() })]]) {
    const handoff = validateSubmissionEvidence(handoffEvidence({ deliveryTrace, deliveryObservation: observation() }), { identifier: IDENTIFIER });
    assert.equal(handoff.ok, false, name);
    assert.deepEqual(handoff.missing, ['deliveryTrace'], name);

    const policy = evaluateSubmissionGate(policyInput({ deliveryTrace, deliveryObservation: observation() }));
    assert.equal(policy.ready, false, name);
    assert.deepEqual(policy.missing, ['delivery_trace'], name);
  }
});

test('both submission checks accept a valid source trace under the v3 contract', () => {
  const delivery = { deliveryTrace: trace(), deliveryObservation: observation() };

  const handoff = validateSubmissionEvidence(handoffEvidence(delivery), { identifier: IDENTIFIER });
  assert.equal(handoff.ok, true, JSON.stringify(handoff.reasons));
  assert.equal(handoff.schemaVersion, 'jarvos-coding-submission-gate/v3');

  const policy = evaluateSubmissionGate(policyInput(delivery));
  assert.equal(policy.ready, true, JSON.stringify(policy.missing));
  assert.equal(policy.schemaVersion, 'jarvos-coding-submission-gate/v3');
  assert.deepEqual(policy.deliveryTrace?.claims, SOURCE_ONLY_CLAIMS);

  // The no-code exception stays an exception; it is never reported as a submission.
  const intake = validateSubmissionEvidence({}, { identifier: IDENTIFIER, mode: 'intake-only' });
  assert.deepEqual([intake.ok, intake.decision, intake.missing], [true, 'document-exception', []]);
});

function adapters({ observed = observation() } = {}) {
  return {
    reviewEngine: createClawpatchAutoreviewAdapter({
      runner: async (payload) => ({ status: 'passed', artifact: `${payload.stage}.json`, summary: payload.tool }),
    }),
    tracker: {
      async claimIssue() { return { status: 'claimed' }; },
      async verifyAndClose() { return { status: 'closed', ok: true }; },
    },
    git: {
      async createBranch(input) { return { status: 'created', branch: input.branch }; },
    },
    fixer: {
      async fixAndRerun() {
        return {
          status: 'passed',
          git: { clean: true, status: 'clean', worktreePath: '/tmp/SUP-4029' },
          ...(observed ? { deliveryObservation: observed } : {}),
        };
      },
    },
    pullRequest: {
      async openPullRequest() { return { status: 'created', url: 'https://example.test/pr/4029', ok: true }; },
    },
    postMerge: {
      async sweep() { return { status: 'completed' }; },
    },
  };
}

test('direct host completion is blocked without a verified delivery trace and never closes the work', async () => {
  const cases = [
    ['green tests and review only', {}, observation(), 'delivery_trace_missing'],
    ['generic proof only', { deliveryTrace: trace({ proof: genericProof() }) }, observation(), 'behavioral_proof_missing'],
    ['caller-supplied observation', { deliveryTrace: trace(), deliveryObservation: observation() }, null, 'observation_unavailable'],
    ['head moved during the fix stage', { deliveryTrace: trace() }, observation({ headCommit: OTHER_HEAD }), 'implementation_stale'],
  ];
  for (const [name, input, observed, reason] of cases) {
    const host = createCodexHostAdapter({ adapters: adapters({ observed }) });
    const wrapped = await host.runTakeIssueToDone({ issueIdentifier: IDENTIFIER, branch: BRANCH, ...input });

    assert.equal(wrapped.status, 'blocked', name);
    assert.equal(wrapped.result.status, 'blocked', name);
    assert.ok(wrapped.result.deliveryGate?.reasons?.includes(reason), `${name}: ${JSON.stringify(wrapped.result.deliveryGate)}`);
    assert.equal(wrapped.result.events.some((event) => event.stage === 'verifyClose'), false, name);
  }
});

test('direct host completion succeeds with a valid source trace and claims source proof only', async () => {
  const host = createCodexHostAdapter({ adapters: adapters() });
  const wrapped = await host.runTakeIssueToDone({ issueIdentifier: IDENTIFIER, branch: BRANCH, deliveryTrace: trace() });

  assert.equal(wrapped.result.status, 'completed');
  assert.equal(wrapped.result.deliveryGate?.ok, true);
  assert.deepEqual(wrapped.result.deliveryGate?.claims, SOURCE_ONLY_CLAIMS);
  assert.deepEqual(wrapped.result.deliveryTrace, trace());

  // The trace is a declared input; the observation is never an MCP argument.
  const properties = buildMcpToolDescriptor('codex').inputSchema.properties;
  assert.equal(properties.deliveryTrace?.type, 'object');
  assert.equal(Object.hasOwn(properties, 'deliveryObservation'), false);
});

function managedComplete(acceptedPlanDigest) {
  const store = createMemoryWorkRunStore();
  const subjectKey = 'levineam/jarvOS:SUP-4029';
  const canonicalWorktree = '/private/jarvos/worktrees/SUP-4029';
  const claim = store.claimWorkRun({ subjectKey, canonicalWorktree, ownerId: 'agent:codex' });
  assert.equal(store.acceptPlan({
    workRunId: claim.workRunId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    planDigest: acceptedPlanDigest,
    artifact: { reference: 'artifact:plan123456', digest: acceptedPlanDigest },
  }).ok, true);
  const workflow = createManagedCodingWorkflow({ manifest, workRunStore: store, ownerId: 'agent:codex' });
  return (input = {}) => workflow.complete({
    subjectKey,
    canonicalWorktree,
    issueIdentifier: IDENTIFIER,
    branch: BRANCH,
    ...input,
  }, adapters());
}

test('managed completion requires the trace and binds it to the accepted plan revision', async () => {
  const acceptedDigest = sha256(PLAN_TEXT);

  const missing = await managedComplete(acceptedDigest)();
  assert.equal(missing.status, 'blocked');
  assert.ok(missing.deliveryGate?.reasons?.includes('delivery_trace_missing'), JSON.stringify(missing.deliveryGate));

  // The plan on the branch is not the revision that was accepted, and a caller
  // cannot restate the accepted digest to make them agree.
  const replaced = await managedComplete('c'.repeat(64))({ deliveryTrace: trace(), acceptedPlanDigest: acceptedDigest });
  assert.equal(replaced.status, 'blocked');
  assert.ok(replaced.deliveryGate?.reasons?.includes('plan_stale'), JSON.stringify(replaced.deliveryGate));

  const completed = await managedComplete(acceptedDigest)({ deliveryTrace: trace() });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.route, 'jarvos-orchestrator');
  assert.equal(completed.deliveryGate?.ok, true);
});

function codingCommand(id, args = {}) {
  return {
    id,
    mutationClass: 'coding.take-issue-to-done',
    desiredGeneration: 'generation-1',
    resource: { machineId: 'machine-1', type: 'paperclip-issue', id: IDENTIFIER },
    commandSpec: {
      operation: 'take-issue-to-done',
      arguments: { issueIdentifier: IDENTIFIER, branch: BRANCH, ...args },
    },
  };
}

// A host result that reports every stage green. `fix` is the fix-stage evidence.
function hostResult({ fix = { deliveryObservation: observation() }, ...top } = {}) {
  return {
    status: 'completed',
    issueIdentifier: IDENTIFIER,
    branch: BRANCH,
    baseRef: 'origin/main',
    events: [
      { stage: 'claim', result: { status: 'claimed', ok: true } },
      { stage: 'branch', result: { status: 'created', branch: BRANCH, ok: true } },
      { stage: 'sliceReview', result: { status: 'passed', artifact: 'slice.json', summary: 'clawpatch' } },
      { stage: 'holisticReview', result: { status: 'passed', artifact: 'holistic.json', summary: 'autoreview' } },
      { stage: 'fixRerun', result: { status: 'passed', git: { clean: true, status: 'clean', worktreePath: '/tmp/SUP-4029' }, ...fix } },
      { stage: 'pullRequest', result: { status: 'created', url: 'https://example.test/pr/4029', ok: true } },
      { stage: 'postMergeSweep', result: { status: 'completed' } },
      { stage: 'verifyClose', result: { status: 'closed', ok: true } },
    ],
    ...top,
  };
}

const FENCE = { fence: 1, assertCurrentFence: () => true };

test('control-plane execution rejects a completed host result without an authentically observed trace', async () => {
  const rows = [
    ['green tests and review only', hostResult({ fix: {} })],
    ['trace without a fix-stage observation', hostResult({ fix: {}, deliveryTrace: trace() })],
    ['observation supplied beside the result', hostResult({ fix: {}, deliveryTrace: trace(), deliveryObservation: observation() })],
    ['observation from an unconfirmed reattached fix stage', hostResult({ fix: { deliveryObservation: observation(), reattached: true }, deliveryTrace: trace() })],
    ['cached ready gate', hostResult({ fix: {}, submissionGate: { ready: true, missing: [] }, deliveryGate: { ok: true, reasons: [] } })],
  ];
  for (const [index, [name, result]] of rows.entries()) {
    const port = createCodingControlPlanePort({ hostAdapter: { runTakeIssueToDone: async () => result } });
    await assert.rejects(
      () => port.executeFenced(codingCommand(`rejected-${index}`, { deliveryTrace: trace() }), FENCE),
      /delivery_trace/,
      name,
    );
  }
});

test('control-plane verify recomputes the trace from stage evidence and ignores forged copies', async () => {
  const seen = [];
  const port = createCodingControlPlanePort({
    hostAdapter: {
      runTakeIssueToDone: async (input) => {
        seen.push(input);
        return hostResult({ deliveryTrace: input.deliveryTrace });
      },
    },
  });
  const command = codingCommand('verified', { deliveryTrace: trace(), deliveryObservation: observation() });
  const execution = await port.executeFenced(command, FENCE);

  assert.deepEqual(seen[0].deliveryTrace, trace());
  assert.equal(seen[0].deliveryObservation, undefined);
  assert.equal(execution.submissionGate.ready, true);
  assert.deepEqual(execution.submissionGate.deliveryTrace?.claims, SOURCE_ONLY_CLAIMS);
  assert.equal((await port.verify(command, { execution })).outcome, 'satisfied');

  const forged = JSON.parse(JSON.stringify(execution));
  delete forged.submissionEvidence.events.find((event) => event.stage === 'fixRerun').result.deliveryObservation;
  forged.deliveryObservation = observation();
  forged.submissionEvidence.deliveryObservation = observation();
  forged.submissionGate = { ready: true, decision: 'ready', missing: [], deliveryTrace: { ok: true, reasons: [] } };

  const verification = await port.verify(command, { execution: forged });
  assert.notEqual(verification.outcome, 'satisfied');
  assert.match(verification.reason || '', /delivery_trace/);
});

test('live fixer observes head, changed files, and the plan through read-only Git argument arrays', async () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: `${[PLAN_PATH, README, SOURCE].join('\n')}\n`, stderr: '' };
    if (args[0] === 'show') return { status: 0, stdout: PLAN_TEXT, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  // The base is the branch stage's resolved commit, not the per-run base ref.
  const branchResult = { status: 'created', ok: true, branch: BRANCH, baseRef: 'origin/main', baseBranch: 'main', baseCommit: BASE, worktreeDir: '/tmp/SUP-4029' };
  const input = { issueIdentifier: IDENTIFIER, branch: BRANCH, baseRef: 'origin/main', branchResult, worktreeDir: '/tmp/SUP-4029' };

  const observed = (await createLiveFixer({ run }).fixAndRerun({ ...input, deliveryTrace: trace() })).deliveryObservation;
  assert.deepEqual(calls.find((call) => call.args[0] === 'diff').args, ['diff', '--name-only', `${BASE}...HEAD`, '--']);
  assert.equal(observed?.baseCommit, BASE);
  assert.equal(observed?.headCommit, HEAD);
  assert.deepEqual(observed?.changedFiles, [PLAN_PATH, README, SOURCE]);
  assert.deepEqual(observed?.plan, { digest: sha256(PLAN_TEXT), mentionsWorkIdentifier: true });
  assert.ok(calls.every((call) => call.command === 'git' && Array.isArray(call.args) && call.options.cwd === '/tmp/SUP-4029'));

  calls.length = 0;
  const unsafePlan = { path: '../../private/plan.md', digest: sha256(PLAN_TEXT) };
  const unsafe = (await createLiveFixer({ run }).fixAndRerun({ ...input, deliveryTrace: trace({ plan: unsafePlan }) })).deliveryObservation;
  assert.equal(unsafe?.headCommit, HEAD);
  assert.equal(unsafe?.plan ?? null, null);
  assert.equal(calls.some((call) => call.args.join(' ').includes('private/plan.md')), false);
});

// A repository whose branch head is HEAD and whose trusted base is BASE. Every
// other name resolves to the head, and a diff from anything but BASE is empty:
// exactly what `HEAD`, the branch itself, or the head commit look like as a base.
function repository({ existingBranch = false, fetchStatus = 0, trustedRef = 'origin/main' } = {}) {
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
  return (command, args) => {
    if (args[0] === 'fetch') return { status: fetchStatus, stdout: '', stderr: '' };
    if (args[0] === 'worktree' && args.includes('-b') && existingBranch) return { status: 1, stdout: '', stderr: 'branch already exists' };
    if (args[0] === 'rev-parse') return ok(`${args.at(-1) === `refs/remotes/${trustedRef}^{commit}` ? BASE : HEAD}\n`);
    if (args[0] === 'diff') return ok(args.includes(`${BASE}...HEAD`) ? `${[PLAN_PATH, README, SOURCE].join('\n')}\n` : '');
    if (args[0] === 'show') return ok(PLAN_TEXT);
    return ok('');
  };
}

async function observeLive(baseRef, { repo = {}, fix = {} } = {}) {
  const run = repository(repo);
  const branchResult = await createLiveGitBranch({
    run,
    repoRootDir: '/tmp/repo',
    worktreeRoot: '/tmp/worktrees',
    mkdir: () => {},
    now: () => 1,
  }).createBranch({ branch: BRANCH, baseRef });
  const fixed = await createLiveFixer({ run, primaryFixPass: () => ({ status: 'passed' }) }).fixAndRerun({
    issueIdentifier: IDENTIFIER,
    branch: BRANCH,
    baseRef,
    branchResult,
    worktreeDir: branchResult.worktreeDir,
    deliveryTrace: trace(),
    ...fix,
  });
  return { branchResult, observed: fixed.deliveryObservation };
}

test('live delivery observation is bound to the resolved trusted base, never a caller ref that aliases the head', async () => {
  for (const existingBranch of [false, true]) {
    const repo = { existingBranch };
    const mode = existingBranch ? 'attached' : 'created';

    const legitimate = await observeLive('origin/main', { repo });
    assert.equal(legitimate.branchResult.status, mode);
    assert.equal(legitimate.branchResult.baseCommit, BASE, mode);
    assert.equal(legitimate.observed?.baseCommit, BASE, mode);
    assert.deepEqual(legitimate.observed?.changedFiles, [PLAN_PATH, README, SOURCE], mode);
    assert.equal(evaluateDeliveryTrace(trace(), { identifier: IDENTIFIER, observed: legitimate.observed }).ok, true, mode);

    // The no-op trace that an empty diff would have admitted.
    const noChange = trace({
      docImpact: { decision: 'none', reason: 'No files changed from the base, so no documentation is affected.' },
      implementation: { headCommit: HEAD, changedFiles: [] },
    });
    for (const alias of ['HEAD', BRANCH, `refs/heads/${BRANCH}`, `origin/${BRANCH}`, HEAD, 'main']) {
      const aliased = await observeLive(alias, { repo });
      assert.equal(aliased.branchResult.baseCommit, null, `${mode}: ${alias}`);
      assert.equal(aliased.observed, null, `${mode}: ${alias}`);
      const gate = evaluateDeliveryTrace(noChange, { identifier: IDENTIFIER, observed: aliased.observed });
      assert.ok(gate.reasons.includes('observation_unavailable'), `${mode}: ${alias}`);
    }

    // An unverifiable base is no observation, not an empty passing diff.
    assert.equal((await observeLive('origin/main', { repo: { existingBranch, fetchStatus: 1 } })).observed, null, mode);

    // An existing pull request that targets another base contradicts the branch evidence.
    const pullRequest = { number: 7, headRefName: BRANCH, baseRefName: 'release' };
    assert.equal((await observeLive('origin/main', { repo, fix: { pullRequest } })).observed, null, mode);
    assert.equal((await observeLive('origin/main', { repo, fix: { pullRequest: { ...pullRequest, baseRefName: 'main' } } })).observed?.baseCommit, BASE, mode);

    // Branch evidence for a different worktree is not evidence for this one.
    assert.equal((await observeLive('origin/main', { repo, fix: { worktreeDir: '/tmp/elsewhere' } })).observed, null, mode);
  }
});

test('the composed live adapters apply one host-owned base to branch observation and pull-request target', async () => {
  const rows = [
    // [host baseRef option, run baseRef, trusted remote-tracking ref, base branch, another base]
    [undefined, 'origin/main', 'origin/main', 'main', 'release'],
    ['origin/release', 'origin/release', 'origin/release', 'release', 'main'],
    ['release', 'release', 'origin/release', 'release', 'main'],
    ['release', 'origin/release', 'origin/release', 'release', 'main'],
  ];
  for (const [hostBaseRef, runBaseRef, trustedRef, baseBranch, otherBase] of rows) {
    const name = `host ${hostBaseRef || 'default'}, run ${runBaseRef}`;
    const gitCalls = [];
    const git = repository({ trustedRef });
    let livePullRequestBase = baseBranch;
    const run = (command, args, options) => {
      if (command === 'gh') {
        return {
          status: 0,
          stdout: JSON.stringify({ number: 7, url: 'https://github.com/levineam/jarvOS/pull/7', title: 'SUP-4029', state: 'OPEN', headRefName: BRANCH, baseRefName: livePullRequestBase }),
          stderr: '',
        };
      }
      gitCalls.push(args);
      return git(command, args, options);
    };
    const live = buildLiveCodingAdapters({
      run,
      repo: 'levineam/jarvOS',
      repoRootDir: '/tmp/repo',
      worktreeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-live-base-')),
      ...(hostBaseRef ? { baseRef: hostBaseRef } : {}),
    });

    const branchResult = await live.git.createBranch({ branch: BRANCH, baseRef: runBaseRef });
    assert.deepEqual(
      [branchResult.ok, branchResult.baseRef, branchResult.baseBranch, branchResult.baseCommit],
      [true, trustedRef, baseBranch, BASE],
      name,
    );
    assert.deepEqual(gitCalls.find((args) => args[0] === 'fetch'), ['fetch', 'origin', baseBranch], name);
    assert.equal(gitCalls.find((args) => args[0] === 'worktree').at(-1), trustedRef, name);

    const fixed = await live.fixer.fixAndRerun({
      issueIdentifier: IDENTIFIER,
      branch: BRANCH,
      baseRef: runBaseRef,
      branchResult,
      worktreeDir: branchResult.worktreeDir,
      deliveryTrace: trace(),
    });
    assert.equal(fixed.deliveryObservation?.baseCommit, BASE, name);
    assert.equal(evaluateDeliveryTrace(trace(), { identifier: IDENTIFIER, observed: fixed.deliveryObservation }).ok, true, name);

    // The pull-request target is the same base, with or without branch evidence.
    const existingPullRequest = { number: 7 };
    for (const evidence of [{ branchResult }, {}]) {
      livePullRequestBase = baseBranch;
      const onBase = await live.pullRequest.openPullRequest({ branch: BRANCH, baseRef: runBaseRef, existingPullRequest, ...evidence });
      assert.deepEqual([onBase.ok, onBase.baseRefName], [true, baseBranch], name);

      livePullRequestBase = otherBase;
      const offBase = await live.pullRequest.openPullRequest({ branch: BRANCH, baseRef: runBaseRef, existingPullRequest, ...evidence });
      assert.deepEqual([offBase.ok, offBase.reasonCode], [false, 'pull_request_base_mismatch'], name);
    }
  }
});

test('the live branch adapter refuses an untrusted or unsafe base before any Git or filesystem effect', async () => {
  const unsafeHostBase = 'origin/+main:refs/heads/unrelated';
  const rows = [
    ['force-update refspec', {}, 'origin/+topic:refs/heads/unrelated', 'base_ref_untrusted'],
    ['option-like string', {}, '--upload-pack=touch', 'base_ref_untrusted'],
    ['alias of the head', {}, 'HEAD', 'base_ref_untrusted'],
    ['well-formed ref the host did not configure', {}, 'origin/release', 'base_ref_untrusted'],
    ['non-string base', {}, { ref: 'origin/main' }, 'base_ref_untrusted'],
    ['unsafe host configuration', { baseRef: unsafeHostBase }, undefined, 'trusted_base_ref_invalid'],
    ['unsafe host configuration requested verbatim', { baseRef: unsafeHostBase }, unsafeHostBase, 'trusted_base_ref_invalid'],
  ];
  for (const [name, options, baseRef, reasonCode] of rows) {
    const effects = [];
    const adapter = createLiveGitBranch({
      ...options,
      repoRootDir: '/tmp/repo',
      worktreeRoot: '/tmp/worktrees',
      now: () => 1,
      run: (command, args) => { effects.push([command, args]); return { status: 0, stdout: '', stderr: '' }; },
      mkdir: (dir) => { effects.push(['mkdir', dir]); },
    });
    const result = await adapter.createBranch({ branch: BRANCH, baseRef });

    assert.deepEqual(effects, [], name);
    assert.deepEqual(
      [result.ok, result.status, result.reasonCode, result.baseCommit, result.worktreeDir],
      [false, 'failed', reasonCode, null, null],
      name,
    );
  }
});

// Runs the orchestrator with the live pull-request adapter against a fake `gh`
// that reports one existing pull request (#7) with the given live base. The
// branch stage yields base evidence only for the host-trusted `origin/main`.
async function runWithExistingPullRequest(liveBaseRefName, input = {}) {
  const composed = adapters();
  composed.git = {
    async createBranch({ branch, baseRef }) {
      const trusted = baseRef === 'origin/main';
      return {
        status: 'attached',
        ok: true,
        branch,
        baseRef,
        baseBranch: trusted ? 'main' : null,
        baseCommit: trusted ? BASE : null,
        worktreeDir: '/tmp/SUP-4029',
      };
    },
  };
  composed.pullRequest = createLivePullRequest({
    repo: 'levineam/jarvOS',
    run: () => ({
      status: 0,
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/levineam/jarvOS/pull/7',
        title: 'SUP-4029 delivery trace',
        state: 'MERGED',
        headRefName: BRANCH,
        ...(liveBaseRefName ? { baseRefName: liveBaseRefName } : {}),
      }),
      stderr: '',
    }),
  });
  const wrapped = await createCodexHostAdapter({ adapters: composed }).runTakeIssueToDone({
    issueIdentifier: IDENTIFIER,
    branch: BRANCH,
    deliveryTrace: trace(),
    // The reattachment pointer claims the trusted base; it is not proof.
    resumeFrom: { branch: BRANCH, pullRequest: { number: 7, url: 'https://github.com/levineam/jarvOS/pull/7', baseRefName: 'main' } },
    ...input,
  });
  return wrapped.result;
}

test('a reattached pull request on the wrong or unreadable base never reaches sweep or close', async () => {
  const rows = [
    ['targets another base', 'release', {}, 'pull_request_base_mismatch'],
    ['run restates that base as its own', 'release', { baseRef: 'origin/release' }, 'pull_request_base_mismatch'],
    ['live base is unreadable', null, {}, 'pull_request_base_unverified'],
  ];
  for (const [name, liveBaseRefName, input, reasonCode] of rows) {
    const result = await runWithExistingPullRequest(liveBaseRefName, input);
    const pullRequest = result.events.find((event) => event.stage === 'pullRequest')?.result;

    assert.equal(result.status, 'failed', name);
    assert.equal(pullRequest?.ok, false, name);
    assert.equal(pullRequest?.reasonCode, reasonCode, name);
    assert.deepEqual(
      result.events.map((event) => event.stage),
      ['claim', 'branch', 'sliceReview', 'holisticReview', 'fixRerun', 'pullRequest'],
      name,
    );
  }
});

test('a reattached pull request on the trusted base completes', async () => {
  const result = await runWithExistingPullRequest('main');
  const pullRequest = result.events.find((event) => event.stage === 'pullRequest')?.result;

  assert.equal(result.status, 'completed');
  assert.deepEqual([pullRequest?.status, pullRequest?.baseRefName, pullRequest?.liveConfirmed], ['merged', 'main', true]);
  assert.deepEqual(result.events.map((event) => event.stage).slice(-2), ['postMergeSweep', 'verifyClose']);
});
