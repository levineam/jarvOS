'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  assertStewardshipAdapter,
  REQUIRED_LIFECYCLE_CAPABILITIES,
  STEWARDSHIP_ADAPTER_VERSION,
} = require('../src');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIMES = ['claude', 'codex', 'openclaw', 'hermes'];
const CAPABILITIES = [...REQUIRED_LIFECYCLE_CAPABILITIES, 'availability'];

function manifestFor(runtime) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', runtime, 'adapter.json'), 'utf8'));
}

function adapterFromDeclaration(declaration) {
  const adapter = {
    version: declaration.version,
    harness: declaration.harness,
    // The static adapter claims a capability to supply isolation. It does not
    // claim that an arbitrary current checkout is already isolated.
    isolationMode: declaration.isolation.preferredMode,
    isolatedWorktrees: declaration.isolation.providesIsolatedWorktrees,
  };
  for (const capability of REQUIRED_LIFECYCLE_CAPABILITIES) adapter[capability] = () => declaration.capabilities[capability];
  return adapter;
}

test('checked-in runtime adapters expose one opt-in stewardship lifecycle contract', () => {
  for (const runtime of RUNTIMES) {
    const manifest = manifestFor(runtime);
    const declaration = manifest.stewardshipAdapter;
    assert.ok(declaration, `${runtime} must declare stewardshipAdapter`);
    assert.equal(declaration.version, STEWARDSHIP_ADAPTER_VERSION);
    assert.equal(declaration.activation.enabledByDefault, false);
    assert.equal(declaration.isolation.providesIsolatedWorktrees, true);
    assert.equal(declaration.isolation.requiresVerifiedWorktreeEvidence, true);
    if (['claude', 'codex'].includes(runtime)) {
      assert.match(declaration.bridge.contract, /nextTurnInput/);
      assert.match(declaration.bridge.contract, /2-3 choices/);
      assert.match(declaration.bridge.contract, /without granting authority/);
    }
    assert.deepEqual(Object.keys(declaration.capabilities).sort(), [...CAPABILITIES].sort());
    assert.equal(declaration.bridge.environment, 'JARVOS_STEWARDSHIP_BRIDGE_COMMAND');
    for (const capability of CAPABILITIES) {
      assert.ok(['native-hook', 'managed-launcher'].includes(declaration.capabilities[capability].mode));
    }
    assert.equal(assertStewardshipAdapter(adapterFromDeclaration(declaration)).harness, declaration.harness);
  }
});

