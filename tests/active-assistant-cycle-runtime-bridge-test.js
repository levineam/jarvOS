'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const bridgePath = path.resolve(__dirname, '..', 'scripts', 'active-assistant-cycle.js');
const bridge = require(bridgePath);

function fixture() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-aa-cycle-runtime-'));
  const publicRoot = path.join(runtimeRoot, 'repos', 'jarvOS');
  const entrypoint = path.join(runtimeRoot, 'scripts', 'active-assistant-cycle.js');
  const selectorPath = path.join(runtimeRoot, 'runtime-selection.json');
  fs.mkdirSync(publicRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true, mode: 0o700 });
  fs.writeFileSync(entrypoint, 'module.exports={cycleContractVersion:"active-assistant-cycle/v1",main(){return "ok";}};\n', { mode: 0o600 });
  fs.writeFileSync(selectorPath, JSON.stringify({
    schema: bridge.SELECTION_SCHEMA,
    runtimeRoot,
    commit: 'a'.repeat(40),
    publicCommit: 'b'.repeat(40),
    reviewedTupleDigest: `sha256:${'c'.repeat(64)}`,
    ciQualification: { reviewedTupleDigest: `sha256:${'c'.repeat(64)}` },
    ciPolicy: { schema: 'fixture-policy/v1' },
    ciQualifiedTupleDigest: `sha256:${'d'.repeat(64)}`,
    ciReviewedTupleDigest: `sha256:${'c'.repeat(64)}`,
    selectedAt: '2026-08-18T00:00:00.000Z',
  }) + '\n', { mode: 0o600 });
  return { runtimeRoot, publicRoot, entrypoint, selectorPath };
}

function cleanup(fixtureValue) {
  fs.rmSync(fixtureValue.runtimeRoot, { recursive: true, force: true });
}

test('resolves only the exact selected runtime and rejects arbitrary roots', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));

  assert.equal(bridge.resolveImplementationEntrypoint(f), fs.realpathSync(f.entrypoint));
  assert.throws(() => bridge.resolveImplementationEntrypoint({ ...f, runtimeRoot: path.join(f.runtimeRoot, 'missing') }), { code: 'active_assistant_runtime_path_invalid' });

  const otherPublic = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-aa-cycle-public-'));
  t.after(() => fs.rmSync(otherPublic, { recursive: true, force: true }));
  assert.throws(() => bridge.resolveImplementationEntrypoint({ ...f, publicRoot: otherPublic }), { code: 'active_assistant_public_runtime_mismatch' });
  assert.throws(() => bridge.resolveImplementationEntrypoint({ ...f, runtimeRoot: 'relative' }), { code: 'active_assistant_runtime_root_required' });
});

test('rejects symlinked roots, public trees, and implementation files', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));

  const rootAlias = `${f.runtimeRoot}-alias`;
  fs.symlinkSync(f.runtimeRoot, rootAlias, 'dir');
  t.after(() => fs.rmSync(rootAlias, { force: true }));
  assert.throws(() => bridge.resolveImplementationEntrypoint({ ...f, runtimeRoot: rootAlias }), { code: 'active_assistant_runtime_path_invalid' });

  const realEntry = `${f.entrypoint}.real`;
  fs.renameSync(f.entrypoint, realEntry);
  fs.symlinkSync(realEntry, f.entrypoint);
  assert.throws(() => bridge.resolveImplementationEntrypoint(f), { code: 'active_assistant_runtime_path_invalid' });
});

test('rejects owner-mismatched and nested-symlink runtime paths', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));
  if (typeof process.getuid === 'function') {
    const otherUid = process.getuid() === 0 ? 1 : process.getuid() - 1;
    const ownerMismatchFs = {
      ...fs,
      lstatSync(target) {
        const stat = fs.lstatSync(target);
        if (target !== f.runtimeRoot) return stat;
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: otherUid });
      },
    };
    assert.throws(() => bridge.resolveImplementationEntrypoint({ ...f, fsImpl: ownerMismatchFs }), { code: 'active_assistant_runtime_owner_mismatch' });
  }
  const reposAlias = `${f.runtimeRoot}-repos-alias`;
  fs.symlinkSync(path.join(f.runtimeRoot, 'repos'), reposAlias, 'dir');
  t.after(() => fs.rmSync(reposAlias, { force: true }));
  assert.throws(() => bridge.resolveImplementationEntrypoint({ ...f, publicRoot: path.join(reposAlias, 'jarvOS') }), { code: 'active_assistant_runtime_path_invalid' });
});

test('loads the versioned private cycle contract without exposing private fields', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));
  const implementation = bridge.loadImplementation({ env: { [bridge.ROOT_ENV]: f.runtimeRoot }, selectorPath: f.selectorPath, publicRoot: f.publicRoot });
  assert.equal(implementation.cycleContractVersion, bridge.CYCLE_CONTRACT_VERSION);
  assert.equal(Object.keys(bridge).includes('coachMessage'), false);
  assert.equal(Object.keys(bridge).includes('runSynthesis'), false);
});

