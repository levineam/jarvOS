'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  PROJECTS_CONTEXT_REFRESH_CONTRACT,
  computeStampDigest,
  createStamp,
} = require('../src/projects-context-refresh.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CODEX_SESSION_ID = '019fbf11-8aca-79c0-981e-15abcd2392f4';
const CLAUDE_SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const FINGERPRINT = 'a'.repeat(64);
const NATIVE_PROJECTS_MARKDOWN = '## Projects Context\n\n- Native bridge marker\n';
const ORDINARY_PROJECTS_MARKDOWN = '## Projects Context\n\n- Ordinary provider marker\n';
const HYDRATED_NON_PROJECTS_MARKDOWN = '# Hydrated Context\n\n- Ordinary hydration marker\n';

function stamp(overrides = {}) {
  return createStamp({
    providerRevision: 'beads:generation-1',
    profileRevision: 'orientation-v2',
    registryWatermark: 'registry-provider:evidence-revision-1',
    activityWatermark: 'activity-provider:evidence-revision',
    workRevision: `sha256:${'b'.repeat(64)}`,
    focusEpoch: 'focus-epoch:1',
    ...overrides,
  });
}

function envelope(status, overrides = {}) {
  const stampValue = status === 'unavailable' ? null : (overrides.stamp === undefined ? stamp() : overrides.stamp);
  const markdown = status === 'unavailable' || status === 'unchanged'
    ? null
    : (overrides.markdown === undefined ? '## Projects Context\n\n- Contract: jarvos.projects-context/v1\n' : overrides.markdown);
  return {
    contract: PROJECTS_CONTEXT_REFRESH_CONTRACT,
    status,
    stamp: stampValue,
    stampDigest: stampValue ? computeStampDigest(stampValue) : null,
    fingerprint: stampValue ? FINGERPRINT : null,
    markdown,
    ...overrides,
  };
}

function spawnSyncStub(resultOrFn) {
  const calls = [];
  const impl = (command, args, opts) => {
    calls.push({ command, args, opts });
    return typeof resultOrFn === 'function' ? resultOrFn(command, args, opts) : resultOrFn;
  };
  impl.calls = calls;
  return impl;
}

function okResult(payload) {
  return { status: 0, stdout: JSON.stringify(payload), stderr: '' };
}

const FAKE_TIMEOUT_RESULT = {
  status: null,
  signal: null,
  error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
};

function codexHook() {
  return require(path.join(ROOT, 'runtimes', 'codex', 'jarvos-session-turn-hook.js'));
}

function claudeHook() {
  return require(path.join(ROOT, 'runtimes', 'claude', 'jarvos-session-turn-hook.js'));
}

test('codex projectsContextStart passes a hard 2000ms timeout with exactly one call', () => {
  const hook = codexHook();
  const impl = spawnSyncStub(okResult(envelope('refreshed')));
  const result = hook.projectsContextStart({
    env: { CODEX_THREAD_ID: CODEX_SESSION_ID, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'fake-bridge' },
    spawnSyncImpl: impl,
  });
  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].opts.timeout, 2000);
  assert.equal(impl.calls[0].args[0], 'projectsContextStart');
  assert.equal(result.envelope.status, 'refreshed');
});

test('codex projectsContextRefresh passes a hard 250ms timeout with exactly one call', () => {
  const hook = codexHook();
  const impl = spawnSyncStub(okResult(envelope('refreshed')));
  const result = hook.projectsContextRefresh({
    env: { CODEX_THREAD_ID: CODEX_SESSION_ID, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'fake-bridge' },
    spawnSyncImpl: impl,
  });
  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].opts.timeout, 250);
  assert.equal(result.envelope.status, 'refreshed');
});

test('claude projectsContextStart/Refresh pass 2000ms/250ms with exactly one call each', () => {
  const hook = claudeHook();
  const startImpl = spawnSyncStub(okResult(envelope('refreshed')));
  hook.projectsContextStart({ sessionId: CLAUDE_SESSION_ID, bridgeCommand: 'fake-bridge', spawnSyncImpl: startImpl });
  assert.equal(startImpl.calls.length, 1);
  assert.equal(startImpl.calls[0].opts.timeout, 2000);

  const refreshImpl = spawnSyncStub(okResult(envelope('unchanged')));
  hook.projectsContextRefresh({ sessionId: CLAUDE_SESSION_ID, bridgeCommand: 'fake-bridge', spawnSyncImpl: refreshImpl });
  assert.equal(refreshImpl.calls.length, 1);
  assert.equal(refreshImpl.calls[0].opts.timeout, 250);
});

