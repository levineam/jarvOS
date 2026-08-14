'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sessionWaitContext, validateSessionWaitBridgeResponse } = require('../runtimes/codex/jarvos-session-turn-hook.js');

const threadId = '11111111-1111-4111-8111-111111111111';

test('Codex runtime accepts only a redacted consumed wait projection', () => {
  const response = validateSessionWaitBridgeResponse({
    available: true,
    pendingSessionWait: true,
    wait: {
      waitId: 'session-wait:receipt-one', workId: 'work-one', state: 'consumed',
      origin: { harness: 'codex', stableSessionId: threadId, adapterGeneration: 'codex-adapter-1' },
      resultDigest: `sha256:${'a'.repeat(64)}`, safeProjection: { status: 'completed', reference: 'result-one' },
    },
  });
  assert.equal(response.ok, true);
  assert.match(sessionWaitContext(response.value), /session follow-through result/);
  assert.doesNotMatch(sessionWaitContext(response.value), /repoBinding|workspaceBinding/);
});

test('Codex runtime rejects raw binding fields and unconsumed states', () => {
  const base = {
    available: true, pendingSessionWait: true,
    wait: {
      waitId: 'session-wait:receipt-one', workId: 'work-one', state: 'queued',
      origin: { harness: 'codex', stableSessionId: threadId, adapterGeneration: 'codex-adapter-1', repoBinding: `sha256:${'a'.repeat(64)}` },
    },
  };
  assert.equal(validateSessionWaitBridgeResponse(base).ok, false);
});
