'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const ROOT = path.resolve(__dirname, '../../..');
const sessionId = '66666666-7777-4888-8999-aaaaaaaaaaaa';

test('native hooks never discover git or a bridge through workspace PATH', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-command-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'workspace-command');
  fs.writeFileSync(path.join(root, 'git'), `#!/bin/sh\nprintf touched > '${marker}'\nexit 1\n`, { mode: 0o700 });
  const bridge = path.join(root, 'trusted-bridge');
  fs.writeFileSync(bridge, `#!/bin/sh\nprintf '%s\\n' '{"available":true,"pendingInSessionInput":false}'\n`, { mode: 0o700 });
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = root;
    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const options = { cwd: root, sessionId, env: { PATH: root, CODEX_THREAD_ID: sessionId }, bridgeCommand: '' };
      assert.equal(hook.stewardshipAdapter.startOrResume(options).reason, 'bridge-not-configured');
      assert.equal(fs.existsSync(marker), false);
      assert.equal(hook.stewardshipAdapter.startOrResume({ ...options, bridgeCommand: bridge }).available, true);
      assert.equal(fs.existsSync(marker), false);
      fs.chmodSync(root, 0o777);
      assert.equal(hook.stewardshipAdapter.startOrResume({ ...options, bridgeCommand: bridge }).available, false);
      fs.chmodSync(root, 0o700);
    }
  } finally { process.env.PATH = priorPath; }
});

test('Claude persists an exact bridge path without persisting inherited PATH or path aliases', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-persistence-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bridge = path.join(root, "bridge's $& command");
  fs.writeFileSync(bridge, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const envFile = path.join(root, 'environment');
  fs.writeFileSync(envFile, '', { mode: 0o600 });
  const hook = require(path.join(ROOT, 'runtimes/claude/jarvos-session-start-hook.js'));
  const env = { CLAUDE_ENV_FILE: envFile, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: bridge, JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT: root, PATH: '/untrusted/workspace' };
  assert.equal(hook.persistBridgeEnvironment({ env }), true);
  const content = fs.readFileSync(envFile, 'utf8');
  assert.doesNotMatch(content, /export PATH/);
  const readBack = spawnSync('/bin/sh', ['-c', '. "$1"; printf "%s" "$JARVOS_STEWARDSHIP_BRIDGE_COMMAND"', 'sh', envFile], { encoding: 'utf8', env: {} });
  assert.equal(readBack.status, 0, readBack.stderr);
  assert.equal(readBack.stdout, bridge);
  const alias = path.join(root, 'alias');
  fs.symlinkSync(root, alias);
  for (const command of ['br', `${alias}/../${path.basename(root)}/${path.basename(bridge)}`]) {
    assert.equal(hook.persistBridgeEnvironment({ env: { ...env, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: command } }), false);
  }
  assert.equal(fs.readFileSync(envFile, 'utf8'), content);
});
