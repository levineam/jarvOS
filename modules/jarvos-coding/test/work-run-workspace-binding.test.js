'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WORKSPACE_BINDING_VERSION,
  WORK_RUN_STORE_SCHEMA_VERSION,
  WORK_RUN_STORE_SCHEMA_VERSION_V2,
  createFileWorkRunStatusReader,
  createFileWorkRunStore,
  createMemoryWorkRunStore,
} = require('../src');

const PACKAGE_ENTRY = path.resolve(__dirname, '..', 'src', 'index.js');
const V1 = 'jarvos-coding-work-run/v1';
const V2 = 'jarvos-coding-work-run/v2';
const WS_ID = /^ws_[0-9a-f]{24}$/;
const UNKNOWN_WS = `ws_${'0'.repeat(24)}`;
const PUBLIC_KEYS = ['bindingFence', 'boundAt', 'state', 'subjectKey', 'updatedAt', 'version', 'workRunId', 'workspaceId'];
const READER_KEYS = ['getFollowThrough', 'getWorkRun', 'getWorkspaceBinding', 'verifyWorkspaceFence'];
const RACERS = 6;

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(root) {
  if (typeof root === 'string' && root.startsWith(os.tmpdir()) && path.basename(root).startsWith('jarvos-ws-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withTempRoot(prefix, fn) {
  const root = tempRoot(prefix);
  try { return fn(root); } finally { cleanup(root); }
}

function claimRun(store, workRunId, ownerId) {
  const result = store.claimWorkRun({ subjectKey: `levineam/jarvOS:${workRunId}`, workRunId, ownerId });
  assert.equal(result.ok, true, JSON.stringify(result));
  return { workRunId: result.workRunId, ownerId: result.ownerId, fence: result.fence };
}

function persisted(store) {
  const bytes = fs.readFileSync(store.paths.statePath);
  return { bytes, state: JSON.parse(bytes) };
}

// The private identity may be nested ({ identity: { canonicalPath, dev, ino } }) or flat on the binding.
function identityOf(binding) {
  return binding.identity || binding;
}

function runWorkspaceId(store, workRunId) {
  return store.getWorkRun(workRunId, { public: false }).workspaceId ?? null;
}

function failsClosed(error) {
  assert.equal(error instanceof TypeError, false, error.stack);
  assert.match(error.message, /invalid work-run state/);
  return true;
}

function workspaceDirs(root) {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, 'child'), { recursive: true });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(ws, alias, 'dir');
  const file = path.join(root, 'file.txt');
  fs.writeFileSync(file, 'not a directory');
  return { ws, alias, child: path.join(ws, 'child'), file };
}

