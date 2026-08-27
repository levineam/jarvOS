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
