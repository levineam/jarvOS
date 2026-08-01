'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  CODING_EXECUTION_AUTHORITIES,
  authorizeToolCall,
  buildEgressPacket,
  createLifecycleReceipt,
  createSessionHandoff,
  redactDiagnostics,
  sanitizeChildEnvironment,
  validateCapabilityProfile,
  validateDispatchRequest,
  validateSessionHandoff,
} = require('../src/index.js');

const profile = {
  version: 'jarvos-harness-capability-profile.v1',
  harness: 'hermes',
  authorities: ['conversation.dispatch'],
  toolActions: [{
    tool: 'jarvos_hydrate',
    actions: ['read'],
    sourceClasses: ['internal'],
  }],
  egress: {
    providers: ['approved-provider'],
    endpoints: ['https://models.example.test'],
    sourceClasses: ['internal'],
  },
};

function request(overrides = {}) {
  return {
    version: 'jarvos-harness-dispatch.v1',
    dispatchId: 'dispatch-1',
    interactionWindowId: 'window-1',
    harness: 'hermes',
    adapterVersion: '1.0.0',
    configurationRevision: 'config-1',
    mode: 'split',
    deadlineAt: '2026-08-01T12:00:00.000Z',
    identity: {
      kind: 'opaque-capability',
      id: 'capability-1',
      issuer: 'jarvos-control-plane',
      subject: 'harness:hermes',
      harness: 'hermes',
      interactionWindowId: 'window-1',
      configurationRevision: 'config-1',
      expiresAt: '2026-08-01T12:00:00.000Z',
      proofDigest: 'a'.repeat(64),
    },
    capabilityProfile: profile,
    context: {
      sources: [{ sourceClass: 'internal', label: 'current-work', content: 'Use only this evidence.' }],
    },
    ...overrides,
  };
}

test('validates declared capability profiles and rejects coding-work authority', () => {
  assert.deepEqual(validateCapabilityProfile(profile), { ok: true, errors: [] });

  for (const authority of CODING_EXECUTION_AUTHORITIES) {
    const rejected = validateCapabilityProfile({ ...profile, authorities: [authority] });
    assert.equal(rejected.ok, false, authority);
    assert.match(rejected.errors.join('\n'), new RegExp(authority));
  }

  assert.equal(validateCapabilityProfile({ ...profile, authorities: 'conversation.dispatch' }).ok, false);
  assert.equal(validateCapabilityProfile({ ...profile, authorities: { read: true } }).ok, false);
});

test('validates a dispatch request bound to an opaque identity', () => {
  assert.deepEqual(validateDispatchRequest(request()), { ok: true, errors: [] });

  const rejected = validateDispatchRequest(request({
    identity: { ...request().identity, interactionWindowId: 'another-window' },
  }));
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join('\n'), /interactionWindowId/);
});