test('legacy literal v1 state loads, refused binds leave its bytes untouched, and the first bind lazily upgrades to v2', () => {
  assert.equal(WORK_RUN_STORE_SCHEMA_VERSION, V1);
  assert.equal(WORK_RUN_STORE_SCHEMA_VERSION_V2, V2);
  assert.equal(WORKSPACE_BINDING_VERSION, 'jarvos-coding-workspace-binding/v1');
  withTempRoot('jarvos-ws-legacy-', (root) => {
    const at = '2026-01-01T00:00:00.000Z';
    const legacy = {
      schemaVersion: V1,
      revision: 3,
      workRuns: {
        run_legacy: {
          schemaVersion: V1, workRunId: 'run_legacy', subjectKey: 'levineam/jarvOS:SUP-3816-legacy', canonicalWorktree: null,
          ownerId: 'agent:legacy', fence: 1, state: 'active', acceptedPlan: null, providerSnapshot: null, artifacts: [], events: [],
          eventNonces: {}, recovery: { state: 'active', reasonCode: null, updatedAt: at }, terminalEvidence: null, createdAt: at, updatedAt: at,
        },
      },
    };
    const storeRoot = path.join(root, 'store');
    fs.mkdirSync(storeRoot);
    fs.writeFileSync(path.join(storeRoot, 'work-runs.json'), JSON.stringify(legacy, null, 2));
    const { ws } = workspaceDirs(root);
    const store = createFileWorkRunStore(storeRoot);
    assert.equal(store.getWorkRun('run_legacy').workRunId, 'run_legacy');
    const before = persisted(store);
    const token = { workRunId: 'run_legacy', ownerId: 'agent:legacy', fence: 1 };

    assert.equal(store.bindWorkspace({ ...token, fence: 2, worktreePath: ws }).reason, 'stale_fence');
    assert.equal(store.bindWorkspace({ ...token, worktreePath: path.join(root, 'missing') }).reason, 'workspace_unresolvable');
    const refused = persisted(store);
    assert.deepEqual(refused.bytes, before.bytes);
    assert.equal(refused.state.schemaVersion, V1);
    for (const key of ['workspaceBindings', 'workspaceFenceSeq']) assert.equal(Object.hasOwn(refused.state, key), false);

    const bound = store.bindWorkspace({ ...token, worktreePath: ws });
    assert.equal(bound.ok, true, JSON.stringify(bound));
    assert.equal(bound.bound, true);
    assert.match(bound.binding.workspaceId, WS_ID);
    assert.equal(bound.binding.bindingFence, 1);
    const upgraded = persisted(store).state;
    assert.equal(upgraded.schemaVersion, V2);
    assert.equal(upgraded.revision, 4);
    assert.equal(upgraded.workspaceFenceSeq, 1);
    assert.deepEqual(Object.keys(upgraded.workspaceBindings), [bound.binding.workspaceId]);
    assert.equal(upgraded.workRuns.run_legacy.workspaceId, bound.binding.workspaceId);
  });
});

test('memory store requires an injected resolver and refuses invalid identities, owners, fences, runs, and revisions', () => {
  const bare = createMemoryWorkRunStore();
  const bareClaim = claimRun(bare, 'run_ws_bare', 'agent:bare');
  assert.equal(bare.bindWorkspace({ ...bareClaim, worktreePath: '/ws/a' }).reason, 'workspace_resolver_required');
  assert.equal(runWorkspaceId(bare, bareClaim.workRunId), null);

  let identity = null;
  const store = createMemoryWorkRunStore({ workspaceResolver: () => identity });
  const a = claimRun(store, 'run_ws_a', 'agent:a');
  const invalid = [
    null,
    { canonicalPath: 'relative/ws', dev: 1, ino: 2 },
    { canonicalPath: '/', dev: 1, ino: 2 },
    { canonicalPath: '/a/../b', dev: 1, ino: 2 },
    { canonicalPath: '/a/b\0c', dev: 1, ino: 2 },
    { canonicalPath: '/ws/a', dev: 1.5, ino: 2 },
    { canonicalPath: '/ws/a', dev: 1, ino: Number.MAX_SAFE_INTEGER + 2 },
    { canonicalPath: '/ws/a', dev: '1', ino: 2 },
  ];
  for (const candidate of invalid) {
    identity = candidate;
    assert.equal(store.bindWorkspace({ ...a, worktreePath: '/ws/a' }).reason, 'workspace_unresolvable', JSON.stringify(candidate));
  }
  identity = { canonicalPath: '/ws/a', dev: 1, ino: 2 };
  assert.equal(store.bindWorkspace({ workRunId: 'run_missing', ownerId: 'agent:a', fence: 1, worktreePath: '/ws/a' }).reason, 'not_found');
  assert.equal(store.bindWorkspace({ workRunId: a.workRunId, fence: a.fence, worktreePath: '/ws/a' }).reason, 'owner_required');
  assert.equal(store.bindWorkspace({ ...a, fence: a.fence + 1, worktreePath: '/ws/a' }).reason, 'stale_fence');
  assert.equal(store.bindWorkspace({ ...a, ownerId: 'agent:other', worktreePath: '/ws/a' }).reason, 'stale_fence');
  assert.equal(store.bindWorkspace({ ...a, worktreePath: '/ws/a', revision: 'abc1234' }).reason, 'workspace_revision_unavailable');
  assert.equal(runWorkspaceId(store, a.workRunId), null);
  const bound = store.bindWorkspace({ ...a, worktreePath: '/ws/a' });
  assert.equal(bound.bound, true, JSON.stringify(bound));
  assert.equal(bound.binding.bindingFence, 1, 'refusals must not consume binding fences');
});

