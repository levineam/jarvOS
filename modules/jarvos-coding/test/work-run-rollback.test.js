'use strict';

// SUP-3816 SR1: exact-predecessor lossless rollback proof. The candidate is the working-tree store
// (require('../src')); the predecessor is the exact 26fe store closure materialized from Git blobs into
// a fresh jarvos-rollback-* temp root. Expected RED until store.retireWorkspaceIndex() exists.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createFileWorkRunStatusReader,
  createFileWorkRunStore,
} = require('../src');

const MODULE_ROOT = path.resolve(__dirname, '..');
const PREDECESSOR_COMMIT = '26fe64ff9be7b9533e9a04f7868d1a25bb448ac3';
const PREDECESSOR_STORE_BLOB = 'd61106265bd0ba0cf4f4b11b7c013bb069916a5c';
const PREDECESSOR_STORE = 'src/features/work-run-store/index.js';
// The exact require closure of the predecessor store (paths under modules/jarvos-coding/).
const PREDECESSOR_CLOSURE = [PREDECESSOR_STORE, 'src/providers/workflow-provider.js', 'src/providers/compound-engineering.js'];
const REQUIRE_PREDECESSOR = process.env.JARVOS_REQUIRE_PREDECESSOR === '1';
const EVIDENCE_ENV = 'JARVOS_ROLLBACK_EVIDENCE_DIR';
const ROOT_PREFIX = 'jarvos-rollback-';
const V1 = 'jarvos-coding-work-run/v1';
const V2 = 'jarvos-coding-work-run/v2';
const READER_KEYS = ['getFollowThrough', 'getWorkRun', 'getWorkspaceBinding', 'verifyWorkspaceFence'];
const OUTCOME_ID = 'out_381601';
const FOLLOW = { outcomeId: OUTCOME_ID, harnessWorkspaceId: 'harness-rb-01', todoId: 'todo-rb-01', triggerId: 'trigger-rb-01' };
const ROUTE = { type: 'route', operation: 'plan', status: 'started', detail: 'route selected' };
const PROVIDER = { id: 'compound-engineering', version: '1.0.0', pinDigest: 'b'.repeat(64), harness: 'codex', adapterVersion: 'adapter-1' };
// A provider-receipt shaped event: provider identity plus its work artifact, recorded through appendEvent.
const PROVIDER_EVENT = {
  type: 'provider', operation: 'work', status: 'succeeded', operationNonce: 'nonce-rb-provider-receipt',
  provider: PROVIDER, artifact: { kind: 'work', reference: 'artifact:work-rb-0001', digest: 'c'.repeat(64) }, detail: ['provider receipt recorded'],
};
const TERMINAL = { reference: 'evidence-rb-b-01', digest: 'd'.repeat(64), status: 'passed' };
const LEGACY_AT = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------------------------
// Scratch roots: only the exact jarvos-rollback-* roots created here, directly under os.tmpdir().

const createdRoots = new Set();

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
  createdRoots.add(root);
  t.after(() => removeScratch(root));
  return root;
}

function removeScratch(root) {
  if (!createdRoots.has(root) || path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith(ROOT_PREFIX)) return;
  fs.rmSync(root, { recursive: true, force: true });
  createdRoots.delete(root);
}

// ---------------------------------------------------------------------------------------------
// Predecessor: pin the full commit and store blob, then materialize the exact closure. No shell,
// no checkout, no index mutation; only rev-parse and cat-file with argv arrays.

