'use strict';

const crypto = require('node:crypto');

const CONTEXT_CONTRACT = 'jarvos.projects-context/v1';
const CAPABILITY_CONTRACT = 'jarvos.projects-context-capability/v1';
const AUDIENCE = 'jarvos-projects-context';
const REDACTION_CLASSES = Object.freeze(['public', 'internal', 'private', 'mixed']);
const CAPABILITY_FIELDS = Object.freeze([
  'type', 'contract', 'capabilityRevision', 'audience', 'subject', 'queryDigest', 'scope', 'redactionClass',
  'freshness', 'providerCoverage', 'limits', 'issuedAt', 'expiresAt', 'nonce', 'hostId', 'receiptId', 'signature',
]);

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) { return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`); return value.trim(); }
function timestamp(value, field) { requiredString(value, field); if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`); return value; }
function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) { if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${field} must be an integer between ${min} and ${max}`); return value; }

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function sha256(value) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex'); }
function hmac(value, secret) { return crypto.createHmac('sha256', secret).update(stableStringify(value)).digest('base64url'); }
function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateIds(value, field, prefix) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.startsWith(prefix) || !/^\w+_[0-9]{6,}$/.test(id))) throw new TypeError(`${field} must contain canonical IDs`);
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must not contain duplicates`);
  return [...value].sort();
}

function validateScope(scope) {
  if (!exactKeys(scope, ['projectIds', 'outcomeIds', 'includeDescendants'])) throw new TypeError('capability scope has unsupported fields');
  if (typeof scope.includeDescendants !== 'boolean') throw new TypeError('scope.includeDescendants must be boolean');
  return {
    projectIds: validateIds(scope.projectIds, 'scope.projectIds', 'prj_'),
    outcomeIds: validateIds(scope.outcomeIds, 'scope.outcomeIds', 'out_'),
    includeDescendants: scope.includeDescendants,
  };
}

function validateLimits(limits) {
  if (!exactKeys(limits, ['maxItems', 'maxBytes', 'maxProviderAgeSeconds'])) throw new TypeError('capability limits have unsupported fields');
  return {
    maxItems: integer(limits.maxItems, 'limits.maxItems', { min: 1, max: 1000 }),
    maxBytes: integer(limits.maxBytes, 'limits.maxBytes', { min: 512, max: 1_000_000 }),
    maxProviderAgeSeconds: integer(limits.maxProviderAgeSeconds, 'limits.maxProviderAgeSeconds', { min: 1, max: 86_400 }),
  };
}

function validateFreshness(freshness) {
  if (!exactKeys(freshness, ['maxAgeSeconds'])) throw new TypeError('capability freshness has unsupported fields');
  return { maxAgeSeconds: integer(freshness.maxAgeSeconds, 'freshness.maxAgeSeconds', { min: 1, max: 86_400 }) };
}

function unsignedFields(capability) {
  return Object.fromEntries(CAPABILITY_FIELDS.filter((field) => field !== 'signature').map((field) => [field, capability[field]]));
}

function validateCapability(capability) {
  if (!exactKeys(capability, CAPABILITY_FIELDS)) throw new TypeError('capability receipt has unsupported fields');
  if (capability.type !== CAPABILITY_CONTRACT || capability.contract !== CONTEXT_CONTRACT || capability.audience !== AUDIENCE) throw new TypeError('capability receipt has an unsupported contract');
  if (!REDACTION_CLASSES.includes(capability.redactionClass)) throw new TypeError(`unsupported redaction class: ${capability.redactionClass}`);
  if (!Array.isArray(capability.providerCoverage) || capability.providerCoverage.some((provider) => typeof provider !== 'string' || !provider.trim())) throw new TypeError('providerCoverage must contain provider names');
  const normalized = {
    type: CAPABILITY_CONTRACT,
    contract: CONTEXT_CONTRACT,
    capabilityRevision: requiredString(capability.capabilityRevision, 'capabilityRevision'),
    audience: AUDIENCE,
    subject: requiredString(capability.subject, 'subject'),
    queryDigest: /^[a-f0-9]{64}$/.test(capability.queryDigest) ? capability.queryDigest : (() => { throw new TypeError('queryDigest must be a sha256 digest'); })(),
    scope: validateScope(capability.scope),
    redactionClass: capability.redactionClass,
    freshness: validateFreshness(capability.freshness),
    providerCoverage: [...new Set(capability.providerCoverage.map((provider) => requiredString(provider, 'providerCoverage[]')))].sort(),
    limits: validateLimits(capability.limits),
    issuedAt: timestamp(capability.issuedAt, 'issuedAt'),
    expiresAt: timestamp(capability.expiresAt, 'expiresAt'),
    nonce: requiredString(capability.nonce, 'nonce'),
    hostId: requiredString(capability.hostId, 'hostId'),
    receiptId: /^cap_[a-f0-9]{32}$/.test(capability.receiptId) ? capability.receiptId : (() => { throw new TypeError('receiptId must be a capability ID'); })(),
    signature: requiredString(capability.signature, 'signature'),
  };
  if (Date.parse(normalized.expiresAt) <= Date.parse(normalized.issuedAt)) throw new RangeError('expiresAt must be after issuedAt');
  return normalized;
}