test('memory store dedupes one identity and refuses identity, inode, overlap, and run conflicts with redacted holders', () => {
  const id = (canonicalPath, ino) => ({ canonicalPath, dev: 7, ino });
  const identities = {
    '/ws/a': id('/ws/a', 10), '/alias/a': id('/ws/a', 10), '/ws/a-replaced': id('/ws/a', 11), '/hardlink/a': id('/ws/hardlink', 10),
    '/ws/a/child': id('/ws/a/child', 12), '/ws': id('/ws', 13), '/ws/b': id('/ws/b', 20), '/ws/c': id('/ws/c', 30),
  };
  let t = Date.parse('2026-10-06T00:00:00.000Z');
  const store = createMemoryWorkRunStore({ workspaceResolver: (p) => identities[p], clock: () => (t += 1000) });
  const a = claimRun(store, 'run_ws_a', 'agent:a');
  const b = claimRun(store, 'run_ws_b', 'agent:b');
  const first = store.bindWorkspace({ ...a, worktreePath: '/ws/a' });
  assert.equal(first.ok && first.bound, true, JSON.stringify(first));
  const { workspaceId } = first.binding;
  assert.match(workspaceId, WS_ID);
  const runBefore = store.getWorkRun(a.workRunId, { public: false });
  const bindingBefore = store.getWorkspaceBinding(workspaceId, { public: false });

  const dedupe = store.bindWorkspace({ ...a, worktreePath: '/alias/a' });
  assert.equal(dedupe.ok, true, JSON.stringify(dedupe));
  assert.equal(dedupe.deduped, true);
  assert.equal(dedupe.binding.workspaceId, workspaceId);
  assert.deepEqual(store.getWorkRun(a.workRunId, { public: false }), runBefore);
  assert.deepEqual(store.getWorkspaceBinding(workspaceId, { public: false }), bindingBefore);

  const holder = { workspaceId, holder: { workRunId: a.workRunId, subjectKey: `levineam/jarvOS:${a.workRunId}` }, bindingFence: 1 };
  for (const [worktreePath, reason] of [
    ['/ws/a-replaced', 'workspace_identity_changed'], ['/ws/a', 'workspace_conflict'], ['/hardlink/a', 'workspace_conflict'],
    ['/ws/a/child', 'workspace_overlap_conflict'], ['/ws', 'workspace_overlap_conflict'],
  ]) {
    const refused = store.bindWorkspace({ ...b, worktreePath });
    assert.equal(refused.reason, reason, `${worktreePath}: ${JSON.stringify(refused)}`);
    if (reason === 'workspace_conflict') {
      assert.deepEqual(refused.conflict, holder);
      assert.doesNotMatch(JSON.stringify(refused), /agent:a|ownerId|\/ws|hardlink|canonicalPath|"dev"|"ino"/);
    }
  }
  assert.equal(runWorkspaceId(store, b.workRunId), null);
  const second = store.bindWorkspace({ ...b, worktreePath: '/ws/b' });
  assert.equal(second.bound, true, JSON.stringify(second));
  assert.equal(second.binding.bindingFence, 2);
  assert.notEqual(second.binding.workspaceId, workspaceId);
  assert.equal(store.bindWorkspace({ ...a, worktreePath: '/ws/c' }).reason, 'run_workspace_conflict');
  assert.deepEqual(store.getWorkRun(a.workRunId, { public: false }), runBefore);
});

