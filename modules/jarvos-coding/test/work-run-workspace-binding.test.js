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

const oid = (n) => `c0ffee${n.toString(16).padStart(34, '0')}`;
const REV_START = { branch: 'codex/SUP-3816-handoff', baseOid: oid(1), headOid: oid(2) };
const HANDOFF_FIELDS = ['handoffFrom', 'handoffTo'];
const HANDOFF_HELD = { ok: false, reason: 'handoff_reserved' };

function snapshot(dir) {
  const files = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const stat = fs.statSync(path.join(dir, name));
    files[name] = { bytes: stat.isFile() ? fs.readFileSync(path.join(dir, name)) : null, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  }
  return { entries: Object.keys(files), mtimeMs: fs.statSync(dir).mtimeMs, files };
}

function assertBytes(store, before, label) {
  assert.deepEqual(persisted(store).bytes, before.bytes, label);
}

// Run A binds root/ws and records one revision; target T, third party B and spare C are claimed and unbound;
// run O holds root/other (so workspaceFenceSeq is 2). Returns A's full current binding token as `source`.
function handoffFixture(root) {
  const dirs = workspaceDirs(root);
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const storeRoot = path.join(root, 'store');
  const store = createFileWorkRunStore(storeRoot);
  const [a, t, b, c, o] = ['a', 't', 'b', 'c', 'o'].map((name) => claimRun(store, `run_ws_${name}`, `agent:${name}`));
  const bound = store.bindWorkspace({ ...a, worktreePath: dirs.ws });
  assert.equal(bound.bound, true, JSON.stringify(bound));
  assert.equal(store.bindWorkspace({ ...o, worktreePath: other }).bound, true);
  const source = { ...a, workspaceId: bound.binding.workspaceId, bindingFence: bound.binding.bindingFence };
  const initial = store.transitionWorkspaceRevision({ ...source, expectedRevisionSeq: 0, intent: 'initial', operationNonce: 'nonce-handoff-initial', next: REV_START });
  assert.equal(initial.ok, true, JSON.stringify(initial));
  return { store, storeRoot, ...dirs, other, a, t, b, c, o, source, workspaceId: source.workspaceId };
}