test('authorizes tools at the server boundary with an identity verifier', () => {
  const allowed = authorizeToolCall(request(), {
    tool: 'jarvos_hydrate', action: 'read', sourceClass: 'internal',
  }, {
    verifyIdentity: (identity) => identity.id === 'capability-1',
  });
  assert.deepEqual(allowed, { ok: true, code: 'allowed' });

  const denied = authorizeToolCall(request(), {
    tool: 'jarvos_control_plane', action: 'mutate', sourceClass: 'internal',
  }, {
    verifyIdentity: () => true,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'tool_not_allowed');
});

test('filters egress by a server-resolved profile, provider, endpoint, source class, and secrets', () => {
  const resolveAuthorizedProfile = (identity) => identity.id === 'capability-1' ? profile : null;
  const packet = buildEgressPacket(request({
    context: {
      sources: [
        { sourceClass: 'internal', label: 'allowed', content: 'OPENAI_API_KEY=sk-abc12345678901234567890' },
        { sourceClass: 'private', label: 'excluded', content: 'private note' },
        { sourceClass: 'secret', label: 'secret', content: 'never send' },
      ],
    },
  }), {
    provider: 'approved-provider', endpoint: 'https://models.example.test/v1/chat',
  }, { resolveAuthorizedProfile });
  assert.equal(packet.ok, true, packet.errors?.join('\n'));
  assert.deepEqual(packet.packet.sources.map((source) => source.label), ['allowed']);
  assert.doesNotMatch(packet.packet.sources[0].content, /abc12345678901234567890/);
  assert.match(packet.packet.sources[0].content, /\[REDACTED\]/);

  const prefixCollision = buildEgressPacket(request({
    capabilityProfile: { ...profile, egress: { ...profile.egress, endpoints: ['https://models.example.test/v1'] } },
  }), {
    provider: 'approved-provider', endpoint: 'https://models.example.test/v1-private',
  }, {
    resolveAuthorizedProfile: () => ({
      ...profile,
      egress: { ...profile.egress, endpoints: ['https://models.example.test/v1'] },
    }),
  });
  assert.equal(prefixCollision.ok, false);
  assert.equal(prefixCollision.code, 'egress_not_allowed');

  const denied = buildEgressPacket(request(), {
    provider: 'other-provider', endpoint: 'https://other.example.test',
  }, { resolveAuthorizedProfile });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'egress_not_allowed');

  const missingAuthority = buildEgressPacket(request(), {
    provider: 'approved-provider', endpoint: 'https://models.example.test',
  });
  assert.deepEqual(missingAuthority, { ok: false, code: 'identity_not_authorized' });

  const forgedProfile = buildEgressPacket(request({
    capabilityProfile: { ...profile, egress: { ...profile.egress, providers: ['forged-provider'] } },
  }), {
    provider: 'forged-provider', endpoint: 'https://models.example.test',
  }, { resolveAuthorizedProfile });
  assert.equal(forgedProfile.ok, false);
  assert.equal(forgedProfile.code, 'egress_not_allowed');
});

test('sanitizes child environment and redacts diagnostics', () => {
  const env = sanitizeChildEnvironment({
    PATH: '/usr/bin', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'sk-abc12345678901234567890',
    JARVOS_TOKEN: 'top-secret', SAFE_CUSTOM: 'allowed',
  }, { allowlist: ['SAFE_CUSTOM'] });
  assert.deepEqual(env, { PATH: '/usr/bin', LANG: 'en_US.UTF-8', SAFE_CUSTOM: 'allowed' });

  const diagnostics = redactDiagnostics('Authorization: Bearer abcdefghijklmnopqrstuvwxyz OPENAI_API_KEY=sk-abc12345678901234567890');
  assert.doesNotMatch(diagnostics, /abcdefghijklmnopqrstuvwxyz|abc12345678901234567890/);
  assert.match(diagnostics, /\[REDACTED\]/);
});

test('normalizes lifecycle receipts without transport authority in split mode', () => {
  const receipt = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'split', status: 'completed', contentDigest: 'b'.repeat(64),
    diagnostics: '{"OPENAI_API_KEY":"sk-abc12345678901234567890"}',
  });
  assert.equal(receipt.ok, true, receipt.errors?.join('\n'));
  assert.equal(receipt.receipt.status, 'completed');
  assert.equal('diagnostics' in receipt.receipt, false);

  const rejected = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'split', status: 'delivered', transportMessageId: 'telegram-1',
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join('\n'), /split lifecycle/);

  const splitIdentity = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'split', status: 'completed',
    providerMessageIds: ['telegram-1'], canonicalParentMessageId: 'telegram-1',
  });
  assert.equal(splitIdentity.ok, false);
  assert.match(splitIdentity.errors.join('\n'), /transport authority/);
});

test('normalizes a digest-bound session handoff without copying transcripts', () => {
  const handoff = createSessionHandoff({
    handoffId: 'handoff-1',
    sourceHarness: 'openclaw',
    targetHarness: 'hermes',
    threadId: 'jarvos-thread-1',
    checkpointDigest: 'c'.repeat(64),
    contextDigest: 'd'.repeat(64),
    sourceGroups: ['current-work', 'session-thread'],
    currentWorkIdentity: 'paperclip:SUP-1',
  });
  assert.equal(handoff.ok, true, handoff.errors?.join('\n'));
  assert.equal(handoff.handoff.targetHarness, 'hermes');
  assert.equal(validateSessionHandoff(handoff.handoff).ok, true);
  assert.equal(validateSessionHandoff({ ...handoff.handoff, transcript: 'private transcript' }).ok, false);
});

