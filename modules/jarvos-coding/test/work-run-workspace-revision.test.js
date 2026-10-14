'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createFileWorkRunStatusReader, createFileWorkRunStore } = require('../src');

const PACKAGE_ENTRY = path.resolve(__dirname, '..', 'src', 'index.js');
const UNKNOWN_WS = `ws_${'0'.repeat(24)}`;
const PUBLIC_KEYS = ['bindingFence', 'boundAt', 'state', 'subjectKey', 'updatedAt', 'version', 'workRunId', 'workspaceId'];
const REVISION_KEYS = ['at', 'baseOid', 'branch', 'headOid', 'intent', 'seq'];
const CAS = 'revision_compare_and_set_conflict';
const BAD = 'invalid_revision_transition';
const GIT = 'invalid_git_revision';
const BRANCH = 'codex/SUP-3816-revisions';
const RACERS = 6;

const oid = (n, length = 40) => `c0ffee${n.toString(16).padStart(length - 6, '0')}`;
const START = { branch: BRANCH, baseOid: oid(1), headOid: oid(2) };

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `jarvos-wsrev-${prefix}-`));
}

function cleanup(root) {
  if (typeof root === 'string' && root.startsWith(os.tmpdir()) && path.basename(root).startsWith('jarvos-wsrev-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withTempRoot(prefix, fn) {
  const root = tempRoot(prefix);
  try { return fn(root); } finally { cleanup(root); }
}

function persisted(store) {
  const bytes = fs.readFileSync(store.paths.statePath);
  return { bytes, state: JSON.parse(bytes) };
}

function failsClosed(error) {
  assert.equal(error instanceof TypeError, false, error.stack);
  assert.match(error.message, /invalid work-run state/);
  return true;
}

function snapshot(dir) {
  const files = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const stat = fs.statSync(path.join(dir, name));
    files[name] = { bytes: stat.isFile() ? fs.readFileSync(path.join(dir, name)) : null, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  }
  return { entries: Object.keys(files), mtimeMs: fs.statSync(dir).mtimeMs, files };
}

// Claims one run and binds a fresh temp workspace (no revision yet); returns the full current token.
function boundStore(root) {
  let t = Date.parse('2026-10-06T00:00:00.000Z');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  const storeRoot = path.join(root, 'store');
  const store = createFileWorkRunStore(storeRoot, { clock: () => (t += 1000) });
  const claim = store.claimWorkRun({ subjectKey: 'levineam/jarvOS:SUP-3816', workRunId: 'run_rev_a', ownerId: 'agent:a' });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const bound = store.bindWorkspace({ workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, worktreePath: ws });
  assert.equal(bound.bound, true, JSON.stringify(bound));
  const token = { workRunId: claim.workRunId, ownerId: claim.ownerId, fence: claim.fence, workspaceId: bound.binding.workspaceId, bindingFence: bound.binding.bindingFence };
  return { store, storeRoot, token, ws };
}

let nonceCounter = 0;
function transition(store, token, expectedRevisionSeq, intent, next, extra = {}) {
  nonceCounter += 1;
  return store.transitionWorkspaceRevision({ ...token, expectedRevisionSeq, intent, operationNonce: `nonce-rev-${nonceCounter}`, next, ...extra });
}

function ok(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.revision;
}

const privateOf = (source, token) => source.getWorkspaceBinding(token.workspaceId, { public: false });

test('initial and each legal intent advance seq and store revision once, keep fences, and project exact redacted shapes', () => {
  withTempRoot('legal', (root) => {
    const { store, token } = boundStore(root);
    assert.deepEqual(Object.keys(store.getWorkspaceBinding(token.workspaceId)).sort(), PUBLIC_KEYS);
    const unrevised = privateOf(store, token);
    for (const key of ['revision', 'revisionHistory']) assert.equal(Object.hasOwn(unrevised, key), false, key);

    const steps = [
      ['initial', START],
      ['commit', { ...START, headOid: oid(3) }],
      ['rebase', { branch: BRANCH, baseOid: oid(4), headOid: oid(5) }],
      ['base_update', { branch: BRANCH, baseOid: oid(6), headOid: oid(5) }],
      ['branch_change', { branch: 'main', baseOid: oid(6), headOid: oid(5) }],
      ['reset', { branch: 'main', baseOid: oid(6), headOid: oid(7) }, 'operator_reset'],
    ];
    const canonical = fs.realpathSync.native(path.join(root, 'ws'));
    let before = persisted(store).state;
    for (const [index, [intent, next, reasonCode]] of steps.entries()) {
      const operationNonce = `nonce-legal-${index}`;
      const revision = ok(store.transitionWorkspaceRevision({ ...token, expectedRevisionSeq: index, intent, next, operationNonce, ...(reasonCode ? { reasonCode } : {}) }));
      assert.deepEqual(Object.keys(revision).sort(), REVISION_KEYS, intent);
      assert.deepEqual({ ...revision, at: null }, { seq: index + 1, ...next, intent, at: null });
      assert.equal(Number.isNaN(Date.parse(revision.at)), false);

      const after = persisted(store).state;
      const [prior, binding] = [before, after].map((state) => state.workspaceBindings[token.workspaceId]);
      assert.equal(after.revision, before.revision + 1, intent);
      assert.deepEqual(
        [binding.bindingFence, binding.runFence, after.workspaceFenceSeq, after.workRuns[token.workRunId].fence],
        [prior.bindingFence, prior.runFence, before.workspaceFenceSeq, token.fence],
      );
      assert.notEqual(binding.updatedAt, prior.updatedAt);

      const priv = privateOf(store, token);
      assert.deepEqual(priv.revision, { ...revision, reasonCode: reasonCode || null, operationNonce, factsSource: 'caller' });
      assert.deepEqual(priv.revisionHistory.map((entry) => entry.seq), Array.from({ length: index + 1 }, (_, k) => k + 1));
      assert.deepEqual(priv.revisionHistory.at(-1), priv.revision);

      const pub = store.getWorkspaceBinding(token.workspaceId);
      assert.deepEqual(Object.keys(pub).sort(), [...PUBLIC_KEYS, 'revision'].sort());
      assert.deepEqual(pub.revision, revision);
      const json = JSON.stringify(pub);
      assert.doesNotMatch(json, /operationNonce|reasonCode|factsSource|revisionHistory|ownerId|agent:a|identity|canonicalPath|"dev"|"ino"|nonce-legal|operator_reset/);
      assert.equal(json.includes(canonical), false);
      before = after;
    }
  });
});

test('illegal, no-op, unknown, malformed git, reason, and nonce inputs are refused without writing', () => {
  withTempRoot('refuse', (root) => {
    const { store, token, ws } = boundStore(root);
    assert.equal(store.bindWorkspace({ workRunId: token.workRunId, ownerId: token.ownerId, fence: token.fence, worktreePath: ws, revision: START }).reason, 'workspace_revision_unavailable');
    ok(transition(store, token, 0, 'initial', START));
    const before = persisted(store).bytes;
    const reset = { reasonCode: 'operator_reset' };
    const head = { ...START, headOid: oid(8) };
    const base = { ...START, baseOid: oid(9) };
    const cases = [
      ['commit', START, {}, BAD], ['commit', { ...head, baseOid: oid(9) }, {}, BAD], ['commit', { ...head, branch: 'main' }, {}, BAD],
      ['rebase', START, {}, BAD], ['rebase', head, {}, BAD], ['rebase', { ...base, branch: 'main' }, {}, BAD],
      ['base_update', START, {}, BAD], ['base_update', { ...base, headOid: oid(8) }, {}, BAD], ['base_update', { ...base, branch: 'main' }, {}, BAD],
      ['branch_change', START, {}, BAD], ['branch_change', base, {}, BAD],
      ['reset', START, reset, BAD], ['reset', { ...head, baseOid: oid(9) }, reset, BAD], ['reset', { ...head, branch: 'main' }, reset, BAD],
      ['reset', head, {}, 'invalid_reason_code'],
      ['initial', head, {}, BAD], ['initial', START, { expectedRevisionSeq: 0 }, BAD],
      ['amend', head, {}, BAD], [undefined, head, {}, BAD], ['__proto__', head, {}, BAD],
    ];
    for (const bad of ['C0FFEE'.padEnd(40, 'A'), oid(8).slice(1), `${oid(8).slice(0, 39)}g`, `${oid(8)}0`, oid(8, 63), ` ${oid(8).slice(1)}`, '', null, 42]) {
      cases.push(['commit', { ...START, headOid: bad }, {}, GIT], ['rebase', { ...START, baseOid: bad }, {}, GIT]);
    }
    const badBranches = [
      '', '-lead', '/abs/branch', 'a..b', 'a@{1}', 'a\tb', 'a\u0001b', 'a\u007fb', 'a b', 'a~1', 'a^1', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b',
      'trail/', 'a//b', 'trail.', 'a/.hidden', '.hidden', 'a.lock', 'a.lock/b', '@', 'token=abc', 'sk-abcdefgh123', null, 42,
    ];
    for (const branch of badBranches) cases.push(['branch_change', { ...START, branch }, {}, GIT]);
    for (const next of [null, undefined, 'main', { branch: BRANCH, baseOid: oid(1) }]) cases.push(['commit', next, {}, GIT]);
    for (const reasonCode of ['Bad', 'x', '1abc', 'has space', 'a'.repeat(65), 42, 'token=abc']) {
      cases.push(['reset', head, { reasonCode }, 'invalid_reason_code'], ['commit', head, { reasonCode }, 'invalid_reason_code']);
    }
    for (const operationNonce of [undefined, '', 'has space', '-lead', 42, 'x'.repeat(129)]) cases.push(['commit', head, { operationNonce }, 'operation_nonce_required']);

    for (const [intent, next, extra, reason] of cases) {
      const result = transition(store, token, 1, intent, next, extra);
      assert.deepEqual([result.ok, result.reason], [false, reason], `${intent} ${JSON.stringify(next)} ${JSON.stringify(extra)}: ${JSON.stringify(result)}`);
    }
    assert.deepEqual(persisted(store).bytes, before);
    assert.equal(fs.existsSync(store.paths.lockPath), false);
    ok(transition(store, token, 1, 'branch_change', { branch: 'feature/a.b_c-2', baseOid: oid(10, 64), headOid: oid(11, 64) }));
  });
});

test('stale, missing, or invalid expected seqs conflict with the redacted authoritative revision and write nothing', () => {
  withTempRoot('cas', (root) => {
    const { store, token } = boundStore(root);
    const empty = persisted(store).bytes;
    // Absent revision: a non-initial intent is an invalid transition; initial with a non-zero expectation conflicts with null.
    for (const [intent, expected, reason] of [['commit', 0, BAD], ['commit', 1, BAD], ['rebase', 0, BAD], ['initial', 1, CAS], ['initial', undefined, CAS], ['initial', -1, CAS]]) {
      const result = transition(store, token, expected, intent, START);
      assert.equal(result.reason, reason, `${intent}/${expected}: ${JSON.stringify(result)}`);
      if (reason === CAS) assert.deepEqual([result.ok, result.authoritative], [false, null]);
    }
    assert.deepEqual(persisted(store).bytes, empty);

    ok(transition(store, token, 0, 'initial', START));
    ok(transition(store, token, 1, 'commit', { ...START, headOid: oid(3) }));
    const authoritative = store.getWorkspaceBinding(token.workspaceId).revision;
    const before = persisted(store).bytes;
    const attempts = [0, 1, 3, 99, -1, 1.5, '2', null, undefined, Number.NaN].map((expected) => [expected, { ...START, headOid: oid(4) }]);
    attempts.push([1, { ...START, headOid: oid(3) }]); // stale and a no-op: the seq is compared first
    for (const [expected, next] of attempts) {
      const result = transition(store, token, expected, 'commit', next);
      assert.deepEqual({ ok: result.ok, reason: result.reason, authoritative: result.authoritative }, { ok: false, reason: CAS, authoritative }, `${expected}: ${JSON.stringify(result)}`);
      assert.deepEqual(Object.keys(result.authoritative).sort(), REVISION_KEYS);
      assert.doesNotMatch(JSON.stringify(result), /operationNonce|reasonCode|factsSource|revisionHistory|ownerId|identity|canonicalPath/);
    }
    assert.deepEqual(persisted(store).bytes, before);
  });
});

test('exact nonce replays dedupe to the original revision only after full fencing; changed replays are refused', () => {
  withTempRoot('replay', (root) => {
    const { store, token } = boundStore(root);
    const send = (input) => store.transitionWorkspaceRevision({ ...token, ...input });
    const initial = { expectedRevisionSeq: 0, intent: 'initial', next: START, operationNonce: 'nonce-initial' };
    const commit = { expectedRevisionSeq: 1, intent: 'commit', next: { ...START, headOid: oid(3) }, operationNonce: 'nonce-commit' };
    const reset = { expectedRevisionSeq: 2, intent: 'reset', reasonCode: 'operator_reset', next: { ...START, headOid: oid(4) }, operationNonce: 'nonce-reset' };
    const originals = [initial, commit, reset].map((input) => ok(send(input)));
    const before = persisted(store);

    for (const [input, index] of [[initial, 0], [commit, 1], [{ ...commit, reasonCode: null }, 1], [reset, 2], [commit, 1]]) {
      assert.deepEqual(send(input), { ok: true, deduped: true, revision: originals[index] }, input.operationNonce);
    }
    for (const changed of [
      { ...commit, next: { ...START, headOid: oid(9) } }, { ...commit, next: { ...commit.next, branch: 'main' } },
      { ...commit, expectedRevisionSeq: 2 }, { ...commit, expectedRevisionSeq: 3 },
      { ...commit, intent: 'reset', reasonCode: 'operator_reset' }, { ...commit, reasonCode: 'other_reason' },
      { ...reset, reasonCode: 'other_reason' }, { ...initial, next: { ...START, branch: 'main' } },
      { expectedRevisionSeq: 3, intent: 'commit', next: { ...START, headOid: oid(5) }, operationNonce: 'nonce-commit' },
    ]) assert.equal(send(changed).reason, BAD, JSON.stringify(changed));

    const fresh = { expectedRevisionSeq: 3, intent: 'commit', next: { ...START, headOid: oid(5) }, operationNonce: 'nonce-fresh' };
    for (const [stale, reason] of [
      [{ fence: token.fence + 1 }, 'stale_fence'], [{ ownerId: 'agent:other' }, 'stale_fence'], [{ ownerId: undefined }, 'owner_required'],
      [{ bindingFence: token.bindingFence + 1 }, 'stale_binding_fence'], [{ workspaceId: UNKNOWN_WS }, 'stale_binding_fence'],
      [{ workRunId: 'run_missing' }, 'not_found'],
    ]) {
      for (const input of [commit, initial, fresh]) assert.equal(send({ ...input, ...stale }).reason, reason, `${input.operationNonce} ${JSON.stringify(stale)}`);
    }
    assert.deepEqual(persisted(store).bytes, before.bytes);
    assert.equal(ok(send(fresh)).seq, 4);
    assert.equal(persisted(store).state.revision, before.state.revision + 1);
  });
});

test('revision history persists across restart as a contiguous 32-entry suffix, and results and getters are isolated clones', () => {
  withTempRoot('history', (root) => {
    const { store, storeRoot, token } = boundStore(root);
    const step = (seq) => ({
      ...token, expectedRevisionSeq: seq - 1, intent: seq % 2 ? 'reset' : 'commit', reasonCode: seq % 2 ? 'cap_reset' : undefined,
      next: { ...START, headOid: oid(100 + seq) }, operationNonce: `nonce-h-${seq}`,
    });
    ok(store.transitionWorkspaceRevision({ ...token, expectedRevisionSeq: 0, intent: 'initial', next: START, operationNonce: 'nonce-h-1' }));
    const revisions = {};
    for (let seq = 2; seq <= 36; seq += 1) revisions[seq] = ok(store.transitionWorkspaceRevision(step(seq)));
    const priv = privateOf(store, token);
    assert.equal(priv.revision.seq, 36);
    assert.deepEqual(priv.revisionHistory.map((entry) => entry.seq), Array.from({ length: 32 }, (_, k) => k + 5));
    assert.equal(new Set(priv.revisionHistory.map((entry) => entry.operationNonce)).size, 32);
    assert.deepEqual(priv.revisionHistory.at(-1), priv.revision);

    const before = persisted(store);
    const restarted = createFileWorkRunStore(storeRoot);
    assert.deepEqual(privateOf(restarted, token), priv);
    assert.deepEqual(privateOf(createFileWorkRunStatusReader(storeRoot), token), priv);
    assert.deepEqual(restarted.transitionWorkspaceRevision(step(5)), { ok: true, deduped: true, revision: revisions[5] });
    const evicted = restarted.transitionWorkspaceRevision(step(4));
    assert.deepEqual([evicted.ok, evicted.reason, evicted.authoritative], [false, CAS, revisions[36]]);
    assert.deepEqual(persisted(store).bytes, before.bytes);

    const latest = ok(restarted.transitionWorkspaceRevision(step(37)));
    const reads = () => ({ pub: restarted.getWorkspaceBinding(token.workspaceId), priv: privateOf(restarted, token), verified: restarted.verifyWorkspaceFence(token) });
    const pristine = JSON.parse(JSON.stringify(reads()));
    const tampered = reads();
    latest.headOid = 'tampered';
    tampered.pub.revision.seq = 0;
    tampered.priv.revision.operationNonce = 'tampered';
    tampered.priv.revisionHistory.length = 0;
    tampered.verified.binding.revisionHistory.push(null);
    restarted.transitionWorkspaceRevision(step(37)).revision.branch = 'tampered';
    assert.deepEqual(reads(), pristine);
    assert.equal(pristine.priv.revisionHistory.length, 32);
    assert.equal(pristine.pub.revision.headOid, oid(137));
  });
});

test('malformed revision state fails closed on load, and seq overflow fails closed without writing', () => {
  withTempRoot('corrupt', (root) => {
    const { store, storeRoot, token } = boundStore(root);
    ok(transition(store, token, 0, 'initial', START));
    ok(transition(store, token, 1, 'commit', { ...START, headOid: oid(3) }));
    const { statePath } = store.paths;
    const baseline = fs.readFileSync(statePath, 'utf8');
    const id = token.workspaceId;
    const both = (fn) => (s) => { const b = s.workspaceBindings[id]; fn(b.revision); fn(b.revisionHistory.at(-1)); };
    const corruptions = {
      badRevisionOid: both((r) => { r.headOid = 'Z'.repeat(40); }),
      nullHistoryEntry: (s) => { s.workspaceBindings[id].revisionHistory[0] = null; },
      duplicateNonces: (s) => { const h = s.workspaceBindings[id].revisionHistory; h[0].operationNonce = h[1].operationNonce; },
      nonContiguousSeq: both((r) => { r.seq = 3; }),
      currentNotLast: (s) => { s.workspaceBindings[id].revision.headOid = oid(9); },
      historyTooLong: (s) => {
        const b = s.workspaceBindings[id];
        b.revisionHistory = Array.from({ length: 33 }, (_, k) => ({ ...b.revision, seq: k + 1, operationNonce: `nonce-long-${k}` }));
        b.revision = { ...b.revisionHistory[32] };
      },
      unknownRevisionField: both((r) => { r.handoff = true; }),
      foreignFactsSource: both((r) => { r.factsSource = 'git'; }),
      revisionWithoutHistory: (s) => { delete s.workspaceBindings[id].revisionHistory; },
      historyWithoutRevision: (s) => { delete s.workspaceBindings[id].revision; },
    };
    for (const [name, corrupt] of Object.entries(corruptions)) {
      const state = JSON.parse(baseline);
      corrupt(state);
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      assert.throws(() => createFileWorkRunStore(storeRoot).getWorkspaceBinding(id), failsClosed, name);
      assert.throws(() => createFileWorkRunStatusReader(storeRoot).verifyWorkspaceFence(token), failsClosed, name);
    }

    const max = JSON.parse(baseline);
    const binding = max.workspaceBindings[id];
    binding.revisionHistory = [{ ...binding.revision, seq: Number.MAX_SAFE_INTEGER }];
    binding.revision = { ...binding.revisionHistory[0] };
    const maxText = JSON.stringify(max, null, 2);
    fs.writeFileSync(statePath, maxText);
    const loaded = createFileWorkRunStore(storeRoot);
    assert.equal(loaded.getWorkspaceBinding(id).revision.seq, Number.MAX_SAFE_INTEGER);
    assert.equal(typeof loaded.transitionWorkspaceRevision, 'function');
    let outcome;
    try {
      outcome = loaded.transitionWorkspaceRevision({ ...token, expectedRevisionSeq: Number.MAX_SAFE_INTEGER, intent: 'commit', next: { ...START, headOid: oid(9) }, operationNonce: 'nonce-overflow' });
    } catch (error) {
      assert.equal(error instanceof TypeError, false, error.stack);
      outcome = { ok: false, error: error.message };
    }
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(fs.readFileSync(statePath, 'utf8'), maxText);
    assert.equal(fs.existsSync(store.paths.lockPath), false);
  });
});

test('getters and verify stay pure reads that compare revision expectations exactly, even under an incumbent lock', () => {
  withTempRoot('reads', (root) => {
    const missing = path.join(root, 'missing-store');
    const missingReader = createFileWorkRunStatusReader(missing);
    assert.equal(missingReader.getWorkspaceBinding(UNKNOWN_WS), null);
    assert.equal(missingReader.verifyWorkspaceFence({ workRunId: 'run_rev_a', ownerId: 'agent:a', fence: 1, workspaceId: UNKNOWN_WS, bindingFence: 1 }).reason, 'not_found');
    assert.equal(fs.existsSync(missing), false);

    const { store, storeRoot, token } = boundStore(root);
    for (const extra of [{ expectedRevisionSeq: 0 }, { expectedRevisionSeq: 1 }, { expectedHeadOid: oid(2) }, { revision: START }]) {
      assert.equal(store.verifyWorkspaceFence({ ...token, ...extra }).reason, 'workspace_revision_unavailable', JSON.stringify(extra));
    }
    ok(transition(store, token, 0, 'initial', START));
    ok(transition(store, token, 1, 'commit', { ...START, headOid: oid(3) }));
    const priv = privateOf(store, token);
    const authoritative = store.getWorkspaceBinding(token.workspaceId).revision;
    const lockToken = `incumbent:${process.pid}`;
    let fd;
    try {
      fd = fs.openSync(store.paths.lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, lockToken);
      const before = snapshot(storeRoot);
      for (const source of [store, createFileWorkRunStatusReader(storeRoot)]) {
        for (const expect of [{}, { expectedRevisionSeq: 2 }, { expectedHeadOid: oid(3) }, { expectedRevisionSeq: 2, expectedHeadOid: oid(3) }]) {
          assert.deepEqual(source.verifyWorkspaceFence({ ...token, ...expect }), { ok: true, binding: priv }, JSON.stringify(expect));
        }
        for (const expect of [
          { expectedRevisionSeq: 1 }, { expectedRevisionSeq: '2' }, { expectedHeadOid: oid(2) },
          { expectedHeadOid: oid(3).toUpperCase() }, { expectedRevisionSeq: 2, expectedHeadOid: oid(2) }, { expectedRevisionSeq: 3, expectedHeadOid: oid(3) },
        ]) {
          assert.deepEqual(source.verifyWorkspaceFence({ ...token, ...expect }), { ok: false, reason: CAS, authoritative }, JSON.stringify(expect));
        }
        assert.equal(source.verifyWorkspaceFence({ ...token, revision: START }).reason, 'workspace_revision_unavailable');
        assert.equal(source.verifyWorkspaceFence({ ...token, revision: START, expectedRevisionSeq: 2 }).reason, 'workspace_revision_unavailable');
        assert.equal(source.verifyWorkspaceFence({ ...token, bindingFence: token.bindingFence + 1, expectedRevisionSeq: 2 }).reason, 'stale_binding_fence');
        assert.deepEqual(source.getWorkspaceBinding(token.workspaceId, { public: false }), priv);
        assert.deepEqual(source.getWorkspaceBinding(token.workspaceId).revision, authoritative);
      }
      assert.deepEqual(snapshot(storeRoot), before);
      assert.equal(fs.readFileSync(store.paths.lockPath, 'utf8'), lockToken);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
});

const CHILD_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [entry, root, barrier, index, tokenJson, nextJson] = process.argv.slice(1);
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
  const result = store.transitionWorkspaceRevision({
    ...JSON.parse(tokenJson), expectedRevisionSeq: 1, intent: 'commit', operationNonce: 'nonce-race-' + index, next: JSON.parse(nextJson),
  });
  report = { index: Number(index), ok: result.ok === true, seq: result.revision ? result.revision.seq : null, reason: result.reason || null };
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
  const root = tempRoot(`race-${round}`);
  const children = [];
  try {
    const barrier = path.join(root, 'barrier');
    fs.mkdirSync(barrier);
    const { store, storeRoot, token } = boundStore(root);
    ok(transition(store, token, 0, 'initial', START));
    const baseline = persisted(store).state.revision;
    const heads = Array.from({ length: RACERS }, (_, i) => oid(500 + i));
    for (const [i, headOid] of heads.entries()) {
      children.push(spawnChild([PACKAGE_ENTRY, storeRoot, barrier, String(i), JSON.stringify(token), JSON.stringify({ ...START, headOid })]));
    }
    const allReady = await waitUntil(() => heads.every((_, i) => fs.existsSync(path.join(barrier, `ready-${i}`))), 10000);
    fs.writeFileSync(path.join(barrier, 'go'), '');
    const outcomes = await Promise.all(children.map((entry) => entry.done));
    const diag = `round ${round}: ${JSON.stringify(outcomes)}`;
    assert.equal(allReady, true, diag);
    const reports = outcomes.map((outcome) => { assert.equal(outcome.code, 0, diag); return JSON.parse(outcome.stdout); });
    const winners = reports.filter((report) => report.ok === true);
    assert.equal(winners.length, 1, diag);
    assert.equal(winners[0].seq, 2, diag);
    for (const report of reports.filter((entry) => entry !== winners[0])) {
      assert.ok(report.reason === CAS || report.error === 'work-run store is busy', diag);
    }
    const final = privateOf(createFileWorkRunStatusReader(storeRoot), token);
    assert.deepEqual([final.revision.seq, final.revision.headOid, final.revision.operationNonce], [2, heads[winners[0].index], `nonce-race-${winners[0].index}`], diag);
    assert.deepEqual(final.revisionHistory.map((entry) => entry.seq), [1, 2]);
    assert.equal(persisted(store).state.revision, baseline + 1, diag);
    assert.equal(fs.existsSync(store.paths.lockPath), false);
  } finally {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map((entry) => entry.done));
    cleanup(root);
  }
}

test('concurrent processes racing one revision CAS produce exactly one durable winner', { timeout: 120000 }, async () => {
  for (let round = 0; round < 2; round += 1) await raceRound(round);
});
