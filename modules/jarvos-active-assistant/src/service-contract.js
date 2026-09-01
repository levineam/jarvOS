'use strict';

// This module is deliberately a pure contract. It performs no I/O, starts no
// work, resolves no credentials, and does not invoke a provider or a bridge.
// Hosts supply validated data and retain transport/session/media mechanics.

const crypto = require('node:crypto');

const ACTIVE_ASSISTANT_CONTRACT_VERSION = 'jarvos-active-assistant-service/v1';
const EVIDENCE_SCHEMA_VERSION = 'jarvos-active-assistant-evidence/v1';
const CANDIDATE_SCHEMA_VERSION = 'jarvos-active-assistant-candidate/v1';
const PROMOTION_SCHEMA_VERSION = 'jarvos-active-assistant-promotion/v1';
const SCHEDULE_SCHEMA_VERSION = 'jarvos-active-assistant-schedule/v1';
const PREPARED_DELIVERY_SCHEMA_VERSION = 'jarvos-active-assistant-prepared-delivery/v1';
const PROVIDER_ENTRY_SCHEMA_VERSION = 'jarvos-active-assistant-provider-entry/v1';
const PROVIDER_CATALOG_SCHEMA_VERSION = 'jarvos-active-assistant-provider-catalog/v1';
const PROVIDER_SELECTION_SCHEMA_VERSION = 'jarvos-active-assistant-provider-selection/v1';
const PROVIDER_PROPOSAL_SCHEMA_VERSION = 'jarvos-active-assistant-provider-proposal/v1';
const CONVERSATION_IDENTITY_SCHEMA_VERSION = 'jarvos-active-assistant-conversation/v1';
const CONVERSATION_MAPPING_SCHEMA_VERSION = 'jarvos-active-assistant-conversation-mapping/v1';
const INTERACTION_RECEIPT_SCHEMA_VERSION = 'jarvos-active-assistant-interaction-receipt/v1';
const LIFECYCLE_RECEIPT_SCHEMA_VERSION = 'jarvos-active-assistant-lifecycle-receipt/v1';
const HARNESS_BRIDGE_SCHEMA_VERSION = 'jarvos-active-assistant-harness-bridge/v1';

const HARNESS_INTERFACE_OPERATIONS = Object.freeze([
  'transport',
  'native_session_mapping',
  'media_reply',
  'event_bridge',
  'receipt_production',
]);
const APPROVAL_SCOPES = Object.freeze(['promotion', 'provider_selection', 'delivery']);
const PROVIDER_OUTCOMES = Object.freeze(['qualified', 'failed']);
const LIFECYCLE_OUTCOMES = Object.freeze(['delivered', 'failed', 'denied']);
const INTERACTION_KINDS = Object.freeze(['user_message', 'assistant_reply', 'media', 'event']);
const EVIDENCE_CLASSIFICATIONS = Object.freeze(['observed', 'inferred']);

const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/i;
const OPAQUE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const FORBIDDEN_FIELD = /(?:authorization|credential|secret|token|password|private(?:key|path)?|signature|executable(?:path)?|hostpath|raw(?:content|output)?|provideroutput|stdout|stderr|argv|environment|api_?key|content|body|url)/i;

const FIELDS = Object.freeze({
  evidence: new Set(['schemaVersion', 'evidenceId', 'subjectId', 'observedAt', 'sourceRef', 'digest', 'classification']),
  candidate: new Set(['schemaVersion', 'candidateId', 'subjectId', 'candidateType', 'evidenceRefs', 'summaryDigest', 'generation']),
  evidenceRef: new Set(['evidenceId', 'digest']),
  approval: new Set(['scope', 'approvalId', 'bindingDigest', 'approved', 'ambiguous']),
  promotion: new Set(['schemaVersion', 'promotionId', 'candidateId', 'candidateGeneration', 'subjectId', 'policyRevision', 'approvalId', 'status']),
  schedule: new Set(['schemaVersion', 'scheduleId', 'candidateId', 'subjectId', 'dueAt', 'expiresAt', 'idempotencyKey']),
  prepared: new Set(['schemaVersion', 'preparedId', 'promotionId', 'scheduleId', 'conversationId', 'subjectId', 'providerEntryId', 'providerGeneration', 'idempotencyKey', 'dueAt', 'expiresAt', 'state']),
  providerEntry: new Set(['schemaVersion', 'entryId', 'provider', 'model', 'reasoningEfforts']),
  providerCatalog: new Set(['schemaVersion', 'entries']),
  providerSelection: new Set(['schemaVersion', 'entryId', 'generation', 'lastOutcome']),
  providerProposal: new Set(['schemaVersion', 'proposalId', 'entryId', 'expectedGeneration']),
  providerOutcome: new Set(['entryId', 'generation', 'resultingGeneration', 'catalogDigest', 'outcome']),
  conversation: new Set(['schemaVersion', 'conversationId', 'subjectId', 'createdAt']),
  mapping: new Set(['schemaVersion', 'mappingId', 'conversationId', 'bridgeId', 'nativeSessionRef', 'mappedAt']),
  interaction: new Set(['schemaVersion', 'receiptId', 'conversationId', 'mappingId', 'kind', 'occurredAt', 'payloadDigest', 'idempotencyKey']),
  lifecycle: new Set(['schemaVersion', 'receiptId', 'preparedId', 'conversationId', 'subjectId', 'mappingId', 'bridgeId', 'idempotencyKey', 'outcome', 'occurredAt', 'producer']),
  bridge: new Set(['schemaVersion', 'bridgeId', 'operations']),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function canonicalDigest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isSafeString(value, { identifier = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return false;
  if (value.includes('..') || value.startsWith('/') || value.startsWith('~') || value.startsWith('\\') || /^file:/i.test(value)) return false;
  return !identifier || SAFE_IDENTIFIER.test(value);
}

function isOpaque(value) {
  return typeof value === 'string' && OPAQUE_REFERENCE.test(value);
}

function isIso(value) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const milliseconds = value.length === 20 ? 0 : Number(value.slice(20, 23));
  return date.getUTCFullYear() === Number(value.slice(0, 4))
    && date.getUTCMonth() + 1 === Number(value.slice(5, 7))
    && date.getUTCDate() === Number(value.slice(8, 10))
    && date.getUTCHours() === Number(value.slice(11, 13))
    && date.getUTCMinutes() === Number(value.slice(14, 16))
    && date.getUTCSeconds() === Number(value.slice(17, 19))
    && date.getUTCMilliseconds() === milliseconds;
}

function isDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function addUnknownFields(value, allowed, path, errors) {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && FORBIDDEN_FIELD.test(key)) errors.push(`${path}.${key} is forbidden`);
    if (!allowed.has(key)) errors.push(`${path} has unknown field: ${key}`);
  }
}