test('file store resolves symlink aliases to one identity and refuses overlapping and unresolvable paths', () => {
  withTempRoot('jarvos-ws-fs-', (root) => {
    const { ws, alias, child, file } = workspaceDirs(root);
    const store = createFileWorkRunStore(path.join(root, 'store'));
    const a = claimRun(store, 'run_ws_a', 'agent:a');
    const b = claimRun(store, 'run_ws_b', 'agent:b');
    assert.equal(persisted(store).state.schemaVersion, V1);
    assert.equal(Object.hasOwn(persisted(store).state, 'workspaceBindings'), false);

    const bound = store.bindWorkspace({ ...a, worktreePath: alias });
    assert.equal(bound.bound, true, JSON.stringify(bound));
    const stat = fs.statSync(ws);
    assert.equal(identityOf(bound.binding).canonicalPath, fs.realpathSync.native(ws));
    assert.equal(identityOf(bound.binding).dev, stat.dev);
    assert.equal(identityOf(bound.binding).ino, stat.ino);
    const before = persisted(store);
    const dedupe = store.bindWorkspace({ ...a, worktreePath: ws });
    assert.equal(dedupe.deduped, true, JSON.stringify(dedupe));
    assert.equal(dedupe.binding.workspaceId, bound.binding.workspaceId);
    assert.equal(store.bindWorkspace({ ...b, worktreePath: ws }).reason, 'workspace_conflict');
    assert.equal(store.bindWorkspace({ ...b, worktreePath: child }).reason, 'workspace_overlap_conflict');
    assert.equal(store.bindWorkspace({ ...b, worktreePath: root }).reason, 'workspace_overlap_conflict');
    for (const worktreePath of [path.join(root, 'missing'), file, '/', 'relative/ws', `${ws}\0suffix`]) {
      assert.equal(store.bindWorkspace({ ...b, worktreePath }).reason, 'workspace_unresolvable', JSON.stringify(worktreePath));
    }
    assert.deepEqual(persisted(store).bytes, before.bytes);
    assert.equal(fs.existsSync(store.paths.lockPath), false);

    const other = createFileWorkRunStore(path.join(root, 'other-store'));
    const otherBound = other.bindWorkspace({ ...claimRun(other, 'run_ws_a', 'agent:a'), worktreePath: ws });
    assert.equal(otherBound.bound, true, JSON.stringify(otherBound));
    assert.notEqual(otherBound.binding.workspaceId, bound.binding.workspaceId, 'workspace ids must be random, not path-derived');
  });
});

