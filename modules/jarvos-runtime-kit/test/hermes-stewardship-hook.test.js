'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PROJECTS_CONTEXT_REFRESH_CONTRACT,
  computeStampDigest,
  createStamp,
} = require('../src/projects-context-refresh.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK = path.join(ROOT, 'runtimes', 'hermes', 'jarvos-pre-llm-hook.js');
const hook = require(HOOK);

function refreshEnvelope(status) {
  if (status === 'invalid') return { available: true };
  if (status === 'unavailable') {
    return { contract: PROJECTS_CONTEXT_REFRESH_CONTRACT, status, stamp: null, stampDigest: null, fingerprint: null, markdown: null };
  }
  const stamp = createStamp({
    providerRevision: 'provider:1', profileRevision: 'profile:1', registryWatermark: 'registry:1',
    activityWatermark: null, workRevision: null, focusEpoch: 'focus:1',
  });
  return {
    contract: PROJECTS_CONTEXT_REFRESH_CONTRACT,
    status,
    stamp,
    stampDigest: computeStampDigest(stamp),
    fingerprint: 'b'.repeat(64),
    markdown: status === 'unchanged' ? null : '## Projects Context\n\n- refreshed from Hermes\n',
  };
}

function bridgeStub(refreshStatus) {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'projectsContextRefresh' && refreshStatus === 'timeout') {
      return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
    }
    const response = args[0] === 'projectsContextRefresh'
      ? refreshEnvelope(refreshStatus)
      : { available: true, pendingInSessionInput: true, prompt: 'Preserve the stewardship judgment.', choices: ['Wait', 'Stop'], default: 'Wait', correlation: 'hermes-judgment' };
    return { status: 0, stdout: JSON.stringify(response) };
  };
  return { calls, spawnSyncImpl };
}

test('Hermes refresh injects validated changed Projects context alongside stewardship judgment with one 250ms call', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-hermes-projects-refresh-'));
  try {
    const bridge = bridgeStub('partial');
    const context = hook.nextTurnContext({ bridgeCommand: 'fake-bridge', ...bridge });
    assert.match(context, /## Projects Context/);
    assert.match(context, /refreshed from Hermes/);
    assert.match(context, /hermes-judgment/);
    assert.equal(hook.PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS, 250);
    assert.deepEqual(bridge.calls.map((call) => [call.command, call.args[0], call.options.timeout]), [
      ['fake-bridge', 'projectsContextRefresh', 250], ['fake-bridge', 'nextTurnInput', 5000],
    ]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const status of ['unchanged', 'unavailable', 'invalid', 'timeout']) {
  test(`Hermes ${status} Projects refresh fails open while preserving stewardship judgment`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-hermes-projects-refresh-'));
    try {
      const bridge = bridgeStub(status);
      const context = hook.nextTurnContext({ bridgeCommand: 'fake-bridge', ...bridge });
      assert.doesNotMatch(context, /## Projects Context|refreshed from Hermes/);
      assert.match(context, /hermes-judgment/);
      assert.deepEqual(bridge.calls.map((call) => [call.command, call.args[0], call.options.timeout]), [
        ['fake-bridge', 'projectsContextRefresh', 250], ['fake-bridge', 'nextTurnInput', 5000],
      ]);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}