test('native hook adapters fall back until linked-worktree evidence is present', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-no-git-'));
  try {
    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-start-hook.js'));
      assertStewardshipAdapter(hook.stewardshipAdapter);
      const state = hook.stewardshipAdapter.availability({ cwd: temp });
      assert.deepEqual(state, {
        capability: 'availability',
        available: false,
        preferredIsolationMode: 'native',
        isolationMode: 'managed-launcher',
        isolatedWorktree: false,
        requiresVerifiedWorktreeEvidence: true,
        pendingInSessionInput: false,
        reason: 'bridge-not-configured',
      });
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function runTurnHook(runtime, env) {
  const result = spawnSync('node', [path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('native hooks display a validated public judgment on the next turn', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-bridge-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"A recovery window is ready. Which safe next step should be displayed?\",\"choices\":[\"Wait for confirmation\",\"Prepare a dry run\"],\"default\":\"Wait for confirmation\",\"correlation\":\"judgment-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';

    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const start = hook.stewardshipAdapter.startOrResume({ cwd: temp });
      const input = hook.stewardshipAdapter.nextTurnInput({ cwd: temp });
      assert.equal(start.available, true);
      assert.equal(start.pendingInSessionInput, false);
      assert.equal(input.available, true);
      assert.equal(input.pendingInSessionInput, true);
      assert.deepEqual(input.nextTurnInput, {
        prompt: 'A recovery window is ready. Which safe next step should be displayed?',
        choices: ['Wait for confirmation', 'Prepare a dry run'],
        default: 'Wait for confirmation',
        correlation: 'judgment-42',
      });
      assert.equal(input.isolationMode, 'managed-launcher');
      assert.deepEqual(Object.keys(input).sort(), [
        'available',
        'capability',
        'isolatedWorktree',
        'isolationMode',
        'nextTurnInput',
        'pendingInSessionInput',
        'preferredIsolationMode',
        'reason',
        'requiresVerifiedWorktreeEvidence',
      ]);
      const output = runTurnHook(runtime, process.env);
      const context = output.hookSpecificOutput.additionalContext;
      assert.match(context, /A recovery window is ready\. Which safe next step should be displayed\?/);
      assert.match(context, /Wait for confirmation/);
      assert.match(context, /Prepare a dry run/);
      assert.match(context, /judgment-42/);
      assert.doesNotMatch(context, /reports pending in-session input/);
    }
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('native turn hooks reject malicious bridge payloads and stay quiet without public input', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-turn-reject-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      "printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Read /Users/alice/private-router before deciding.\",\"choices\":[\"Wait\",\"Proceed\"],\"default\":\"Wait\",\"correlation\":\"judgment-42\",\"route\":\"private-router\"}'",
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';

    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const input = hook.stewardshipAdapter.nextTurnInput({ cwd: temp });
      assert.equal(input.available, false);
      assert.equal(input.pendingInSessionInput, false);
      assert.equal(input.reason, 'bridge-unavailable');
      assert.deepEqual(runTurnHook(runtime, process.env), {});
    }

    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      "printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":false}'",
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const input = hook.stewardshipAdapter.nextTurnInput({ cwd: temp });
      assert.equal(input.available, true);
      assert.equal(input.pendingInSessionInput, false);
      assert.deepEqual(runTurnHook(runtime, process.env), {});
    }

    delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    for (const runtime of ['claude', 'codex']) assert.deepEqual(runTurnHook(runtime, process.env), {});
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('native hook declarations point at the packaged start and turn bridges', () => {
  for (const runtime of ['claude', 'codex']) {
    const declaration = manifestFor(runtime).stewardshipAdapter;
    assert.equal(declaration.capabilities.startOrResume.script, 'jarvos-session-start-hook.js');
    for (const capability of ['heartbeat', 'nextTurnInput', 'availability']) {
      assert.equal(declaration.capabilities[capability].script, 'jarvos-session-turn-hook.js');
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js')));
  }
});

function runSetup(script, env) {
  const result = spawnSync('bash', [script], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function count(content, pattern) {
  return (content.match(pattern) || []).length;
}

test('Claude setup merges both jarvOS lifecycle hooks without replacing user hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-hook-setup-'));
  const settings = path.join(temp, 'settings.json');
  const desktop = path.join(temp, 'desktop.json');
  try {
    fs.writeFileSync(settings, `${JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'user-session-start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-prompt-submit' }] }],
      },
    }, null, 2)}\n`, 'utf8');
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      CLAUDE_SETTINGS: settings,
      CLAUDE_DESKTOP_CONFIG: desktop,
      JARVOS_SKIP_CLAUDE_CODE_MCP: '1',
      JARVOS_SKIP_CLAUDE_MD: '1',
    };
    const script = path.join(ROOT, 'runtimes', 'claude', 'setup.sh');
    runSetup(script, env);
    const first = fs.readFileSync(settings, 'utf8');
    runSetup(script, env);
    const second = fs.readFileSync(settings, 'utf8');
    const parsed = JSON.parse(second);
    assert.equal(first, second);
    assert.equal(parsed.hooks.SessionStart.length, 2);
    assert.equal(parsed.hooks.UserPromptSubmit.length, 2);
    assert.equal(count(second, /jarvos-session-start-hook\.js/g), 1);
    assert.equal(count(second, /jarvos-session-turn-hook\.js/g), 1);
    assert.match(second, /user-session-start/);
    assert.match(second, /user-prompt-submit/);
    assert.equal(fs.readdirSync(temp).filter((name) => name.startsWith('settings.json.bak-jarvos-')).length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex setup merges both jarvOS lifecycle hooks without replacing user hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-hook-setup-'));
  const bin = path.join(temp, 'bin');
  const config = path.join(temp, 'config.toml');
  try {
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, [
      '#!/usr/bin/env sh',
      'if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi',
      'exit 0',
      '',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(codex, 0o755);
    fs.writeFileSync(config, [
      '[hooks]',
      'SessionStart = [{ matcher = "startup", hooks = [{ type = "command", command = "user-session-start" }] }]',
      'UserPromptSubmit = [{ hooks = [{ type = "command", command = "user-prompt-submit" }] }]',
      '',
      '[unrelated]',
      'value = true',
      '',
    ].join('\n'), 'utf8');
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      CODEX_CONFIG: config,
    };
    const script = path.join(ROOT, 'runtimes', 'codex', 'setup.sh');
    runSetup(script, env);
    const first = fs.readFileSync(config, 'utf8');
    runSetup(script, env);
    const second = fs.readFileSync(config, 'utf8');
    assert.equal(first, second);
    assert.equal(count(second, /jarvos-session-start-hook\.js/g), 1);
    assert.equal(count(second, /jarvos-session-turn-hook\.js/g), 1);
    assert.match(second, /user-session-start/);
    assert.match(second, /user-prompt-submit/);
    assert.match(second, /\[unrelated\]\nvalue = true/);
    assert.equal(fs.readdirSync(temp).filter((name) => name.startsWith('config.toml.bak-jarvos-')).length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