function git(args, encoding) {
  return spawnSync('git', args, {
    cwd: MODULE_ROOT,
    encoding,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitBlobId(content) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest('hex');
}

// Must run before any other assertion in a predecessor case. Returns the old module, or null when skipped.
function loadPredecessor(t, root) {
  const commit = git(['rev-parse', '--verify', '--quiet', `${PREDECESSOR_COMMIT}^{commit}`], 'utf8');
  if (commit.error || commit.status !== 0) {
    const reason = `predecessor commit ${PREDECESSOR_COMMIT} is not available in this clone`;
    if (REQUIRE_PREDECESSOR) assert.fail(`${reason}; JARVOS_REQUIRE_PREDECESSOR=1 forbids skipping`);
    t.skip(reason);
    return null;
  }
  assert.equal(commit.stdout.trim(), PREDECESSOR_COMMIT, 'predecessor commit pin');
  const oldRoot = path.join(root, 'old26fe');
  for (const rel of PREDECESSOR_CLOSURE) {
    const spec = `${PREDECESSOR_COMMIT}:modules/jarvos-coding/${rel}`;
    const blob = git(['rev-parse', '--verify', '--quiet', spec], 'utf8');
    assert.equal(blob.status, 0, `${spec}: ${blob.stderr}`);
    const oid = blob.stdout.trim();
    if (rel === PREDECESSOR_STORE) assert.equal(oid, PREDECESSOR_STORE_BLOB, 'predecessor store blob pin');
    const content = git(['cat-file', 'blob', oid]);
    assert.equal(content.status, 0, `${spec}: ${String(content.stderr)}`);
    assert.equal(gitBlobId(content.stdout), oid, `${spec}: materialized bytes must hash to the pinned blob`);
    const target = path.join(oldRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content.stdout);
  }
  const old = require(path.join(oldRoot, PREDECESSOR_STORE));
  assert.equal(typeof old.createFileWorkRunStore, 'function', 'old26fe exports createFileWorkRunStore');
  return old;
}

// ---------------------------------------------------------------------------------------------
// Evidence: optional, outside every fixture root, one JSONL file per case that survives cleanup.

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Realpath of the nearest existing ancestor plus the not-yet-created remainder.
function resolvedPath(p) {
  let current = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(current) && path.dirname(current) !== current) {
    rest.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync.native(current), ...rest);
}

function inventory(state) {
  const runs = isObject(state.workRuns) ? state.workRuns : {};
  return {
    runs: Object.keys(runs).sort(),
    events: Object.fromEntries(Object.entries(runs).map(([id, run]) => [id, (run.events || []).map((event) => event.eventId ?? null)])),
    followThrough: Object.keys(state.followThrough || {}).sort(),
    bindings: Object.keys(state.workspaceBindings || {}).sort(),
  };
}

function recorder(label) {
  const configured = process.env[EVIDENCE_ENV];
  if (!configured) return () => {};
  const dir = resolvedPath(configured);
  for (const root of createdRoots) {
    for (const fixture of [root, fs.realpathSync.native(root)]) {
      assert.equal(isWithin(dir, fixture), false, `${EVIDENCE_ENV} must resolve outside the fixture root ${fixture}`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `SUP-3816-sr1-${label}.jsonl`);
  fs.writeFileSync(file, '');
  return (stage, statePath, extra = {}) => {
    const bytes = fs.readFileSync(statePath);
    const state = JSON.parse(bytes);
    fs.appendFileSync(file, `${JSON.stringify({
      case: label,
      stage,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      revision: state.revision,
      schemaVersion: state.schemaVersion,
      workspaceFenceSeq: state.workspaceFenceSeq ?? null,
      inventory: inventory(state),
      ...extra,
    })}\n`);
  };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers.

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function readRevision(statePath) {
  return fs.existsSync(statePath) ? readState(statePath).revision : 0;
}

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

// Every successful mutation, old or candidate, advances the durable revision by exactly one.
function committed(statePath, fn) {
  const before = readRevision(statePath);
  const result = ok(fn());
  assert.equal(readRevision(statePath), before + 1, `successful mutation must advance the revision once: ${JSON.stringify(result).slice(0, 200)}`);
  return result;
}

function claim(store, statePath, workRunId, ownerId) {
  const result = committed(statePath, () => store.claimWorkRun({ subjectKey: `levineam/jarvOS:${workRunId}`, workRunId, ownerId }));
  return { workRunId: result.workRunId, ownerId: result.ownerId, fence: result.fence };
}

function caught(fn) {
  try { fn(); } catch (error) { return error; }
  return null;
}

function failsClosed(error) {
  assert.equal(error instanceof TypeError, false, error.stack);
  assert.match(error.message, /invalid work-run state/);
  return true;
}

function storePaths(root, name = 'store') {
  const storeRoot = path.join(root, name);
  return { storeRoot, statePath: path.join(storeRoot, 'work-runs.json'), lockPath: path.join(storeRoot, 'work-runs.lock') };
}

function workspaceDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function retire(store, statePath) {
  assert.equal(typeof store.retireWorkspaceIndex, 'function', 'SR1 requires a public store.retireWorkspaceIndex()');
  return committed(statePath, () => store.retireWorkspaceIndex());
}

function assertRefusedUnchanged(statePath, attempt, label) {
  const before = fs.readFileSync(statePath);
  const result = attempt();
  assert.equal(result.ok, false, `${label}: ${JSON.stringify(result)}`);
  assert.equal(typeof result.reason, 'string', label);
  assert.deepEqual(fs.readFileSync(statePath), before, `${label}: a refusal must not write`);
  return result;
}

// The genuine predecessor creates v1 run, event and follow-through records.
function seedWithOld(old, storeRoot, statePath) {
  const store = old.createFileWorkRunStore(storeRoot);
  const a = claim(store, statePath, 'run_rb_a', 'agent:rb-a');
  const b = claim(store, statePath, 'run_rb_b', 'agent:rb-b');
  committed(statePath, () => store.appendEvent({ ...a, ...ROUTE, operationNonce: 'nonce-rb-old-route' }));
  committed(statePath, () => store.bindFollowThrough({ ...FOLLOW, workRunId: a.workRunId, executorOwnerId: a.ownerId, ownerId: a.ownerId, fence: a.fence }));
  return { a, b };
}

// Candidate appends an event, a provider-receipt event, terminal evidence and a renewed follow-through
// lease, binds two workspaces (upgrading to v2, fence high-water 2) and releases them both.
function driveCandidate(root, storeRoot, statePath, { a, b }) {
  const store = createFileWorkRunStore(storeRoot);
  const wsA = workspaceDir(root, 'ws-a');
  const wsC = workspaceDir(root, 'ws-c');
  committed(statePath, () => store.appendEvent({ ...a, ...ROUTE, operationNonce: 'nonce-rb-new-route' }));
  committed(statePath, () => store.appendEvent({ ...a, ...PROVIDER_EVENT }));
  committed(statePath, () => store.setTerminalEvidence({ ...b, evidence: TERMINAL, state: 'completed' }));
  // Renewing the follow-through lease needs a higher run fence: release and reclaim run A.
  committed(statePath, () => store.releaseWorkRun({ ...a }));
  const a2 = claim(store, statePath, a.workRunId, a.ownerId);
  assert.equal(a2.fence, a.fence + 1);
  const renewed = committed(statePath, () => store.bindFollowThrough({ ...FOLLOW, workRunId: a2.workRunId, executorOwnerId: a2.ownerId, ownerId: a2.ownerId, fence: a2.fence }));
  assert.equal(renewed.renewed, true, JSON.stringify(renewed));
  const c = claim(store, statePath, 'run_rb_c', 'agent:rb-c');
  const boundA = committed(statePath, () => store.bindWorkspace({ ...a2, worktreePath: wsA })).binding;
  const boundC = committed(statePath, () => store.bindWorkspace({ ...c, worktreePath: wsC })).binding;
  assert.deepEqual([boundA.bindingFence, boundC.bindingFence], [1, 2]);
  const tokenA = { ...a2, workspaceId: boundA.workspaceId, bindingFence: boundA.bindingFence };
  const tokenC = { ...c, workspaceId: boundC.workspaceId, bindingFence: boundC.bindingFence };
  committed(statePath, () => store.releaseWorkspace(tokenA));
  committed(statePath, () => store.releaseWorkspace(tokenC));
  const released = readState(statePath);
  assert.equal(released.schemaVersion, V2);
  assert.deepEqual(released.workspaceBindings, {});
  assert.equal(released.workspaceFenceSeq, 2);
  return { a2, c, wsA, wsC, workspaceTokens: [tokenA, tokenC] };
}

// The exact predecessor must refuse current v2 for both a read and a write, without changing bytes.
function assertOldRefusesV2(old, storeRoot, statePath, label) {
  assert.equal(readState(statePath).schemaVersion, V2, label);
  const before = fs.readFileSync(statePath);
  const oldStore = old.createFileWorkRunStore(storeRoot);
  const errors = [
    caught(() => oldStore.getWorkRun('run_rb_a')),
    caught(() => oldStore.claimWorkRun({ subjectKey: 'levineam/jarvOS:run_rb_refused', workRunId: 'run_rb_refused', ownerId: 'agent:rb-refused' })),
  ];
  for (const [index, error] of errors.entries()) {
    assert.ok(error instanceof Error, `${label}: old26fe ${index ? 'write' : 'read'} must throw on v2 state`);
    assert.match(error.message, /invalid work-run state/, label);
    assert.match(error.message, /schemaVersion/, label);
  }
  assert.deepEqual(fs.readFileSync(statePath), before, `${label}: old refusals must not write`);
  return errors.map((error) => error.message);
}

// Old writes a new run with events and terminal evidence, releases and reclaims it; nothing else moves.
function oldWrites(old, storeRoot, statePath) {
  const before = readState(statePath);
  const oldStore = old.createFileWorkRunStore(storeRoot);
  const first = claim(oldStore, statePath, 'run_rb_old', 'agent:rb-old');
  committed(statePath, () => oldStore.appendEvent({ ...first, ...ROUTE, operationNonce: 'nonce-rb-old-after-1' }));
  committed(statePath, () => oldStore.appendEvent({ ...first, ...ROUTE, status: 'succeeded', operationNonce: 'nonce-rb-old-after-2' }));
  committed(statePath, () => oldStore.setTerminalEvidence({ ...first, evidence: { reference: 'evidence-rb-old-01', digest: 'e'.repeat(64), status: 'passed' }, state: 'completed' }));
  committed(statePath, () => oldStore.releaseWorkRun({ ...first }));
  const reclaimed = claim(oldStore, statePath, first.workRunId, first.ownerId);
  assert.equal(reclaimed.fence, first.fence + 1);
  const after = readState(statePath);
  assert.equal(after.schemaVersion, V1);
  assert.equal(after.workspaceFenceSeq, before.workspaceFenceSeq, 'old writes must keep the fence high-water');
  for (const [id, run] of Object.entries(before.workRuns)) assert.deepEqual(after.workRuns[id], run, `old writes must not touch ${id}`);
  assert.deepEqual(after.followThrough, before.followThrough);
  assert.deepEqual(after.workRuns.run_rb_old.events.map((event) => event.operationNonce), ['nonce-rb-old-after-1', 'nonce-rb-old-after-2']);
  return { first, reclaimed };
}

function rolledBackScenario(t, label) {
  const root = scratch(t);
  const old = loadPredecessor(t, root);
  if (!old) return null;
  const record = recorder(label);
  const { storeRoot, statePath } = storePaths(root);
  const seeded = seedWithOld(old, storeRoot, statePath);
  record('old26fe-seeded-v1', statePath);
  const driven = driveCandidate(root, storeRoot, statePath, seeded);
  record('candidate-released-v2', statePath);
  return { root, old, record, storeRoot, statePath, ...seeded, ...driven };
}

function reboundScenario(t, label) {
  const ctx = rolledBackScenario(t, label);
  if (!ctx) return null;
  const { old, record, storeRoot, statePath } = ctx;
  retire(createFileWorkRunStore(storeRoot), statePath);
  record('candidate-retired-v1', statePath);
  const oldRun = oldWrites(old, storeRoot, statePath);
  record('old26fe-wrote-v1', statePath);
  const highWater = readState(statePath).workspaceFenceSeq;
  const store = createFileWorkRunStore(storeRoot);
  const rebound = committed(statePath, () => store.bindWorkspace({ ...ctx.a2, worktreePath: ctx.wsA })).binding;
  record('candidate-rebound-v2', statePath);
  return { ...ctx, store, oldRun, highWater, rebound };
}

// A literal v1 state, as a predecessor would persist it, for hand-crafted validator checks.
function legacyState(extra = {}) {
  return {
    schemaVersion: V1,
    revision: 3,
    workRuns: {
      run_legacy: {
        schemaVersion: V1, workRunId: 'run_legacy', subjectKey: 'levineam/jarvOS:SUP-3816-legacy', canonicalWorktree: null,
        ownerId: 'agent:legacy', fence: 1, state: 'active', acceptedPlan: null, providerSnapshot: null, artifacts: [], events: [],
        eventNonces: {}, recovery: { state: 'active', reasonCode: null, updatedAt: LEGACY_AT }, terminalEvidence: null, createdAt: LEGACY_AT, updatedAt: LEGACY_AT,
      },
    },
    followThrough: {},
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------

test('AC1 genuine old26fe creates v1 run/event/follow-through that the candidate reads and writes; first bind upgrades to v2', (t) => {
  const root = scratch(t);
  const old = loadPredecessor(t, root);
  if (!old) return;
  const record = recorder('AC1');
  const { storeRoot, statePath } = storePaths(root);
  const { a, b } = seedWithOld(old, storeRoot, statePath);
  record('old26fe-seeded-v1', statePath);
  const seeded = readState(statePath);
  assert.equal(seeded.schemaVersion, V1);
  for (const key of ['workspaceBindings', 'workspaceFenceSeq']) assert.equal(Object.hasOwn(seeded, key), false, key);
  assert.deepEqual(Object.keys(seeded.workRuns).sort(), [a.workRunId, b.workRunId]);
  assert.deepEqual(Object.keys(seeded.followThrough), [OUTCOME_ID]);

  const store = createFileWorkRunStore(storeRoot);
  const reader = createFileWorkRunStatusReader(storeRoot);
  for (const source of [store, reader]) {
    assert.deepEqual(source.getWorkRun(a.workRunId, { public: false }), seeded.workRuns[a.workRunId]);
    assert.deepEqual(source.getWorkRun(b.workRunId, { public: false }), seeded.workRuns[b.workRunId]);
    const follow = source.getFollowThrough(OUTCOME_ID);
    assert.deepEqual([follow.workRunId, follow.executorOwnerId, follow.fence], [a.workRunId, a.ownerId, a.fence]);
  }
  committed(statePath, () => store.appendEvent({ ...a, ...ROUTE, operationNonce: 'nonce-rb-ac1-route' }));
  assert.equal(readState(statePath).schemaVersion, V1, 'ordinary candidate writes keep v1');

  const bound = committed(statePath, () => store.bindWorkspace({ ...a, worktreePath: workspaceDir(root, 'ws-a') }));
  record('candidate-first-bind-v2', statePath);
  const upgraded = readState(statePath);
  assert.equal(upgraded.schemaVersion, V2);
  assert.equal(bound.binding.bindingFence, 1);
  assert.equal(upgraded.workspaceFenceSeq, 1);
  assert.equal(upgraded.workRuns[a.workRunId].workspaceId, bound.binding.workspaceId);
  assert.deepEqual(upgraded.workRuns[b.workRunId], seeded.workRuns[b.workRunId]);
  assert.deepEqual(upgraded.followThrough, seeded.followThrough);
});

test('AC2 retireWorkspaceIndex refuses held, pending, busy, interrupted and invalid states without loss and is idempotent on v1', (t) => {
  const root = scratch(t);
  const record = recorder('AC2');
  const { storeRoot, statePath, lockPath } = storePaths(root);
  const store = createFileWorkRunStore(storeRoot);
  assert.equal(typeof store.retireWorkspaceIndex, 'function', 'SR1 requires a public store.retireWorkspaceIndex()');
  const a = claim(store, statePath, 'run_rb_a', 'agent:rb-a');
  const b = claim(store, statePath, 'run_rb_b', 'agent:rb-b');
  const bound = committed(statePath, () => store.bindWorkspace({ ...a, worktreePath: workspaceDir(root, 'ws-a') })).binding;
  const token = { ...a, workspaceId: bound.workspaceId, bindingFence: bound.bindingFence };

  // A held binding (and so a non-null run.workspaceId) refuses.
  assertRefusedUnchanged(statePath, () => store.retireWorkspaceIndex(), 'bound');
  // A pending handoff reservation refuses.
  committed(statePath, () => store.releaseWorkspace({ ...token, handoffTo: b.workRunId }));
  assert.equal(readState(statePath).workspaceBindings[bound.workspaceId].state, 'handoff_pending');
  assertRefusedUnchanged(statePath, () => store.retireWorkspaceIndex(), 'handoff_pending');
  committed(statePath, () => store.releaseWorkspace(token));
  record('released-v2', statePath);
  const released = fs.readFileSync(statePath);

  // An incumbent lock refuses as busy and is left exactly as found.
  let fd;
  try {
    const holder = `incumbent:${process.pid}`;
    fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, holder);
    const ino = fs.statSync(lockPath).ino;
    assert.throws(() => store.retireWorkspaceIndex(), /work-run store is busy/);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), holder);
    assert.equal(fs.statSync(lockPath).ino, ino);
    assert.deepEqual(fs.readFileSync(statePath), released);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }

  // An interrupted atomic save keeps the old bytes and releases the lock.
  const tempPath = `${statePath}.${process.pid}.tmp`;
  fs.mkdirSync(tempPath);
  try {
    assert.throws(() => store.retireWorkspaceIndex(), { code: 'EISDIR' });
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(fs.readFileSync(statePath), released);
  } finally {
    fs.rmdirSync(tempPath);
  }

  retire(store, statePath);
  record('retired-v1', statePath);
  const retired = readState(statePath);
  assert.equal(retired.schemaVersion, V1);
  assert.equal(retired.workspaceFenceSeq, 1);
  // Idempotent on v1: no commit, so bytes and revision are unchanged.
  const v1Bytes = fs.readFileSync(statePath);
  ok(store.retireWorkspaceIndex());
  assert.deepEqual(fs.readFileSync(statePath), v1Bytes);
  const neverUpgraded = storePaths(root, 'never-upgraded');
  const plain = createFileWorkRunStore(neverUpgraded.storeRoot);
  claim(plain, neverUpgraded.statePath, 'run_rb_plain', 'agent:rb-plain');
  const plainBytes = fs.readFileSync(neverUpgraded.statePath);
  ok(plain.retireWorkspaceIndex());
  assert.deepEqual(fs.readFileSync(neverUpgraded.statePath), plainBytes);

  // v1 permits an optional nonnegative safe-integer fence high-water and nothing else workspace-shaped.
  const cases = {
    negativeSeq: [legacyState({ workspaceFenceSeq: -1 }), false],
    fractionalSeq: [legacyState({ workspaceFenceSeq: 1.5 }), false],
    unsafeSeq: [legacyState({ workspaceFenceSeq: Number.MAX_SAFE_INTEGER + 1 }), false],
    stringSeq: [legacyState({ workspaceFenceSeq: '2' }), false],
    v1EmptyBindings: [legacyState({ workspaceBindings: {} }), false],
    v1RunWorkspaceId: [(() => { const s = legacyState(); s.workRuns.run_legacy.workspaceId = `ws_${'0'.repeat(24)}`; return s; })(), false],
    zeroSeq: [legacyState({ workspaceFenceSeq: 0 }), true],
    retainedSeq: [legacyState({ workspaceFenceSeq: 7 }), true],
  };
  for (const [name, [state, valid]] of Object.entries(cases)) {
    const crafted = storePaths(root, `crafted-${name}`);
    fs.mkdirSync(crafted.storeRoot);
    fs.writeFileSync(crafted.statePath, JSON.stringify(state, null, 2));
    const bytes = fs.readFileSync(crafted.statePath);
    if (valid) {
      assert.equal(createFileWorkRunStore(crafted.storeRoot).getWorkRun('run_legacy').workRunId, 'run_legacy', name);
      assert.equal(createFileWorkRunStatusReader(crafted.storeRoot).getWorkRun('run_legacy').workRunId, 'run_legacy', name);
      continue;
    }
    assert.throws(() => createFileWorkRunStore(crafted.storeRoot).getWorkRun('run_legacy'), failsClosed, name);
    assert.throws(() => createFileWorkRunStatusReader(crafted.storeRoot).getWorkRun('run_legacy'), failsClosed, name);
    assert.throws(() => createFileWorkRunStore(crafted.storeRoot).retireWorkspaceIndex(), failsClosed, name);
    assert.deepEqual(fs.readFileSync(crafted.statePath), bytes, `${name}: fail closed without writing`);
    assert.equal(fs.existsSync(crafted.lockPath), false, name);
  }
});

test('AC3 released v2 stays refused by old26fe until retireWorkspaceIndex, then old26fe reads and writes every record losslessly', (t) => {
  const ctx = rolledBackScenario(t, 'AC3');
  if (!ctx) return;
  const { old, record, storeRoot, statePath, a, b, c } = ctx;
  const refusals = assertOldRefusesV2(old, storeRoot, statePath, 'released v2');
  record('old26fe-refused-v2', statePath, { refusals });

  const pre = readState(statePath);
  retire(createFileWorkRunStore(storeRoot), statePath);
  record('candidate-retired-v1', statePath);
  const post = readState(statePath);
  const expected = clone(pre);
  delete expected.workspaceBindings;
  expected.schemaVersion = V1;
  expected.revision = pre.revision + 1;
  for (const run of Object.values(expected.workRuns)) if (run.workspaceId === null) delete run.workspaceId;
  assert.deepEqual(post, expected, 'retirement only drops the empty index and null workspace pointers');
  assert.equal(post.workspaceFenceSeq, 2);
  assert.deepEqual(fs.readdirSync(storeRoot).sort(), ['work-runs.json'], 'no sidecar, snapshot or leftover lock');

  // Follow-through leases, events, nonces, receipts and terminal evidence are all still present.
  assert.deepEqual(post.followThrough[OUTCOME_ID].leaseHistory.map((lease) => lease.fence), [1, 2]);
  const runA = post.workRuns[a.workRunId];
  assert.deepEqual(runA.events.map((event) => event.operationNonce), ['nonce-rb-old-route', 'nonce-rb-new-route', PROVIDER_EVENT.operationNonce]);
  assert.deepEqual(Object.keys(runA.eventNonces).sort(), runA.events.map((event) => event.operationNonce).sort());
  assert.equal(runA.events[2].provider.pinDigest, PROVIDER.pinDigest);
  assert.ok(runA.artifacts.some((artifact) => artifact.reference === PROVIDER_EVENT.artifact.reference));
  assert.deepEqual([post.workRuns[b.workRunId].state, post.workRuns[b.workRunId].terminalEvidence.reference], ['completed', TERMINAL.reference]);
  for (const id of [a.workRunId, c.workRunId]) assert.equal(Object.hasOwn(post.workRuns[id], 'workspaceId'), false, id);

  const retiredBytes = fs.readFileSync(statePath);
  const oldStore = old.createFileWorkRunStore(storeRoot);
  for (const [id, run] of Object.entries(post.workRuns)) assert.deepEqual(oldStore.getWorkRun(id, { public: false }), run, `old26fe reads ${id}`);
  const follow = oldStore.getFollowThrough(OUTCOME_ID);
  assert.deepEqual([follow.workRunId, follow.fence], [a.workRunId, 2]);
  assert.deepEqual(fs.readFileSync(statePath), retiredBytes, 'old reads are pure');

  oldWrites(old, storeRoot, statePath);
  record('old26fe-wrote-v1', statePath);
  const after = readState(statePath);
  for (const [id, run] of Object.entries(post.workRuns)) assert.deepEqual(after.workRuns[id], run, `old writes preserve ${id}`);
  assert.deepEqual(after.followThrough, post.followThrough);
  const candidateView = createFileWorkRunStore(storeRoot).getWorkRun('run_rb_old', { public: false });
  assert.deepEqual(candidateView, after.workRuns.run_rb_old, 'candidate reads old-written records');
});

test('AC4 the fence high-water survives old writes and rebinding issues high-water + 1 while every old token is stale', (t) => {
  const ctx = reboundScenario(t, 'AC4');
  if (!ctx) return;
  const { store, statePath, a, a2, oldRun, highWater, rebound, workspaceTokens } = ctx;
  assert.equal(highWater, 2);
  assert.equal(rebound.bindingFence, highWater + 1, 'rebind uses the retained high-water, never 0');
  const state = readState(statePath);
  assert.equal(state.schemaVersion, V2);
  assert.equal(state.workspaceFenceSeq, highWater + 1);
  const current = { ...a2, workspaceId: rebound.workspaceId, bindingFence: rebound.bindingFence };
  ok(store.verifyWorkspaceFence(current));

  const before = fs.readFileSync(statePath);
  for (const token of [...workspaceTokens, { ...current, bindingFence: 1 }, { ...current, bindingFence: 2 }]) {
    assert.equal(store.verifyWorkspaceFence(token).reason, 'stale_binding_fence', JSON.stringify(token));
    assert.equal(store.releaseWorkspace(token).reason, 'stale_binding_fence', JSON.stringify(token));
  }
  assert.equal(store.bindWorkspace({ ...workspaceTokens[0], worktreePath: ctx.wsA }).reason, 'stale_binding_fence');
  assert.equal(store.bindWorkspace({ ...workspaceTokens[1], worktreePath: ctx.wsC }).reason, 'stale_binding_fence');
  // Superseded run owner/fence tokens stay stale across the round trip.
  assert.equal(store.appendEvent({ ...a, ...ROUTE, operationNonce: 'nonce-rb-stale-a' }).reason, 'stale_fence');
  assert.equal(store.verifyWorkspaceFence({ ...current, fence: a.fence }).reason, 'stale_fence');
  assert.equal(store.appendEvent({ ...oldRun.first, ...ROUTE, operationNonce: 'nonce-rb-stale-old' }).reason, 'stale_fence');
  assert.deepEqual(fs.readFileSync(statePath), before, 'stale tokens must not write');
});

test('AC5 re-upgraded v2 refuses exact old26fe reads and writes without changing bytes', (t) => {
  const ctx = reboundScenario(t, 'AC5');
  if (!ctx) return;
  const refusals = assertOldRefusesV2(ctx.old, ctx.storeRoot, ctx.statePath, 're-upgraded v2');
  ctx.record('old26fe-refused-reupgraded-v2', ctx.statePath, { refusals });
});

test('AC5 optional frozen ae723 predecessor proof', { skip: 'omitted in SR1: the frozen ae723 proof is optional; the exact 26fe proof is mandatory' }, () => {});

test('AC6 existing suites stay unchanged: v1HidingBindings remains a fail-closed corruption for store, reader and retirement', (t) => {
  // The immutable suites are run by the host; this case only reads one and reproduces its corruption.
  const existing = fs.readFileSync(path.join(__dirname, 'work-run-workspace-binding.test.js'), 'utf8');
  assert.match(existing, /v1HidingBindings: \(s\) => \{ s\.schemaVersion = V1; \}/);

  const root = scratch(t);
  const { storeRoot, statePath } = storePaths(root);
  const store = createFileWorkRunStore(storeRoot);
  const a = claim(store, statePath, 'run_rb_a', 'agent:rb-a');
  committed(statePath, () => store.bindWorkspace({ ...a, worktreePath: workspaceDir(root, 'ws-a') }));
  const baseline = fs.readFileSync(statePath, 'utf8');
  const corruptions = {
    v1HidingBindings: (s) => { s.schemaVersion = V1; },
    v1HidingRunPointer: (s) => { s.schemaVersion = V1; delete s.workspaceBindings; },
  };
  for (const [name, corrupt] of Object.entries(corruptions)) {
    const state = JSON.parse(baseline);
    corrupt(state);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    const bytes = fs.readFileSync(statePath);
    assert.throws(() => createFileWorkRunStore(storeRoot).getWorkRun(a.workRunId), failsClosed, name);
    assert.throws(() => createFileWorkRunStatusReader(storeRoot).getWorkRun(a.workRunId), failsClosed, name);
    assert.throws(() => createFileWorkRunStore(storeRoot).retireWorkspaceIndex(), failsClosed, name);
    assert.deepEqual(fs.readFileSync(statePath), bytes, name);
  }
});

test('AC7 the pure status reader reads converted v1 without lock, create or write and has no retireWorkspaceIndex', (t) => {
  const root = scratch(t);
  const record = recorder('AC7');
  const { storeRoot, statePath, lockPath } = storePaths(root);
  const store = createFileWorkRunStore(storeRoot);
  const a = claim(store, statePath, 'run_rb_a', 'agent:rb-a');
  committed(statePath, () => store.bindFollowThrough({ ...FOLLOW, workRunId: a.workRunId, executorOwnerId: a.ownerId, ownerId: a.ownerId, fence: a.fence }));
  const bound = committed(statePath, () => store.bindWorkspace({ ...a, worktreePath: workspaceDir(root, 'ws-a') })).binding;
  const token = { ...a, workspaceId: bound.workspaceId, bindingFence: bound.bindingFence };
  committed(statePath, () => store.releaseWorkspace(token));
  retire(store, statePath);
  record('retired-v1', statePath);

  const entries = fs.readdirSync(storeRoot).sort();
  const bytes = fs.readFileSync(statePath);
  const { mtimeMs } = fs.statSync(statePath);
  const reader = createFileWorkRunStatusReader(storeRoot);
  assert.equal('retireWorkspaceIndex' in reader, false);
  assert.deepEqual(Object.keys(reader).sort(), READER_KEYS);
  assert.deepEqual(reader.getWorkRun(a.workRunId), store.getWorkRun(a.workRunId));
  assert.deepEqual(reader.getWorkRun(a.workRunId, { public: false }), store.getWorkRun(a.workRunId, { public: false }));
  assert.deepEqual(reader.getFollowThrough(OUTCOME_ID), store.getFollowThrough(OUTCOME_ID));
  assert.equal(reader.getWorkspaceBinding(bound.workspaceId), null);
  assert.equal(reader.verifyWorkspaceFence(token).reason, 'stale_binding_fence');
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(fs.readdirSync(storeRoot).sort(), entries);
  assert.deepEqual(fs.readFileSync(statePath), bytes);
  assert.equal(fs.statSync(statePath).mtimeMs, mtimeMs);

  const missing = path.join(root, 'missing-store');
  assert.equal(createFileWorkRunStatusReader(missing).getWorkRun(a.workRunId), null);
  assert.equal(fs.existsSync(missing), false, 'the reader never creates a root');
});