function reserve(store, source, target) {
  const result = store.releaseWorkspace({ ...source, handoffTo: target.workRunId });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

// The target presents the source's exact binding token with its own run owner and fence.
const consumeToken = (claim, source) => ({ ...claim, workspaceId: source.workspaceId, bindingFence: source.bindingFence });

function staleTokens(token) {
  return [
    [{ ...token, workRunId: 'run_missing' }, 'not_found'], [{ ...token, ownerId: undefined }, 'owner_required'],
    [{ ...token, fence: token.fence + 1 }, 'stale_fence'], [{ ...token, ownerId: 'agent:intruder' }, 'stale_fence'],
    [{ ...token, bindingFence: token.bindingFence + 1 }, 'stale_binding_fence'], [{ ...token, workspaceId: UNKNOWN_WS }, 'stale_binding_fence'],
  ];
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
      [store.releaseWorkspace({ ...a, workspaceId, bindingFence, handoffTo: 'agent:b' }), 'invalid_handoff_target'],
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
const [entry, root, barrier, index, workRunId, ownerId, fence, worktreePath, tokenJson] = process.argv.slice(1);
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
  const token = tokenJson ? JSON.parse(tokenJson) : {};
  const result = store.bindWorkspace({ workRunId, ownerId, fence: Number(fence), worktreePath, ...token });
  report = { index: Number(index), ok: result.ok === true, bound: result.bound === true, deduped: result.deduped === true, reason: result.reason || null };
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

test('releaseWorkspace handoffTo reserves the binding for an existing unbound target run without advancing the fence', () => {
  withTempRoot('jarvos-ws-handoff-reserve-', (root) => {
    const { store, ws, a, t, c, o, source, workspaceId } = handoffFixture(root);
    const publicBefore = store.getWorkspaceBinding(workspaceId);
    const before = persisted(store);
    const privateBefore = before.state.workspaceBindings[workspaceId];
    for (const [handoffTo, label] of [
      [null, 'null'], ['', 'empty'], [a.workRunId, 'self'], ['bad target!', 'non-opaque'], [42, 'number'], [{ workRunId: t.workRunId }, 'object'],
      ['run_missing', 'nonexistent'], ['agent:b', 'owner string'], [t.ownerId, 'target owner string'], [o.workRunId, 'target bound elsewhere'],
    ]) {
      const refused = store.releaseWorkspace({ ...source, handoffTo });
      assert.equal(refused.reason, 'invalid_handoff_target', `${label}: ${JSON.stringify(refused)}`);
    }
    for (const [token, reason] of [...staleTokens(source), [{ ...source, workspaceId: undefined, bindingFence: undefined }, 'stale_binding_fence']]) {
      const refused = store.releaseWorkspace({ ...token, handoffTo: t.workRunId });
      assert.equal(refused.reason, reason, JSON.stringify(refused));
    }
    const runRelease = { ...a, releaseWorkspace: true, workspaceId, bindingFence: source.bindingFence };
    assert.equal(store.releaseWorkRun({ ...runRelease, handoffTo: t.workRunId }).reason, 'workspace_handoff_unavailable');
    assertBytes(store, before, 'refused reserves must not write');

    const reserved = reserve(store, source, t);
    if (reserved.public !== undefined) {
      assert.deepEqual(Object.keys(reserved.public).sort(), Object.keys(publicBefore).sort());
      assert.equal(reserved.public.state, 'handoff_pending');
      for (const field of HANDOFF_FIELDS) assert.equal(Object.hasOwn(reserved.public, field), false, field);
    }
    const pending = persisted(store);
    const binding = pending.state.workspaceBindings[workspaceId];
    assert.equal(pending.state.revision, before.state.revision + 1);
    assert.equal(pending.state.workspaceFenceSeq, before.state.workspaceFenceSeq, 'reserve must not advance the fence sequence');
    assert.deepEqual(
      [binding.state, binding.handoffFrom, binding.handoffTo, binding.workRunId, binding.ownerId, binding.runFence, binding.bindingFence],
      ['handoff_pending', a.workRunId, t.workRunId, a.workRunId, a.ownerId, a.fence, source.bindingFence],
    );
    for (const field of ['identity', 'subjectKey', 'boundAt', 'revision', 'revisionHistory']) assert.deepEqual(binding[field], privateBefore[field], field);
    assert.equal(pending.state.workRuns[a.workRunId].workspaceId, workspaceId);
    assert.equal(pending.state.workRuns[t.workRunId].workspaceId ?? null, null);

    const publicPending = store.getWorkspaceBinding(workspaceId);
    assert.deepEqual(Object.keys(publicPending).sort(), Object.keys(publicBefore).sort());
    const { updatedAt: _beforeAt, ...stableBefore } = publicBefore;
    const { updatedAt: _pendingAt, ...stablePending } = publicPending;
    assert.deepEqual(stablePending, { ...stableBefore, state: 'handoff_pending' });
    const publicJson = JSON.stringify(publicPending);
    assert.doesNotMatch(publicJson, /handoffFrom|handoffTo|run_ws_t|agent:|ownerId|runFence|identity|canonicalPath|"dev"|"ino"|operationNonce|nonce-/);
    assert.equal(publicJson.includes(fs.realpathSync.native(ws)), false);

    const dedupe = store.releaseWorkspace({ ...source, handoffTo: t.workRunId });
    assert.equal(dedupe.ok, true, JSON.stringify(dedupe));
    assert.equal(dedupe.deduped, true, JSON.stringify(dedupe));
    assert.equal(store.releaseWorkspace({ ...source, handoffTo: c.workRunId }).reason, 'handoff_reserved');
    assert.equal(store.releaseWorkRun({ ...a, handoffTo: t.workRunId }).reason, 'workspace_handoff_unavailable');
    assert.equal(store.releaseWorkRun({ ...runRelease, handoffTo: c.workRunId }).reason, 'workspace_handoff_unavailable');
    assertBytes(store, pending, 'pending dedupes and refusals must not write');
  });
});

test('a pending handoff refuses verify, revision transitions, replays and third-party binds after full stale-token checks', () => {
  withTempRoot('jarvos-ws-handoff-pending-', (root) => {
    const { store, ws, alias, child, a, t, b, source, workspaceId } = handoffFixture(root);
    reserve(store, source, t);
    const pending = persisted(store);
    const commit = { expectedRevisionSeq: 1, intent: 'commit', operationNonce: 'nonce-handoff-commit', next: { ...REV_START, headOid: oid(3) } };
    for (const [token, reason] of staleTokens(source)) {
      assert.equal(store.verifyWorkspaceFence(token).reason, reason, JSON.stringify(token));
      assert.equal(store.transitionWorkspaceRevision({ ...token, ...commit }).reason, reason, JSON.stringify(token));
    }
    assert.deepEqual(store.verifyWorkspaceFence(source), HANDOFF_HELD);
    assert.equal(store.verifyWorkspaceFence({ ...source, expectedRevisionSeq: 1 }).reason, 'handoff_reserved');
    assert.equal(store.transitionWorkspaceRevision({ ...source, ...commit }).reason, 'handoff_reserved');
    const replay = { ...source, expectedRevisionSeq: 0, intent: 'initial', operationNonce: 'nonce-handoff-initial', next: REV_START };
    assert.equal(store.transitionWorkspaceRevision(replay).reason, 'handoff_reserved', 'pending outranks exact nonce replay');
    for (const worktreePath of [ws, alias, child]) {
      assert.equal(store.bindWorkspace({ ...b, worktreePath }).reason, 'handoff_reserved', worktreePath);
    }
    assertBytes(store, pending, 'pending refusals must not write');

    // The current holder's ordinary release still deletes a pending binding.
    const released = store.releaseWorkspace(source);
    assert.equal(released.ok, true, JSON.stringify(released));
    let state = persisted(store).state;
    assert.equal(Object.hasOwn(state.workspaceBindings, workspaceId), false);
    assert.equal(state.workspaceFenceSeq, pending.state.workspaceFenceSeq);
    for (const run of [a, t]) assert.equal(state.workRuns[run.workRunId].workspaceId ?? null, null, run.workRunId);

    // ...and so does releaseWorkRun with the full binding token.
    const rebound = store.bindWorkspace({ ...a, worktreePath: ws });
    assert.equal(rebound.bound, true, JSON.stringify(rebound));
    const second = { ...a, workspaceId: rebound.binding.workspaceId, bindingFence: rebound.binding.bindingFence };
    reserve(store, second, t);
    const runReleased = store.releaseWorkRun({ ...a, releaseWorkspace: true, workspaceId: second.workspaceId, bindingFence: second.bindingFence });
    assert.equal(runReleased.ok, true, JSON.stringify(runReleased));
    state = persisted(store).state;
    assert.equal(Object.hasOwn(state.workspaceBindings, second.workspaceId), false);
    assert.equal(state.workRuns[a.workRunId].ownerId, null);
    for (const run of [a, t]) assert.equal(state.workRuns[run.workRunId].workspaceId ?? null, null, run.workRunId);

    // Identity replacement keeps its own reason while pending (memory store with a resolver map).
    const id = (canonicalPath, ino) => ({ canonicalPath, dev: 7, ino });
    const identities = { '/ws/a': id('/ws/a', 10), '/alias/a': id('/ws/a', 10), '/ws/a-replaced': id('/ws/a', 11), '/ws/a/child': id('/ws/a/child', 12) };
    const memory = createMemoryWorkRunStore({ workspaceResolver: (p) => identities[p] });
    const [ma, mt, mb] = ['a', 't', 'b'].map((name) => claimRun(memory, `run_ws_${name}`, `agent:${name}`));
    const mBound = memory.bindWorkspace({ ...ma, worktreePath: '/ws/a' }).binding;
    reserve(memory, { ...ma, workspaceId: mBound.workspaceId, bindingFence: mBound.bindingFence }, mt);
    const mPending = memory.getWorkspaceBinding(mBound.workspaceId, { public: false });
    assert.equal(memory.bindWorkspace({ ...mb, worktreePath: '/ws/a-replaced' }).reason, 'workspace_identity_changed');
    for (const worktreePath of ['/ws/a', '/alias/a', '/ws/a/child']) {
      assert.equal(memory.bindWorkspace({ ...mb, worktreePath }).reason, 'handoff_reserved', worktreePath);
    }
    assert.deepEqual(memory.getWorkspaceBinding(mBound.workspaceId, { public: false }), mPending);
  });
});

test('the target consumes a reserved handoff via bindWorkspace with the exact token, advancing the fence once and moving the run pointer', () => {
  withTempRoot('jarvos-ws-handoff-consume-', (root) => {
    const { store, alias, other, a, t, b, source, workspaceId } = handoffFixture(root);
    reserve(store, source, t);
    const pending = persisted(store);
    const prior = pending.state.workspaceBindings[workspaceId];
    const priorSeq = pending.state.workspaceFenceSeq;
    const exact = consumeToken(t, source);
    for (const [input, reason] of [
      [{ ...t, worktreePath: alias }, 'stale_binding_fence'],
      [{ ...exact, bindingFence: undefined, worktreePath: alias }, 'stale_binding_fence'],
      [{ ...exact, workspaceId: UNKNOWN_WS, worktreePath: alias }, 'stale_binding_fence'],
      [{ ...exact, bindingFence: source.bindingFence + 1, worktreePath: alias }, 'stale_binding_fence'],
      [{ ...exact, fence: t.fence + 1, worktreePath: alias }, 'stale_fence'],
      [{ ...exact, ownerId: 'agent:intruder', worktreePath: alias }, 'stale_fence'],
      [{ ...exact, ownerId: undefined, worktreePath: alias }, 'owner_required'],
    ]) assert.equal(store.bindWorkspace(input).reason, reason, JSON.stringify(input));
    assert.equal(store.bindWorkspace({ ...exact, worktreePath: other }).ok, false, 'a different identity cannot consume');
    assert.equal(store.bindWorkspace({ ...consumeToken(b, source), worktreePath: alias }).ok, false, 'a third party cannot consume');
    assertBytes(store, pending, 'refused consumes must not write');

    const consumed = store.bindWorkspace({ ...exact, worktreePath: alias });
    assert.equal(consumed.ok, true, JSON.stringify(consumed));
    if (consumed.binding) assert.equal(consumed.binding.bindingFence, priorSeq + 1);
    if (consumed.public) assert.deepEqual([consumed.public.state, consumed.public.workRunId], ['bound', t.workRunId]);
    const after = persisted(store).state;
    const binding = after.workspaceBindings[workspaceId];
    assert.equal(after.revision, pending.state.revision + 1);
    assert.equal(after.workspaceFenceSeq, priorSeq + 1);
    assert.deepEqual(
      [binding.state, binding.workRunId, binding.subjectKey, binding.ownerId, binding.runFence, binding.bindingFence],
      ['bound', t.workRunId, `levineam/jarvOS:${t.workRunId}`, t.ownerId, t.fence, priorSeq + 1],
    );
    for (const field of HANDOFF_FIELDS) assert.equal(Object.hasOwn(binding, field), false, field);
    for (const field of ['workspaceId', 'identity', 'revision', 'revisionHistory']) assert.deepEqual(binding[field], prior[field], field);
    assert.equal(after.workRuns[t.workRunId].workspaceId, workspaceId);
    assert.equal(after.workRuns[a.workRunId].workspaceId ?? null, null);

    const consumedBytes = persisted(store);
    const oldCommit = { expectedRevisionSeq: prior.revision.seq, intent: 'commit', operationNonce: 'nonce-handoff-old', next: { ...REV_START, headOid: oid(3) } };
    const sourceStale = ['stale_binding_fence', 'stale_fence', 'not_found'];
    assert.ok(sourceStale.includes(store.verifyWorkspaceFence(source).reason), 'old source token must be stale');
    assert.equal(store.verifyWorkspaceFence(exact).reason, 'stale_binding_fence');
    assert.ok(sourceStale.includes(store.transitionWorkspaceRevision({ ...source, ...oldCommit }).reason), 'old source token cannot transition');
    assert.equal(store.bindWorkspace({ ...exact, worktreePath: alias }).reason, 'stale_binding_fence', 'a replayed consume is not a dedupe');
    assert.equal(store.releaseWorkspace(source).ok, false);
    assertBytes(store, consumedBytes, 'old tokens must not write after consume');

    const current = { ...exact, bindingFence: priorSeq + 1 };
    const verified = store.verifyWorkspaceFence({ ...current, expectedRevisionSeq: prior.revision.seq });
    assert.equal(verified.ok, true, JSON.stringify(verified));
    const moved = store.transitionWorkspaceRevision({ ...current, ...oldCommit, operationNonce: 'nonce-handoff-after' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.revision.seq, prior.revision.seq + 1);
    const history = persisted(store).state.workspaceBindings[workspaceId].revisionHistory;
    assert.deepEqual(history.map((entry) => entry.operationNonce), ['nonce-handoff-initial', 'nonce-handoff-after']);
  });
});

test('the source cancels a reserved handoff via bindWorkspace with its exact token, and explicit tokens on a bound-run dedupe are checked', () => {
  withTempRoot('jarvos-ws-handoff-cancel-', (root) => {
    const { store, ws, a, t, source, workspaceId } = handoffFixture(root);
    reserve(store, source, t);
    const pending = persisted(store);
    const prior = pending.state.workspaceBindings[workspaceId];
    const priorSeq = pending.state.workspaceFenceSeq;
    for (const [input, reason] of [
      [{ ...a, worktreePath: ws }, 'stale_binding_fence'],
      [{ ...source, bindingFence: source.bindingFence + 1, worktreePath: ws }, 'stale_binding_fence'],
      [{ ...source, workspaceId: UNKNOWN_WS, worktreePath: ws }, 'stale_binding_fence'],
      [{ ...source, fence: a.fence + 1, worktreePath: ws }, 'stale_fence'],
      [{ ...source, ownerId: 'agent:intruder', worktreePath: ws }, 'stale_fence'],
    ]) assert.equal(store.bindWorkspace(input).reason, reason, JSON.stringify(input));
    assertBytes(store, pending, 'refused cancels must not write');

    const cancelled = store.bindWorkspace({ ...source, worktreePath: ws });
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const after = persisted(store).state;
    const binding = after.workspaceBindings[workspaceId];
    assert.equal(after.revision, pending.state.revision + 1);
    assert.equal(after.workspaceFenceSeq, priorSeq + 1);
    assert.deepEqual(
      [binding.state, binding.workRunId, binding.ownerId, binding.runFence, binding.bindingFence],
      ['bound', a.workRunId, a.ownerId, a.fence, priorSeq + 1],
    );
    for (const field of HANDOFF_FIELDS) assert.equal(Object.hasOwn(binding, field), false, field);
    for (const field of ['identity', 'revision', 'revisionHistory']) assert.deepEqual(binding[field], prior[field], field);
    assert.equal(after.workRuns[a.workRunId].workspaceId, workspaceId);
    assert.equal(after.workRuns[t.workRunId].workspaceId ?? null, null);

    const current = { ...source, bindingFence: priorSeq + 1 };
    const cancelledBytes = persisted(store);
    assert.equal(store.verifyWorkspaceFence(source).reason, 'stale_binding_fence');
    assert.equal(store.verifyWorkspaceFence(current).ok, true);
    assert.equal(store.bindWorkspace({ ...consumeToken(t, source), worktreePath: ws }).ok, false, 'the target cannot consume a cancelled handoff');
    assert.equal(store.bindWorkspace({ ...consumeToken(t, current), worktreePath: ws }).ok, false, 'nor with the new token');
    assert.equal(store.bindWorkspace({ ...source, worktreePath: ws }).reason, 'stale_binding_fence', 'explicit old token on dedupe');
    assert.equal(store.bindWorkspace({ ...current, workspaceId: UNKNOWN_WS, worktreePath: ws }).reason, 'stale_binding_fence');
    const exactDedupe = store.bindWorkspace({ ...current, worktreePath: ws });
    assert.equal(exactDedupe.ok && exactDedupe.deduped, true, JSON.stringify(exactDedupe));
    const legacyDedupe = store.bindWorkspace({ ...a, worktreePath: ws });
    assert.equal(legacyDedupe.ok && legacyDedupe.deduped, true, JSON.stringify(legacyDedupe));
    assertBytes(store, cancelledBytes, 'checked dedupes and refusals must not write');
  });
});

test('malformed handoff state fails closed with the invalid-state error and never a TypeError', () => {
  withTempRoot('jarvos-ws-handoff-malformed-', (root) => {
    const { store, storeRoot, a, t, c, o, source, workspaceId } = handoffFixture(root);
    reserve(store, source, t);
    const baseline = fs.readFileSync(store.paths.statePath, 'utf8');
    const pendingOf = (s) => s.workspaceBindings[workspaceId];
    const corruptions = {
      boundWithBothHandoffFields: (s) => { pendingOf(s).state = 'bound'; },
      boundWithHandoffFrom: (s) => { pendingOf(s).state = 'bound'; delete pendingOf(s).handoffTo; },
      boundWithHandoffTo: (s) => { pendingOf(s).state = 'bound'; delete pendingOf(s).handoffFrom; },
      missingHandoffTo: (s) => { delete pendingOf(s).handoffTo; },
      nullHandoffTo: (s) => { pendingOf(s).handoffTo = null; },
      malformedHandoffTo: (s) => { pendingOf(s).handoffTo = 'bad target!'; },
      numericHandoffTo: (s) => { pendingOf(s).handoffTo = 42; },
      nonexistentHandoffTo: (s) => { pendingOf(s).handoffTo = 'run_missing'; },
      selfHandoffTo: (s) => { pendingOf(s).handoffTo = a.workRunId; },
      missingHandoffFrom: (s) => { delete pendingOf(s).handoffFrom; },
      handoffFromMismatch: (s) => { pendingOf(s).handoffFrom = c.workRunId; },
      targetBoundElsewhere: (s) => { pendingOf(s).handoffTo = o.workRunId; },
    };
    for (const [name, corrupt] of Object.entries(corruptions)) {
      const state = JSON.parse(baseline);
      corrupt(state);
      fs.writeFileSync(store.paths.statePath, JSON.stringify(state, null, 2));
      assert.throws(() => createFileWorkRunStore(storeRoot).getWorkRun(a.workRunId), failsClosed, name);
      assert.throws(() => createFileWorkRunStatusReader(storeRoot).getWorkspaceBinding(workspaceId), failsClosed, name);
    }
    fs.writeFileSync(store.paths.statePath, baseline);
    assert.equal(createFileWorkRunStatusReader(storeRoot).getWorkspaceBinding(workspaceId).state, 'handoff_pending');
  });
});

test('status getters and verify project a pending handoff and stay pure reads, even under an incumbent lock', () => {
  withTempRoot('jarvos-ws-handoff-reads-', (root) => {
    const { store, storeRoot, ws, t, source, workspaceId } = handoffFixture(root);
    const publicBefore = store.getWorkspaceBinding(workspaceId);
    reserve(store, source, t);
    const priv = store.getWorkspaceBinding(workspaceId, { public: false });
    const lockToken = `incumbent:${process.pid}`;
    let fd;
    try {
      fd = fs.openSync(store.paths.lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, lockToken);
      const lockIno = fs.statSync(store.paths.lockPath).ino;
      const stateBefore = persisted(store).bytes;
      const before = snapshot(storeRoot);
      for (const view of [store, createFileWorkRunStatusReader(storeRoot)]) {
        const pub = view.getWorkspaceBinding(workspaceId);
        assert.deepEqual(Object.keys(pub).sort(), Object.keys(publicBefore).sort());
        assert.equal(pub.state, 'handoff_pending');
        assert.doesNotMatch(JSON.stringify(pub), /handoffFrom|handoffTo|run_ws_t|agent:|ownerId|canonicalPath|nonce-/);
        assert.equal(JSON.stringify(pub).includes(fs.realpathSync.native(ws)), false);
        assert.deepEqual(view.getWorkspaceBinding(workspaceId, { public: false }), priv);
        assert.deepEqual(view.verifyWorkspaceFence(source), HANDOFF_HELD);
        assert.equal(view.verifyWorkspaceFence({ ...source, bindingFence: source.bindingFence + 1 }).reason, 'stale_binding_fence');
        assert.equal(view.verifyWorkspaceFence(consumeToken(t, source)).reason, 'stale_binding_fence');
        assert.notEqual(view.getWorkRun(t.workRunId), null);
      }
      assert.deepEqual(snapshot(storeRoot), before);
      assert.equal(fs.readFileSync(store.paths.lockPath, 'utf8'), lockToken);
      assert.equal(fs.statSync(store.paths.lockPath).ino, lockIno);
      assert.deepEqual(persisted(store).bytes, stateBefore);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
});

// kind 'A': the target T (index 0) consumes while RACERS-1 claimed third parties bind the dir or its alias.
// kind 'B': RACERS children all consume for T with the same token. No retries: a busy child is a bounded outcome.
async function handoffRaceRound(kind) {
  const root = tempRoot(`jarvos-ws-handoff-race-${kind}-`);
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
    const a = claimRun(store, 'run_race_source', 'agent:source');
    const t = claimRun(store, 'run_race_target', 'agent:target');
    const thirds = kind === 'A' ? Array.from({ length: RACERS - 1 }, (_, i) => claimRun(store, `run_race_third_${i}`, `agent:third${i}`)) : [];
    const bound = store.bindWorkspace({ ...a, worktreePath: target }).binding;
    reserve(store, { ...a, workspaceId: bound.workspaceId, bindingFence: bound.bindingFence }, t);
    const pending = persisted(store);
    const priorSeq = pending.state.workspaceFenceSeq;
    const tokenJson = JSON.stringify({ workspaceId: bound.workspaceId, bindingFence: bound.bindingFence });
    const racers = kind === 'A' ? [t, ...thirds] : Array.from({ length: RACERS }, () => t);
    const isConsumer = (index) => kind === 'B' || index === 0;
    for (const [i, claim] of racers.entries()) {
      const args = [PACKAGE_ENTRY, storeRoot, barrier, String(i), claim.workRunId, claim.ownerId, String(claim.fence), i % 2 ? alias : target];
      if (isConsumer(i)) args.push(tokenJson);
      children.push(spawnChild(args));
    }
    const allReady = await waitUntil(() => racers.every((_, i) => fs.existsSync(path.join(barrier, `ready-${i}`))), 10000);
    fs.writeFileSync(path.join(barrier, 'go'), '');
    const outcomes = await Promise.all(children.map((entry) => entry.done));
    const diag = `handoff race ${kind}: ${JSON.stringify(outcomes)}`;
    assert.equal(allReady, true, diag);
    const reports = outcomes.map((outcome) => { assert.equal(outcome.code, 0, diag); return JSON.parse(outcome.stdout); });
    const busy = (report) => report.error === 'work-run store is busy';
    const winners = reports.filter((report) => report.ok === true);
    for (const report of reports.filter((entry) => entry.ok !== true)) {
      const allowed = isConsumer(report.index) ? ['stale_binding_fence'] : ['handoff_reserved', 'workspace_conflict'];
      assert.ok(allowed.includes(report.reason) || busy(report), diag);
    }
    assert.ok(winners.length <= 1, diag);
    assert.ok(winners.every((report) => isConsumer(report.index) && report.deduped !== true), diag);
    // The first lock holder in B is always a valid consumer; in A, T can only lose the lock, never be refused.
    if (kind === 'B' || !busy(reports[0])) assert.equal(winners.length, 1, diag);
    assert.equal(fs.existsSync(store.paths.lockPath), false);
    if (winners.length === 0) {
      assert.deepEqual(persisted(store).bytes, pending.bytes, diag);
      return;
    }
    const final = persisted(store).state;
    assert.deepEqual(Object.keys(final.workspaceBindings), [bound.workspaceId], diag);
    const binding = final.workspaceBindings[bound.workspaceId];
    assert.deepEqual([binding.state, binding.workRunId, binding.ownerId, binding.bindingFence], ['bound', t.workRunId, t.ownerId, priorSeq + 1], diag);
    for (const field of HANDOFF_FIELDS) assert.equal(Object.hasOwn(binding, field), false, diag);
    assert.equal(final.workspaceFenceSeq, priorSeq + 1, diag);
    assert.equal(final.revision, pending.state.revision + 1, diag);
    assert.equal(final.workRuns[t.workRunId].workspaceId, bound.workspaceId, diag);
    assert.equal(final.workRuns[a.workRunId].workspaceId ?? null, null, diag);
    const verified = createFileWorkRunStatusReader(storeRoot).verifyWorkspaceFence({ ...t, workspaceId: bound.workspaceId, bindingFence: priorSeq + 1 });
    assert.equal(verified.ok, true, diag);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map((entry) => entry.done));
    cleanup(root);
  }
}

test('concurrent processes racing a reserved handoff consume it at most once with exactly one fence increment', { timeout: 120000 }, async () => {
  for (const kind of ['A', 'B']) await handoffRaceRound(kind);
});

test('a target run holds at most one pending reservation and cannot bind elsewhere while reserved', () => {
  const otherToken = (store, o) => {
    const state = persisted(store).state;
    const oWs = state.workRuns[o.workRunId].workspaceId;
    return { oWs, token: { ...o, workspaceId: oWs, bindingFence: state.workspaceBindings[oWs].bindingFence } };
  };
  withTempRoot('jarvos-ws-handoff-single-', (root) => {
    const { store, ws, other, t, o, source, workspaceId } = handoffFixture(root);
    reserve(store, source, t);
    const pending = persisted(store);
    const { token } = otherToken(store, o);
    const second = store.releaseWorkspace({ ...token, handoffTo: t.workRunId });
    assert.equal(second.reason, 'invalid_handoff_target', JSON.stringify(second));
    assertBytes(store, pending, 'a second reservation to the same target must not write');

    const unrelated = path.join(root, 'unrelated');
    fs.mkdirSync(unrelated);
    for (const dir of [ws, other]) assert.equal(path.relative(dir, unrelated).startsWith('..'), true, dir);
    const elsewhere = store.bindWorkspace({ ...t, worktreePath: unrelated });
    assert.equal(elsewhere.reason, 'run_workspace_conflict', JSON.stringify(elsewhere));
    assertBytes(store, pending, 'a reserved target binding elsewhere must not write');

    const consumed = store.bindWorkspace({ ...consumeToken(t, source), worktreePath: ws });
    assert.equal(consumed.ok, true, JSON.stringify(consumed));
    assert.equal(persisted(store).state.workRuns[t.workRunId].workspaceId, workspaceId);
  });
  withTempRoot('jarvos-ws-handoff-double-', (root) => {
    const { store, storeRoot, a, t, o, source, workspaceId } = handoffFixture(root);
    reserve(store, source, t);
    const { oWs } = otherToken(store, o);
    const state = JSON.parse(fs.readFileSync(store.paths.statePath, 'utf8'));
    Object.assign(state.workspaceBindings[oWs], { state: 'handoff_pending', handoffFrom: o.workRunId, handoffTo: t.workRunId });
    assert.equal(state.workRuns[o.workRunId].workspaceId, oWs);
    assert.equal(state.workRuns[t.workRunId].workspaceId ?? null, null);
    fs.writeFileSync(store.paths.statePath, JSON.stringify(state, null, 2));
    const corrupted = persisted(store);
    assert.throws(() => createFileWorkRunStore(storeRoot).getWorkRun(a.workRunId), failsClosed, 'store');
    assert.throws(() => createFileWorkRunStatusReader(storeRoot).getWorkspaceBinding(workspaceId), failsClosed, 'reader');
    assertBytes(store, corrupted, 'fail-closed reads must not write');
  });
});
