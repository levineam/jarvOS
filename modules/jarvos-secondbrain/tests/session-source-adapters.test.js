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
const {
  digestText,
  hasAssistantContribution,
  normalizeDraftingList,
} = require('../bridge/provenance/src/content-origin-contract');
const { normalizeCaptureEvent } = require('../bridge/capture/src/universal-capture');

function eventFor(result, messageId) {
  return result.events.find((event) => event.source.messageId === messageId);
}

function assertSkippedFor(result, messageId, pattern) {
  assert.equal(eventFor(result, messageId), undefined, `${messageId} must not be emitted`);
  const skip = result.skipped.find((entry) => entry.messageId === messageId);
  assert.ok(skip, `${messageId} must be reported as skipped`);
  if (pattern) assert.match(JSON.stringify(skip), pattern);
}

const CODEX_DECLARED = { kind: 'assistant_draft', harness: 'codex', model: 'gpt-5-codex', model_evidence: 'declared' };
const CLAUDE_DECLARED = { kind: 'assistant_edit', harness: 'claude-code', model: 'claude-opus-5-5', model_evidence: 'declared' };

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
  assert.equal(result.events[0].content_origin, 'assistant');
  assert.equal(result.events[0].content_origin_basis, 'assistant_generated');
  assert.equal(result.events[0].human_evidence_eligible, false);
  assert.equal(result.events[0].source.label, 'Architecture decision');
  assert.equal(result.events[0].date, '2026-06-21');
});

test('Codex session adapter handles content arrays and stable source IDs', () => {
  const userText = 'Save this quote about source-backed notes.\n\nThe source notes remain authoritative.';
  const adapter = createCodexSessionAdapter({
    resolveUserSource: (captureEventId) => captureEventId === 'capture:codex:codex-session-1:turn-1'
      ? { capture_event_id: captureEventId, actor: 'user', text: userText }
      : null,
  });
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
  assert.equal(result.events[0].content_origin, 'human');
  assert.equal(result.events[0].content_origin_basis, 'verbatim_user');
  assert.equal(result.events[0].human_evidence_eligible, true);
  assert.equal(result.events[0].user_source.capture_event_id, result.events[0].captureEventId);
  assert.match(result.events[0].text, /source notes remain authoritative/);
});

test('a session role alone cannot mint a human-source receipt', () => {
  const result = createCodexSessionAdapter().normalizeSession({
    sessionId: 'codex-unverified-user',
    turns: [{ messageId: 'turn-1', role: 'user', content: 'A role label is not a source receipt.' }],
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].content_origin, 'unknown');
  assert.equal(result.events[0].human_evidence_eligible, false);
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
  assert.equal(result.events[0].content_origin, 'unknown');
});