test('a fake timed-out spawnSync result fails open with no retry for both capabilities and both harnesses', () => {
  for (const hook of [codexHook(), claudeHook()]) {
    for (const capability of ['projectsContextStart', 'projectsContextRefresh']) {
      const impl = spawnSyncStub(FAKE_TIMEOUT_RESULT);
      const options = hook.HARNESS === 'claude-code'
        ? { sessionId: CLAUDE_SESSION_ID, bridgeCommand: 'fake-bridge', spawnSyncImpl: impl }
        : { env: { CODEX_THREAD_ID: CODEX_SESSION_ID, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'fake-bridge' }, spawnSyncImpl: impl };
      const result = hook[capability](options);
      assert.equal(impl.calls.length, 1, 'a timeout must not trigger a retry');
      assert.equal(result.envelope, null);
      assert.equal(result.reason, 'bridge-unavailable');
    }
  }
});

test('refreshed and partial envelopes carry content; unchanged, unavailable, and invalid do not', () => {
  const hook = codexHook();
  const baseOptions = (impl) => ({
    env: { CODEX_THREAD_ID: CODEX_SESSION_ID, JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'fake-bridge' },
    spawnSyncImpl: impl,
  });

  for (const status of ['refreshed', 'partial']) {
    const impl = spawnSyncStub(okResult(envelope(status)));
    const result = hook.projectsContextRefresh(baseOptions(impl));
    assert.equal(result.envelope.status, status);
    assert.match(result.envelope.markdown, /^## Projects Context/);
  }

  const unchangedImpl = spawnSyncStub(okResult(envelope('unchanged')));
  const unchanged = hook.projectsContextRefresh(baseOptions(unchangedImpl));
  assert.equal(unchanged.envelope.status, 'unchanged');
  assert.equal(unchanged.envelope.markdown, null);

  const unavailableImpl = spawnSyncStub(okResult(envelope('unavailable')));
  const unavailable = hook.projectsContextRefresh(baseOptions(unavailableImpl));
  assert.equal(unavailable.envelope.status, 'unavailable');

  const nonzeroImpl = spawnSyncStub({ status: 1, stdout: '', stderr: 'boom' });
  const nonzero = hook.projectsContextRefresh(baseOptions(nonzeroImpl));
  assert.equal(nonzero.envelope, null);
  assert.equal(nonzero.reason, 'bridge-unavailable');

  const malformedImpl = spawnSyncStub({ status: 0, stdout: 'not json' });
  const malformed = hook.projectsContextRefresh(baseOptions(malformedImpl));
  assert.equal(malformed.envelope, null);

  const invalidShapeImpl = spawnSyncStub(okResult({ available: true }));
  const invalidShape = hook.projectsContextRefresh(baseOptions(invalidShapeImpl));
  assert.equal(invalidShape.envelope, null);

  const tamperedDigestImpl = spawnSyncStub(okResult(envelope('refreshed', { stampDigest: 'f'.repeat(64) })));
  const tampered = hook.projectsContextRefresh(baseOptions(tamperedDigestImpl));
  assert.equal(tampered.envelope, null);
});

function runTurnHook(runtime, env, input) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'runtimes', runtime, 'jarvos-session-turn-hook.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    input: input === undefined ? undefined : JSON.stringify(input),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout || '{}');
}

function runSessionStartHook(runtime, env, input, hydrationMarkdown) {
  const { spawnSync } = require('node:child_process');
  const agentContextPath = path.join(ROOT, 'modules', 'jarvos-agent-context', 'src', 'index.js');
  const hookPath = path.join(ROOT, 'runtimes', runtime, 'jarvos-session-start-hook.js');
  const callsPath = path.join(env.JARVOS_TEST_HYDRATE_CALLS_FILE);
  const script = [
    "'use strict';",
    "const fs = require('node:fs');",
    `const agentContextPath = ${JSON.stringify(agentContextPath)};`,
    `const callsPath = ${JSON.stringify(callsPath)};`,
    `require.cache[agentContextPath] = { id: agentContextPath, filename: agentContextPath, loaded: true, exports: { hydrate: async (options) => { fs.writeFileSync(callsPath, JSON.stringify(options)); return { markdown: ${JSON.stringify(hydrationMarkdown)} }; } } };`,
    runtime === 'claude'
      ? "const childProcess = require('node:child_process'); childProcess.spawn = () => ({ unref() {} });"
      : '',
    `const hook = require(${JSON.stringify(hookPath)});`,
    runtime === 'codex'
      ? 'Promise.resolve(hook.main()).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });'
      : `Promise.resolve(hook.main(${JSON.stringify(input)})).catch((error) => { console.error(error.stack || error); process.exitCode = 1; });`,
  ].filter(Boolean).join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    input: runtime === 'codex' ? JSON.stringify(input) : undefined,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(callsPath), true, 'SessionStart must call hydrate exactly once');
  return {
    output: JSON.parse(result.stdout || '{}'),
    hydrationOptions: JSON.parse(fs.readFileSync(callsPath, 'utf8')),
  };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildBridgeScript(handlers) {
  const lines = ['#!/usr/bin/env sh'];
  for (const [capability, payload] of Object.entries(handlers)) {
    lines.push(`if [ "$1" = "${capability}" ]; then`);
    if (payload === 'FAIL') {
      lines.push('  exit 1');
    } else {
      lines.push(`  printf '%s\\n' ${shellQuote(JSON.stringify(payload))}`);
      // A matched capability must terminate before the unavailable fallback;
      // otherwise a valid response is followed by a second JSON document.
      lines.push('  exit 0');
    }
    lines.push('fi');
  }
  lines.push('printf \'%s\\n\' \'{"available":true}\'');
  return lines.join('\n');
}

