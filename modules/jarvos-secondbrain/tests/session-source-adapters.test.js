'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createOpenClawSessionAdapter,
  createCodexSessionAdapter,
  createClaudeCodeSessionAdapter,
  createSessionSourceAdapter,
} = require('../adapters');
const {
  CAPTURE_EVENT_SCHEMA_VERSION,
  validateCaptureEvent,
} = require('../packages/jarvos-ambient/src/intent/capture-contract');

function assertSourceBackedEvent(event, sourceTool, expectedPrivacyTier = 'local-private') {
  assert.equal(event.schemaVersion, CAPTURE_EVENT_SCHEMA_VERSION);
  assert.equal(event.source.tool, sourceTool);
  assert.equal(event.captureMode, 'session-summary');
  assert.equal(event.privacyTier, expectedPrivacyTier);
  assert.equal(event.origin.kind, 'session');
  assert.ok(event.source.sessionId);
  assert.ok(event.source.messageId);
  assert.ok(event.evidence[0].quote.includes(event.text));
  assert.deepEqual(validateCaptureEvent(event), []);
}

test('OpenClaw session adapter emits source-backed CaptureEvent v2 events', () => {
  const adapter = createOpenClawSessionAdapter();
  const result = adapter.normalizeSession({
    id: 'openclaw-session-1',
    title: 'Architecture decision',
    sourcePath: '/workspace/sessions/openclaw-session-1.json',
    startedAt: '2026-06-21T14:01:00Z',
    messages: [{
      id: 'msg-1',
      role: 'assistant',
      model: 'test-model',
      timestamp: '2026-06-21T14:02:00Z',
      content: 'Decision: keep generated wiki pages rebuildable from source notes.',
    }],
  });

  assert.equal(result.skipped.length, 0);
  assert.equal(result.events.length, 1);
  assertSourceBackedEvent(result.events[0], 'openclaw');
  assert.equal(result.events[0].actor.type, 'assistant');
  assert.equal(result.events[0].actor.model, 'test-model');
  assert.equal(result.events[0].source.label, 'Architecture decision');
  assert.equal(result.events[0].date, '2026-06-21');
});

test('Codex session adapter handles content arrays and stable source IDs', () => {
  const adapter = createCodexSessionAdapter();
  const result = adapter.normalizeSession({
    sessionId: 'codex-session-1',
    turns: [{
      messageId: 'turn-1',
      role: 'user',
      content: [
        { type: 'text', text: 'Save this quote about source-backed notes.' },
        { type: 'text', text: 'The source notes remain authoritative.' },
      ],
    }],
  });

  assert.equal(result.skipped.length, 0);
  assert.equal(result.events.length, 1);
  assertSourceBackedEvent(result.events[0], 'codex');
  assert.equal(result.events[0].id, 'capture:codex:codex-session-1:turn-1');
  assert.equal(result.events[0].actor.type, 'human');
  assert.match(result.events[0].text, /source notes remain authoritative/);
});

test('Claude Code session adapter accepts entries and caller privacy overrides', () => {
  const adapter = createClaudeCodeSessionAdapter({ privacyTier: 'private' });
  const result = adapter.normalizeSession({
    conversationId: 'claude-code-session-1',
    entries: [{
      uuid: 'entry-1',
      actor: 'tool',
      text: 'Ran tests for the generated wiki compiler.',
    }],
  });

  assert.equal(result.skipped.length, 0);
  assert.equal(result.events.length, 1);
  assertSourceBackedEvent(result.events[0], 'claude-code', 'private');
  assert.equal(result.events[0].actor.type, 'tool');
  assert.equal(result.events[0].privacyTier, 'private');
});

test('session adapters skip secret sessions and unsupported tools explicitly', () => {
  const secretOverride = createCodexSessionAdapter({ privacyTier: 'private' }).normalizeSession({
    sessionId: 'codex-secret-override',
    privacyTier: 'secret',
    messages: [{ role: 'assistant', content: 'Do not downgrade this content.' }],
  });
  assert.deepEqual(secretOverride, {
    events: [],
    skipped: [{
      reason: 'secret-session-not-emitted',
      sourceTool: 'codex',
    }],
  });

  const secret = createCodexSessionAdapter().normalizeSession({
    sessionId: 'codex-secret',
    privacyTier: 'secret',
    messages: [{ role: 'assistant', content: 'Do not emit this content.' }],
  });
  assert.deepEqual(secret, {
    events: [],
    skipped: [{
      reason: 'secret-session-not-emitted',
      sourceTool: 'codex',
    }],
  });

  const unsupported = createSessionSourceAdapter('future-tool').normalizeSession({
    messages: [{ role: 'assistant', content: 'Unsupported tool.' }],
  });
  assert.deepEqual(unsupported, {
    events: [],
    skipped: [{
      reason: 'unsupported-source-tool',
      sourceTool: 'future-tool',
    }],
  });
});

test('session adapters record invalid caller overrides as skipped events', () => {
  const result = createCodexSessionAdapter({ privacyTier: 'classified' }).normalizeSession({
    sessionId: 'codex-invalid-privacy',
    messages: [{ id: 'msg-invalid', role: 'assistant', content: 'This event has an invalid privacy tier.' }],
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'invalid-capture-event');
  assert.deepEqual(result.skipped[0].errors, [
    'Unknown privacyTier: "classified". Expected one of: public, local-private, private, sensitive, secret',
  ]);
});

test('session adapters record empty messages as skipped without emitting invalid events', () => {
  const result = createOpenClawSessionAdapter().normalizeSession({
    sessionId: 'empty-message-session',
    messages: [
      { id: 'empty', role: 'assistant', content: '   ' },
      { id: 'useful', role: 'assistant', content: 'Useful session evidence.' },
    ],
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'empty-message');
  assert.equal(result.skipped[0].messageId, 'empty');
  assertSourceBackedEvent(result.events[0], 'openclaw');
});