test('bindings project an exact public allowlist, return isolated clones, and verify after a store restart', () => {
  withTempRoot('jarvos-ws-public-', (root) => {
    const { ws } = workspaceDirs(root);
    const storeRoot = path.join(root, 'store');
    const store = createFileWorkRunStore(storeRoot);
    const a = claimRun(store, 'run_ws_a', 'agent:a');
    const bound = store.bindWorkspace({ ...a, worktreePath: ws });
    assert.equal(bound.bound, true, JSON.stringify(bound));
    const { workspaceId, bindingFence } = bound.binding;
    const canonical = fs.realpathSync.native(ws);

    assert.deepEqual(Object.keys(bound.public).sort(), PUBLIC_KEYS);
    assert.equal(typeof bound.public.version, 'string');
    assert.ok(bound.public.version.length > 0);
    assert.notEqual(bound.public.version, WORKSPACE_BINDING_VERSION);
    assert.deepEqual([bound.public.workspaceId, bound.public.workRunId, bound.public.state, bound.public.bindingFence], [workspaceId, a.workRunId, 'bound', 1]);
    const publicJson = JSON.stringify(bound.public);
    assert.doesNotMatch(publicJson, /agent:a|ownerId|runFence|identity|canonicalPath|"dev"|"ino"/);
    assert.equal(publicJson.includes(canonical), false);

    const priv = bound.binding;
    assert.deepEqual([priv.workRunId, priv.subjectKey, priv.ownerId, priv.runFence, priv.state], [a.workRunId, `levineam/jarvOS:${a.workRunId}`, a.ownerId, a.fence, 'bound']);
    assert.equal(identityOf(priv).canonicalPath, canonical);
    assert.ok(Number.isSafeInteger(identityOf(priv).dev) && Number.isSafeInteger(identityOf(priv).ino));
    for (const field of ['boundAt', 'updatedAt']) assert.equal(Number.isNaN(Date.parse(priv[field])), false);

    const pristine = JSON.parse(JSON.stringify(priv));
    const pristinePublic = JSON.parse(publicJson);
    const readPublic = store.getWorkspaceBinding(workspaceId);
    const readPrivate = store.getWorkspaceBinding(workspaceId, { public: false });
    assert.deepEqual(readPublic, pristinePublic);
    assert.deepEqual(readPrivate, pristine);
    readPublic.workRunId = 'run_tampered';
    readPrivate.ownerId = 'agent:tampered';
    identityOf(readPrivate).canonicalPath = '/tampered';
    bound.binding.bindingFence = 99;
    assert.deepEqual(store.getWorkspaceBinding(workspaceId), pristinePublic);
    assert.deepEqual(store.getWorkspaceBinding(workspaceId, { public: false }), pristine);

    const before = persisted(store);
    const restarted = createFileWorkRunStore(storeRoot);
    assert.deepEqual(restarted.getWorkspaceBinding(workspaceId, { public: false }), pristine);
    const token = { ...a, workspaceId, bindingFence };
    const verified = restarted.verifyWorkspaceFence(token);
    assert.equal(verified.ok, true, JSON.stringify(verified));
    assert.deepEqual(verified.binding, pristine);
    assert.equal(restarted.verifyWorkspaceFence({ ...token, bindingFence: bindingFence + 1 }).reason, 'stale_binding_fence');
    assert.equal(restarted.verifyWorkspaceFence({ ...token, workspaceId: UNKNOWN_WS }).reason, 'stale_binding_fence');
    assert.equal(restarted.verifyWorkspaceFence({ ...token, workRunId: 'run_missing' }).reason, 'not_found');
    assert.equal(restarted.verifyWorkspaceFence({ ...token, fence: a.fence + 1 }).ok, false);
    assert.equal(restarted.getWorkspaceBinding(UNKNOWN_WS), null);
    assert.equal(restarted.verifyWorkspaceFence({ ...token, expectedHeadOid: 'abc1234' }).reason, 'workspace_revision_unavailable');
    assert.equal(restarted.verifyWorkspaceFence({ ...token, expectedRevisionSeq: 1 }).reason, 'workspace_revision_unavailable');
    assert.deepEqual(persisted(store).bytes, before.bytes);
  });
});

test('releaseWorkRun refuses while bound, releases run and workspace atomically, and never ignores handoffTo', () => {
  withTempRoot('jarvos-ws-release-run-', (root) => {
    const { ws } = workspaceDirs(root);
    const store = createFileWorkRunStore(path.join(root, 'store'));
    const a = claimRun(store, 'run_ws_a', 'agent:a');
    const b = claimRun(store, 'run_ws_b', 'agent:b');
    const { workspaceId, bindingFence } = store.bindWorkspace({ ...a, worktreePath: ws }).binding;
    const before = persisted(store);
    for (const [result, reason] of [
      [store.releaseWorkRun({ ...a }), 'workspace_binding_held'],
      [store.releaseWorkRun({ ...a, handoffTo: 'agent:b' }), 'workspace_handoff_unavailable'],
      [store.releaseWorkRun({ ...a, releaseWorkspace: true, workspaceId, bindingFence, handoffTo: 'agent:b' }), 'workspace_handoff_unavailable'],
      [store.releaseWorkspace({ ...a, workspaceId, bindingFence, handoffTo: 'agent:b' }), 'workspace_handoff_unavailable'],
      [store.releaseWorkRun({ ...b, handoffTo: 'agent:a' }), 'workspace_handoff_unavailable'],
    ]) assert.equal(result.reason, reason, JSON.stringify(result));
    assert.equal(store.releaseWorkRun({ ...a, releaseWorkspace: true, workspaceId, bindingFence: bindingFence + 1 }).ok, false);
    assert.deepEqual(persisted(store).bytes, before.bytes);

    const released = store.releaseWorkRun({ ...a, releaseWorkspace: true, workspaceId, bindingFence });
    assert.equal(released.ok, true, JSON.stringify(released));
    const after = persisted(store).state;
    assert.equal(after.revision, before.state.revision + 1);
    assert.deepEqual(after.workspaceBindings, {});
    assert.equal(after.workspaceFenceSeq, 1);
    assert.equal(after.workRuns[a.workRunId].ownerId, null);
    assert.equal(after.workRuns[a.workRunId].workspaceId ?? null, null);
    assert.equal(store.getWorkspaceBinding(workspaceId), null);

    const plain = store.releaseWorkRun({ ...b });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.equal(persisted(store).state.revision, after.revision + 1);
  });
});

