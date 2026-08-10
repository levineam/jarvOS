'use strict';

const crypto = require('node:crypto');

const PROVIDER_SNAPSHOT_CONTRACT = 'jarvos.provider-snapshot/v1';
const VERIFIED_ACTIVITY_CONTRACT = 'jarvos.verified-activity/v1';
const AGENT_OBSERVATION_CONTRACT = 'jarvos.project-observation/v1';
const CANONICAL_REFERENCE_CONTRACT = 'jarvos.canonical-reference/v1';
const EXECUTION_REFERENCE_CONTRACT = 'jarvos.execution-reference/v1';
const HANDOFF_CONTRACT = 'jarvos.explicit-handoff/v1';
const PROMOTION_OPERATION_CONTRACT = 'jarvos.todo-beads-promotion/v1';
const RELEASE_EVIDENCE_CONTRACT = 'jarvos.release-evidence/v1';
const UNKNOWN_LINK_PROPOSAL_CONTRACT = 'jarvos.project-link-proposal/v1';
const PROVIDER_STATES = Object.freeze(['fresh', 'stale', 'partial', 'unknown', 'unavailable', 'healthy-empty']);
const TRUST_LEVELS = Object.freeze(['verified', 'unverified']);
const SUMMARY_CATEGORIES = Object.freeze(['activity', 'intent', 'execution', 'attention', 'work']);
const EXECUTION_AUTHORITIES = Object.freeze(['beads', 'paperclip']);
const HANDOFF_STATES = Object.freeze(['requested', 'external-created', 'external-owned', 'local-owned', 'indeterminate', 'reconciled']);
const PROMOTION_STATES = Object.freeze(['pending', 'creating', 'indeterminate', 'committed', 'not-committed', 'conflict']);
const PROMOTION_OUTCOMES = Object.freeze(['indeterminate', 'committed', 'not-committed']);
const SNAPSHOT_FIELDS = Object.freeze([
  'contract', 'provider', 'state', 'trust', 'capturedAt', 'watermark', 'scope', 'summaries', 'omissions', 'errorCode', 'admission',
]);
const SNAPSHOT_INPUT_FIELDS = Object.freeze(SNAPSHOT_FIELDS.filter((field) => field !== 'admission'));
const SUMMARY_FIELDS = Object.freeze(['id', 'canonicalId', 'category', 'status', 'title', 'occurredAt', 'observedAt', 'evidenceRefs']);
const ACTIVITY_FIELDS = Object.freeze([
  'contract', 'eventId', 'canonicalId', 'producerId', 'kind', 'occurredAt', 'observedAt', 'evidenceRefs', 'sourceRevision', 'sensitivity', 'dedupeKey',
]);
const ADMITTED_ACTIVITY_FIELDS = Object.freeze([...ACTIVITY_FIELDS, 'trust', 'admission']);
const ADMISSION_FIELDS = Object.freeze(['producerId', 'digest', 'signature']);
const OBSERVATION_FIELDS = Object.freeze([
  'contract', 'observationId', 'canonicalId', 'caller', 'sessionId', 'sourcePacket', 'summary', 'evidenceRefs', 'receivedAt', 'trust',
]);
const OBSERVATION_INPUT_FIELDS = Object.freeze(OBSERVATION_FIELDS.filter((field) => field !== 'trust'));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, field) {
  if (value !== null && value !== undefined && (typeof value !== 'string' || !value.trim())) throw new TypeError(`${field} must be a string or null`);
  return value === undefined ? null : value;
}

