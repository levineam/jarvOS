'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  CODING_EXECUTION_AUTHORITIES,
  COMMON_WORK_ACTIONS,
  authorizeToolCall,
  buildEgressPacket,
  createCommonWorkBridge,
  createLifecycleReceipt,
  createSessionHandoff,
  createWorkHandoff,
  redactDiagnostics,
  sanitizeChildEnvironment,
  validateCapabilityProfile,
  validateDispatchRequest,
  validateSessionHandoff,
  validateWorkHandoff,
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

test('common work handoffs use canonical pointers only', () => {
  const handoff = createWorkHandoff({
    workId: 'work:SUP-2214',
    workspaceId: 'workspace:jarvos-main',
    headOid: 'a'.repeat(40),
  });
  assert.equal(handoff.ok, true, handoff.errors?.join('\n'));
  assert.deepEqual(handoff.handoff, {
    workId: 'work:SUP-2214', workspaceId: 'workspace:jarvos-main', headOid: 'a'.repeat(40),
  });
  assert.equal(validateWorkHandoff({ ...handoff.handoff, branch: 'unsafe-copy' }).ok, false);
  assert.equal(validateWorkHandoff({ ...handoff.handoff, headOid: 'short' }).ok, false);
});

test('common work bridge exposes one vocabulary and rereads authority before resume or mutation', async () => {
  const calls = [];
  const handoff = { workId: 'work:SUP-2214', workspaceId: 'workspace:jarvos-main', headOid: 'a'.repeat(40) };
  const authority = Object.fromEntries(COMMON_WORK_ACTIONS.map((action) => [action, async (input) => {
    calls.push(action);
    return { ok: true, action, input, ...handoff };
  }]));
  authority.reread = async (input) => {
    calls.push(`reread:${input.action}`);
    return { ok: true, ...handoff };
  };
  const bridge = createCommonWorkBridge(authority);

  assert.deepEqual(Object.keys(bridge.availability), COMMON_WORK_ACTIONS);
  assert.deepEqual(COMMON_WORK_ACTIONS.filter((action) => typeof bridge[action] === 'function'), COMMON_WORK_ACTIONS);
  await bridge.get_status({ handoff });
  await bridge.attach_or_resume({ handoff });
  await bridge.submit_judgment({ handoff, judgment: 'hold' });
  await bridge.claim({ handoff });
  await bridge.request_or_answer_approval({ handoff, answer: 'wait' });
  await bridge.get_terminal_receipt({ handoff, operationId: 'operation:one' });
  assert.deepEqual(calls, [
    'reread:get_status', 'get_status',
    'reread:attach_or_resume', 'attach_or_resume',
    'reread:submit_judgment', 'submit_judgment',
    'reread:claim', 'claim',
    'reread:request_or_answer_approval', 'request_or_answer_approval',
    'reread:get_terminal_receipt', 'get_terminal_receipt',
  ]);
  assert.equal('authoritySnapshot' in (await bridge.claim({ handoff })).input, false);
});

test('common work bridge fails closed for stale, dirty, foreign, or unavailable authority', async () => {
  const handoff = { workId: 'work:SUP-2214', workspaceId: 'workspace:jarvos-main', headOid: 'a'.repeat(40) };
  for (const [label, snapshot, code] of [
    ['stale', { ok: true, ...handoff, stale: true }, 'stale_handoff'],
    ['dirty', { ok: true, ...handoff, dirty: true }, 'dirty_workspace'],
    ['foreign', { ok: true, ...handoff, foreign: true }, 'foreign_workspace'],
    ['head changed', { ok: true, ...handoff, headOid: 'b'.repeat(40) }, 'stale_handoff'],
  ]) {
    let mutated = false;
    const result = await createCommonWorkBridge({
      reread: async () => snapshot,
      claim: async () => { mutated = true; return { ok: true }; },
    }).claim({ handoff });
    assert.equal(result.ok, false, label);
    assert.equal(result.code, code, label);
    assert.equal(mutated, false, label);
  }
  assert.equal((await createCommonWorkBridge({ claim: async () => ({ ok: true }) }).claim({ handoff })).code, 'authority_reread_required');
  assert.equal(createCommonWorkBridge({ claim: async () => ({ ok: true }) }).availability.claim, false);
  assert.equal(createCommonWorkBridge({ get_terminal_receipt: async () => ({ ok: true }) }).availability.get_terminal_receipt, false);
});