test('releaseWorkspace keeps the fence sequence, rebinding advances it, and stale tokens cannot release a rebound workspace', () => {
  withTempRoot('jarvos-ws-release-ws-', (root) => {
    const { ws } = workspaceDirs(root);
    const store = createFileWorkRunStore(path.join(root, 'store'));
    const a = claimRun(store, 'run_ws_a', 'agent:a');
    const first = store.bindWorkspace({ ...a, worktreePath: ws }).binding;
    const firstToken = { ...a, workspaceId: first.workspaceId, bindingFence: first.bindingFence };
    assert.equal(store.releaseWorkspace({ ...firstToken, ownerId: 'agent:intruder' }).ok, false);
    const released = store.releaseWorkspace(firstToken);
    assert.equal(released.ok, true, JSON.stringify(released));
    const state = persisted(store).state;
    assert.deepEqual(state.workspaceBindings, {});
    assert.equal(state.workspaceFenceSeq, 1);
    assert.equal(runWorkspaceId(store, a.workRunId), null);
    assert.equal(store.getWorkRun(a.workRunId, { public: false }).ownerId, a.ownerId);

    const second = store.bindWorkspace({ ...a, worktreePath: ws }).binding;
    assert.equal(second.bindingFence, 2);
    assert.match(second.workspaceId, WS_ID);
    const before = persisted(store);
    for (const stale of [firstToken, { ...firstToken, workspaceId: second.workspaceId }, { ...firstToken, bindingFence: second.bindingFence }]) {
      assert.equal(store.releaseWorkspace(stale).ok, false, JSON.stringify(stale));
    }
    assert.equal(store.verifyWorkspaceFence(firstToken).reason, 'stale_binding_fence');
    assert.deepEqual(persisted(store).bytes, before.bytes);
    assert.deepEqual(store.getWorkspaceBinding(second.workspaceId, { public: false }), second);
  });
});

test('malformed v2 state fails closed with the existing invalid-state error and never a TypeError', () => {
  withTempRoot('jarvos-ws-malformed-', (root) => {
    const storeRoot = path.join(root, 'store');
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    const store = createFileWorkRunStore(storeRoot);
    const a = claimRun(store, 'run_ws_a', 'agent:a');
    const b = claimRun(store, 'run_ws_b', 'agent:b');
    const idA = store.bindWorkspace({ ...a, worktreePath: path.join(root, 'a') }).binding.workspaceId;
    const idB = store.bindWorkspace({ ...b, worktreePath: path.join(root, 'b') }).binding.workspaceId;
    const baseline = fs.readFileSync(store.paths.statePath, 'utf8');
    const corruptions = {
      orphanRunWorkspaceId: (s) => { delete s.workspaceBindings[idB]; },
      runFenceMismatch: (s) => { s.workspaceBindings[idA].runFence += 1; },
      bindingFenceAboveSeq: (s) => { s.workspaceBindings[idB].bindingFence = s.workspaceFenceSeq + 1; },
      overlappingPaths: (s) => { identityOf(s.workspaceBindings[idB]).canonicalPath = path.join(identityOf(s.workspaceBindings[idA]).canonicalPath, 'nested'); },
      v1HidingBindings: (s) => { s.schemaVersion = V1; },
      nullBinding: (s) => { s.workspaceBindings[idA] = null; },
      nonObjectBinding: (s) => { s.workspaceBindings[idA] = 'bound'; },
    };
    for (const [name, corrupt] of Object.entries(corruptions)) {
      const state = JSON.parse(baseline);
      corrupt(state);
      fs.writeFileSync(store.paths.statePath, JSON.stringify(state, null, 2));
      assert.throws(() => createFileWorkRunStore(storeRoot).getWorkRun(a.workRunId), failsClosed, name);
      assert.throws(() => createFileWorkRunStatusReader(storeRoot).getWorkspaceBinding(idA), failsClosed, name);
    }
    fs.writeFileSync(store.paths.statePath, baseline);
    assert.notEqual(createFileWorkRunStore(storeRoot).getWorkspaceBinding(idA), null);
  });
});