test('session adapter preserves an explicit mixed declaration only when it is a valid origin pair', () => {
  const result = createOpenClawSessionAdapter({
    content_origin: 'mixed',
    content_origin_basis: 'mixed_composition',
  }).normalizeSession({
    sessionId: 'mixed-session',
    messages: [{ role: 'assistant', content: 'A jointly edited conclusion.' }],
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].content_origin, 'mixed');
  assert.equal(result.events[0].content_origin_basis, 'mixed_composition');
  assert.equal(result.events[0].human_evidence_eligible, false);
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

// SUP-4054: drafting provenance at the session-source seam.

test('actual Codex, Claude Code and OpenClaw assistant messages declare their own harness and message model', () => {
  const cases = [
    [createCodexSessionAdapter(), 'codex', 'gpt-5-codex'],
    [createClaudeCodeSessionAdapter(), 'claude-code', 'claude-opus-5-5'],
    [createOpenClawSessionAdapter(), 'openclaw', 'openclaw-message-model'],
  ];
  for (const [adapter, tool, model] of cases) {
    const result = adapter.normalizeSession({
      sessionId: `${tool}-drafting-session`,
      model: 'session-model-must-not-be-drafting',
      messages: [{ id: 'reply-1', role: 'assistant', model, content: `${tool} drafted this reply.` }],
    });
    assert.equal(result.skipped.length, 0, tool);
    const event = eventFor(result, 'reply-1');
    assertSourceBackedEvent(event, tool);
    assert.equal(event.content_origin, 'assistant');
    assert.equal(event.human_evidence_eligible, false);
    assert.deepEqual(event.content_origin_drafting, [
      { kind: 'assistant_draft', harness: tool, model, model_evidence: 'declared' },
    ], tool);
    // The emitted declaration survives the capture boundary unchanged.
    assert.deepEqual(normalizeCaptureEvent(event).content_origin_drafting, event.content_origin_drafting, tool);
  }
});

test('assistant message without its own model records an explicitly unknown model, never session or default models', () => {
  const result = createCodexSessionAdapter({ model: 'provider-default-model' }).normalizeSession({
    sessionId: 'codex-session-model-only',
    model: 'session-only-model',
    messages: [{ id: 'reply-1', role: 'assistant', content: 'Reply with no per-message model.' }],
  });
  const event = eventFor(result, 'reply-1');
  assert.ok(event);
  assert.equal(event.content_origin, 'assistant');
  assert.deepEqual(event.content_origin_drafting, [
    { kind: 'assistant_draft', harness: 'codex', model: 'unknown', model_evidence: 'unknown' },
  ]);
  assert.doesNotMatch(JSON.stringify(event.content_origin_drafting), /session-only-model|provider-default-model/);
});

test('explicit mixed message keeps its supplied prior contributor and does not copy a session-wide declaration', () => {
  const sessionWide = { kind: 'assistant_draft', harness: 'session-wide-harness', model: 'session-wide-model', model_evidence: 'declared' };
  const result = createClaudeCodeSessionAdapter().normalizeSession({
    sessionId: 'claude-mixed-session',
    model: 'session-wide-model',
    content_origin_drafting: [sessionWide],
    messages: [
      {
        id: 'edit-1',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content_origin: 'mixed',
        content_origin_basis: 'mixed_composition',
        content_origin_drafting: [CODEX_DECLARED],
        content: 'Claude revised the Codex draft with the user.',
      },
      { id: 'reply-2', role: 'assistant', content: 'A later reply with no message model.' },
    ],
  });

  const edit = eventFor(result, 'edit-1');
  assert.ok(edit);
  assert.equal(edit.content_origin, 'mixed');
  assert.equal(edit.content_origin_basis, 'mixed_composition');
  assert.equal(edit.human_evidence_eligible, false);
  assert.deepEqual(edit.content_origin_drafting, [
    CODEX_DECLARED,
    { kind: 'assistant_edit', harness: 'claude-code', model: 'claude-opus-5-5', model_evidence: 'declared' },
  ]);
  assert.ok(normalizeDraftingList(edit.content_origin_drafting).ok);
  assert.ok(hasAssistantContribution(edit.content_origin_drafting));
  assert.doesNotMatch(JSON.stringify(edit.content_origin_drafting), /session-wide-harness|session-wide-model/);

  const later = eventFor(result, 'reply-2');
  assert.ok(later);
  assert.deepEqual(later.content_origin_drafting, [
    { kind: 'assistant_draft', harness: 'claude-code', model: 'unknown', model_evidence: 'unknown' },
  ]);
});

test('a prior contribution is not proof of the current response: exact kind, harness and message model must match', () => {
  const result = createCodexSessionAdapter().normalizeSession({
    sessionId: 'codex-current-tuple-session',
    messages: [
      // Prior known Codex draft; this response reports no model of its own.
      { id: 'no-model', role: 'assistant', content_origin_drafting: [CODEX_DECLARED], content: 'Reply without a per-message model.' },
      // Prior same-harness/model draft; this response is a mixed edit.
      {
        id: 'mixed-edit',
        role: 'assistant',
        model: 'gpt-5-codex',
        content_origin: 'mixed',
        content_origin_basis: 'mixed_composition',
        content_origin_drafting: [CODEX_DECLARED],
        content: 'Codex revised its earlier draft with the user.',
      },
    ],
  });

  assert.deepEqual(eventFor(result, 'no-model').content_origin_drafting, [
    CODEX_DECLARED,
    { kind: 'assistant_draft', harness: 'codex', model: 'unknown', model_evidence: 'unknown' },
  ]);
  assert.deepEqual(eventFor(result, 'mixed-edit').content_origin_drafting, [
    CODEX_DECLARED,
    { kind: 'assistant_edit', harness: 'codex', model: 'gpt-5-codex', model_evidence: 'declared' },
  ]);
});

test('both message drafting aliases are preserved and a malformed alias is skipped, not hidden', () => {
  const result = createCodexSessionAdapter().normalizeSession({
    sessionId: 'codex-alias-session',
    messages: [
      { id: 'both', role: 'assistant', model: 'gpt-5-codex', content_origin_drafting: [CODEX_DECLARED], drafting: [CLAUDE_DECLARED], content: 'Both aliases declared.' },
      { id: 'malformed-type', role: 'assistant', model: 'gpt-5-codex', content_origin_drafting: [CODEX_DECLARED], drafting: 'not-an-array', content: 'Second alias is not a list.' },
      { id: 'malformed-entry', role: 'assistant', model: 'gpt-5-codex', drafting: [{ kind: 'assistant_draft' }], content: 'Entry lacks a harness.' },
    ],
  });

  const both = eventFor(result, 'both');
  assert.ok(both);
  // The current Codex/gpt-5-codex contribution is already declared, so no clone is appended.
  assert.deepEqual(both.content_origin_drafting, [CODEX_DECLARED, CLAUDE_DECLARED]);
  assertSkippedFor(result, 'malformed-type', /drafting/);
  assertSkippedFor(result, 'malformed-entry', /drafting|harness/);
});

test('resolver-owned human message stays eligible with no assistant contribution; human plus assistant history is not laundered', () => {
  const sessionId = 'codex-human-session';
  const verbatim = 'Keep exactly these words as my own note.';
  const laundered = 'These words also claim to be mine.';
  const transcribed = 'An assistant saved these user words verbatim.';
  const texts = { 'user-1': verbatim, 'user-2': laundered, 'saved-1': transcribed };
  const savedId = `capture:codex:${sessionId}:saved-1`;
  const resolveUserSource = (captureEventId) => {
    const id = captureEventId.split(':').pop();
    return texts[id] && captureEventId === `capture:codex:${sessionId}:${id}`
      ? { capture_event_id: captureEventId, actor: 'user', text: texts[id] }
      : null;
  };
  const result = createCodexSessionAdapter({ resolveUserSource }).normalizeSession({
    sessionId,
    model: 'session-model-must-not-be-drafting',
    messages: [
      { id: 'user-1', role: 'user', content: verbatim },
      { id: 'user-2', role: 'user', content: laundered, content_origin_drafting: [CODEX_DECLARED] },
      {
        id: 'saved-1',
        role: 'assistant',
        model: 'gpt-5-codex',
        content: transcribed,
        content_origin: 'human',
        content_origin_basis: 'verbatim_user',
        user_source: { capture_event_id: savedId, actor: 'user', source_digest: digestText(transcribed), content_digest: digestText(transcribed) },
      },
    ],
  });

  const human = eventFor(result, 'user-1');
  assert.ok(human);
  assert.equal(human.content_origin, 'human');
  assert.equal(human.content_origin_basis, 'verbatim_user');
  assert.equal(human.human_evidence_eligible, true);
  assert.equal(hasAssistantContribution(human.content_origin_drafting || []), false);
  assert.doesNotMatch(JSON.stringify(human.content_origin_drafting || []), /session-model-must-not-be-drafting/);

  // Human origin with assistant history is reported, never emitted as human evidence.
  assertSkippedFor(result, 'user-2', /human_origin_with_assistant_history/);
  assert.ok(result.events.length >= 2, 'other messages in the session are still emitted');

  // Saving or transcribing verbatim user words does not add an assistant contribution.
  const saved = eventFor(result, 'saved-1');
  assert.ok(saved);
  assert.equal(saved.content_origin, 'human');
  assert.equal(saved.human_evidence_eligible, true);
  assert.equal(saved.content_origin_drafting, undefined);
});

test('served drafting claims need the injected resolver; unresolved, forged or mismatched claims are skipped', () => {
  const served = { kind: 'assistant_draft', harness: 'codex', model: 'gpt-5-codex', model_evidence: 'served', served_ref: 'resp-session-1' };
  const session = {
    sessionId: 'codex-served-session',
    messages: [{ id: 'served-1', role: 'assistant', model: 'gpt-5-codex', content_origin_drafting: [served], content: 'Served reply.' }],
  };

  assertSkippedFor(createCodexSessionAdapter().normalizeSession(session), 'served-1', /served/);
  assertSkippedFor(createCodexSessionAdapter({ resolveServedModel: () => null }).normalizeSession(session), 'served-1', /served/);
  assertSkippedFor(createCodexSessionAdapter({ resolveServedModel: () => ({ model: 'other-model' }) }).normalizeSession(session), 'served-1', /served/);

  const resolveServedModel = (ref) => (ref === 'resp-session-1' ? { model: 'gpt-5-codex' } : null);
  const accepted = createCodexSessionAdapter({ resolveServedModel }).normalizeSession(session);
  const event = eventFor(accepted, 'served-1');
  assert.ok(event);
  // Served evidence is kept as resolved, with no redundant declared clone.
  assert.deepEqual(event.content_origin_drafting, [served]);
  assert.equal(event.human_evidence_eligible, false);
});