test('common work bridge rejects authority-shaped input and cross-work terminal receipts', async () => {
  const handoff = { workId: 'work:SUP-2214', workspaceId: 'workspace:jarvos-main', headOid: 'a'.repeat(40) };
  const reread = async () => ({ ok: true, ...handoff });
  let calls = 0;
  const bridge = createCommonWorkBridge({
    reread,
    claim: async (input) => { calls += 1; return { ok: true, ...handoff, input }; },
    get_terminal_receipt: async () => ({ ok: true, workId: 'work:OTHER', workspaceId: handoff.workspaceId, headOid: handoff.headOid }),
  });
  for (const hostile of [
    { authoritySnapshot: { ownerLease: 'lease:other' } },
    { payload: { privateSnapshot: { path: '/private' } } },
    { lease: 'lease:other' },
  ]) {
    assert.deepEqual(await bridge.claim({ handoff, ...hostile }), { ok: false, code: 'reserved_authority_input' });
  }
  const inherited = Object.create({ privateSnapshot: { lease: 'lease:inherited' } });
  inherited.handoff = handoff;
  assert.deepEqual(await bridge.claim(inherited), { ok: false, code: 'reserved_authority_input' });
  const hidden = { handoff };
  Object.defineProperty(hidden, 'lease', { value: 'lease:hidden', enumerable: false });
  assert.deepEqual(await bridge.claim(hidden), { ok: false, code: 'reserved_authority_input' });
  const callable = () => {};
  callable.handoff = handoff;
  callable.privateSnapshot = { lease: 'lease:callable' };
  assert.deepEqual(await bridge.claim(callable), { ok: false, code: 'reserved_authority_input' });
  assert.equal(calls, 0);
  assert.deepEqual(await bridge.get_terminal_receipt({ handoff, operationId: 'operation:one' }), {
    ok: false, code: 'authority_result_mismatch',
  });
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
  const apiKeyName = ['OPENAI', 'API', 'KEY'].join('_');
  const credentialMarker = ['sk', 'test', 'fixture', 'value'].join('-');
  const packet = buildEgressPacket(request({
    context: {
      sources: [
        { sourceClass: 'internal', label: 'allowed', content: `${apiKeyName}=${credentialMarker}` },
        { sourceClass: 'private', label: 'excluded', content: 'private note' },
        { sourceClass: 'secret', label: 'secret', content: 'never send' },
      ],
    },
  }), {
    provider: 'approved-provider', endpoint: 'https://models.example.test/v1/chat',
  }, { resolveAuthorizedProfile });
  assert.equal(packet.ok, true, packet.errors?.join('\n'));
  assert.deepEqual(packet.packet.sources.map((source) => source.label), ['allowed']);
  assert.doesNotMatch(packet.packet.sources[0].content, /sk-test-fixture-value/);
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
  const apiKeyName = ['OPENAI', 'API', 'KEY'].join('_');
  const credentialMarker = ['sk', 'test', 'fixture', 'value'].join('-');
  const env = sanitizeChildEnvironment({
    PATH: '/usr/bin', LANG: 'en_US.UTF-8', [apiKeyName]: credentialMarker,
    JARVOS_TOKEN: 'top-secret', SAFE_CUSTOM: 'allowed',
  }, { allowlist: ['SAFE_CUSTOM'] });
  assert.deepEqual(env, { PATH: '/usr/bin', LANG: 'en_US.UTF-8', SAFE_CUSTOM: 'allowed' });

  const bearerMarker = 'abcdefghijklmnopqrstuvwx';
  const diagnostics = redactDiagnostics(`Authorization: Bearer ${bearerMarker} ${apiKeyName}=${credentialMarker}`);
  assert.doesNotMatch(diagnostics, new RegExp(`${bearerMarker}|${credentialMarker}`));
  assert.match(diagnostics, /\[REDACTED\]/);
});

test('normalizes lifecycle receipts without transport authority in split mode', () => {
  const apiKeyName = ['OPENAI', 'API', 'KEY'].join('_');
  const credentialMarker = ['sk', 'test', 'fixture', 'value'].join('-');
  const receipt = createLifecycleReceipt({
    dispatchId: 'dispatch-1', mode: 'split', status: 'completed', contentDigest: 'b'.repeat(64),
    diagnostics: JSON.stringify({ [apiKeyName]: credentialMarker }),
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