test('status reader adds only workspace getters, stays pure on a missing root, and matches the store on v2 state', () => {
  withTempRoot('jarvos-ws-reader-', (root) => {
    const missing = path.join(root, 'missing-store');
    const missingReader = createFileWorkRunStatusReader(missing);
    assert.deepEqual(Object.keys(missingReader).sort(), READER_KEYS);
    assert.equal(missingReader.getWorkspaceBinding(UNKNOWN_WS), null);
    const absent = missingReader.verifyWorkspaceFence({ workRunId: 'run_ws_a', ownerId: 'agent:a', fence: 1, workspaceId: UNKNOWN_WS, bindingFence: 1 });
    assert.equal(absent.ok, false);
    assert.equal(absent.reason, 'not_found');
    assert.equal(fs.existsSync(missing), false);

    const { ws } = workspaceDirs(root);
    const storeRoot = path.join(root, 'store');
    const store = createFileWorkRunStore(storeRoot);
    const a = claimRun(store, 'run_ws_a', 'agent:a');
    const { workspaceId, bindingFence } = store.bindWorkspace({ ...a, worktreePath: ws }).binding;
    const token = { ...a, workspaceId, bindingFence };
    const reads = (source) => ({
      public: source.getWorkspaceBinding(workspaceId),
      private: source.getWorkspaceBinding(workspaceId, { public: false }),
      verified: source.verifyWorkspaceFence(token),
      stale: source.verifyWorkspaceFence({ ...token, bindingFence: bindingFence + 1 }),
      absent: source.getWorkspaceBinding(UNKNOWN_WS),
    });
    const expected = reads(store);
    assert.equal(expected.verified.ok, true, JSON.stringify(expected.verified));
    const before = persisted(store);
    const entries = fs.readdirSync(storeRoot).sort();
    const reader = createFileWorkRunStatusReader(storeRoot);
    assert.deepEqual(Object.keys(reader).sort(), READER_KEYS);
    assert.deepEqual(reads(reader), expected);
    assert.deepEqual(persisted(store).bytes, before.bytes);
    assert.deepEqual(fs.readdirSync(storeRoot).sort(), entries);
  });
});

