'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const contract = require('../src');

const digest = (value) => contract.canonicalDigest(value);
const time = '2026-09-01T12:00:00.000Z';
const later = '2026-09-01T13:00:00.000Z';
const expiry = '2026-09-01T14:00:00.000Z';

function evidence(id = 'evidence-1') {
  return {
    schemaVersion: contract.EVIDENCE_SCHEMA_VERSION,
    evidenceId: id,
    subjectId: 'subject-1',
    observedAt: time,
    sourceRef: `source-${id}`,
    digest: digest({ id }),
    classification: 'observed',
  };
}

function approval(scope, bindingDigest, { approved = true, ambiguous = false } = {}) {
  return { scope, approvalId: `${scope}-approval-1`, bindingDigest, approved, ambiguous };
}

function promotionFixture() {
  const record = evidence();
  const candidate = contract.createCandidate({
    candidateId: 'candidate-1',
    subjectId: 'subject-1',
    candidateType: 'follow_up',
    evidence: [record],
    summaryDigest: digest({ summary: 1 }),
    generation: 'candidate-generation-1',
  });
  const outcome = contract.promoteCandidate({
    candidate,
    evidence: [record],
    expectedGeneration: candidate.generation,
    approval: approval('promotion', contract.promotionApprovalBinding({ candidate, policyRevision: 'policy-1' })),
    policyRevision: 'policy-1',
  });
  assert.equal(outcome.ok, true);
  return { record, candidate, promotion: outcome.promotion };
}

function catalogFixture() {
  return contract.createProviderCatalog({
    entries: [{
      schemaVersion: contract.PROVIDER_ENTRY_SCHEMA_VERSION,
      entryId: 'provider-a',
      provider: 'vendor-a',
      model: 'model-a',
      reasoningEfforts: ['low', 'high'],
    }],
  });
}