test('requires native transport identity before a lifecycle receipt can be delivered', () => {
  const accepted = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'native_gateway', status: 'accepted',
  });
  assert.equal(accepted.ok, true, accepted.errors?.join('\n'));
  const delivered = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'native_gateway', status: 'delivered',
    transportMessageId: 'telegram-1', routeIdentity: 'hermes:telegram:default', gatewayIdentity: 'hermes:native-gateway',
    routeCredentialRevision: '1',
    generationSessionReference: 'generation-1', conversationSessionReference: 'conversation-1',
  });
  assert.equal(delivered.ok, true, delivered.errors?.join('\n'));
  assert.equal(delivered.receipt.transportMessageId, 'telegram-1');
  assert.equal(createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'native_gateway', status: 'delivered',
    transportMessageId: 'telegram-1', routeIdentity: 'hermes:telegram:default', gatewayIdentity: 'hermes:native-gateway',
  }).ok, false);
});

test('records every first-contact native delivery ID without inventing a session', () => {
  const delivered = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'native_gateway', status: 'delivered',
    providerMessageIds: ['telegram-1', 'telegram-2'],
    canonicalParentMessageId: 'telegram-2',
    routeIdentity: 'hermes:telegram:default', gatewayIdentity: 'hermes:native-gateway',
    routeCredentialRevision: '1', generationSessionReference: 'generation-1',
    conversationSessionReference: 'hermes:telegram:expected-conversation',
  });
  assert.equal(delivered.ok, true, delivered.errors?.join('\n'));
  assert.deepEqual(delivered.receipt.providerMessageIds, ['telegram-1', 'telegram-2']);
  assert.equal(delivered.receipt.transportMessageId, 'telegram-2');
  assert.equal(delivered.receipt.canonicalParentMessageId, 'telegram-2');
  assert.equal(delivered.receipt.conversationSessionReference, 'hermes:telegram:expected-conversation');
  assert.equal(delivered.receipt.resolvedConversationSessionId, null);

  const resolved = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'native_gateway', status: 'delivered',
    providerMessageIds: ['telegram-1'], canonicalParentMessageId: 'telegram-1',
    routeIdentity: 'hermes:telegram:default', gatewayIdentity: 'hermes:native-gateway',
    routeCredentialRevision: '1', generationSessionReference: 'generation-1',
    conversationSessionReference: 'hermes:telegram:expected-conversation',
    resolvedConversationSessionId: 'hermes:telegram:actual-conversation',
  });
  assert.equal(resolved.ok, true, resolved.errors?.join('\n'));
  assert.equal(resolved.receipt.resolvedConversationSessionId, 'hermes:telegram:actual-conversation');

  const invalidResolved = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'native_gateway', status: 'delivered',
    providerMessageIds: ['telegram-1'], canonicalParentMessageId: 'telegram-1',
    routeIdentity: 'hermes:telegram:default', gatewayIdentity: 'hermes:native-gateway',
    routeCredentialRevision: '1', generationSessionReference: 'generation-1',
    conversationSessionReference: 'hermes:telegram:expected-conversation',
    resolvedConversationSessionId: '',
  });
  assert.equal(invalidResolved.ok, false);
  assert.match(invalidResolved.errors.join('\n'), /resolvedConversationSessionId/);

  const invalidParent = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'native_gateway', status: 'delivered',
    providerMessageIds: ['telegram-1', 'telegram-2'],
    canonicalParentMessageId: 'telegram-3',
    routeIdentity: 'hermes:telegram:default', gatewayIdentity: 'hermes:native-gateway',
    routeCredentialRevision: '1', generationSessionReference: 'generation-1',
    conversationSessionReference: 'hermes:telegram:expected-conversation',
  });
  assert.equal(invalidParent.ok, false);
  assert.match(invalidParent.errors.join('\n'), /canonicalParentMessageId/);
});