const CHILD_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [entry, root, barrier, index, workRunId, ownerId, fence, worktreePath] = process.argv.slice(1);
let report;
try {
  const store = require(entry).createFileWorkRunStore(root);
  fs.writeFileSync(path.join(barrier, 'ready-' + index), '');
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(barrier, 'go'))) {
    if (Date.now() > deadline) throw new Error('barrier timeout');
    Atomics.wait(sleeper, 0, 0, 5);
  }
  const result = store.bindWorkspace({ workRunId, ownerId, fence: Number(fence), worktreePath });
  report = { index: Number(index), ok: result.ok === true, bound: result.bound === true, reason: result.reason || null };
} catch (error) {
  report = { index: Number(index), ok: false, error: error.message };
}
process.stdout.write(JSON.stringify(report));
`;

function spawnChild(args, timeoutMs = 20000) {
  const child = spawn(process.execPath, ['-e', CHILD_SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const done = new Promise((resolve) => {
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr: error.message }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done };
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

async function raceRound(round) {
  const root = tempRoot(`jarvos-ws-race-${round}-`);
  const children = [];
  try {
    const storeRoot = path.join(root, 'store');
    const barrier = path.join(root, 'barrier');
    const target = path.join(root, 'target');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(barrier);
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, 'dir');
    const store = createFileWorkRunStore(storeRoot);
    const claims = Array.from({ length: RACERS }, (_, i) => claimRun(store, `run_race_${i}`, `agent:race${i}`));
    const baseline = persisted(store).state.revision;
    for (const [i, claim] of claims.entries()) {
      children.push(spawnChild([PACKAGE_ENTRY, storeRoot, barrier, String(i), claim.workRunId, claim.ownerId, String(claim.fence), i % 2 ? alias : target]));
    }
    const allReady = await waitUntil(() => claims.every((_, i) => fs.existsSync(path.join(barrier, `ready-${i}`))), 10000);
    fs.writeFileSync(path.join(barrier, 'go'), '');
    const outcomes = await Promise.all(children.map((entry) => entry.done));
    const diag = `round ${round}: ${JSON.stringify(outcomes)}`;
    assert.equal(allReady, true, diag);
    const reports = outcomes.map((outcome) => { assert.equal(outcome.code, 0, diag); return JSON.parse(outcome.stdout); });
    const winners = reports.filter((report) => report.bound === true);
    assert.equal(winners.length, 1, diag);
    for (const report of reports.filter((entry) => entry !== winners[0])) {
      assert.ok(report.reason === 'workspace_conflict' || report.error === 'work-run store is busy', diag);
    }
    const final = persisted(store).state;
    const bindings = Object.values(final.workspaceBindings);
    assert.equal(bindings.length, 1, diag);
    const winner = claims[winners[0].index];
    assert.equal(bindings[0].workRunId, winner.workRunId);
    assert.equal(bindings[0].ownerId, winner.ownerId);
    assert.equal(final.revision, baseline + 1, diag);
    const { workspaceId, bindingFence } = bindings[0];
    const reader = createFileWorkRunStatusReader(storeRoot);
    assert.deepEqual(reader.getWorkspaceBinding(workspaceId), store.getWorkspaceBinding(workspaceId));
    assert.deepEqual(reader.getWorkspaceBinding(workspaceId, { public: false }), store.getWorkspaceBinding(workspaceId, { public: false }));
    assert.deepEqual(reader.verifyWorkspaceFence({ ...winner, workspaceId, bindingFence }), store.verifyWorkspaceFence({ ...winner, workspaceId, bindingFence }));
    assert.equal(fs.existsSync(store.paths.lockPath), false);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map((entry) => entry.done));
    cleanup(root);
  }
}

test('concurrent processes binding one directory through aliases produce exactly one durable winner', { timeout: 120000 }, async () => {
  for (let round = 0; round < 3; round += 1) await raceRound(round);
});

test('bindWorkspace against an incumbent lock is refused and leaves the lock and state intact', () => {
  withTempRoot('jarvos-ws-lock-', (root) => {
    let fd;
    try {
      const { ws } = workspaceDirs(root);
      const store = createFileWorkRunStore(path.join(root, 'store'));
      const a = claimRun(store, 'run_ws_a', 'agent:a');
      const { lockPath, statePath } = store.paths;
      const stateBefore = fs.readFileSync(statePath);
      const token = `incumbent:${process.pid}`;
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, token);
      const ino = fs.statSync(lockPath).ino;

      assert.throws(() => store.bindWorkspace({ ...a, worktreePath: ws }), /work-run store is busy/);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), token);
      assert.equal(fs.statSync(lockPath).ino, ino);
      assert.deepEqual(fs.readFileSync(statePath), stateBefore);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
});
