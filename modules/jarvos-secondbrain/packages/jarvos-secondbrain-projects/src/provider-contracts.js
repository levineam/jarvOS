'use strict';

const crypto = require('node:crypto');

const PROVIDER_SNAPSHOT_CONTRACT = 'jarvos.provider-snapshot/v1';
const VERIFIED_ACTIVITY_CONTRACT = 'jarvos.verified-activity/v1';
const AGENT_OBSERVATION_CONTRACT = 'jarvos.project-observation/v1';
const PROVIDER_STATES = Object.freeze(['fresh', 'stale', 'partial', 'unknown', 'unavailable', 'healthy-empty']);
const TRUST_LEVELS = Object.freeze(['verified', 'unverified']);
const SUMMARY_CATEGORIES = Object.freeze(['activity', 'intent', 'execution', 'attention', 'work']);
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
  OBSERVATION_FIELDS,
  PROVIDER_SNAPSHOT_CONTRACT,
  PROVIDER_STATES,
  SNAPSHOT_FIELDS,
  SUMMARY_FIELDS,
  TRUST_LEVELS,
  VERIFIED_ACTIVITY_CONTRACT,
  createHostAdmission,
  submitAgentObservation,
  validateActivityReceipt,
  validateAgentObservation,
  validateAdmission,
  validateProviderSnapshot,
  validateSummary,
  validateVerifiedReceipt,
  stableStringify,
  digest,
};