function timestamp(value, field) {
  requiredString(value, field);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function optionalTimestamp(value, field) {
  if (value === null) return null;
  return timestamp(value, field);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sign(value, secret) {
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) throw new TypeError('admission secret is required');
  return crypto.createHmac('sha256', secret).update(stableStringify(value)).digest('base64url');
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateId(value, field) {
  requiredString(value, field);
  if (!/^(?:prj|out)_[0-9]{6,}$/.test(value)) throw new TypeError(`${field} must be a canonical project or outcome ID`);
  return value;
}

function validateScope(scope) {
  if (!exactKeys(scope, ['projectIds', 'outcomeIds'])) throw new TypeError('provider scope has unsupported fields');
  for (const [field, prefix] of [['projectIds', 'prj_'], ['outcomeIds', 'out_']]) {
    if (!Array.isArray(scope[field]) || scope[field].some((id) => typeof id !== 'string' || !id.startsWith(prefix) || !/^\w+_[0-9]{6,}$/.test(id))) {
      throw new TypeError(`${field} must contain canonical IDs`);
    }
    if (new Set(scope[field]).size !== scope[field].length) throw new TypeError(`${field} must not contain duplicate IDs`);
  }
  return { projectIds: [...scope.projectIds].sort(), outcomeIds: [...scope.outcomeIds].sort() };
}

function validateSummary(summary) {
  if (!exactKeys(summary, SUMMARY_FIELDS)) throw new TypeError('provider summary has unsupported fields');
  const normalized = {
    id: requiredString(summary.id, 'summary.id'),
    canonicalId: validateId(summary.canonicalId, 'summary.canonicalId'),
    category: requiredString(summary.category, 'summary.category'),
    status: requiredString(summary.status, 'summary.status'),
    title: optionalString(summary.title, 'summary.title'),
    occurredAt: optionalTimestamp(summary.occurredAt, 'summary.occurredAt'),
    observedAt: timestamp(summary.observedAt, 'summary.observedAt'),
    evidenceRefs: Array.isArray(summary.evidenceRefs) ? summary.evidenceRefs.map((ref) => requiredString(ref, 'summary.evidenceRefs[]')) : (() => { throw new TypeError('summary.evidenceRefs must be an array'); })(),
  };
  if (!SUMMARY_CATEGORIES.includes(normalized.category)) throw new TypeError(`unsupported summary category: ${normalized.category}`);
  return normalized;
}

function validateAdmission(admission) {
  if (!exactKeys(admission, ADMISSION_FIELDS)) throw new TypeError('provider admission has unsupported fields');
  return {
    producerId: requiredString(admission.producerId, 'admission.producerId'),
    digest: /^[a-f0-9]{64}$/.test(admission.digest) ? admission.digest : (() => { throw new TypeError('admission.digest must be a sha256 digest'); })(),
    signature: requiredString(admission.signature, 'admission.signature'),
  };
}

function validateProviderSnapshot(snapshot) {
  if (!exactKeys(snapshot, SNAPSHOT_FIELDS)) throw new TypeError('provider snapshot has unsupported fields');
  if (snapshot.contract !== PROVIDER_SNAPSHOT_CONTRACT) throw new TypeError('provider snapshot has an unsupported contract');
  const provider = requiredString(snapshot.provider, 'provider');
  if (!PROVIDER_STATES.includes(snapshot.state)) throw new TypeError(`unsupported provider state: ${snapshot.state}`);
  if (!TRUST_LEVELS.includes(snapshot.trust)) throw new TypeError(`unsupported provider trust: ${snapshot.trust}`);
  const capturedAt = optionalTimestamp(snapshot.capturedAt, 'capturedAt');
  if (snapshot.state !== 'unavailable' && snapshot.state !== 'unknown' && !capturedAt) throw new TypeError('capturedAt is required for an available provider');
  const watermark = optionalString(snapshot.watermark, 'watermark');
  const scope = validateScope(snapshot.scope);
  if (!Array.isArray(snapshot.summaries) || snapshot.summaries.length > 100) throw new TypeError('summaries must be a bounded array');
  const summaries = snapshot.summaries.map(validateSummary);
  if (!Array.isArray(snapshot.omissions) || snapshot.omissions.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new TypeError('omissions must be strings');
  const errorCode = optionalString(snapshot.errorCode, 'errorCode');
  const admission = snapshot.admission === null ? null : validateAdmission(snapshot.admission);
  if (snapshot.trust === 'verified' && !admission) throw new TypeError('verified provider snapshots require host admission');
  if (snapshot.trust === 'unverified' && admission) throw new TypeError('unverified provider snapshots cannot carry admission');
  return {
    contract: PROVIDER_SNAPSHOT_CONTRACT, provider, state: snapshot.state, trust: snapshot.trust, capturedAt,
    watermark, scope, summaries, omissions: [...snapshot.omissions], errorCode, admission,
  };
}

function validateActivityReceipt(receipt) {
  if (!exactKeys(receipt, ACTIVITY_FIELDS)) throw new TypeError('activity receipt has unsupported fields');
  if (receipt.contract !== VERIFIED_ACTIVITY_CONTRACT) throw new TypeError('activity receipt has an unsupported contract');
  const normalized = {
    contract: VERIFIED_ACTIVITY_CONTRACT,
    eventId: requiredString(receipt.eventId, 'eventId'),
    canonicalId: validateId(receipt.canonicalId, 'canonicalId'),
    producerId: requiredString(receipt.producerId, 'producerId'),
    kind: requiredString(receipt.kind, 'kind'),
    occurredAt: timestamp(receipt.occurredAt, 'occurredAt'),
    observedAt: timestamp(receipt.observedAt, 'observedAt'),
    evidenceRefs: Array.isArray(receipt.evidenceRefs) ? receipt.evidenceRefs.map((ref) => requiredString(ref, 'evidenceRefs[]')) : (() => { throw new TypeError('evidenceRefs must be an array'); })(),
    sourceRevision: requiredString(receipt.sourceRevision, 'sourceRevision'),
    sensitivity: requiredString(receipt.sensitivity, 'sensitivity'),
    dedupeKey: requiredString(receipt.dedupeKey, 'dedupeKey'),
  };
  return normalized;
}

function validateVerifiedReceipt(receipt) {
  if (!exactKeys(receipt, ADMITTED_ACTIVITY_FIELDS)) throw new TypeError('verified receipt has unsupported fields');
  const base = validateActivityReceipt(Object.fromEntries(ACTIVITY_FIELDS.map((field) => [field, receipt[field]])));
  if (receipt.trust !== 'verified') throw new TypeError('verified receipt must be trusted');
  return { ...base, trust: 'verified', admission: validateAdmission(receipt.admission) };
}

function validateAgentObservation(observation) {
  if (!exactKeys(observation, OBSERVATION_FIELDS)) throw new TypeError('agent observation has unsupported fields');
  if (observation.contract !== AGENT_OBSERVATION_CONTRACT) throw new TypeError('agent observation has an unsupported contract');
  if (observation.trust !== 'unverified') throw new TypeError('agent observations are always unverified');
  return {
    contract: AGENT_OBSERVATION_CONTRACT,
    observationId: requiredString(observation.observationId, 'observationId'),
    canonicalId: validateId(observation.canonicalId, 'canonicalId'),
    caller: requiredString(observation.caller, 'caller'),
    sessionId: requiredString(observation.sessionId, 'sessionId'),
    sourcePacket: requiredString(observation.sourcePacket, 'sourcePacket'),
    summary: requiredString(observation.summary, 'summary'),
    evidenceRefs: Array.isArray(observation.evidenceRefs) ? observation.evidenceRefs.map((ref) => requiredString(ref, 'evidenceRefs[]')) : (() => { throw new TypeError('evidenceRefs must be an array'); })(),
    receivedAt: timestamp(observation.receivedAt, 'receivedAt'),
    trust: 'unverified',
  };
}

function submitAgentObservation(input) {
  if (!isPlainObject(input) || Object.prototype.hasOwnProperty.call(input, 'producerId')) throw new TypeError('agent observations cannot assert a producerId');
  const candidate = { ...input, contract: input.contract || AGENT_OBSERVATION_CONTRACT, trust: 'unverified' };
  return validateAgentObservation(candidate);
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function evidenceRefs(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((ref) => requiredString(ref, `${field}[]`));
}

function validateCanonicalReference(reference) {
  if (!exactKeys(reference, ['contract', 'kind', 'id', 'revision', 'breadcrumb'])) throw new TypeError('canonical reference has unsupported fields');
  if (reference.contract !== CANONICAL_REFERENCE_CONTRACT) throw new TypeError('canonical reference has an unsupported contract');
  if (reference.kind !== 'project' && reference.kind !== 'outcome') throw new TypeError('canonical reference kind is unsupported');
  const id = validateId(reference.id, 'canonical reference id');
  if ((reference.kind === 'project' && !id.startsWith('prj_')) || (reference.kind === 'outcome' && !id.startsWith('out_'))) {
    throw new TypeError('canonical reference kind and id do not agree');
  }
  return {
    ok: true,
    reference: {
      contract: CANONICAL_REFERENCE_CONTRACT,
      kind: reference.kind,
      id,
      revision: positiveInteger(reference.revision, 'canonical reference revision'),
      breadcrumb: requiredString(reference.breadcrumb, 'canonical reference breadcrumb'),
    },
  };
}

function createCanonicalReference(input) {
  return validateCanonicalReference(input).reference;
}

function validateExecutionReference(reference) {
  if (!exactKeys(reference, [
    'contract', 'authority', 'provider', 'workspaceId', 'itemId', 'itemRevision', 'status', 'canonical', 'capturedAt', 'sourceRevision',
  ])) throw new TypeError('execution reference has unsupported fields');
  if (reference.contract !== EXECUTION_REFERENCE_CONTRACT) throw new TypeError('execution reference has an unsupported contract');
  const authority = requiredString(reference.authority, 'execution reference authority');
  const provider = requiredString(reference.provider, 'execution reference provider');
  if (!EXECUTION_AUTHORITIES.includes(authority)) throw new TypeError('execution reference authority is unsupported');
  if (provider !== authority) throw new TypeError('execution reference authority and provider must agree');
  const canonical = validateCanonicalReference(reference.canonical).reference;
  return {
    ok: true,
    reference: {
      contract: EXECUTION_REFERENCE_CONTRACT,
      authority,
      provider,
      workspaceId: requiredString(reference.workspaceId, 'execution reference workspaceId'),
      itemId: requiredString(reference.itemId, 'execution reference itemId'),
      itemRevision: requiredString(reference.itemRevision, 'execution reference itemRevision'),
      status: requiredString(reference.status, 'execution reference status'),
      canonical,
      capturedAt: timestamp(reference.capturedAt, 'execution reference capturedAt'),
      sourceRevision: requiredString(reference.sourceRevision, 'execution reference sourceRevision'),
    },
  };
}

function createExecutionReference(input) {
  return validateExecutionReference(input).reference;
}

function validateExplicitHandoff(handoff) {
  if (!exactKeys(handoff, [
    'contract', 'operationId', 'fromAuthority', 'toAuthority', 'state', 'canonical', 'executionReference', 'externalReference',
    'requestedAt', 'confirmedAt', 'evidenceRefs',
  ])) throw new TypeError('explicit handoff has unsupported fields');
  if (handoff.contract !== HANDOFF_CONTRACT) throw new TypeError('explicit handoff has an unsupported contract');
  const fromAuthority = requiredString(handoff.fromAuthority, 'handoff fromAuthority');
  const toAuthority = requiredString(handoff.toAuthority, 'handoff toAuthority');
  if (!EXECUTION_AUTHORITIES.includes(fromAuthority) || !EXECUTION_AUTHORITIES.includes(toAuthority)) throw new TypeError('handoff authority is unsupported');
  if (fromAuthority === toAuthority) throw new TypeError('handoff authorities must differ');
  const state = requiredString(handoff.state, 'handoff state');
  if (!HANDOFF_STATES.includes(state)) throw new TypeError(`unsupported handoff state: ${state}`);
  const canonical = validateCanonicalReference(handoff.canonical).reference;
  const executionReference = handoff.executionReference === null ? null : validateExecutionReference(handoff.executionReference).reference;
  if (executionReference && (executionReference.canonical.id !== canonical.id || executionReference.canonical.revision !== canonical.revision)) {
    throw new TypeError('handoff execution reference targets a different canonical record');
  }
  const externalReference = optionalString(handoff.externalReference, 'handoff externalReference');
  if ((state === 'external-created' || state === 'external-owned') && !externalReference) throw new TypeError('external handoff states require externalReference');
  const confirmedAt = optionalTimestamp(handoff.confirmedAt, 'handoff confirmedAt');
  if (state === 'external-owned' && !confirmedAt) throw new TypeError('external-owned handoffs require confirmedAt');
  return {
    ok: true,
    handoff: {
      contract: HANDOFF_CONTRACT,
      operationId: requiredString(handoff.operationId, 'handoff operationId'),
      fromAuthority,
      toAuthority,
      state,
      canonical,
      executionReference,
      externalReference,
      requestedAt: timestamp(handoff.requestedAt, 'handoff requestedAt'),
      confirmedAt,
      evidenceRefs: evidenceRefs(handoff.evidenceRefs, 'handoff evidenceRefs'),
    },
  };
}

function createExplicitHandoff(input) {
  return validateExplicitHandoff(input).handoff;
}

function promotionFingerprint({ todoId, todoRevision, target, intentDigest }) {
  return digest({ todoId, todoRevision, target, intentDigest, authority: 'beads' });
}

function validatePromotionOperation(operation) {
  if (!exactKeys(operation, [
    'contract', 'operationId', 'todoId', 'todoRevision', 'target', 'intentDigest', 'correlationKey', 'authority', 'state', 'resolution',
    'beadsReference', 'requestedAt', 'updatedAt', 'reason',
  ])) throw new TypeError('promotion operation has unsupported fields');
  if (operation.contract !== PROMOTION_OPERATION_CONTRACT) throw new TypeError('promotion operation has an unsupported contract');
  const todoId = requiredString(operation.todoId, 'promotion todoId');
  const todoRevision = positiveInteger(operation.todoRevision, 'promotion todoRevision');
  const target = validateCanonicalReference(operation.target).reference;
  if (target.kind !== 'outcome') throw new TypeError('promotion target must be an outcome');
  const intentDigest = /^[a-f0-9]{64}$/.test(operation.intentDigest) ? operation.intentDigest : (() => { throw new TypeError('promotion intentDigest must be a sha256 digest'); })();
  const correlationKey = requiredString(operation.correlationKey, 'promotion correlationKey');
  if (!/^promote_[a-f0-9]{32}$/.test(correlationKey)) throw new TypeError('promotion correlationKey is invalid');
  if (correlationKey !== `promote_${promotionFingerprint({ todoId, todoRevision, target, intentDigest }).slice(0, 32)}`) throw new TypeError('promotion correlationKey does not match operation identity');
  const authority = requiredString(operation.authority, 'promotion authority');
  if (authority !== 'beads') throw new TypeError('promotion authority must be beads');
  const state = requiredString(operation.state, 'promotion state');
  const resolution = requiredString(operation.resolution, 'promotion resolution');
  if (!PROMOTION_STATES.includes(state) || !PROMOTION_STATES.includes(resolution)) throw new TypeError('promotion state is unsupported');
  const validStateResolution = (state === 'creating' && resolution === 'pending') || state === resolution;
  if (!validStateResolution) throw new TypeError('promotion state and resolution do not agree');
  const beadsReference = operation.beadsReference === null ? null : validateExecutionReference(operation.beadsReference).reference;
  if (beadsReference && (beadsReference.authority !== 'beads' || beadsReference.canonical.id !== target.id || beadsReference.canonical.revision !== target.revision)) {
    throw new TypeError('promotion beads reference does not match target');
  }
  if (state === 'committed' && !beadsReference) throw new TypeError('committed promotion requires beadsReference');
  if (state !== 'committed' && beadsReference) throw new TypeError('only committed promotions may carry beadsReference');
  return {
    ok: true,
    operation: {
      contract: PROMOTION_OPERATION_CONTRACT,
      operationId: requiredString(operation.operationId, 'promotion operationId'),
      todoId,
      todoRevision,
      target,
      intentDigest,
      correlationKey,
      authority,
      state,
      resolution,
      beadsReference,
      requestedAt: timestamp(operation.requestedAt, 'promotion requestedAt'),
      updatedAt: timestamp(operation.updatedAt, 'promotion updatedAt'),
      reason: optionalString(operation.reason, 'promotion reason'),
    },
  };
}

function createPromotionOperation(request) {
  if (!isPlainObject(request) || !['operationId', 'todoId', 'todoRevision', 'target', 'executionIntent', 'requestedAt'].every((field) => Object.prototype.hasOwnProperty.call(request, field))) {
    throw new TypeError('promotion request is incomplete');
  }
  const target = validateCanonicalReference(request.target).reference;
  if (target.kind !== 'outcome') throw new TypeError('promotion target must be an outcome');
  const todoId = requiredString(request.todoId, 'promotion todoId');
  const todoRevision = positiveInteger(request.todoRevision, 'promotion todoRevision');
  const intentDigest = digest(requiredString(request.executionIntent, 'promotion executionIntent'));
  const requestedAt = timestamp(request.requestedAt, 'promotion requestedAt');
  const operation = {
    contract: PROMOTION_OPERATION_CONTRACT,
    operationId: requiredString(request.operationId, 'promotion operationId'),
    todoId,
    todoRevision,
    target,
    intentDigest,
    correlationKey: `promote_${promotionFingerprint({ todoId, todoRevision, target, intentDigest }).slice(0, 32)}`,
    authority: 'beads',
    state: 'pending',
    resolution: 'pending',
    beadsReference: null,
    requestedAt,
    updatedAt: timestamp(request.updatedAt || requestedAt, 'promotion updatedAt'),
    reason: null,
  };
  return validatePromotionOperation(operation).operation;
}

function replayPromotionOperation(existing, request) {
  const operation = validatePromotionOperation(existing).operation;
  const candidate = createPromotionOperation(request);
  if (operation.todoId !== candidate.todoId) return { status: 'new', operation: candidate };
  if (operation.todoRevision !== candidate.todoRevision) return { status: 'conflict', reason: 'stale-todo-revision', operation };
  if (operation.target.id !== candidate.target.id || operation.target.revision !== candidate.target.revision) return { status: 'conflict', reason: 'target-conflict', operation };
  if (operation.intentDigest !== candidate.intentDigest) return { status: 'conflict', reason: 'intent-conflict', operation };
  return {
    status: operation.state === 'indeterminate' ? 'reconcile-required' : 'deduped',
    operation,
  };
}

function resolvePromotionOperation(operation, resolution) {
  const current = validatePromotionOperation(operation).operation;
  if (!isPlainObject(resolution)) throw new TypeError('promotion resolution is required');
  const outcome = requiredString(resolution.outcome, 'promotion outcome');
  if (!PROMOTION_OUTCOMES.includes(outcome)) throw new TypeError(`unsupported promotion outcome: ${outcome}`);
  const updatedAt = timestamp(resolution.observedAt, 'promotion observedAt');
  let beadsReference = null;
  if (outcome === 'committed') {
    if (resolution.observedTodoRevision !== current.todoRevision) throw new Error('committed promotion has an unexpected Todo revision');
    if (!resolution.executionReference) throw new TypeError('committed promotion requires executionReference');
    beadsReference = validateExecutionReference(resolution.executionReference).reference;
    if (beadsReference.authority !== 'beads' || beadsReference.canonical.id !== current.target.id || beadsReference.canonical.revision !== current.target.revision) {
      throw new Error('committed promotion execution reference does not match target');
    }
  }
  const state = outcome === 'committed' ? 'committed' : outcome;
  return validatePromotionOperation({
    ...current,
    state,
    resolution: outcome,
    beadsReference,
    updatedAt,
    reason: optionalString(resolution.reason, 'promotion reason'),
  }).operation;
}

function promotionRetryStatus(operation) {
  const normalized = validatePromotionOperation(operation).operation;
  return normalized.resolution === 'not-committed' ? 'allowed' : 'blocked';
}

function validateReleaseEvidence(evidence) {
  if (!exactKeys(evidence, [
    'contract', 'evidenceId', 'canonical', 'finding', 'release', 'repairReference', 'observedAt', 'sourceRevision', 'evidenceRefs', 'trust',
  ])) throw new TypeError('release evidence has unsupported fields');
  if (evidence.contract !== RELEASE_EVIDENCE_CONTRACT) throw new TypeError('release evidence has an unsupported contract');
  const canonical = validateCanonicalReference(evidence.canonical).reference;
  if (canonical.kind !== 'outcome') throw new TypeError('release evidence must target an outcome');
  if (!exactKeys(evidence.finding, ['code', 'summary'])) throw new TypeError('release evidence finding has unsupported fields');
  const finding = { code: requiredString(evidence.finding.code, 'release finding code'), summary: requiredString(evidence.finding.summary, 'release finding summary') };
  if (!exactKeys(evidence.release, ['version', 'published', 'latestPublicVersion', 'drift'])) throw new TypeError('release evidence release has unsupported fields');
  const release = {
    version: requiredString(evidence.release.version, 'release version'),
    published: evidence.release.published,
    latestPublicVersion: requiredString(evidence.release.latestPublicVersion, 'release latestPublicVersion'),
    drift: requiredString(evidence.release.drift, 'release drift'),
  };
  if (typeof release.published !== 'boolean') throw new TypeError('release published must be boolean');
  const repairReference = evidence.repairReference === null ? null : validateExecutionReference(evidence.repairReference).reference;
  if (repairReference && (repairReference.authority !== 'beads' || repairReference.canonical.id !== canonical.id || repairReference.canonical.revision !== canonical.revision)) {
    throw new TypeError('release repair reference does not match canonical outcome');
  }
  const trust = requiredString(evidence.trust, 'release evidence trust');
  if (!TRUST_LEVELS.includes(trust)) throw new TypeError('release evidence trust is unsupported');
  return {
    ok: true,
    evidence: {
      contract: RELEASE_EVIDENCE_CONTRACT,
      evidenceId: requiredString(evidence.evidenceId, 'release evidenceId'),
      canonical,
      finding,
      release,
      repairReference,
      observedAt: timestamp(evidence.observedAt, 'release observedAt'),
      sourceRevision: requiredString(evidence.sourceRevision, 'release sourceRevision'),
      evidenceRefs: evidenceRefs(evidence.evidenceRefs, 'release evidenceRefs'),
      trust,
    },
  };
}

function createReleaseEvidence(input) {
  return validateReleaseEvidence(input).evidence;
}

function validateUnknownLinkProposal(proposal) {
  if (!exactKeys(proposal, ['contract', 'proposalId', 'source', 'externalReference', 'displayName', 'evidenceId', 'reason', 'status', 'createdAt'])) {
    throw new TypeError('unknown link proposal has unsupported fields');
  }
  if (proposal.contract !== UNKNOWN_LINK_PROPOSAL_CONTRACT) throw new TypeError('unknown link proposal has an unsupported contract');
  const status = requiredString(proposal.status, 'unknown link proposal status');
  if (status !== 'proposed') throw new TypeError('unknown link proposal status must be proposed');
  return {
    ok: true,
    proposal: {
      contract: UNKNOWN_LINK_PROPOSAL_CONTRACT,
      proposalId: requiredString(proposal.proposalId, 'unknown link proposalId'),
      source: requiredString(proposal.source, 'unknown link source'),
      externalReference: requiredString(proposal.externalReference, 'unknown link externalReference'),
      displayName: requiredString(proposal.displayName, 'unknown link displayName'),
      evidenceId: requiredString(proposal.evidenceId, 'unknown link evidenceId'),
      reason: requiredString(proposal.reason, 'unknown link reason'),
      status: 'proposed',
      createdAt: timestamp(proposal.createdAt, 'unknown link createdAt'),
    },
  };
}

function createUnknownLinkProposal(input) {
  return validateUnknownLinkProposal({ ...input, contract: input.contract || UNKNOWN_LINK_PROPOSAL_CONTRACT, status: input.status || 'proposed' }).proposal;
}

function paperclipProjection(handoff) {
  if (handoff === null || handoff === undefined) return { state: 'omitted', reference: null };
  const normalized = validateExplicitHandoff(handoff).handoff;
  if (normalized.toAuthority !== 'paperclip') throw new TypeError('paperclip projection requires a Paperclip handoff');
  return { state: normalized.state, reference: normalized.externalReference };
}

function createHostAdmission({ producerId, secret, allowedKinds = [], allowedProviders = [] } = {}) {
  producerId = requiredString(producerId, 'producerId');
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) throw new TypeError('secret is required');
  const kinds = new Set(allowedKinds.map((kind) => requiredString(kind, 'allowedKinds[]')));
  const providers = new Set(allowedProviders.map((provider) => requiredString(provider, 'allowedProviders[]')));
  function allowed(kind, provider) {
    return (!kinds.size || kinds.has(kind)) && (!providers.size || providers.has(provider));
  }
  function admitVerifiedReceipt(input) {
    const base = validateActivityReceipt(input);
    if (base.producerId !== producerId) throw new Error('producer identity is not admitted');
    if (!allowed(base.kind)) throw new Error('activity kind is not admitted');
    const admission = { producerId, digest: digest(base), signature: sign({ kind: 'activity', base }, secret) };
    return validateVerifiedReceipt({ ...base, trust: 'verified', admission });
  }
  function admitProviderSnapshot(input) {
    const candidate = { ...input, trust: 'unverified', admission: null };
    const base = validateProviderSnapshot(candidate);
    if (!allowed(`provider:${base.provider}`, base.provider)) throw new Error('provider is not admitted');
    const admission = { producerId, digest: digest({ ...base, trust: 'unverified', admission: null }), signature: sign({ kind: 'provider', base }, secret) };
    return validateProviderSnapshot({ ...base, trust: 'verified', admission });
  }
  function verifyProviderSnapshot(snapshot, { now, expectedProvider } = {}) {
    try {
      const normalized = validateProviderSnapshot(snapshot);
      if (normalized.trust !== 'verified' || !normalized.admission || normalized.admission.producerId !== producerId) return { ok: false, reason: 'not-admitted' };
      if (expectedProvider && normalized.provider !== expectedProvider) return { ok: false, reason: 'not-admitted' };
      if (!allowed(`provider:${normalized.provider}`, normalized.provider)) return { ok: false, reason: 'not-admitted' };
      const base = { ...normalized, trust: 'unverified', admission: null };
      if (normalized.admission.digest !== digest(base)) return { ok: false, reason: 'invalid-signature' };
      const expected = sign({ kind: 'provider', base }, secret);
      if (!constantTimeEqual(expected, normalized.admission.signature)) return { ok: false, reason: 'invalid-signature' };
      if (now !== undefined && Number.isNaN(Date.parse(now))) return { ok: false, reason: 'invalid-contract' };
      return { ok: true, snapshot: normalized };
    } catch (_) {
      return { ok: false, reason: 'invalid-contract' };
    }
  }
  function verifyVerifiedReceipt(receipt, { now, expectedCanonicalId } = {}) {
    try {
      const normalized = validateVerifiedReceipt(receipt);
      if (normalized.admission.producerId !== producerId || (expectedCanonicalId && normalized.canonicalId !== expectedCanonicalId)) return { ok: false, reason: 'not-admitted' };
      if (!allowed(normalized.kind)) return { ok: false, reason: 'not-admitted' };
      if (normalized.admission.digest !== digest(Object.fromEntries(ACTIVITY_FIELDS.map((field) => [field, normalized[field]])))) return { ok: false, reason: 'invalid-signature' };
      const expected = sign({ kind: 'activity', base: Object.fromEntries(ACTIVITY_FIELDS.map((field) => [field, normalized[field]])) }, secret);
      if (!constantTimeEqual(expected, normalized.admission.signature)) return { ok: false, reason: 'invalid-signature' };
      if (now !== undefined && Number.isNaN(Date.parse(now))) return { ok: false, reason: 'invalid-contract' };
      return { ok: true, receipt: normalized };
    } catch (_) {
      return { ok: false, reason: 'invalid-contract' };
    }
  }
  return Object.freeze({ admitVerifiedReceipt, admitProviderSnapshot, verifyVerifiedReceipt, verifyProviderSnapshot });
}

module.exports = {
  ACTIVITY_FIELDS,
  ADMISSION_FIELDS,
  AGENT_OBSERVATION_CONTRACT,
  CANONICAL_REFERENCE_CONTRACT,
  EXECUTION_REFERENCE_CONTRACT,
  EXECUTION_AUTHORITIES,
  HANDOFF_CONTRACT,
  HANDOFF_STATES,
  OBSERVATION_FIELDS,
  PROMOTION_OPERATION_CONTRACT,
  PROMOTION_OUTCOMES,
  PROMOTION_STATES,
  PROVIDER_SNAPSHOT_CONTRACT,
  PROVIDER_STATES,
  RELEASE_EVIDENCE_CONTRACT,
  SNAPSHOT_FIELDS,
  SUMMARY_FIELDS,
  TRUST_LEVELS,
  UNKNOWN_LINK_PROPOSAL_CONTRACT,
  VERIFIED_ACTIVITY_CONTRACT,
  createCanonicalReference,
  createExplicitHandoff,
  createExecutionReference,
  createHostAdmission,
  createPromotionOperation,
  createReleaseEvidence,
  createUnknownLinkProposal,
  paperclipProjection,
  promotionRetryStatus,
  replayPromotionOperation,
  resolvePromotionOperation,
  submitAgentObservation,
  validateActivityReceipt,
  validateAgentObservation,
  validateAdmission,
  validateCanonicalReference,
  validateExplicitHandoff,
  validateExecutionReference,
  validatePromotionOperation,
  validateProviderSnapshot,
  validateReleaseEvidence,
  validateSummary,
  validateVerifiedReceipt,
  validateUnknownLinkProposal,
  stableStringify,
  digest,
};
