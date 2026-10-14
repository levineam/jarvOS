'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLiveBeadsTracker } = require('../src/adapters/live/beads-tracker');

test('Beads rejects PATH lookup, unsafe ownership/modes and symlink ancestry before execution', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beads-executable-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'br');
  fs.writeFileSync(executable, 'disposable mocked executable', { mode: 0o700 });
  let calls = 0;
  const options = { workspaceRoot: root, run() { calls += 1; return { status: 0, stdout: '{}' }; } };
  for (const value of [undefined, 'br', './br', `${bin}/../bin/br`]) {
    assert.throws(() => createLiveBeadsTracker({ ...options, executable: value }), /absolute path/);
  }
  const alias = path.join(root, 'alias');
  fs.symlinkSync(bin, alias);
  assert.throws(() => createLiveBeadsTracker({ ...options, executable: path.join(alias, 'br') }), /symbolic links/);
  fs.chmodSync(executable, 0o770);
  assert.throws(() => createLiveBeadsTracker({ ...options, executable }), /group\/world-writable/);
  fs.chmodSync(executable, 0o700);
  fs.chmodSync(bin, 0o777);
  assert.throws(() => createLiveBeadsTracker({ ...options, executable }), /unsafe ancestor/);
  fs.chmodSync(bin, 0o755);
  const getuid = process.getuid;
  try {
    process.getuid = () => getuid() + 1;
    assert.throws(() => createLiveBeadsTracker({ ...options, executable }), /untrusted owner/);
  } finally { process.getuid = getuid; }
  const tracker = createLiveBeadsTracker({ ...options, executable });
  fs.chmodSync(bin, 0o777);
  await assert.rejects(() => tracker.createWorkItem({ operationId: 'swap', title: 'cannot run' }), /unsafe ancestor/);
  assert.equal(calls, 0);
});