function requireObject(value, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  return true;
}

function requireSafe(value, path, errors, options) {
  if (!isSafeString(value, options)) errors.push(`${path} must be a safe non-empty string`);
}

function requireOpaque(value, path, errors) {
  if (!isOpaque(value)) errors.push(`${path} must be an opaque reference`);
}

function requireDigest(value, path, errors) {
  if (!isDigest(value)) errors.push(`${path} must be a SHA-256 digest`);
}

function requireIso(value, path, errors) {
  if (!isIso(value)) errors.push(`${path} must be an ISO UTC timestamp`);
}

function requireEnum(value, path, values, errors) {
  if (!values.includes(value)) errors.push(`${path} must be one of: ${values.join(', ')}`);
}

function validateApproval(approval) {
  const errors = [];
  if (!requireObject(approval, 'approval', errors)) return { ok: false, errors };
  addUnknownFields(approval, FIELDS.approval, 'approval', errors);
  requireEnum(approval.scope, 'approval.scope', APPROVAL_SCOPES, errors);
  requireOpaque(approval.approvalId, 'approval.approvalId', errors);
  requireDigest(approval.bindingDigest, 'approval.bindingDigest', errors);
  if (typeof approval.approved !== 'boolean') errors.push('approval.approved must be boolean');
  if (typeof approval.ambiguous !== 'boolean') errors.push('approval.ambiguous must be boolean');
  return { ok: errors.length === 0, errors };
}