function issueCapability({
  authorization,
  hostId,
  hostSecret,
  subject,
  query,
  queryDigest,
  scope,
  redactionClass = 'private',
  freshness = { maxAgeSeconds: 3600 },
  providerCoverage = [],
  limits = { maxItems: 100, maxBytes: 50_000, maxProviderAgeSeconds: 3600 },
  capabilityRevision,
  issuedAt,
  expiresAt,
  nonce = crypto.randomBytes(16).toString('base64url'),
} = {}) {
  if (!authorization || authorization.allowed !== true) return { status: 'denied' };
  if (typeof hostSecret !== 'string' && !Buffer.isBuffer(hostSecret)) throw new TypeError('hostSecret is required');
  const normalizedScope = validateScope(scope || (query && query.scope));
  const normalizedLimits = validateLimits(limits);
  const normalizedFreshness = validateFreshness(freshness);
  const digest = queryDigest || (query ? sha256(query) : null);
  const unsigned = {
    type: CAPABILITY_CONTRACT,
    contract: CONTEXT_CONTRACT,
    capabilityRevision: requiredString(capabilityRevision, 'capabilityRevision'),
    audience: AUDIENCE,
    subject: requiredString(subject, 'subject'),
    queryDigest: /^[a-f0-9]{64}$/.test(digest || '') ? digest : (() => { throw new TypeError('query or queryDigest is required'); })(),
    scope: normalizedScope,
    redactionClass,
    freshness: normalizedFreshness,
    providerCoverage: [...new Set(providerCoverage.map((provider) => requiredString(provider, 'providerCoverage[]')))].sort(),
    limits: normalizedLimits,
    issuedAt: timestamp(issuedAt, 'issuedAt'),
    expiresAt: timestamp(expiresAt, 'expiresAt'),
    nonce: requiredString(nonce, 'nonce'),
    hostId: requiredString(hostId, 'hostId'),
  };
  const receiptId = `cap_${sha256(unsigned).slice(0, 32)}`;
  const capability = { ...unsigned, receiptId };
  capability.signature = hmac(unsignedFields(capability), hostSecret);
  return validateCapability(capability);
}

function verifyCapability(capability, {
  hostSecret,
  now = new Date().toISOString(),
  expectedSubject,
  expectedQuery,
  expectedScope,
  expectedRedactionClass,
  expectedHostId,
} = {}) {
  try {
    const normalized = validateCapability(capability);
    if (typeof hostSecret !== 'string' && !Buffer.isBuffer(hostSecret)) return { ok: false, reason: 'invalid-signature' };
    if (expectedSubject !== undefined && normalized.subject !== expectedSubject) return { ok: false, reason: 'audience-mismatch' };
    if (expectedHostId !== undefined && normalized.hostId !== expectedHostId) return { ok: false, reason: 'audience-mismatch' };
    if (expectedQuery !== undefined && normalized.queryDigest !== sha256(expectedQuery)) return { ok: false, reason: 'scope-mismatch' };
    if (expectedScope !== undefined && stableStringify(normalized.scope) !== stableStringify(validateScope(expectedScope))) return { ok: false, reason: 'scope-mismatch' };
    if (expectedRedactionClass !== undefined && normalized.redactionClass !== expectedRedactionClass) return { ok: false, reason: 'scope-mismatch' };
    const expectedSignature = hmac(unsignedFields(normalized), hostSecret);
    if (!constantTimeEqual(expectedSignature, normalized.signature)) return { ok: false, reason: 'invalid-signature' };
    const current = Date.parse(now);
    if (Number.isNaN(current)) return { ok: false, reason: 'invalid-contract' };
    if (current < Date.parse(normalized.issuedAt)) return { ok: false, reason: 'not-yet-valid' };
    if (current >= Date.parse(normalized.expiresAt)) return { ok: false, reason: 'expired' };
    return { ok: true, capability: normalized };
  } catch (_) {
    return { ok: false, reason: 'invalid-contract' };
  }
}

function capabilityDigest(capability) { return sha256(capability); }

module.exports = {
  AUDIENCE,
  CAPABILITY_FIELDS,
  CAPABILITY_CONTRACT,
  CONTEXT_CONTRACT,
  REDACTION_CLASSES,
  capabilityDigest,
  issueCapability,
  validateCapability,
  verifyCapability,
};