function withBridge(handlers, fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-projects-refresh-hook-'));
  const bin = path.join(temp, 'bin');
  const bridge = path.join(bin, 'jarvos-stewardship-bridge');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(bridge, buildBridgeScript(handlers), { mode: 0o755 });
  fs.chmodSync(bridge, 0o755);
  try {
    // Prime the disposable shell fixture so the first 250ms production bridge
    // call measures the capability, not cold process startup on macOS.
    spawnSync(bridge, ['fixtureWarmup'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` },
    });
    return fn({ temp, bin, bridge });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function sessionStartEnvironment(bin, temp, runtime) {
  return {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    HOME: path.join(temp, 'home'),
    JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
    JARVOS_TEST_HYDRATE_CALLS_FILE: path.join(temp, 'hydrate-calls.json'),
    ...(runtime === 'codex' ? { CODEX_THREAD_ID: CODEX_SESSION_ID } : {}),
  };
}

function sessionStartInput(runtime) {
  return runtime === 'codex'
    ? { hook_event_name: 'SessionStart', session_id: CODEX_SESSION_ID }
    : { session_id: CLAUDE_SESSION_ID };
}

function codexSessionWait() {
  return {
    available: true,
    pendingSessionWait: true,
    wait: {
      waitId: 'session-wait:codex-91',
      workId: 'work-91',
      state: 'consumed',
      origin: {
        harness: 'codex',
        stableSessionId: CODEX_SESSION_ID,
        adapterGeneration: 'jarvos-stewardship-adapter.v1',
      },
      resultDigest: `sha256:${'c'.repeat(64)}`,
      safeProjection: {
        status: 'completed',
        reference: 'result-91',
        summary: 'Completed safely',
        resultClass: 'success',
      },
    },
  };
}

test('native SessionStart injects one refreshed or partial Projects block and disables Projects hydration for Codex and Claude', () => {
  for (const runtime of ['codex', 'claude']) {
    for (const status of ['refreshed', 'partial']) {
      withBridge({
        projectsContextStart: envelope(status, { markdown: NATIVE_PROJECTS_MARKDOWN }),
      }, ({ bin, temp }) => {
        const { output, hydrationOptions } = runSessionStartHook(
          runtime,
          sessionStartEnvironment(bin, temp, runtime),
          sessionStartInput(runtime),
          HYDRATED_NON_PROJECTS_MARKDOWN,
        );
        const context = output.hookSpecificOutput.additionalContext;
        assert.equal(context.split('## Projects Context').length - 1, 1, `${runtime} ${status} must inject exactly one Projects block`);
        assert.match(context, /Native bridge marker/);
        assert.match(context, /Ordinary hydration marker/);
        assert.equal(hydrationOptions.projectsContext, false, `${runtime} ${status} must disable ordinary Projects hydration`);
      });
    }
  }
});

test('native SessionStart preserves ordinary Projects hydration for unchanged, unavailable, and invalid bridge envelopes', () => {
  const cases = [
    ['unchanged', envelope('unchanged')],
    ['unavailable', envelope('unavailable')],
    ['invalid', { available: true }],
  ];
  for (const runtime of ['codex', 'claude']) {
    for (const [label, projectsContextStart] of cases) {
      withBridge({ projectsContextStart }, ({ bin, temp }) => {
        const { output, hydrationOptions } = runSessionStartHook(
          runtime,
          sessionStartEnvironment(bin, temp, runtime),
          sessionStartInput(runtime),
          ORDINARY_PROJECTS_MARKDOWN,
        );
        const context = output.hookSpecificOutput.additionalContext;
        assert.equal(context.split('## Projects Context').length - 1, 1, `${runtime} ${label} must preserve one ordinary Projects block`);
        assert.match(context, /Ordinary provider marker/);
        assert.doesNotMatch(context, /Native bridge marker/);
        assert.equal(hydrationOptions.projectsContext, undefined, `${runtime} ${label} must keep ordinary Projects hydration enabled`);
      });
    }
  }
});

test('codex turn hook coexists with one refreshed Projects block, SessionWait, and existing stewardship context', () => {
  withBridge({
    projectsContextRefresh: envelope('refreshed', { markdown: NATIVE_PROJECTS_MARKDOWN }),
    nextTurnInput: {
      available: true,
      pendingInSessionInput: true,
      prompt: 'A recovery window is ready.',
      choices: ['Wait', 'Prepare a dry run'],
      default: 'Wait',
      correlation: 'judgment-with-wait',
    },
    sessionWaitNextTurn: codexSessionWait(),
  }, ({ bin }) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      CODEX_THREAD_ID: CODEX_SESSION_ID,
    };
    const output = runTurnHook('codex', env, { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID });
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(context.split('## Projects Context').length - 1, 1);
    assert.match(context, /Native bridge marker/);
    assert.match(context, /judgment-with-wait/);
    assert.match(context, /session-wait:codex-91/);
    assert.match(context, /Reference: result-91/);
  });
});

test('codex turn hook preserves SessionWait without Projects injection when unchanged', () => {
  withBridge({
    projectsContextRefresh: envelope('unchanged'),
    nextTurnInput: { available: true, pendingInSessionInput: false },
    sessionWaitNextTurn: codexSessionWait(),
  }, ({ bin }) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      CODEX_THREAD_ID: CODEX_SESSION_ID,
    };
    const output = runTurnHook('codex', env, { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID });
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(context.split('## Projects Context').length - 1, 0);
    assert.doesNotMatch(context, /Native bridge marker/);
    assert.match(context, /session-wait:codex-91/);
    assert.match(context, /Reference: result-91/);
  });
});

test('codex turn hook injects exactly one Projects block on refreshed and coexists with a stewardship judgment block', () => {
  withBridge({
    projectsContextRefresh: envelope('refreshed'),
    nextTurnInput: {
      available: true,
      pendingInSessionInput: true,
      prompt: 'A recovery window is ready.',
      choices: ['Wait', 'Prepare a dry run'],
      default: 'Wait',
      correlation: 'judgment-91',
    },
  }, ({ bin }) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      CODEX_THREAD_ID: CODEX_SESSION_ID,
    };
    const output = runTurnHook('codex', env, { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID });
    const context = output.hookSpecificOutput.additionalContext;
    const projectsHeadingCount = context.split('## Projects Context').length - 1;
    assert.equal(projectsHeadingCount, 1, 'exactly one Projects block must be injected');
    assert.match(context, /judgment-91/);
  });
});

test('codex turn hook injects no Projects block when unchanged, and no context at all when nothing else is pending', () => {
  withBridge({
    projectsContextRefresh: envelope('unchanged'),
    nextTurnInput: { available: true, pendingInSessionInput: false },
  }, ({ bin }) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      CODEX_THREAD_ID: CODEX_SESSION_ID,
    };
    const output = runTurnHook('codex', env, { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID });
    assert.deepEqual(output, {});
  });
});

test('codex turn hook injects nothing when the Projects refresh capability is unavailable (nonzero exit)', () => {
  withBridge({
    projectsContextRefresh: 'FAIL',
    nextTurnInput: { available: true, pendingInSessionInput: false },
  }, ({ bin }) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
      CODEX_THREAD_ID: CODEX_SESSION_ID,
    };
    const output = runTurnHook('codex', env, { hook_event_name: 'UserPromptSubmit', session_id: CODEX_SESSION_ID });
    assert.deepEqual(output, {});
  });
});

test('claude turn hook injects exactly one Projects block on partial and coexists with a stewardship judgment block', () => {
  withBridge({
    projectsContextRefresh: envelope('partial'),
    nextTurnInput: {
      available: true,
      pendingInSessionInput: true,
      prompt: 'Choose the safe recovery step.',
      choices: ['Wait', 'Prepare a dry run'],
      default: 'Wait',
      correlation: 'claude-judgment-7',
    },
  }, ({ bin }) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
    };
    const output = runTurnHook('claude', env, { session_id: CLAUDE_SESSION_ID });
    const context = output.hookSpecificOutput.additionalContext;
    const projectsHeadingCount = context.split('## Projects Context').length - 1;
    assert.equal(projectsHeadingCount, 1);
    assert.match(context, /claude-judgment-7/);
  });
});

test('claude turn hook injects no Projects block on an invalid envelope shape', () => {
  withBridge({
    projectsContextRefresh: { available: true },
    nextTurnInput: { available: true, pendingInSessionInput: false },
  }, ({ bin }) => {
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
      JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-stewardship-bridge',
    };
    const output = runTurnHook('claude', env, { session_id: CLAUDE_SESSION_ID });
    assert.deepEqual(output, {});
  });
});
