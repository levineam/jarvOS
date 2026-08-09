'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