test('evidence becomes a candidate and is promoted only through complete unambiguous governance', () => {
  const record = evidence();
  const candidate = contract.createCandidate({
    candidateId: 'candidate-1',
    subjectId: 'subject-1',
    candidateType: 'follow_up',
    evidence: [record],
    summaryDigest: digest({ summary: 'a' }),
    generation: 'candidate-generation-1',
  });
  assert.deepEqual(candidate.evidenceRefs, [{ evidenceId: 'evidence-1', digest: record.digest }]);
  const promotionBinding = contract.promotionApprovalBinding({ candidate, policyRevision: 'policy-1' });

  const promoted = contract.promoteCandidate({
    candidate,
    evidence: [record],
    expectedGeneration: candidate.generation,
    approval: approval('promotion', promotionBinding),
    policyRevision: 'policy-1',
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.promotion.status, 'promoted');
  assert.equal(promoted.promotion.candidateGeneration, candidate.generation);

  assert.equal(contract.promoteCandidate({
    candidate,
    evidence: [],
    expectedGeneration: candidate.generation,
    approval: approval('promotion', promotionBinding),
    policyRevision: 'policy-1',
  }).code, 'evidence_incomplete');
  assert.equal(contract.promoteCandidate({
    candidate,
    evidence: [record, { ...record, digest: digest({ conflict: true }) }],
    expectedGeneration: candidate.generation,
    approval: approval('promotion', promotionBinding),
    policyRevision: 'policy-1',
  }).code, 'evidence_conflict');
  assert.throws(() => contract.createCandidate({
    candidateId: 'candidate-2',
    subjectId: 'subject-1',
    candidateType: 'follow_up',
    evidence: [record, { ...record, digest: digest({ conflict: true }) }],
    summaryDigest: digest({ summary: 'conflict' }),
  }), /conflicting evidence records/);
  assert.throws(() => contract.createCandidate({
    candidateId: 'candidate-3',
    subjectId: 'subject-1',
    candidateType: 'follow_up',
    evidence: [{ ...record, subjectId: 'subject-2' }],
    summaryDigest: digest({ summary: 'wrong-subject' }),
  }), /evidence subject does not match candidate subject/);
  assert.equal(contract.promoteCandidate({
    candidate,
    evidence: [{ ...record, digest: digest({ replacement: true }) }],
    expectedGeneration: candidate.generation,
    approval: approval('promotion', promotionBinding),
    policyRevision: 'policy-1',
  }).code, 'evidence_incomplete');
  assert.equal(contract.promoteCandidate({
    candidate,
    evidence: [record],
    expectedGeneration: 'other-generation',
    approval: approval('promotion', promotionBinding),
    policyRevision: 'policy-1',
  }).code, 'stale_generation');
  assert.equal(contract.promoteCandidate({
    candidate,
    evidence: [record],
    expectedGeneration: candidate.generation,
    approval: approval('promotion', promotionBinding, { ambiguous: true }),
    policyRevision: 'policy-1',
  }).code, 'ambiguous_request');
  assert.equal(contract.promoteCandidate({
    candidate: { ...candidate, summaryDigest: digest({ changed: true }) },
    evidence: [record],
    expectedGeneration: candidate.generation,
    approval: approval('promotion', promotionBinding),
    policyRevision: 'policy-1',
  }).code, 'approval_binding_mismatch');
});

test('provider catalog selection is registered, approval-gated, compare-and-swap bound, and failure-preserving', () => {
  const catalog = catalogFixture();
  const initial = contract.createInitialProviderSelection({ generation: 'selection-generation-1' });
  const proposal = contract.createProviderProposal({ catalog, entryId: 'provider-a', expectedGeneration: initial.generation });
  const selectionBinding = contract.providerSelectionApprovalBinding({ catalog, proposal });

  const failed = contract.settleProviderSelection({ catalog, selection: initial, proposal, outcome: 'failed' });
  assert.equal(failed.ok, true);
  assert.equal(failed.selection.entryId, null);
  assert.equal(failed.selection.generation, initial.generation);
  assert.equal(failed.selection.lastOutcome.outcome, 'failed');

  assert.equal(contract.settleProviderSelection({
    catalog,
    selection: initial,
    proposal,
    outcome: 'qualified',
    approval: approval('provider_selection', selectionBinding, { approved: false }),
  }).code, 'approval_required');

  const selected = contract.settleProviderSelection({
    catalog,
    selection: initial,
    proposal,
    outcome: 'qualified',
    approval: approval('provider_selection', selectionBinding),
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.selection.entryId, 'provider-a');
  assert.notEqual(selected.selection.generation, initial.generation);
  assert.equal(contract.settleProviderSelection({
    catalog,
    selection: selected.selection,
    proposal,
    outcome: 'qualified',
    approval: approval('provider_selection', selectionBinding),
  }).code, 'stale_generation');
  assert.equal(contract.settleProviderSelection({
    catalog,
    selection: initial,
    proposal,
    outcome: 'qualified',
    approval: approval('provider_selection', digest({ another: 'proposal' })),
  }).code, 'approval_binding_mismatch');
});

test('prepare is inert and delivery is due-bound, receipt-bound, expiry-bound, and idempotent', () => {
  const { candidate, promotion } = promotionFixture();
  const catalog = catalogFixture();
  const initial = contract.createInitialProviderSelection({ generation: 'selection-generation-1' });
  const proposal = contract.createProviderProposal({ catalog, entryId: 'provider-a', expectedGeneration: initial.generation });
  const selection = contract.settleProviderSelection({
    catalog,
    selection: initial,
    proposal,
    outcome: 'qualified',
    approval: approval('provider_selection', contract.providerSelectionApprovalBinding({ catalog, proposal })),
  }).selection;
  const schedule = {
    schemaVersion: contract.SCHEDULE_SCHEMA_VERSION,
    scheduleId: 'schedule-1',
    candidateId: candidate.candidateId,
    subjectId: candidate.subjectId,
    dueAt: later,
    expiresAt: expiry,
    idempotencyKey: 'delivery-key-1',
  };
  const conversation = {
    schemaVersion: contract.CONVERSATION_IDENTITY_SCHEMA_VERSION,
    conversationId: 'conversation-1',
    subjectId: 'subject-1',
    createdAt: time,
  };
  const bridge = {
    schemaVersion: contract.HARNESS_BRIDGE_SCHEMA_VERSION,
    bridgeId: 'bridge-1',
    operations: ['transport', 'native_session_mapping', 'event_bridge', 'receipt_production'],
  };
  const mapping = {
    schemaVersion: contract.CONVERSATION_MAPPING_SCHEMA_VERSION,
    mappingId: 'mapping-1',
    conversationId: conversation.conversationId,
    bridgeId: bridge.bridgeId,
    nativeSessionRef: 'native-session-opaque-1',
    mappedAt: time,
  };
  const prepared = contract.prepareDelivery({
    promotion,
    schedule,
    conversation,
    catalog,
    selection,
    approval: approval('delivery', contract.deliveryApprovalBinding({ promotion, schedule, conversation, selection })),
    now: time,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.prepared.state, 'prepared');
  assert.equal(contract.prepareDelivery({
    promotion,
    schedule,
    conversation,
    catalog,
    selection,
    approval: approval('delivery', digest({ another: 'delivery' })),
    now: time,
  }).code, 'approval_binding_mismatch');
  const receipt = {
    schemaVersion: contract.LIFECYCLE_RECEIPT_SCHEMA_VERSION,
    receiptId: 'delivery-receipt-1',
    preparedId: prepared.prepared.preparedId,
    conversationId: conversation.conversationId,
    subjectId: conversation.subjectId,
    mappingId: mapping.mappingId,
    bridgeId: bridge.bridgeId,
    idempotencyKey: schedule.idempotencyKey,
    outcome: 'delivered',
    occurredAt: later,
    producer: 'harness_bridge',
  };
  assert.equal(contract.evaluateDelivery({ prepared: prepared.prepared, receipt, bridge, mapping, now: time }).code, 'receipt_future');
  assert.equal(contract.evaluateDelivery({ prepared: prepared.prepared, receipt, bridge, mapping, now: later }).code, 'delivered');
  assert.equal(contract.evaluateDelivery({ prepared: prepared.prepared, receipt: { ...receipt, subjectId: 'subject-2' }, bridge, mapping, now: later }).code, 'receipt_binding_mismatch');
  assert.equal(contract.evaluateDelivery({ prepared: prepared.prepared, receipt, bridge: { ...bridge, bridgeId: 'bridge-2' }, mapping, now: later }).code, 'conversation_mapping_mismatch');
  assert.equal(contract.evaluateDelivery({ prepared: prepared.prepared, receipt, bridge, mapping: { ...mapping, mappingId: 'mapping-2' }, now: later }).code, 'receipt_binding_mismatch');
  const replay = contract.evaluateDelivery({ prepared: prepared.prepared, receipt, priorReceipts: [receipt], bridge, mapping, now: later });
  assert.equal(replay.code, 'idempotent_replay');
  assert.equal(contract.evaluateDelivery({
    prepared: prepared.prepared,
    receipt,
    priorReceipts: [{ ...receipt, occurredAt: '2026-09-01T13:30:00.000Z' }],
    bridge,
    mapping,
    now: later,
  }).code, 'idempotency_record_invalid');
  assert.equal(contract.evaluateDelivery({
    prepared: prepared.prepared,
    receipt,
    priorReceipts: [receipt, { ...receipt, receiptId: 'delivery-receipt-2' }],
    bridge,
    mapping,
    now: later,
  }).code, 'idempotency_conflict');
  assert.equal(contract.evaluateDelivery({
    prepared: prepared.prepared,
    receipt,
    priorReceipts: [{ ...receipt, preparedId: 'other-prepared' }],
    bridge,
    mapping,
    now: later,
  }).code, 'idempotency_record_invalid');
  assert.equal(contract.evaluateDelivery({
    prepared: prepared.prepared,
    receipt,
    priorReceipts: [{ ...receipt, occurredAt: time }],
    bridge,
    mapping,
    now: later,
  }).code, 'idempotency_record_invalid');
  assert.equal(contract.evaluateDelivery({
    prepared: prepared.prepared,
    receipt: { ...receipt, occurredAt: time }, bridge, mapping,
    now: later,
  }).code, 'receipt_outside_schedule');
  assert.equal(contract.evaluateDelivery({ prepared: prepared.prepared, receipt, bridge, mapping, now: '2026-09-01T15:00:00.000Z' }).code, 'schedule_expired');
  assert.equal(contract.prepareDelivery({
    promotion,
    schedule: { ...schedule, subjectId: 'subject-2' },
    conversation,
    catalog,
    selection,
    approval: approval('delivery', contract.deliveryApprovalBinding({ promotion, schedule, conversation, selection })),
    now: time,
  }).code, 'subject_mismatch');
  assert.equal(contract.prepareDelivery({
    promotion,
    schedule: { ...schedule, dueAt: time },
    conversation,
    catalog,
    selection,
    approval: approval('delivery', contract.deliveryApprovalBinding({ promotion, schedule, conversation, selection })),
    now: time,
  }).code, 'approval_binding_mismatch');
  assert.equal(contract.prepareDelivery({
    promotion,
    schedule,
    conversation,
    catalog,
    selection: { ...selection, lastOutcome: { ...selection.lastOutcome, outcome: 'failed' } },
    approval: approval('delivery', contract.deliveryApprovalBinding({ promotion, schedule, conversation, selection })),
    now: time,
  }).code, 'provider_not_qualified');
  assert.equal(contract.prepareDelivery({
    promotion,
    schedule,
    conversation,
    catalog,
    selection: {
      ...selection,
      lastOutcome: { ...selection.lastOutcome, resultingGeneration: 'forged-generation' },
    },
    approval: approval('delivery', contract.deliveryApprovalBinding({ promotion, schedule, conversation, selection })),
    now: time,
  }).code, 'provider_not_qualified');
});

test('portable conversation and bridge receipts have a closed, redacted boundary', () => {
  const identity = {
    schemaVersion: contract.CONVERSATION_IDENTITY_SCHEMA_VERSION,
    conversationId: 'conversation-1',
    subjectId: 'subject-1',
    createdAt: time,
  };
  const mapping = {
    schemaVersion: contract.CONVERSATION_MAPPING_SCHEMA_VERSION,
    mappingId: 'mapping-1',
    conversationId: identity.conversationId,
    bridgeId: 'bridge-1',
    nativeSessionRef: 'native-session-opaque-1',
    mappedAt: time,
  };
  const interaction = {
    schemaVersion: contract.INTERACTION_RECEIPT_SCHEMA_VERSION,
    receiptId: 'interaction-1',
    conversationId: identity.conversationId,
    mappingId: mapping.mappingId,
    kind: 'user_message',
    occurredAt: time,
    payloadDigest: digest({ message: 1 }),
    idempotencyKey: 'interaction-key-1',
  };
  assert.equal(contract.validateConversationIdentity(identity).ok, true);
  assert.equal(contract.validateConversationMapping(mapping).ok, true);
  assert.equal(contract.validateInteractionReceipt(interaction).ok, true);
  assert.equal(contract.validateHarnessBridge({
    schemaVersion: contract.HARNESS_BRIDGE_SCHEMA_VERSION,
    bridgeId: 'bridge-1',
    operations: [...contract.HARNESS_INTERFACE_OPERATIONS],
  }).ok, true);
  assert.equal(contract.validateHarnessBridge({
    schemaVersion: contract.HARNESS_BRIDGE_SCHEMA_VERSION,
    bridgeId: 'bridge-1',
    operations: ['transport', 'schedule_work'],
  }).ok, false);
  assert.equal(contract.validateInteractionReceipt({ ...interaction, credential: 'nope' }).ok, false);
});

test('timestamps are strict UTC calendar values rather than normalized dates', () => {
  const schedule = {
    schemaVersion: contract.SCHEDULE_SCHEMA_VERSION,
    scheduleId: 'schedule-1',
    candidateId: 'candidate-1',
    subjectId: 'subject-1',
    dueAt: later,
    expiresAt: expiry,
    idempotencyKey: 'delivery-key-1',
  };
  for (const invalidDueAt of ['2026-02-29T12:00:00Z', '2026-02-31T12:00:00.000Z', '2026-04-31T12:00:00Z']) {
    assert.equal(contract.validateSchedule({ ...schedule, dueAt: invalidDueAt }).ok, false, invalidDueAt);
  }
});

test('the schema artifact parses and production code stays pure and host-namespace-free', () => {
  const schemaPath = path.resolve(__dirname, '..', 'schemas', 'active-assistant-service.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.$id, 'https://jarvos.dev/schemas/active-assistant-service.schema.json');
  assert.match(schema.$comment, /structural envelope/i);
  assert.ok(schema.oneOf.some((entry) => entry.$ref === '#/$defs/approval'));
  const schemaText = JSON.stringify(schema);
  [
    contract.EVIDENCE_SCHEMA_VERSION,
    contract.CANDIDATE_SCHEMA_VERSION,
    contract.PROMOTION_SCHEMA_VERSION,
    contract.SCHEDULE_SCHEMA_VERSION,
    contract.PREPARED_DELIVERY_SCHEMA_VERSION,
    contract.PROVIDER_ENTRY_SCHEMA_VERSION,
    contract.PROVIDER_CATALOG_SCHEMA_VERSION,
    contract.PROVIDER_SELECTION_SCHEMA_VERSION,
    contract.PROVIDER_PROPOSAL_SCHEMA_VERSION,
    contract.CONVERSATION_IDENTITY_SCHEMA_VERSION,
    contract.CONVERSATION_MAPPING_SCHEMA_VERSION,
    contract.INTERACTION_RECEIPT_SCHEMA_VERSION,
    contract.LIFECYCLE_RECEIPT_SCHEMA_VERSION,
    contract.HARNESS_BRIDGE_SCHEMA_VERSION,
  ].forEach((version) => assert.match(schemaText, new RegExp(version.replace('/', '\\/'))));

  const sourceRoot = path.resolve(__dirname, '..', 'src');
  const source = fs.readdirSync(sourceRoot)
    .filter((file) => file.endsWith('.js'))
    .map((file) => fs.readFileSync(path.join(sourceRoot, file), 'utf8'))
    .join('\n');
  const forbiddenNamespace = new RegExp(['open', 'claw'].join(''), 'i');
  assert.doesNotMatch(source, forbiddenNamespace);
  assert.deepEqual([...source.matchAll(/require\(([^)]+)\)/g)].map((match) => match[1]), ["'./service-contract'", "'node:crypto'"]);
  assert.doesNotMatch(source, /(?:fetch\s*\(|set(?:Interval|Timeout)\s*\(|spawn\s*\(|exec\s*\()/);
});