test('rejects a private implementation with the wrong contract or recursive entrypoint', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));
  fs.writeFileSync(f.entrypoint, 'module.exports={cycleContractVersion:"wrong/v1",main(){}};\n', { mode: 0o600 });
  assert.throws(() => bridge.loadImplementation({ env: { [bridge.ROOT_ENV]: f.runtimeRoot }, selectorPath: f.selectorPath, publicRoot: f.publicRoot }), { code: 'active_assistant_cycle_contract_mismatch' });

  fs.writeFileSync(f.entrypoint, 'module.exports={cycleContractVersion:"active-assistant-cycle/v1",main(){}};\n', { mode: 0o600 });
  const resolvedEntrypoint = path.resolve(fs.realpathSync(f.runtimeRoot), 'scripts', 'active-assistant-cycle.js');
  const fsImpl = {
    ...fs,
    realpathSync(target) {
      return target === resolvedEntrypoint ? bridgePath : fs.realpathSync(target);
    },
  };
  assert.throws(() => bridge.resolveImplementationEntrypoint({ ...f, fsImpl }), { code: 'active_assistant_runtime_recursion' });
});

test('forwards prepare/deliver mode arguments to the private main', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));
  fs.writeFileSync(f.entrypoint, [
    'module.exports={',
    'cycleContractVersion:"active-assistant-cycle/v1",',
    'main(argv){return {mode:argv[0],profile:argv[2]};}',
    '};',
  ].join(''), { mode: 0o600 });
  assert.deepEqual(bridge.main(['prepare', '--profile', 'full'], { env: { [bridge.ROOT_ENV]: f.runtimeRoot }, selectorPath: f.selectorPath, publicRoot: f.publicRoot }), { mode: 'prepare', profile: 'full' });
  assert.deepEqual(bridge.main(['deliver', '--profile', 'current-read'], { env: { [bridge.ROOT_ENV]: f.runtimeRoot }, selectorPath: f.selectorPath, publicRoot: f.publicRoot }), { mode: 'deliver', profile: 'current-read' });
});

test('CLI delegates through the selected public runtime and redacts private failures', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));
  fs.mkdirSync(path.join(f.publicRoot, 'scripts'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(bridgePath, path.join(f.publicRoot, 'scripts', 'active-assistant-cycle.js'));
  fs.writeFileSync(f.entrypoint, [
    'module.exports={',
    'cycleContractVersion:"active-assistant-cycle/v1",',
    'async main(argv){process.stdout.write(JSON.stringify({mode:argv[0],metadata:true})+"\\n");throw new Error("/private/coach/prose");}',
    '};',
  ].join(''), { mode: 0o600 });
  const child = spawnSync(process.execPath, [path.join(f.publicRoot, 'scripts', 'active-assistant-cycle.js'), 'deliver', '--profile', 'current-read'], {
    encoding: 'utf8',
    env: { ...process.env, [bridge.ROOT_ENV]: f.runtimeRoot, [bridge.SELECTOR_ENV]: f.selectorPath },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /active_assistant_runtime_failure/);
  assert.equal(child.stderr.includes('/private/coach/prose'), false);
});

test('requires the owner-private selector and rejects selector/runtime drift', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));
  assert.throws(() => bridge.loadImplementation({ env: { [bridge.ROOT_ENV]: f.runtimeRoot }, publicRoot: f.publicRoot }), { code: 'active_assistant_runtime_selector_required' });

  const other = fixture();
  t.after(() => cleanup(other));
  assert.throws(() => bridge.loadImplementation({
    env: { [bridge.ROOT_ENV]: f.runtimeRoot },
    selectorPath: other.selectorPath,
    publicRoot: f.publicRoot,
  }), { code: 'active_assistant_runtime_selector_mismatch' });
});

test('exposes only metadata from the selected runtime identity and rejects malformed selectors', (t) => {
  const f = fixture();
  t.after(() => cleanup(f));
  const identity = bridge.readRuntimeSelection({ selectorPath: f.selectorPath });
  assert.deepEqual(identity, {
    schema: bridge.SELECTION_SCHEMA,
    selectorPath: f.selectorPath,
    runtimeRoot: f.runtimeRoot,
    commit: 'a'.repeat(40),
    publicCommit: 'b'.repeat(40),
    reviewedTupleDigest: `sha256:${'c'.repeat(64)}`,
    ciQualifiedTupleDigest: `sha256:${'d'.repeat(64)}`,
    ciReviewedTupleDigest: `sha256:${'c'.repeat(64)}`,
    selectedAt: '2026-08-18T00:00:00.000Z',
  });
  assert.equal(Object.hasOwn(identity, 'ciPolicy'), false);
  fs.writeFileSync(f.selectorPath, JSON.stringify({ schema: 'wrong/v1', runtimeRoot: f.runtimeRoot }), { mode: 0o600 });
  assert.throws(() => bridge.readRuntimeSelection({ selectorPath: f.selectorPath }), { code: 'active_assistant_runtime_selector_invalid' });
});
