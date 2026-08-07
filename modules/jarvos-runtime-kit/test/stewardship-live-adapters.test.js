'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
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
const CLAUDE_HOOK_SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const CODEX_HOOK_SESSION_ID = '019fbf11-8aca-79c0-981e-15abcd2392f4';

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

function runTurnHook(runtime, env, input) {
  const result = spawnSync('node', [path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    input: input === undefined ? undefined : JSON.stringify(input),
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
  const oldClaudeSession = process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
  const oldCodexThread = process.env.CODEX_THREAD_ID;
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
    process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = CLAUDE_HOOK_SESSION_ID;
    process.env.CODEX_THREAD_ID = CODEX_HOOK_SESSION_ID;

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
      const output = runTurnHook(runtime, process.env, runtime === 'claude'
        ? { session_id: CLAUDE_HOOK_SESSION_ID }
        : { hook_event_name: 'UserPromptSubmit', session_id: CODEX_HOOK_SESSION_ID });
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
    if (oldClaudeSession === undefined) delete process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
    else process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = oldClaudeSession;
    if (oldCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = oldCodexThread;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude turn hooks accept only a consistent canonical or transcript-derived UUID identity', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-turn-identity-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const invoked = path.join(temp, 'bridge-invoked');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-turn-hook.js'));
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      `: > ${JSON.stringify(invoked)}`,
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID" = "${CLAUDE_HOOK_SESSION_ID}" ] || exit 23`,
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the safe recovery step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"claude-identity-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${oldPath || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
    };
    const accepted = [
      { session_id: CLAUDE_HOOK_SESSION_ID },
      { sessionId: CLAUDE_HOOK_SESSION_ID },
      { transcript_path: path.join(temp, 'private', `${CLAUDE_HOOK_SESSION_ID}.jsonl`) },
      { session_id: CLAUDE_HOOK_SESSION_ID, sessionId: CLAUDE_HOOK_SESSION_ID, transcript_path: path.join(temp, `${CLAUDE_HOOK_SESSION_ID}.jsonl`) },
    ];
    for (const input of accepted) {
      assert.equal(hook.hookSessionId(input), CLAUDE_HOOK_SESSION_ID);
      fs.rmSync(invoked, { force: true });
      const output = runTurnHook('claude', env, input);
      assert.equal(fs.existsSync(invoked), true);
      assert.match(output.hookSpecificOutput.additionalContext, /Choose the safe recovery step\./);
      assert.doesNotMatch(JSON.stringify(output), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    const rejected = [
      {},
      { session_id: 'arbitrary-session' },
      { sessionId: 'arbitrary-session' },
      { session_id: CLAUDE_HOOK_SESSION_ID, sessionId: '77777777-7777-4888-8999-aaaaaaaaaaaa' },
      { session_id: CLAUDE_HOOK_SESSION_ID, transcript_path: path.join(temp, '77777777-7777-4888-8999-aaaaaaaaaaaa.jsonl') },
      { transcript_path: path.join(temp, 'not-a-uuid.jsonl') },
      { transcript_path: `${CLAUDE_HOOK_SESSION_ID}.jsonl` },
      { transcript_path: path.join(temp, `${CLAUDE_HOOK_SESSION_ID}.jsonl`, 'nested') },
    ];
    for (const input of rejected) {
      assert.equal(hook.hookSessionId(input), null);
      fs.rmSync(invoked, { force: true });
      assert.deepEqual(runTurnHook('claude', env, input), {});
      assert.equal(fs.existsSync(invoked), false, `bridge must not run for ${JSON.stringify(input)}`);
    }
    fs.rmSync(invoked, { force: true });
    assert.equal(hook.stewardshipAdapter.nextTurnInput({ cwd: temp, sessionId: null, bridgeCommand: 'jarvos-stewardship-bridge', env }).reason, 'bridge-unavailable');
    assert.equal(fs.existsSync(invoked), false, 'a caller that explicitly lacks a session identity must not run the bridge');
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex SessionStart exposes a pending public judgment for both fresh and resumed sessions', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-session-start-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the safe recovery step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"resume-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';

    const hook = require(path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-start-hook.js'));
    const context = hook.stewardshipContext({ cwd: temp, env: { ...process.env, CODEX_THREAD_ID: CODEX_HOOK_SESSION_ID } });
    assert.match(context, /Choose the safe recovery step\./);
    assert.match(context, /resume-42/);
    assert.match(context, /jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>/);
    assert.doesNotMatch(context, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    process.env.PATH = oldPath;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex SessionStart derives a bridge-only thread identity from resume stdin', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-resume-stdin-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  const invoked = path.join(temp, 'bridge-invoked');
  const sessionId = '019fbf11-8aca-79c0-981e-15abcd2392f4';
  const mismatchedId = '019fbf11-8aca-79c0-981e-15abcd2392f5';
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      `printf '%s\\n' "$1" >> ${JSON.stringify(invoked)}`,
      `[ "$CODEX_THREAD_ID" = "${sessionId}" ] || exit 23`,
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Resume safely?\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"codex-resume-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    const baseEnv = {
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      HOME: path.join(temp, 'clean-home'),
      JARVOS_SECONDBRAIN_DIR: path.join(temp, 'missing-secondbrain'),
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: path.join(temp, 'private-map'),
    };
    const start = (env, input) => spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-start-hook.js')], {
      cwd: temp,
      encoding: 'utf8',
      env,
      input: typeof input === 'string' || input === undefined ? input : JSON.stringify(input),
    });
    const turn = (env, input) => spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-turn-hook.js')], {
      cwd: temp,
      encoding: 'utf8',
      env,
      input: typeof input === 'string' || input === undefined ? input : JSON.stringify(input),
    });

    const resumed = start(baseEnv, { hook_event_name: 'SessionStart', session_id: sessionId });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /Resume safely\?/);
    assert.match(output.hookSpecificOutput.additionalContext, /codex-resume-42/);
    assert.match(output.hookSpecificOutput.additionalContext, /jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>/);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(fs.readFileSync(invoked, 'utf8').trim().split('\n'), ['startOrResume', 'nextTurnInput']);

    fs.rmSync(invoked, { force: true });
    const mismatch = start({ ...baseEnv, CODEX_THREAD_ID: mismatchedId }, { hook_event_name: 'SessionStart', session_id: sessionId });
    assert.equal(mismatch.status, 0, mismatch.stderr || mismatch.stdout);
    assert.deepEqual(JSON.parse(mismatch.stdout), {});
    assert.equal(fs.existsSync(invoked), false);

    const invalidInputs = [
      undefined,
      '{',
      { hook_event_name: 'UserPromptSubmit', session_id: sessionId },
      `{"hook_event_name":"SessionStart","session_id":"${sessionId}","padding":"${'x'.repeat(4096)}"}`,
    ];
    const hydrationEnv = { ...baseEnv, JARVOS_SECONDBRAIN_DIR: path.join(ROOT, 'modules', 'jarvos-secondbrain') };
    for (const ambientThreadId of [sessionId, 'stale-thread-id']) {
      for (const input of invalidInputs) {
        fs.rmSync(invoked, { force: true });
        const rejected = start({ ...hydrationEnv, CODEX_THREAD_ID: ambientThreadId }, input);
        assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
        assert.match(JSON.parse(rejected.stdout).hookSpecificOutput.additionalContext, /# jarvOS Working Context Packet/);
        assert.equal(fs.existsSync(invoked), false, `bridge must not run for ${typeof input === 'string' ? input.slice(0, 32) : JSON.stringify(input)}`);
      }
    }

    const invalidTurnInputs = [
      undefined,
      '{',
      { hook_event_name: 'SessionStart', session_id: sessionId },
      { hook_event_name: 'UserPromptSubmit', session_id: mismatchedId },
    ];
    for (const ambientThreadId of [sessionId, 'stale-thread-id']) {
      for (const input of invalidTurnInputs) {
        fs.rmSync(invoked, { force: true });
        const rejected = turn({ ...baseEnv, CODEX_THREAD_ID: ambientThreadId }, input);
        assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
        assert.deepEqual(JSON.parse(rejected.stdout), {});
        assert.equal(fs.existsSync(invoked), false, `turn bridge must not run for ${typeof input === 'string' ? input : JSON.stringify(input)}`);
      }
    }
    fs.rmSync(invoked, { force: true });
    const mismatchedTurn = turn({ ...baseEnv, CODEX_THREAD_ID: mismatchedId }, { hook_event_name: 'UserPromptSubmit', session_id: sessionId });
    assert.equal(mismatchedTurn.status, 0, mismatchedTurn.stderr || mismatchedTurn.stdout);
    assert.deepEqual(JSON.parse(mismatchedTurn.stdout), {});
    assert.equal(fs.existsSync(invoked), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude SessionStart persists only a validated bridge command and neutral map root for later hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-env-file-'));
  const bin = path.join(temp, 'bin');
  const mappingRoot = path.join(temp, 'claude-session-map');
  const envFile = path.join(temp, 'claude.env');
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(mappingRoot, { mode: 0o700 });
    const bridge = path.join(bin, 'jarvos-stewardship-bridge');
    fs.writeFileSync(bridge, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(bridge, 0o700);
    fs.writeFileSync(envFile, 'export UNRELATED=value\n', { mode: 0o600 });
    fs.chmodSync(envFile, 0o600);
    const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-start-hook.js'));
    const env = {
      CLAUDE_ENV_FILE: envFile,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT: mappingRoot,
      PATH: bin,
    };
    assert.equal(hook.persistBridgeEnvironment({ env }), true);
    const expected = [
      'export UNRELATED=value',
      "export JARVOS_STEWARDSHIP_BRIDGE_COMMAND='jarvos-stewardship-bridge'",
      `export JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT='${mappingRoot}'`,
      `export PATH='${bin}':\"$PATH\"`,
      '',
    ].join('\n');
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
    assert.equal(hook.persistBridgeEnvironment({ env }), true);
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
    assert.equal(hook.persistBridgeEnvironment({ env: { ...env, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: '../invalid' } }), false);
    assert.equal(hook.persistBridgeEnvironment({ env: { ...env, JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT: 'relative-map' } }), false);
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
    fs.chmodSync(envFile, 0o644);
    assert.equal(hook.persistBridgeEnvironment({ env }), false);
    assert.equal(fs.readFileSync(envFile, 'utf8'), expected);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude SessionStart exposes a pending stewardship judgment even when hydration is unavailable', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-start-judgment-'));
  const bin = path.join(temp, 'bin');
  const oldPath = process.env.PATH;
  const oldBridge = process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  try {
    fs.mkdirSync(bin, { recursive: true });
    const bridge = path.join(bin, 'jarvos-stewardship-bridge');
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID" = "${CLAUDE_HOOK_SESSION_ID}" ] || exit 23`,
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the safe recovery step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"claude-start-42\"}'",
      'else',
      "  printf '%s\\n' '{\"available\":true}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${oldPath || ''}`;
    process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = 'jarvos-stewardship-bridge';
    const hook = require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-start-hook.js'));
    const context = hook.stewardshipContext({ cwd: temp, sessionId: CLAUDE_HOOK_SESSION_ID });
    assert.match(context, /Choose the safe recovery step\./);
    assert.match(context, /claude-start-42/);
    assert.match(context, /jarvos-stewardship-bridge answer --correlation <correlation> --choice <listed-choice>/);
    const started = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-start-hook.js')], {
      cwd: temp,
      encoding: 'utf8',
      input: JSON.stringify({ transcript_path: path.join(temp, 'private', `${CLAUDE_HOOK_SESSION_ID}.jsonl`) }),
      env: {
        ...process.env,
        JARVOS_SECONDBRAIN_DIR: path.join(temp, 'missing-secondbrain'),
      },
    });
    assert.equal(started.status, 0, started.stderr);
    const startupOutput = JSON.parse(started.stdout);
    assert.match(startupOutput.hookSpecificOutput.additionalContext, /Choose the safe recovery step\./);
    assert.match(startupOutput.hookSpecificOutput.additionalContext, /claude-start-42/);
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
  const oldClaudeSession = process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
  const oldCodexThread = process.env.CODEX_THREAD_ID;
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
    process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = CLAUDE_HOOK_SESSION_ID;
    process.env.CODEX_THREAD_ID = CODEX_HOOK_SESSION_ID;

    for (const runtime of ['claude', 'codex']) {
      const hook = require(path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js'));
      const input = hook.stewardshipAdapter.nextTurnInput({ cwd: temp });
      assert.equal(input.available, false);
      assert.equal(input.pendingInSessionInput, false);
      assert.equal(input.reason, 'bridge-unavailable');
      assert.deepEqual(runTurnHook(runtime, process.env, runtime === 'claude'
        ? { session_id: CLAUDE_HOOK_SESSION_ID }
        : { hook_event_name: 'UserPromptSubmit', session_id: CODEX_HOOK_SESSION_ID }), {});
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
      assert.deepEqual(runTurnHook(runtime, process.env, runtime === 'claude'
        ? { session_id: CLAUDE_HOOK_SESSION_ID }
        : { hook_event_name: 'UserPromptSubmit', session_id: CODEX_HOOK_SESSION_ID }), {});
    }

    delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    for (const runtime of ['claude', 'codex']) assert.deepEqual(runTurnHook(runtime, process.env), {});
  } finally {
    if (oldBridge === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND = oldBridge;
    if (oldClaudeSession === undefined) delete process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID;
    else process.env.JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID = oldClaudeSession;
    if (oldCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = oldCodexThread;
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

test('OpenClaw and Hermes package bounded per-turn stewardship bridge artifacts without activating user configuration', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'openclaw.plugin.json'), 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'package.json'), 'utf8'));
  assert.equal(manifest.id, 'jarvos-stewardship');
  assert.deepEqual(manifest.contracts, { tools: ['jarvos_stewardship_answer'] });
  assert.deepEqual(manifest.configSchema, {
    type: 'object', additionalProperties: false,
    properties: {
      mappingRoot: { type: 'string', pattern: '^/' }, toolAllowAddedByJarvos: { type: 'boolean' },
      agentToolGrantByJarvos: {
        type: 'object', additionalProperties: false,
        properties: {
          agentId: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' }, added: { type: 'boolean' },
          createdAgent: { type: 'boolean' }, createdTools: { type: 'boolean' }, createdAlsoAllow: { type: 'boolean' },
        },
        required: ['agentId', 'added', 'createdAgent', 'createdTools', 'createdAlsoAllow'],
      },
    }, required: ['mappingRoot'],
  });
  assert.deepEqual(packageJson.openclaw.extensions, ['jarvos-next-turn-plugin.js']);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-stewardship-public-turn-hook-'));
  const bin = path.join(temp, 'bin'); const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  try {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      "if [ \"$1\" = answer ]; then printf '%s\\n' '{\"status\":\"answered\"}'; else printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose a safe next step.\",\"choices\":[\"Wait\",\"Prepare a dry run\"],\"default\":\"Wait\",\"correlation\":\"judgment-42\"}'; fi",
      '',
    ].join('\n'), { mode: 0o755 });
    fs.chmodSync(bridge, 0o755);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge' };
    const hermesResult = spawnSync('node', [path.join(ROOT, 'runtimes', 'hermes', 'jarvos-pre-llm-hook.js')], { encoding: 'utf8', env });
    assert.equal(hermesResult.status, 0, hermesResult.stderr);
    assert.match(JSON.parse(hermesResult.stdout).context, /Choose a safe next step/);
    const mappings = path.join(temp, 'mappings'); fs.mkdirSync(mappings);
    const sessionKey = 'agent:main:explicit:session-42';
    fs.writeFileSync(path.join(mappings, `${createHash('sha256').update(sessionKey).digest('hex')}.json`), `${JSON.stringify({ schemaVersion: 1, contextFile: path.join(temp, 'context.json'), bridgeExecutable: bridge })}\n`, { mode: 0o600 });
    fs.chmodSync(path.join(mappings, `${createHash('sha256').update(sessionKey).digest('hex')}.json`), 0o600);
    const plugin = require(path.join(ROOT, 'runtimes', 'openclaw', 'jarvos-next-turn-plugin.js'));
    // OpenClaw 2026.7.1 places the session identity on the typed hook
    // context, not the before_prompt_build event. Keep the event shape
    // faithful so this regression proves delivery on a normal agent turn.
    const directContext = plugin.before_prompt_build({ prompt: 'Continue', messages: [] }, { sessionKey, pluginConfig: { mappingRoot: mappings } }).prependContext;
    assert.match(directContext, /Choose a safe next step/);
    assert.match(directContext, /call jarvos_stewardship_answer/);
    assert.doesNotMatch(directContext, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(plugin.before_prompt_build({ prompt: 'Continue', messages: [] }, { sessionKey: 'agent:other:explicit:session-42', pluginConfig: { mappingRoot: mappings } }), {});
    assert.deepEqual(plugin.before_prompt_build({ prompt: 'Continue', messages: [] }, { sessionKey: 'unmapped', pluginConfig: { mappingRoot: mappings } }), {});
    const registrations = []; const tools = [];
    plugin({ pluginConfig: { mappingRoot: mappings }, on: (...args) => registrations.push(args), registerTool: (...args) => tools.push(args) });
    assert.equal(registrations.length, 1); assert.equal(registrations[0][0], 'before_prompt_build'); assert.equal(registrations[0][2].timeoutMs, 5000);
    const registeredContext = registrations[0][1]({ prompt: 'Continue', messages: [] }, { sessionKey }).prependContext;
    assert.match(registeredContext, /Choose a safe next step/);
    assert.doesNotMatch(registeredContext, new RegExp(temp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(registrations[0][1]({ prompt: 'Continue', messages: [] }, { sessionKey: 'agent:other:explicit:session-42' }), {});
    assert.equal(tools.length, 1); assert.equal(tools[0][1].name, 'jarvos_stewardship_answer');
    const answer = await tools[0][0]({ sessionKey }).execute('call-42', { correlation: 'judgment-42', choice: 'Wait' });
    assert.deepEqual(answer, { content: [{ type: 'text', text: 'Stewardship answer recorded.' }] });
    const rejected = await tools[0][0]({ sessionKey: 'agent:other:explicit:session-42' }).execute('call-43', { correlation: 'judgment-42', choice: 'Wait' });
    assert.equal(rejected.isError, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function runSetup(script, env) {
  const result = runSetupResult(script, env);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runSetupResult(script, env) {
  return spawnSync('bash', [script], { cwd: ROOT, encoding: 'utf8', env });
}

function count(content, pattern) {
  return (content.match(pattern) || []).length;
}

function assertCodexParsesConfig(config) {
  const result = spawnSync('codex', ['features', 'list'], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: path.dirname(config) },
  });
  // The unit suite also runs where the Codex executable is intentionally not
  // installed. The setup-specific assertions below still prove there is one
  // TOML representation; exercise Codex's own parser whenever it is present.
  if (result.error && result.error.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('OpenClaw stewardship-only setup preserves unrelated configuration and rolls back only its staged plugin', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-setup-'));
  const config = path.join(temp, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ plugins: { load: { paths: ['/user/plugin', '/old/managed-harness/old/public/runtimes/openclaw'] }, allow: ['unrelated'], entries: { unrelated: { enabled: true } } }, tools: { profile: 'coding', allow: ['read'] }, agents: { list: [{ id: 'main', tools: { alsoAllow: ['browser'] } }] }, unrelated: { keep: true } }, null, 2)}\n`);
    const env = { ...process.env, HOME: path.join(temp, 'home'), OPENCLAW_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const script = path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh');
    runSetup(script, env); const first = fs.readFileSync(config, 'utf8'); runSetup(script, env); assert.equal(fs.readFileSync(config, 'utf8'), first);
    let parsed = JSON.parse(first); assert.deepEqual(parsed.plugins.load.paths, ['/user/plugin', path.join(staged, 'runtimes', 'openclaw')]); assert.equal(parsed.unrelated.keep, true); assert.equal(parsed.plugins.entries.unrelated.enabled, true); assert.equal(parsed.plugins.entries['jarvos-stewardship'].config.mappingRoot, path.join(state, 'stewardship-bridge', 'openclaw-sessions')); assert.deepEqual(parsed.tools.allow, ['read', 'jarvos_stewardship_answer']);
    assert.equal(parsed.plugins.entries['jarvos-stewardship'].config.toolAllowAddedByJarvos, true);
    assert.deepEqual(parsed.agents.list[0].tools.alsoAllow, ['browser', 'jarvos_stewardship_answer']);
    assert.deepEqual(parsed.plugins.entries['jarvos-stewardship'].config.agentToolGrantByJarvos, { agentId: 'main', added: true, createdAgent: false, createdTools: false, createdAlsoAllow: false });
    const pluginSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'openclaw.plugin.json'), 'utf8')).configSchema;
    for (const key of Object.keys(parsed.plugins.entries['jarvos-stewardship'].config)) assert.ok(pluginSchema.properties[key], `${key} must be declared in the plugin config schema`);
    assert.equal(pluginSchema.properties.toolAllowAddedByJarvos.type, 'boolean');
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' }); parsed = JSON.parse(fs.readFileSync(config, 'utf8'));
    assert.deepEqual(parsed.plugins.load.paths, ['/user/plugin']); assert.deepEqual(parsed.plugins.allow, ['unrelated']); assert.equal(parsed.plugins.entries['jarvos-stewardship'], undefined); assert.equal(parsed.plugins.entries.unrelated.enabled, true); assert.deepEqual(parsed.tools.allow, ['read']); assert.deepEqual(parsed.agents.list[0].tools.alsoAllow, ['browser']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw rollback preserves a stewardship tool grant that predated jarvOS setup', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-preexisting-tool-'));
  const config = path.join(temp, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ tools: { profile: 'coding', allow: ['read', 'jarvos_stewardship_answer'] }, agents: { list: [{ id: 'main', tools: { alsoAllow: ['jarvos_stewardship_answer'] } }] } }, null, 2)}\n`);
    const env = { ...process.env, HOME: path.join(temp, 'home'), OPENCLAW_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const script = path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh');
    runSetup(script, env); const installed = JSON.parse(fs.readFileSync(config, 'utf8')); assert.equal(installed.plugins.entries['jarvos-stewardship'].config.toolAllowAddedByJarvos, false); assert.equal(installed.plugins.entries['jarvos-stewardship'].config.agentToolGrantByJarvos.added, false);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = JSON.parse(fs.readFileSync(config, 'utf8')); assert.deepEqual(rolledBack.tools.allow, ['read', 'jarvos_stewardship_answer']); assert.deepEqual(rolledBack.agents.list[0].tools.alsoAllow, ['jarvos_stewardship_answer']);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw setup does not claim permission ownership when its configuration update fails', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-config-failure-'));
  const configRoot = path.join(temp, 'config'); const config = path.join(configRoot, 'openclaw.json'); const staged = path.join(temp, 'stage'); const state = path.join(temp, 'state');
  try {
    fs.mkdirSync(configRoot, { recursive: true }); fs.mkdirSync(path.join(staged, 'runtimes', 'openclaw'), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({ tools: { allow: ['read'] } }, null, 2)}\n`); fs.chmodSync(configRoot, 0o500);
    const env = { ...process.env, HOME: path.join(temp, 'home'), OPENCLAW_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged, JARVOS_MANAGED_HARNESS_STATE_ROOT: state };
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'openclaw', 'setup.sh'), env);
    assert.notEqual(result.status, 0); assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')).tools.allow, ['read']);
  } finally { fs.chmodSync(configRoot, 0o700); fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Hermes stewardship-only setup records exact consent idempotently and removes only that consent on rollback', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-hermes-stewardship-setup-'));
  const home = path.join(temp, 'home'); const config = path.join(temp, 'config.yaml'); const staged = path.join(temp, 'stage'); const hook = path.join(staged, 'runtimes', 'hermes', 'jarvos-pre-llm-hook.js'); const allowlist = path.join(home, '.hermes', 'shell-hooks-allowlist.json');
  try {
    fs.mkdirSync(path.dirname(hook), { recursive: true }); fs.mkdirSync(path.dirname(allowlist), { recursive: true });
    fs.writeFileSync(hook, '#!/usr/bin/env node\n', { mode: 0o700 }); fs.chmodSync(hook, 0o700);
    fs.writeFileSync(config, 'hooks:\n  pre_tool_call:\n    - command: user-hook\n  pre_llm_call:\n    - command: /old/stage/jarvos-pre-llm-hook.js\nunrelated: keep\n');
    fs.writeFileSync(allowlist, `${JSON.stringify({ approvals: [{ event: 'pre_tool_call', command: 'user-hook' }, { event: 'pre_llm_call', command: '/old/stage/jarvos-pre-llm-hook.js' }] }, null, 2)}\n`);
    const env = { ...process.env, HOME: home, HERMES_CONFIG: config, JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repo', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged };
    const script = path.join(ROOT, 'runtimes', 'hermes', 'setup.sh');
    runSetup(script, env); const firstConfig = fs.readFileSync(config, 'utf8'); const firstAllowlist = fs.readFileSync(allowlist, 'utf8'); runSetup(script, env); assert.equal(fs.readFileSync(config, 'utf8'), firstConfig); assert.equal(fs.readFileSync(allowlist, 'utf8'), firstAllowlist);
    assert.match(firstConfig, new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); const approvals = JSON.parse(firstAllowlist).approvals; const approval = approvals.find((item) => item.command === hook); assert.equal(approval.event, 'pre_llm_call'); assert.ok(approval.script_mtime_at_approval);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.doesNotMatch(fs.readFileSync(config, 'utf8'), new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); const remaining = JSON.parse(fs.readFileSync(allowlist, 'utf8')).approvals; assert.deepEqual(remaining, [{ event: 'pre_tool_call', command: 'user-hook' }]); assert.match(fs.readFileSync(config, 'utf8'), /pre_tool_call/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Claude setup merges both jarvOS lifecycle hooks without replacing user hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-hook-setup-'));
  const settings = path.join(temp, 'settings.json');
  const desktop = path.join(temp, 'desktop.json');
  const staged = path.join(temp, 'staged-public');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'claude'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'claude', file), path.join(staged, 'runtimes', 'claude', file));
    fs.writeFileSync(settings, `${JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'user-session-start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'user-prompt-submit' }] }],
      },
    }, null, 2)}\n`, 'utf8');
    const existingSettings = JSON.parse(fs.readFileSync(settings, 'utf8'));
    existingSettings.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command: 'node "/old/stage/runtimes/claude/jarvos-session-start-hook.js"' }] });
    existingSettings.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command: 'node "/older/stage/runtimes/claude/jarvos-session-start-hook.js"' }] });
    existingSettings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'node "/old/stage/runtimes/claude/jarvos-session-turn-hook.js"' }] });
    fs.writeFileSync(settings, `${JSON.stringify(existingSettings, null, 2)}\n`);
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      CLAUDE_SETTINGS: settings,
      CLAUDE_DESKTOP_CONFIG: desktop,
      JARVOS_SKIP_CLAUDE_CODE_MCP: '1',
      JARVOS_SKIP_CLAUDE_MD: '1',
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
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
    assert.match(second, new RegExp(staged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(second, new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/runtimes/claude/jarvos-session`));
    assert.equal(fs.readdirSync(temp).filter((name) => name.startsWith('settings.json.bak-jarvos-')).length, 1);
    assert.equal(fs.existsSync(desktop), false);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(rolledBack.hooks.SessionStart.length, 1);
    assert.equal(rolledBack.hooks.UserPromptSubmit.length, 1);
    assert.match(JSON.stringify(rolledBack), /user-session-start/);
    assert.match(JSON.stringify(rolledBack), /user-prompt-submit/);
    assert.doesNotMatch(JSON.stringify(rolledBack), /jarvos-session-(?:start|turn)-hook\.js/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude setup injects a private bridge command environment without retaining a context-file path', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-bridge-setup-'));
  const settings = path.join(temp, 'settings.json'); const desktop = path.join(temp, 'desktop.json');
  const bin = path.join(temp, 'bridge-bin'); const mapRoot = path.join(temp, 'claude-map'); const contextFile = path.join(temp, 'private-context.json');
  try {
    fs.mkdirSync(bin, { mode: 0o700 }); fs.chmodSync(bin, 0o700);
    fs.mkdirSync(mapRoot, { mode: 0o700 }); fs.chmodSync(mapRoot, 0o700);
    fs.writeFileSync(contextFile, '{"private":"context"}\n', { mode: 0o600 }); fs.chmodSync(contextFile, 0o600);
    const bridge = path.join(bin, 'jarvos-stewardship-bridge');
    fs.writeFileSync(bridge, [
      '#!/usr/bin/env sh',
      'state=none',
      '[ "$JARVOS_STEWARDSHIP_BRIDGE_COMMAND" = "jarvos-stewardship-bridge" ] && state=command',
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT" = ${JSON.stringify(mapRoot)} ] && state=map`,
      `[ "$JARVOS_STEWARDSHIP_CLAUDE_SESSION_ID" = "${CLAUDE_HOOK_SESSION_ID}" ] && state=session`,
      '[ "$state" = "session" ] && state=ready',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' \"{\\\"available\\\":true,\\\"pendingInSessionInput\\\":true,\\\"prompt\\\":\\\"Bridge configuration $state.\\\",\\\"choices\\\":[\\\"Wait\\\",\\\"Prepare a dry run\\\"],\\\"default\\\":\\\"Wait\\\",\\\"correlation\\\":\\\"configured-42\\\"}\"",
      'else',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":false}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.chmodSync(bridge, 0o700);
    const env = {
      ...process.env, HOME: path.join(temp, 'home'), CLAUDE_SETTINGS: settings, CLAUDE_DESKTOP_CONFIG: desktop,
      JARVOS_SKIP_CLAUDE_CODE_MCP: '1', JARVOS_SKIP_CLAUDE_MD: '1', JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT: mapRoot, JARVOS_STEWARDSHIP_BRIDGE_PATH: bin,
    };
    runSetup(path.join(ROOT, 'runtimes', 'claude', 'setup.sh'), env);
    const configured = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const command = configured.hooks.SessionStart[0].hooks[0].command;
    const turnCommand = configured.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.match(command, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND='jarvos-stewardship-bridge'/);
    assert.match(turnCommand, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND='jarvos-stewardship-bridge'/);
    assert.match(command, new RegExp(mapRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(command, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(configured), new RegExp(contextFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: ROOT, encoding: 'utf8', input: JSON.stringify({ session_id: CLAUDE_HOOK_SESSION_ID, hook_event_name: 'SessionStart' }),
      env: { PATH: process.env.PATH || '', HOME: path.join(temp, 'clean-home') },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /Bridge configuration ready\./);
    assert.doesNotMatch(JSON.stringify(output), new RegExp(contextFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Claude setup rollback removes only the managed command from a mixed hook entry', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-claude-hook-rollback-'));
  const settings = path.join(temp, 'settings.json'); const desktop = path.join(temp, 'desktop.json');
  const userCommand = 'node "/user/hooks/jarvos-session-start-hook.js"';
  try {
    fs.writeFileSync(settings, `${JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [
      { type: 'command', command: userCommand },
      { type: 'command', command: 'node "/old/stage/runtimes/claude/jarvos-session-start-hook.js"' },
    ] }] } }, null, 2)}\n`);
    const env = { ...process.env, HOME: path.join(temp, 'home'), CLAUDE_SETTINGS: settings, CLAUDE_DESKTOP_CONFIG: desktop, JARVOS_SKIP_CLAUDE_CODE_MCP: '1', JARVOS_SKIP_CLAUDE_MD: '1', JARVOS_STEWARDSHIP_ONLY: '1' };
    const script = path.join(ROOT, 'runtimes', 'claude', 'setup.sh');
    runSetup(script, env);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.deepEqual(rolledBack.hooks.SessionStart, [{ matcher: 'startup', hooks: [{ type: 'command', command: userCommand }] }]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex setup merges both jarvOS lifecycle hooks without replacing user hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-hook-setup-'));
  const bin = path.join(temp, 'bin');
  const config = path.join(temp, 'config.toml');
  const staged = path.join(temp, 'staged-public');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
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
      '[shell_environment_policy]',
      'set = { EXISTING = "keep" }',
      '',
      '[unrelated]',
      'value = true',
      '',
    ].join('\n'), 'utf8');
    let prior = fs.readFileSync(config, 'utf8');
    prior = prior.replace('SessionStart = [', 'SessionStart = [{ matcher = "startup", hooks = [{ type = "command", command = "node \\"/old/stage/runtimes/codex/jarvos-session-start-hook.js\\"", async = false, timeout = 30 }] }, ');
    prior = prior.replace('UserPromptSubmit = [', 'UserPromptSubmit = [{ hooks = [{ type = "command", command = "node \\"/old/stage/runtimes/codex/jarvos-session-turn-hook.js\\"", async = false, timeout = 30 }] }, ');
    fs.writeFileSync(config, prior);
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      CODEX_CONFIG: config,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: path.join(temp, 'codex-session-map'),
    };
    const script = path.join(ROOT, 'runtimes', 'codex', 'setup.sh');
    runSetup(script, env);
    const first = fs.readFileSync(config, 'utf8');
    runSetup(script, env);
    const second = fs.readFileSync(config, 'utf8');
    assert.equal(first, second);
    assert.equal(count(second, /^\[hooks\]$/gm), 1);
    assert.equal(count(second, /jarvos-session-start-hook\.js/g), 1);
    assert.equal(count(second, /jarvos-session-turn-hook\.js/g), 1);
    assert.match(second, /matcher = "startup\|resume"/);
    assert.match(second, /user-session-start/);
    assert.match(second, /user-prompt-submit/);
    assert.match(second, /EXISTING = "keep"/);
    assert.match(second, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND = "jarvos-stewardship-bridge"/);
    assert.match(second, /JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT = ".*codex-session-map"/);
    assert.doesNotMatch(second, /JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE/);
    assert.match(second, new RegExp(staged.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(second, new RegExp(`${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/runtimes/codex/jarvos-session`));
    assert.match(second, /\[unrelated\]\nvalue = true/);
    assert.equal(fs.readdirSync(temp).filter((name) => name.startsWith('config.toml.bak-jarvos-')).length, 1);
    const withoutBridge = { ...env };
    delete withoutBridge.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
    delete withoutBridge.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT;
    runSetup(script, withoutBridge);
    assert.equal(fs.readFileSync(config, 'utf8'), second);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = fs.readFileSync(config, 'utf8');
    assert.doesNotMatch(rolledBack, /jarvos-session-(?:start|turn)-hook\.js/);
    assert.doesNotMatch(rolledBack, /JARVOS_STEWARDSHIP_(?:BRIDGE_COMMAND|CODEX_SESSION_MAP_ROOT)/);
    assert.match(rolledBack, /EXISTING = "keep"/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex setup repairs the nested shell environment table without losing user variables', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-nested-environment-'));
  const bin = path.join(temp, 'bin');
  const codexHome = path.join(temp, 'codex-home');
  const config = path.join(codexHome, 'config.toml');
  const staged = path.join(temp, 'staged-public');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(path.join(bin, 'codex'), 0o755);
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(config, [
      '[hooks]',
      'SessionStart = [{ hooks = [{ type = "command", command = "user-session-start" }] }]',
      '',
      '[shell_environment_policy.set]',
      'BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"',
      'NODE_REPL_TRUSTED_CODE_PATHS = "/trusted/code"',
      '',
      // This is the real drift shape: a nested table plus a stale inline set.
      '[shell_environment_policy]',
      'set = { JARVOS_STEWARDSHIP_BRIDGE_COMMAND = "old-bridge", JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT = "/old/map" } # Preserve this trailing user note.',
      '# Keep this note for the person maintaining the environment policy.',
      '',
      '[unrelated]',
      'value = true',
      '',
    ].join('\n'), 'utf8');
    const env = {
      ...process.env,
      HOME: path.join(temp, 'home'),
      CODEX_HOME: codexHome,
      CODEX_CONFIG: config,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: path.join(temp, 'codex-session-map'),
    };
    const script = path.join(ROOT, 'runtimes', 'codex', 'setup.sh');
    runSetup(script, env);
    const configured = fs.readFileSync(config, 'utf8');
    assert.equal(count(configured, /^\[shell_environment_policy\.set\]$/gm), 1);
    assert.equal(count(configured, /^\[shell_environment_policy\]$/gm), 0);
    assert.doesNotMatch(configured, /^set\s*=/m);
    assert.match(configured, /BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"/);
    assert.match(configured, /NODE_REPL_TRUSTED_CODE_PATHS = "\/trusted\/code"/);
    assert.match(configured, /JARVOS_STEWARDSHIP_BRIDGE_COMMAND = "jarvos-stewardship-bridge"/);
    assert.match(configured, /JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT = ".*codex-session-map"/);
    assert.match(configured, /# Keep this note for the person maintaining the environment policy\./);
    assert.match(configured, /# Preserve this trailing user note\./);
    assertCodexParsesConfig(config);

    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = fs.readFileSync(config, 'utf8');
    assert.equal(count(rolledBack, /^\[shell_environment_policy\.set\]$/gm), 1);
    assert.equal(count(rolledBack, /^\[shell_environment_policy\]$/gm), 0);
    assert.doesNotMatch(rolledBack, /^set\s*=/m);
    assert.doesNotMatch(rolledBack, /JARVOS_STEWARDSHIP_(?:BRIDGE_COMMAND|CODEX_SESSION_MAP_ROOT|BRIDGE_CONTEXT_FILE)/);
    assert.match(rolledBack, /BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"/);
    assert.match(rolledBack, /NODE_REPL_TRUSTED_CODE_PATHS = "\/trusted\/code"/);
    assert.match(rolledBack, /\[unrelated\]\nvalue = true/);
    assert.match(rolledBack, /# Keep this note for the person maintaining the environment policy\./);
    assert.match(rolledBack, /# Preserve this trailing user note\./);
    assertCodexParsesConfig(config);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex stewardship setup migrates legacy hooks.json without losing unrelated hooks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-hooks-migration-'));
  const bin = path.join(temp, 'bin');
  const home = path.join(temp, 'home');
  const codexHome = path.join(temp, 'codex-home');
  const config = path.join(codexHome, 'config.toml');
  const hooksJson = path.join(codexHome, 'hooks.json');
  const staged = path.join(temp, 'staged-public');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/usr/bin/env sh\nif [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(codex, 0o755);
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(config, [
      '[hooks]',
      'PreToolUse = [{ matcher = "Bash", hooks = [{ timeout = 9, command = "dcg --check", type = "command", async = true }] }]',
      'UserPromptSubmit = [{ hooks = [{ type = "command", command = "model-routing" }] }]',
      '',
      '[unrelated]',
      'value = true',
      '',
    ].join('\n'), 'utf8');
    const originalConfig = fs.readFileSync(config, 'utf8');
    const originalHooks = JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'dcg --check', async: true, timeout: 9 }] }],
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'unrelated-session-hook', timeout: 12 }] }],
    } }, null, 2);
    fs.writeFileSync(hooksJson, `${originalHooks}\n`, { mode: 0o600 });
    fs.chmodSync(hooksJson, 0o600);
    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
    };
    const script = path.join(ROOT, 'runtimes', 'codex', 'setup.sh');
    runSetup(script, env);
    const first = fs.readFileSync(config, 'utf8');
    assert.equal(fs.existsSync(hooksJson), false);
    assert.equal(count(first, /dcg --check/g), 1);
    assert.equal(count(first, /jarvos-session-start-hook\.js/g), 1);
    assert.equal(count(first, /jarvos-session-turn-hook\.js/g), 1);
    assert.match(first, /model-routing/);
    assert.match(first, /unrelated-session-hook/);
    assert.match(first, /\[unrelated\]\nvalue = true/);
    const configBackups = fs.readdirSync(codexHome).filter((name) => name.startsWith('config.toml.bak-jarvos-'));
    const hooksBackups = fs.readdirSync(codexHome).filter((name) => name.startsWith('hooks.json.bak-jarvos-'));
    assert.equal(configBackups.length, 1);
    assert.equal(hooksBackups.length, 1);
    assert.equal(fs.readFileSync(path.join(codexHome, configBackups[0]), 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(path.join(codexHome, hooksBackups[0]), 'utf8'), `${originalHooks}\n`);
    assert.equal(fs.statSync(path.join(codexHome, hooksBackups[0])).mode & 0o777, 0o600);
    runSetup(script, env);
    assert.equal(fs.readFileSync(config, 'utf8'), first);
    assert.equal(fs.readdirSync(codexHome).filter((name) => name.startsWith('hooks.json.bak-jarvos-')).length, 1);
    runSetup(script, { ...env, JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    const rolledBack = fs.readFileSync(config, 'utf8');
    assert.doesNotMatch(rolledBack, /jarvos-session-(?:start|turn)-hook\.js/);
    assert.match(rolledBack, /dcg --check/);
    assert.match(rolledBack, /model-routing/);
    assert.equal(fs.existsSync(hooksJson), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Codex hooks migration fails closed for malformed legacy hooks.json', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-hooks-malformed-'));
  const bin = path.join(temp, 'bin');
  const codexHome = path.join(temp, 'codex-home');
  const config = path.join(codexHome, 'config.toml');
  const hooksJson = path.join(codexHome, 'hooks.json');
  const staged = path.join(temp, 'staged-public');
  try {
    fs.mkdirSync(path.join(staged, 'runtimes', 'codex'), { recursive: true });
    for (const file of ['jarvos-session-start-hook.js', 'jarvos-session-turn-hook.js']) fs.copyFileSync(path.join(ROOT, 'runtimes', 'codex', file), path.join(staged, 'runtimes', 'codex', file));
    fs.mkdirSync(bin, { recursive: true });
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(codex, 0o755);
    fs.mkdirSync(codexHome, { recursive: true });
    const originalConfig = '[hooks]\nPreToolUse = [{ hooks = [{ type = "command", command = "keep-me" }] }]\n';
    const originalHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":{"unsupported":true}}]}]}}\n';
    fs.writeFileSync(config, originalConfig);
    fs.writeFileSync(hooksJson, originalHooks);
    const result = runSetupResult(path.join(ROOT, 'runtimes', 'codex', 'setup.sh'), {
      ...process.env,
      HOME: path.join(temp, 'home'),
      CODEX_HOME: codexHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1',
      JARVOS_MANAGED_REPOSITORIES: '/managed/repository',
      JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing Codex hook migration/);
    assert.equal(fs.readFileSync(config, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(hooksJson, 'utf8'), originalHooks);
    assert.deepEqual(fs.readdirSync(codexHome).filter((name) => name.includes('.bak-jarvos-')), []);

    const multilineConfig = '[hooks]\nPreToolUse = [\n  { hooks = [{ type = "command", command = "keep-me" }] }\n]\n';
    const validHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"dcg --check"}]}]}}\n';
    fs.writeFileSync(config, multilineConfig);
    fs.writeFileSync(hooksJson, validHooks);
    const multilineResult = runSetupResult(path.join(ROOT, 'runtimes', 'codex', 'setup.sh'), {
      ...process.env,
      HOME: path.join(temp, 'home'), CODEX_HOME: codexHome,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_ONLY: '1', JARVOS_MANAGED_REPOSITORIES: '/managed/repository', JARVOS_STAGED_PUBLIC_RUNTIME_ROOT: staged,
    });
    assert.notEqual(multilineResult.status, 0);
    assert.match(multilineResult.stderr, /one-line inline-array/);
    assert.equal(fs.readFileSync(config, 'utf8'), multilineConfig);
    assert.equal(fs.readFileSync(hooksJson, 'utf8'), validHooks);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
