'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const bridge = require('../scripts/active-assistant-nightly-synthesis.js');

function fixture() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-aa-runtime-'));
  const publicRoot = path.join(runtimeRoot, 'repos', 'jarvOS');
  const entrypoint = path.join(runtimeRoot, bridge.IMPLEMENTATION_RELATIVE_PATH);
  fs.mkdirSync(publicRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true, mode: 0o700 });
  fs.writeFileSync(entrypoint, 'module.exports={runSynthesis(){}};\n', { mode: 0o600 });
  return { runtimeRoot, publicRoot, entrypoint };
}

test('resolves only the implementation paired with the current public runtime', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.runtimeRoot, { recursive: true, force: true }));

  assert.equal(bridge.resolveImplementationEntrypoint(f), fs.realpathSync(f.entrypoint));

  const otherPublic = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-aa-public-'));
  t.after(() => fs.rmSync(otherPublic, { recursive: true, force: true }));
  assert.throws(
    () => bridge.resolveImplementationEntrypoint({ ...f, publicRoot: otherPublic }),
    { code: 'active_assistant_public_runtime_mismatch' },
  );
});

test('rejects relative roots and symlinked implementation files', (t) => {
  assert.throws(
    () => bridge.resolveImplementationEntrypoint({ runtimeRoot: 'relative' }),
    { code: 'active_assistant_runtime_root_required' },
  );

  const f = fixture();
  t.after(() => fs.rmSync(f.runtimeRoot, { recursive: true, force: true }));
  const real = `${f.entrypoint}.real`;
  fs.renameSync(f.entrypoint, real);
  fs.symlinkSync(real, f.entrypoint);
  assert.throws(
    () => bridge.resolveImplementationEntrypoint(f),
    { code: 'active_assistant_runtime_path_invalid' },
  );
});

test('rejects group- or world-writable runtime paths', (t) => {
  const cases = [
    { target: (f) => f.runtimeRoot, mode: 0o720 },
    { target: (f) => path.dirname(f.entrypoint), mode: 0o702 },
    { target: (f) => f.entrypoint, mode: 0o620 },
    { target: (f) => f.entrypoint, mode: 0o602 },
  ];

  for (const testCase of cases) {
    const f = fixture();
    t.after(() => fs.rmSync(f.runtimeRoot, { recursive: true, force: true }));
    fs.chmodSync(testCase.target(f), testCase.mode);
    assert.throws(
      () => bridge.resolveImplementationEntrypoint(f),
      { code: 'active_assistant_runtime_permissions_unsafe' },
    );
  }
});

test('rejects a runtime that aliases the genuine public root through a symlink', (t) => {
  const genuine = fixture();
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-aa-alias-'));
  t.after(() => fs.rmSync(genuine.runtimeRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(aliasRoot, 'repos'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(aliasRoot, 'scripts'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(genuine.publicRoot, path.join(aliasRoot, 'repos', 'jarvOS'));
  fs.writeFileSync(
    path.join(aliasRoot, bridge.IMPLEMENTATION_RELATIVE_PATH),
    'module.exports={runSynthesis(){}};\n',
    { mode: 0o600 },
  );

  assert.throws(
    () => bridge.resolveImplementationEntrypoint({
      runtimeRoot: aliasRoot,
      publicRoot: genuine.publicRoot,
    }),
    { code: 'active_assistant_public_runtime_mismatch' },
  );
});

test('loads the paired implementation and keeps module introspection local', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.runtimeRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    f.entrypoint,
    'module.exports={runSynthesis(){return "loaded";},main(){}};\n',
    { mode: 0o600 },
  );
  const implementation = bridge.loadImplementation({
    env: { [bridge.ROOT_ENV]: f.runtimeRoot },
    publicRoot: f.publicRoot,
  });
  assert.equal(implementation.runSynthesis(), 'loaded');
  assert.doesNotThrow(() => Object.keys(bridge));
  assert.equal(Object.keys(bridge).includes('runSynthesis'), false);
});

test('publishes the typed synthesis contract version without exposing host evidence', () => {
  assert.equal(bridge.SYNTHESIS_CONTRACT_VERSION, 'active-assistant-synthesis/v1');
  assert.equal(Object.keys(bridge).includes('coachMessage'), false);
});

test('CLI awaits main and redacts implementation failures', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.runtimeRoot, { recursive: true, force: true }));
  const copiedBridge = path.join(f.publicRoot, 'scripts', 'active-assistant-nightly-synthesis.js');
  fs.mkdirSync(path.dirname(copiedBridge), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.resolve(__dirname, '..', 'scripts', 'active-assistant-nightly-synthesis.js'), copiedBridge);
  fs.writeFileSync(
    f.entrypoint,
    'module.exports={runSynthesis(){},async main(){await Promise.resolve();throw new Error("/private/runtime/path");}};\n',
    { mode: 0o600 },
  );

  const child = spawnSync(process.execPath, [copiedBridge], {
    encoding: 'utf8',
    env: { ...process.env, [bridge.ROOT_ENV]: f.runtimeRoot },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /active_assistant_runtime_failure/);
  assert.equal(child.stderr.includes('/private/runtime/path'), false);
});