function validateEvidence(evidence) {
  const errors = [];
  if (!requireObject(evidence, 'evidence', errors)) return { ok: false, errors };
  addUnknownFields(evidence, FIELDS.evidence, 'evidence', errors);
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) errors.push(`evidence.schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  requireSafe(evidence.evidenceId, 'evidence.evidenceId', errors, { identifier: true });
  requireSafe(evidence.subjectId, 'evidence.subjectId', errors, { identifier: true });
  requireIso(evidence.observedAt, 'evidence.observedAt', errors);
  requireOpaque(evidence.sourceRef, 'evidence.sourceRef', errors);
  requireDigest(evidence.digest, 'evidence.digest', errors);
  requireEnum(evidence.classification, 'evidence.classification', EVIDENCE_CLASSIFICATIONS, errors);
  return { ok: errors.length === 0, errors };
}

function validateCandidate(candidate) {
  const errors = [];
  if (!requireObject(candidate, 'candidate', errors)) return { ok: false, errors };
  addUnknownFields(candidate, FIELDS.candidate, 'candidate', errors);
  if (candidate.schemaVersion !== CANDIDATE_SCHEMA_VERSION) errors.push(`candidate.schemaVersion must be ${CANDIDATE_SCHEMA_VERSION}`);
  requireSafe(candidate.candidateId, 'candidate.candidateId', errors, { identifier: true });
  requireSafe(candidate.subjectId, 'candidate.subjectId', errors, { identifier: true });
  requireSafe(candidate.candidateType, 'candidate.candidateType', errors, { identifier: true });
  if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.length === 0) {
    errors.push('candidate.evidenceRefs must be a non-empty array');
  } else {
    if (new Set(candidate.evidenceRefs.map((ref) => ref?.evidenceId)).size !== candidate.evidenceRefs.length) errors.push('candidate.evidenceRefs must not contain duplicate evidenceId values');
    candidate.evidenceRefs.forEach((ref, index) => {
      if (!requireObject(ref, `candidate.evidenceRefs[${index}]`, errors)) return;
      addUnknownFields(ref, FIELDS.evidenceRef, `candidate.evidenceRefs[${index}]`, errors);
      requireSafe(ref.evidenceId, `candidate.evidenceRefs[${index}].evidenceId`, errors, { identifier: true });
      requireDigest(ref.digest, `candidate.evidenceRefs[${index}].digest`, errors);
    });
  }
  requireDigest(candidate.summaryDigest, 'candidate.summaryDigest', errors);
  requireOpaque(candidate.generation, 'candidate.generation', errors);
  return { ok: errors.length === 0, errors };
}

function validatePromotion(promotion) {
  const errors = [];
  if (!requireObject(promotion, 'promotion', errors)) return { ok: false, errors };
  addUnknownFields(promotion, FIELDS.promotion, 'promotion', errors);
  if (promotion.schemaVersion !== PROMOTION_SCHEMA_VERSION) errors.push(`promotion.schemaVersion must be ${PROMOTION_SCHEMA_VERSION}`);
  requireSafe(promotion.promotionId, 'promotion.promotionId', errors, { identifier: true });
  requireSafe(promotion.candidateId, 'promotion.candidateId', errors, { identifier: true });
  requireOpaque(promotion.candidateGeneration, 'promotion.candidateGeneration', errors);
  requireSafe(promotion.subjectId, 'promotion.subjectId', errors, { identifier: true });
  requireSafe(promotion.policyRevision, 'promotion.policyRevision', errors, { identifier: true });
  requireOpaque(promotion.approvalId, 'promotion.approvalId', errors);
  if (promotion.status !== 'promoted') errors.push('promotion.status must be promoted');
  return { ok: errors.length === 0, errors };
}

function validateSchedule(schedule) {
  const errors = [];
  if (!requireObject(schedule, 'schedule', errors)) return { ok: false, errors };
  addUnknownFields(schedule, FIELDS.schedule, 'schedule', errors);
  if (schedule.schemaVersion !== SCHEDULE_SCHEMA_VERSION) errors.push(`schedule.schemaVersion must be ${SCHEDULE_SCHEMA_VERSION}`);
  requireSafe(schedule.scheduleId, 'schedule.scheduleId', errors, { identifier: true });
  requireSafe(schedule.candidateId, 'schedule.candidateId', errors, { identifier: true });
  requireSafe(schedule.subjectId, 'schedule.subjectId', errors, { identifier: true });
  requireIso(schedule.dueAt, 'schedule.dueAt', errors);
  requireIso(schedule.expiresAt, 'schedule.expiresAt', errors);
  requireOpaque(schedule.idempotencyKey, 'schedule.idempotencyKey', errors);
  if (isIso(schedule.dueAt) && isIso(schedule.expiresAt) && Date.parse(schedule.expiresAt) < Date.parse(schedule.dueAt)) {
    errors.push('schedule.expiresAt must be at or after schedule.dueAt');
  }
  return { ok: errors.length === 0, errors };
}

function validateProviderEntry(entry) {
  const errors = [];
  if (!requireObject(entry, 'provider entry', errors)) return { ok: false, errors };
  addUnknownFields(entry, FIELDS.providerEntry, 'provider entry', errors);
  if (entry.schemaVersion !== PROVIDER_ENTRY_SCHEMA_VERSION) errors.push(`provider entry.schemaVersion must be ${PROVIDER_ENTRY_SCHEMA_VERSION}`);
  requireSafe(entry.entryId, 'provider entry.entryId', errors, { identifier: true });
  requireSafe(entry.provider, 'provider entry.provider', errors, { identifier: true });
  requireSafe(entry.model, 'provider entry.model', errors);
  if (!Array.isArray(entry.reasoningEfforts) || entry.reasoningEfforts.length === 0) errors.push('provider entry.reasoningEfforts must be a non-empty array');
  else {
    if (new Set(entry.reasoningEfforts).size !== entry.reasoningEfforts.length) errors.push('provider entry.reasoningEfforts must not contain duplicates');
    entry.reasoningEfforts.forEach((value, index) => requireEnum(value, `provider entry.reasoningEfforts[${index}]`, ['low', 'medium', 'high', 'max'], errors));
  }
  return { ok: errors.length === 0, errors };
}

function validateProviderCatalog(catalog) {
  const errors = [];
  if (!requireObject(catalog, 'provider catalog', errors)) return { ok: false, errors };
  addUnknownFields(catalog, FIELDS.providerCatalog, 'provider catalog', errors);
  if (catalog.schemaVersion !== PROVIDER_CATALOG_SCHEMA_VERSION) errors.push(`provider catalog.schemaVersion must be ${PROVIDER_CATALOG_SCHEMA_VERSION}`);
  if (!Array.isArray(catalog.entries)) errors.push('provider catalog.entries must be an array');
  else {
    catalog.entries.forEach((entry, index) => errors.push(...validateProviderEntry(entry).errors.map((error) => `provider catalog.entries[${index}]: ${error}`)));
    if (new Set(catalog.entries.map((entry) => entry?.entryId)).size !== catalog.entries.length) errors.push('provider catalog.entries must have unique entryId values');
  }
  return { ok: errors.length === 0, errors };
}

function validateProviderSelection(selection) {
  const errors = [];
  if (!requireObject(selection, 'provider selection', errors)) return { ok: false, errors };
  addUnknownFields(selection, FIELDS.providerSelection, 'provider selection', errors);
  if (selection.schemaVersion !== PROVIDER_SELECTION_SCHEMA_VERSION) errors.push(`provider selection.schemaVersion must be ${PROVIDER_SELECTION_SCHEMA_VERSION}`);
  if (selection.entryId !== null) requireSafe(selection.entryId, 'provider selection.entryId', errors, { identifier: true });
  requireOpaque(selection.generation, 'provider selection.generation', errors);
  if (selection.lastOutcome !== null) {
    if (!requireObject(selection.lastOutcome, 'provider selection.lastOutcome', errors)) return { ok: false, errors };
    addUnknownFields(selection.lastOutcome, FIELDS.providerOutcome, 'provider selection.lastOutcome', errors);
    requireSafe(selection.lastOutcome.entryId, 'provider selection.lastOutcome.entryId', errors, { identifier: true });
    requireOpaque(selection.lastOutcome.generation, 'provider selection.lastOutcome.generation', errors);
    requireOpaque(selection.lastOutcome.resultingGeneration, 'provider selection.lastOutcome.resultingGeneration', errors);
    requireDigest(selection.lastOutcome.catalogDigest, 'provider selection.lastOutcome.catalogDigest', errors);
    requireEnum(selection.lastOutcome.outcome, 'provider selection.lastOutcome.outcome', PROVIDER_OUTCOMES, errors);
  }
  return { ok: errors.length === 0, errors };
}

function validateProviderProposal(proposal) {
  const errors = [];
  if (!requireObject(proposal, 'provider proposal', errors)) return { ok: false, errors };
  addUnknownFields(proposal, FIELDS.providerProposal, 'provider proposal', errors);
  if (proposal.schemaVersion !== PROVIDER_PROPOSAL_SCHEMA_VERSION) errors.push(`provider proposal.schemaVersion must be ${PROVIDER_PROPOSAL_SCHEMA_VERSION}`);
  requireOpaque(proposal.proposalId, 'provider proposal.proposalId', errors);
  requireSafe(proposal.entryId, 'provider proposal.entryId', errors, { identifier: true });
  requireOpaque(proposal.expectedGeneration, 'provider proposal.expectedGeneration', errors);
  return { ok: errors.length === 0, errors };
}

function validateConversationIdentity(identity) {
  const errors = [];
  if (!requireObject(identity, 'conversation identity', errors)) return { ok: false, errors };
  addUnknownFields(identity, FIELDS.conversation, 'conversation identity', errors);
  if (identity.schemaVersion !== CONVERSATION_IDENTITY_SCHEMA_VERSION) errors.push(`conversation identity.schemaVersion must be ${CONVERSATION_IDENTITY_SCHEMA_VERSION}`);
  requireSafe(identity.conversationId, 'conversation identity.conversationId', errors, { identifier: true });
  requireSafe(identity.subjectId, 'conversation identity.subjectId', errors, { identifier: true });
  requireIso(identity.createdAt, 'conversation identity.createdAt', errors);
  return { ok: errors.length === 0, errors };
}

function validateConversationMapping(mapping) {
  const errors = [];
  if (!requireObject(mapping, 'conversation mapping', errors)) return { ok: false, errors };
  addUnknownFields(mapping, FIELDS.mapping, 'conversation mapping', errors);
  if (mapping.schemaVersion !== CONVERSATION_MAPPING_SCHEMA_VERSION) errors.push(`conversation mapping.schemaVersion must be ${CONVERSATION_MAPPING_SCHEMA_VERSION}`);
  requireSafe(mapping.mappingId, 'conversation mapping.mappingId', errors, { identifier: true });
  requireSafe(mapping.conversationId, 'conversation mapping.conversationId', errors, { identifier: true });
  requireSafe(mapping.bridgeId, 'conversation mapping.bridgeId', errors, { identifier: true });
  requireOpaque(mapping.nativeSessionRef, 'conversation mapping.nativeSessionRef', errors);
  requireIso(mapping.mappedAt, 'conversation mapping.mappedAt', errors);
  return { ok: errors.length === 0, errors };
}

function validateInteractionReceipt(receipt) {
  const errors = [];
  if (!requireObject(receipt, 'interaction receipt', errors)) return { ok: false, errors };
  addUnknownFields(receipt, FIELDS.interaction, 'interaction receipt', errors);
  if (receipt.schemaVersion !== INTERACTION_RECEIPT_SCHEMA_VERSION) errors.push(`interaction receipt.schemaVersion must be ${INTERACTION_RECEIPT_SCHEMA_VERSION}`);
  requireSafe(receipt.receiptId, 'interaction receipt.receiptId', errors, { identifier: true });
  requireSafe(receipt.conversationId, 'interaction receipt.conversationId', errors, { identifier: true });
  requireSafe(receipt.mappingId, 'interaction receipt.mappingId', errors, { identifier: true });
  requireEnum(receipt.kind, 'interaction receipt.kind', INTERACTION_KINDS, errors);
  requireIso(receipt.occurredAt, 'interaction receipt.occurredAt', errors);
  requireDigest(receipt.payloadDigest, 'interaction receipt.payloadDigest', errors);
  requireOpaque(receipt.idempotencyKey, 'interaction receipt.idempotencyKey', errors);
  return { ok: errors.length === 0, errors };
}

function validateLifecycleReceipt(receipt) {
  const errors = [];
  if (!requireObject(receipt, 'lifecycle receipt', errors)) return { ok: false, errors };
  addUnknownFields(receipt, FIELDS.lifecycle, 'lifecycle receipt', errors);
  if (receipt.schemaVersion !== LIFECYCLE_RECEIPT_SCHEMA_VERSION) errors.push(`lifecycle receipt.schemaVersion must be ${LIFECYCLE_RECEIPT_SCHEMA_VERSION}`);
  requireSafe(receipt.receiptId, 'lifecycle receipt.receiptId', errors, { identifier: true });
  requireSafe(receipt.preparedId, 'lifecycle receipt.preparedId', errors, { identifier: true });
  requireSafe(receipt.conversationId, 'lifecycle receipt.conversationId', errors, { identifier: true });
  requireSafe(receipt.subjectId, 'lifecycle receipt.subjectId', errors, { identifier: true });
  requireSafe(receipt.mappingId, 'lifecycle receipt.mappingId', errors, { identifier: true });
  requireSafe(receipt.bridgeId, 'lifecycle receipt.bridgeId', errors, { identifier: true });
  requireOpaque(receipt.idempotencyKey, 'lifecycle receipt.idempotencyKey', errors);
  requireEnum(receipt.outcome, 'lifecycle receipt.outcome', LIFECYCLE_OUTCOMES, errors);
  requireIso(receipt.occurredAt, 'lifecycle receipt.occurredAt', errors);
  if (receipt.producer !== 'harness_bridge') errors.push('lifecycle receipt.producer must be harness_bridge');
  return { ok: errors.length === 0, errors };
}

function validateHarnessBridge(bridge) {
  const errors = [];
  if (!requireObject(bridge, 'harness bridge', errors)) return { ok: false, errors };
  addUnknownFields(bridge, FIELDS.bridge, 'harness bridge', errors);
  if (bridge.schemaVersion !== HARNESS_BRIDGE_SCHEMA_VERSION) errors.push(`harness bridge.schemaVersion must be ${HARNESS_BRIDGE_SCHEMA_VERSION}`);
  requireSafe(bridge.bridgeId, 'harness bridge.bridgeId', errors, { identifier: true });
  if (!Array.isArray(bridge.operations) || bridge.operations.length === 0) errors.push('harness bridge.operations must be a non-empty array');
  else {
    if (new Set(bridge.operations).size !== bridge.operations.length) errors.push('harness bridge.operations must not contain duplicates');
    bridge.operations.forEach((operation, index) => requireEnum(operation, `harness bridge.operations[${index}]`, HARNESS_INTERFACE_OPERATIONS, errors));
  }
  return { ok: errors.length === 0, errors };
}

function validatePreparedDelivery(prepared) {
  const errors = [];
  if (!requireObject(prepared, 'prepared delivery', errors)) return { ok: false, errors };
  addUnknownFields(prepared, FIELDS.prepared, 'prepared delivery', errors);
  if (prepared.schemaVersion !== PREPARED_DELIVERY_SCHEMA_VERSION) errors.push(`prepared delivery.schemaVersion must be ${PREPARED_DELIVERY_SCHEMA_VERSION}`);
  for (const field of ['preparedId', 'promotionId', 'scheduleId', 'conversationId', 'subjectId', 'providerEntryId']) requireSafe(prepared[field], `prepared delivery.${field}`, errors, { identifier: true });
  requireOpaque(prepared.providerGeneration, 'prepared delivery.providerGeneration', errors);
  requireOpaque(prepared.idempotencyKey, 'prepared delivery.idempotencyKey', errors);
  requireIso(prepared.dueAt, 'prepared delivery.dueAt', errors);
  requireIso(prepared.expiresAt, 'prepared delivery.expiresAt', errors);
  if (isIso(prepared.dueAt) && isIso(prepared.expiresAt) && Date.parse(prepared.expiresAt) < Date.parse(prepared.dueAt)) {
    errors.push('prepared delivery.expiresAt must be at or after prepared delivery.dueAt');
  }
  if (prepared.state !== 'prepared') errors.push('prepared delivery.state must be prepared');
  return { ok: errors.length === 0, errors };
}

function contractError(code, details = []) {
  return { ok: false, code, details };
}

function createApprovalBinding(value) {
  return canonicalDigest(value);
}

function promotionApprovalBinding({ candidate, policyRevision } = {}) {
  return createApprovalBinding({
    scope: 'promotion',
    candidateDigest: canonicalDigest(candidate),
    policyRevision,
  });
}

function providerSelectionApprovalBinding({ catalog, proposal } = {}) {
  return createApprovalBinding({
    scope: 'provider_selection',
    catalogDigest: canonicalDigest(catalog),
    proposalId: proposal?.proposalId,
    entryId: proposal?.entryId,
    expectedGeneration: proposal?.expectedGeneration,
  });
}

function deliveryApprovalBinding({ promotion, schedule, conversation, selection } = {}) {
  return createApprovalBinding({
    scope: 'delivery',
    promotionDigest: canonicalDigest(promotion),
    scheduleDigest: canonicalDigest(schedule),
    conversationDigest: canonicalDigest(conversation),
    selectionDigest: canonicalDigest(selection),
  });
}

function actionAllowed(approval, scope, bindingDigest) {
  const validation = validateApproval(approval);
  if (!validation.ok) return contractError('approval_invalid', validation.errors);
  if (approval.scope !== scope) return contractError('approval_scope_mismatch');
  if (approval.ambiguous) return contractError('ambiguous_request');
  if (!approval.approved) return contractError('approval_required');
  if (approval.bindingDigest !== bindingDigest) return contractError('approval_binding_mismatch');
  return { ok: true };
}

function createCandidate({ candidateId, subjectId, candidateType, evidence = [], summaryDigest, generation } = {}) {
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error('candidate requires at least one evidence record');
  const knownEvidence = new Map();
  evidence.forEach((record) => {
    const validation = validateEvidence(record);
    if (!validation.ok) throw new Error(`invalid evidence: ${validation.errors.join('; ')}`);
    if (record.subjectId !== subjectId) throw new Error('evidence subject does not match candidate subject');
    const existing = knownEvidence.get(record.evidenceId);
    if (existing !== undefined && existing !== record.digest) throw new Error('conflicting evidence records share an evidenceId');
    knownEvidence.set(record.evidenceId, record.digest);
  });
  const candidate = {
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    candidateId,
    subjectId,
    candidateType,
    evidenceRefs: evidence.map((record) => ({ evidenceId: record.evidenceId, digest: record.digest })),
    summaryDigest,
    generation: generation || canonicalDigest({ candidateId, subjectId, candidateType, evidence: evidence.map((record) => record.digest), summaryDigest }),
  };
  const validation = validateCandidate(candidate);
  if (!validation.ok) throw new Error(`invalid candidate: ${validation.errors.join('; ')}`);
  return candidate;
}

function promoteCandidate({ candidate, evidence = [], expectedGeneration, approval, policyRevision } = {}) {
  const candidateValidation = validateCandidate(candidate);
  if (!candidateValidation.ok) return contractError('candidate_invalid', candidateValidation.errors);
  if (candidate.generation !== expectedGeneration) return contractError('stale_generation');
  if (!isSafeString(policyRevision, { identifier: true })) return contractError('policy_revision_invalid');
  const gate = actionAllowed(approval, 'promotion', promotionApprovalBinding({ candidate, policyRevision }));
  if (!gate.ok) return gate;
  if (!Array.isArray(evidence)) return contractError('evidence_invalid', ['evidence must be an array']);
  const knownEvidence = new Map();
  for (const record of evidence) {
    const validation = validateEvidence(record);
    if (!validation.ok) return contractError('evidence_invalid', validation.errors);
    if (record.subjectId !== candidate.subjectId) return contractError('evidence_subject_mismatch');
    const existing = knownEvidence.get(record.evidenceId);
    if (existing !== undefined && existing !== record.digest) return contractError('evidence_conflict');
    knownEvidence.set(record.evidenceId, record.digest);
  }
  if (candidate.evidenceRefs.some((reference) => knownEvidence.get(reference.evidenceId) !== reference.digest)) return contractError('evidence_incomplete');
  const promotion = {
    schemaVersion: PROMOTION_SCHEMA_VERSION,
    promotionId: `promotion-${canonicalDigest({ candidateId: candidate.candidateId, generation: candidate.generation, approvalId: approval.approvalId, policyRevision }).slice(0, 32)}`,
    candidateId: candidate.candidateId,
    candidateGeneration: candidate.generation,
    subjectId: candidate.subjectId,
    policyRevision,
    approvalId: approval.approvalId,
    status: 'promoted',
  };
  return { ok: true, promotion };
}

function createProviderCatalog({ entries = [] } = {}) {
  const catalog = { schemaVersion: PROVIDER_CATALOG_SCHEMA_VERSION, entries: [...entries] };
  const validation = validateProviderCatalog(catalog);
  if (!validation.ok) throw new Error(`invalid provider catalog: ${validation.errors.join('; ')}`);
  return catalog;
}

function createInitialProviderSelection({ generation = 'initial-generation' } = {}) {
  const selection = { schemaVersion: PROVIDER_SELECTION_SCHEMA_VERSION, entryId: null, generation, lastOutcome: null };
  const validation = validateProviderSelection(selection);
  if (!validation.ok) throw new Error(`invalid provider selection: ${validation.errors.join('; ')}`);
  return selection;
}

function createProviderProposal({ catalog, entryId, expectedGeneration } = {}) {
  const catalogValidation = validateProviderCatalog(catalog);
  if (!catalogValidation.ok) throw new Error(`invalid provider catalog: ${catalogValidation.errors.join('; ')}`);
  if (!catalog.entries.some((entry) => entry.entryId === entryId)) throw new Error('provider entry is not registered');
  const proposal = {
    schemaVersion: PROVIDER_PROPOSAL_SCHEMA_VERSION,
    proposalId: `proposal-${canonicalDigest({ entryId, expectedGeneration }).slice(0, 32)}`,
    entryId,
    expectedGeneration,
  };
  const validation = validateProviderProposal(proposal);
  if (!validation.ok) throw new Error(`invalid provider proposal: ${validation.errors.join('; ')}`);
  return proposal;
}

function settleProviderSelection({ catalog, selection, proposal, outcome, approval } = {}) {
  const catalogValidation = validateProviderCatalog(catalog);
  if (!catalogValidation.ok) return contractError('provider_catalog_invalid', catalogValidation.errors);
  const selectionValidation = validateProviderSelection(selection);
  if (!selectionValidation.ok) return contractError('provider_selection_invalid', selectionValidation.errors);
  const proposalValidation = validateProviderProposal(proposal);
  if (!proposalValidation.ok) return contractError('provider_proposal_invalid', proposalValidation.errors);
  if (!PROVIDER_OUTCOMES.includes(outcome)) return contractError('provider_outcome_invalid');
  if (!catalog.entries.some((entry) => entry.entryId === proposal.entryId)) return contractError('provider_entry_unregistered');
  if (proposal.expectedGeneration !== selection.generation) return contractError('stale_generation');
  if (outcome === 'failed') {
    return {
      ok: true,
      selection: {
        ...selection,
        lastOutcome: {
          entryId: proposal.entryId,
          generation: selection.generation,
          resultingGeneration: selection.generation,
          catalogDigest: canonicalDigest(catalog),
          outcome: 'failed',
        },
      },
    };
  }
  const gate = actionAllowed(approval, 'provider_selection', providerSelectionApprovalBinding({ catalog, proposal }));
  if (!gate.ok) return gate;
  const nextGeneration = canonicalDigest({ generation: selection.generation, entryId: proposal.entryId, proposalId: proposal.proposalId, outcome });
  return {
    ok: true,
    selection: {
      schemaVersion: PROVIDER_SELECTION_SCHEMA_VERSION,
      entryId: proposal.entryId,
      generation: nextGeneration,
      lastOutcome: {
        entryId: proposal.entryId,
        generation: selection.generation,
        resultingGeneration: nextGeneration,
        catalogDigest: canonicalDigest(catalog),
        outcome: 'qualified',
      },
    },
  };
}

function prepareDelivery({ promotion, schedule, conversation, catalog, selection, approval, now } = {}) {
  const promotionValidation = validatePromotion(promotion);
  if (!promotionValidation.ok) return contractError('promotion_invalid', promotionValidation.errors);
  const scheduleValidation = validateSchedule(schedule);
  if (!scheduleValidation.ok) return contractError('schedule_invalid', scheduleValidation.errors);
  const conversationValidation = validateConversationIdentity(conversation);
  if (!conversationValidation.ok) return contractError('conversation_invalid', conversationValidation.errors);
  const catalogValidation = validateProviderCatalog(catalog);
  if (!catalogValidation.ok) return contractError('provider_catalog_invalid', catalogValidation.errors);
  const selectionValidation = validateProviderSelection(selection);
  if (!selectionValidation.ok) return contractError('provider_selection_invalid', selectionValidation.errors);
  if (!isIso(now)) return contractError('time_invalid');
  if (promotion.candidateId !== schedule.candidateId) return contractError('candidate_mismatch');
  if (promotion.subjectId !== schedule.subjectId || promotion.subjectId !== conversation.subjectId) return contractError('subject_mismatch');
  if (Date.parse(now) > Date.parse(schedule.expiresAt)) return contractError('schedule_expired');
  if (selection.entryId === null) return contractError('provider_unselected');
  if (!catalog.entries.some((entry) => entry.entryId === selection.entryId)) return contractError('provider_entry_unregistered');
  if (selection.lastOutcome?.outcome !== 'qualified'
    || selection.lastOutcome.entryId !== selection.entryId
    || selection.lastOutcome.resultingGeneration !== selection.generation
    || selection.lastOutcome.catalogDigest !== canonicalDigest(catalog)) return contractError('provider_not_qualified');
  const gate = actionAllowed(approval, 'delivery', deliveryApprovalBinding({ promotion, schedule, conversation, selection }));
  if (!gate.ok) return gate;
  const prepared = {
    schemaVersion: PREPARED_DELIVERY_SCHEMA_VERSION,
    preparedId: `prepared-${canonicalDigest({ promotionId: promotion.promotionId, scheduleId: schedule.scheduleId, conversationId: conversation.conversationId, subjectId: promotion.subjectId, entryId: selection.entryId, generation: selection.generation, idempotencyKey: schedule.idempotencyKey }).slice(0, 32)}`,
    promotionId: promotion.promotionId,
    scheduleId: schedule.scheduleId,
    conversationId: conversation.conversationId,
    subjectId: promotion.subjectId,
    providerEntryId: selection.entryId,
    providerGeneration: selection.generation,
    idempotencyKey: schedule.idempotencyKey,
    dueAt: schedule.dueAt,
    expiresAt: schedule.expiresAt,
    state: 'prepared',
  };
  return { ok: true, prepared };
}

function evaluateDelivery({ prepared, receipt, priorReceipts = [], bridge, mapping, now } = {}) {
  const preparedValidation = validatePreparedDelivery(prepared);
  if (!preparedValidation.ok) return contractError('prepared_delivery_invalid', preparedValidation.errors);
  if (!isIso(now)) return contractError('time_invalid');
  if (!Array.isArray(priorReceipts)) return contractError('prior_receipts_invalid');
  const bridgeValidation = validateHarnessBridge(bridge);
  if (!bridgeValidation.ok) return contractError('harness_bridge_invalid', bridgeValidation.errors);
  if (!bridge.operations.includes('receipt_production')) return contractError('harness_bridge_receipt_unsupported');
  const mappingValidation = validateConversationMapping(mapping);
  if (!mappingValidation.ok) return contractError('conversation_mapping_invalid', mappingValidation.errors);
  if (mapping.conversationId !== prepared.conversationId || mapping.bridgeId !== bridge.bridgeId) return contractError('conversation_mapping_mismatch');
  const duplicates = priorReceipts.filter((item) => item && item.idempotencyKey === prepared.idempotencyKey);
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) {
      const duplicateValidation = validateLifecycleReceipt(duplicate);
      if (!duplicateValidation.ok
        || duplicate.preparedId !== prepared.preparedId
        || duplicate.conversationId !== prepared.conversationId
        || duplicate.subjectId !== prepared.subjectId
        || duplicate.mappingId !== mapping.mappingId
        || duplicate.bridgeId !== bridge.bridgeId
        || Date.parse(duplicate.occurredAt) < Date.parse(prepared.dueAt)
        || Date.parse(duplicate.occurredAt) > Date.parse(prepared.expiresAt)
        || Date.parse(duplicate.occurredAt) > Date.parse(now)) {
        return contractError('idempotency_record_invalid');
      }
    }
    if (new Set(duplicates.map(canonicalDigest)).size !== 1) return contractError('idempotency_conflict');
    return { ok: true, code: 'idempotent_replay', receipt: duplicates[0] };
  }
  const receiptValidation = validateLifecycleReceipt(receipt);
  if (!receiptValidation.ok) return contractError('lifecycle_receipt_invalid', receiptValidation.errors);
  if (Date.parse(receipt.occurredAt) > Date.parse(now)) return contractError('receipt_future');
  if (Date.parse(now) < Date.parse(prepared.dueAt)) return contractError('not_due');
  if (Date.parse(now) > Date.parse(prepared.expiresAt)) return contractError('schedule_expired');
  if (receipt.preparedId !== prepared.preparedId
    || receipt.conversationId !== prepared.conversationId
    || receipt.subjectId !== prepared.subjectId
    || receipt.mappingId !== mapping.mappingId
    || receipt.bridgeId !== bridge.bridgeId
    || receipt.idempotencyKey !== prepared.idempotencyKey) {
    return contractError('receipt_binding_mismatch');
  }
  if (Date.parse(receipt.occurredAt) < Date.parse(prepared.dueAt) || Date.parse(receipt.occurredAt) > Date.parse(prepared.expiresAt)) {
    return contractError('receipt_outside_schedule');
  }
  return { ok: true, code: receipt.outcome, receipt };
}

module.exports = {
  ACTIVE_ASSISTANT_CONTRACT_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  CANDIDATE_SCHEMA_VERSION,
  PROMOTION_SCHEMA_VERSION,
  SCHEDULE_SCHEMA_VERSION,
  PREPARED_DELIVERY_SCHEMA_VERSION,
  PROVIDER_ENTRY_SCHEMA_VERSION,
  PROVIDER_CATALOG_SCHEMA_VERSION,
  PROVIDER_SELECTION_SCHEMA_VERSION,
  PROVIDER_PROPOSAL_SCHEMA_VERSION,
  CONVERSATION_IDENTITY_SCHEMA_VERSION,
  CONVERSATION_MAPPING_SCHEMA_VERSION,
  INTERACTION_RECEIPT_SCHEMA_VERSION,
  LIFECYCLE_RECEIPT_SCHEMA_VERSION,
  HARNESS_BRIDGE_SCHEMA_VERSION,
  HARNESS_INTERFACE_OPERATIONS,
  canonicalDigest,
  createApprovalBinding,
  promotionApprovalBinding,
  providerSelectionApprovalBinding,
  deliveryApprovalBinding,
  validateApproval,
  validateEvidence,
  validateCandidate,
  validatePromotion,
  validateSchedule,
  validateProviderEntry,
  validateProviderCatalog,
  validateProviderSelection,
  validateProviderProposal,
  validateConversationIdentity,
  validateConversationMapping,
  validateInteractionReceipt,
  validateLifecycleReceipt,
  validateHarnessBridge,
  validatePreparedDelivery,
  createCandidate,
  promoteCandidate,
  createProviderCatalog,
  createInitialProviderSelection,
  createProviderProposal,
  settleProviderSelection,
  prepareDelivery,
  evaluateDelivery,
};
