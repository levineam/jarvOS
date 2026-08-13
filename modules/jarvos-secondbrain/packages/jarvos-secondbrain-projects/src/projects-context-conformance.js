'use strict';

const crypto = require('node:crypto');

const CONFORMANCE_CONTRACT = 'jarvos.projects-context-conformance/v1';
const CONFORMANCE_FIELDS = Object.freeze([
  'contract',
  'receiptId',
  'publicContract',
  'sourceRevision',
  'packageDigest',
  'providerContract',
  'providerRevision',
  'selectorRevision',
  'configDigest',
  'registryGeneration',
  'capabilityReceiptId',
  'capabilityDigest',
  'profile',
  'profileRevision',
  'providerSnapshotDigests',
  'consumers',
  'status',
  'blockerCode',
  'generatedAt',
]);
const CONSUMER_NAMES = Object.freeze([
  'library',
  'mcp',
  'hydrate',
  'coding-startup',
  'active-assistant',
  'codex',
  'claude',
]);
const CONSUMER_STATUSES = Object.freeze(['ready', 'blocked', 'unavailable']);

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) { return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`); return value.trim(); }
function optionalString(value, field) { if (value === null) return null; return requiredString(value, field); }
function timestamp(value, field) { const normalized = requiredString(value, field); if (Number.isNaN(Date.parse(normalized))) throw new TypeError(`${field} must be an ISO timestamp`); return normalized; }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableDigest(value) { return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }

function normalizeDigest(value, field) {
  const normalized = requiredString(value, field);
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new TypeError(`${field} must be a sha256 digest`);
  return normalized;
}

function normalizeConsumers(value) {
  if (!isPlainObject(value) || !Object.keys(value).length) throw new TypeError('conformance consumers are required');
  const normalized = {};
  for (const name of Object.keys(value).sort()) {
    if (!CONSUMER_NAMES.includes(name)) throw new TypeError(`unsupported conformance consumer: ${name}`);
    const result = value[name];
    if (!exactKeys(result, ['status', 'fingerprint'])) throw new TypeError(`consumer ${name} has unsupported fields`);
    const status = requiredString(result.status, `consumer ${name}.status`);
    if (!CONSUMER_STATUSES.includes(status)) throw new TypeError(`consumer ${name} status is unsupported`);
    const fingerprint = result.fingerprint === null ? null : normalizeDigest(result.fingerprint, `consumer ${name}.fingerprint`);
    if (status === 'ready' && !fingerprint) throw new TypeError(`ready consumer ${name} requires a fingerprint`);
    if (status !== 'ready' && fingerprint !== null) throw new TypeError(`non-ready consumer ${name} cannot carry a fingerprint`);
    normalized[name] = { status, fingerprint };
  }
  return normalized;
}

function normalizeProviderSnapshotDigests(value) {
  if (!isPlainObject(value)) throw new TypeError('providerSnapshotDigests must be an object');
  const normalized = {};
  for (const name of Object.keys(value).sort()) normalized[requiredString(name, 'provider name')] = normalizeDigest(value[name], `providerSnapshotDigests.${name}`);
  return normalized;
}

function identity(receipt) {
  const copy = { ...receipt };
  delete copy.receiptId;
  return stableValue(copy);
}

function validateConformanceReceipt(receipt) {
  try {
    if (!exactKeys(receipt, CONFORMANCE_FIELDS)) throw new TypeError('Projects conformance receipt has unsupported fields');
    const normalized = {
      contract: requiredString(receipt.contract, 'contract'),
      receiptId: requiredString(receipt.receiptId, 'receiptId'),
      publicContract: requiredString(receipt.publicContract, 'publicContract'),
      sourceRevision: requiredString(receipt.sourceRevision, 'sourceRevision'),
      packageDigest: normalizeDigest(receipt.packageDigest, 'packageDigest'),
      providerContract: requiredString(receipt.providerContract, 'providerContract'),
      providerRevision: requiredString(receipt.providerRevision, 'providerRevision'),
      selectorRevision: requiredString(receipt.selectorRevision, 'selectorRevision'),
      configDigest: normalizeDigest(receipt.configDigest, 'configDigest'),
      registryGeneration: receipt.registryGeneration,
      capabilityReceiptId: optionalString(receipt.capabilityReceiptId, 'capabilityReceiptId'),
      capabilityDigest: optionalString(receipt.capabilityDigest, 'capabilityDigest'),
      profile: requiredString(receipt.profile, 'profile'),
      profileRevision: requiredString(receipt.profileRevision, 'profileRevision'),
      providerSnapshotDigests: normalizeProviderSnapshotDigests(receipt.providerSnapshotDigests),
      consumers: normalizeConsumers(receipt.consumers),
      status: requiredString(receipt.status, 'status'),
      blockerCode: optionalString(receipt.blockerCode, 'blockerCode'),
      generatedAt: timestamp(receipt.generatedAt, 'generatedAt'),
    };
    if (normalized.contract !== CONFORMANCE_CONTRACT) throw new TypeError('Projects conformance receipt has an unsupported contract');
    if (normalized.publicContract !== 'jarvos.projects-context/v1') throw new TypeError('publicContract is unsupported');
    if (!/^conformance_[a-f0-9]{32}$/.test(normalized.receiptId)) throw new TypeError('receiptId is invalid');
    if (!Number.isInteger(normalized.registryGeneration) || normalized.registryGeneration < 0) throw new TypeError('registryGeneration is invalid');
    if (normalized.capabilityReceiptId !== null && !/^cap_[a-f0-9]{32}$/.test(normalized.capabilityReceiptId)) throw new TypeError('capabilityReceiptId is invalid');
    if (normalized.capabilityDigest !== null && !/^[a-f0-9]{64}$/.test(normalized.capabilityDigest)) throw new TypeError('capabilityDigest is invalid');
    if ((normalized.capabilityReceiptId === null) !== (normalized.capabilityDigest === null)) throw new TypeError('capability metadata must be complete');
    if (!['orientation', 'recent-activity'].includes(normalized.profile)) throw new TypeError('profile is unsupported');
    if (!/^[a-z0-9._/-]{1,128}$/.test(normalized.providerContract)) throw new TypeError('providerContract is invalid');
    if (!/^[a-z0-9._/-]{1,128}$/.test(normalized.providerRevision)) throw new TypeError('providerRevision is invalid');
    if (!/^[a-z0-9._/-]{1,128}$/.test(normalized.selectorRevision)) throw new TypeError('selectorRevision is invalid');

    const consumerValues = Object.values(normalized.consumers);
    const ready = consumerValues.filter((consumer) => consumer.status === 'ready');
    const fingerprints = new Set(ready.map((consumer) => consumer.fingerprint));
    if (normalized.status === 'ready') {
      if (!normalized.capabilityReceiptId || !normalized.capabilityDigest || normalized.blockerCode !== null) throw new TypeError('ready conformance requires capability metadata and no blocker');
      if (ready.length !== consumerValues.length || fingerprints.size !== 1) throw new TypeError('ready conformance requires consumer parity');
    } else if (normalized.status !== 'blocked' || !normalized.blockerCode) {
      throw new TypeError('blocked conformance requires blockerCode');
    }
    if (normalized.receiptId !== `conformance_${stableDigest(identity(normalized)).slice(0, 32)}`) throw new TypeError('receiptId does not match receipt contents');
    return { ok: true, receipt: normalized };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function createConformanceReceipt(input = {}) {
  const consumers = normalizeConsumers(input.consumers);
  const required = Array.isArray(input.requiredConsumers) && input.requiredConsumers.length
    ? [...new Set(input.requiredConsumers)]
    : Object.keys(consumers);
  if (required.some((name) => !CONSUMER_NAMES.includes(name) || !Object.prototype.hasOwnProperty.call(consumers, name))) throw new TypeError('requiredConsumers must name supplied consumers');
  const requiredValues = required.map((name) => consumers[name]);
  const ready = requiredValues.every((consumer) => consumer.status === 'ready');
  const fingerprints = new Set(requiredValues.filter((consumer) => consumer.status === 'ready').map((consumer) => consumer.fingerprint));
  const status = ready && fingerprints.size === 1 ? 'ready' : 'blocked';
  const blockerCode = status === 'ready'
    ? null
    : requiredValues.some((consumer) => consumer.status !== 'ready')
      ? 'consumer-unavailable'
      : 'consumer-fingerprint-mismatch';
  const candidate = {
    contract: CONFORMANCE_CONTRACT,
    receiptId: '',
    publicContract: input.publicContract || 'jarvos.projects-context/v1',
    sourceRevision: input.sourceRevision,
    packageDigest: input.packageDigest,
    providerContract: input.providerContract,
    providerRevision: input.providerRevision,
    selectorRevision: input.selectorRevision,
    configDigest: input.configDigest,
    registryGeneration: input.registryGeneration,
    capabilityReceiptId: input.capabilityReceiptId ?? null,
    capabilityDigest: input.capabilityDigest ?? null,
    profile: input.profile,
    profileRevision: input.profileRevision,
    providerSnapshotDigests: input.providerSnapshotDigests || {},
    consumers,
    status,
    blockerCode,
    generatedAt: input.generatedAt,
  };
  candidate.receiptId = `conformance_${stableDigest(identity(candidate)).slice(0, 32)}`;
  const result = validateConformanceReceipt(candidate);
  if (!result.ok) throw new TypeError(result.reason);
  return result.receipt;
}

function conformanceDigest(receipt) {
  const result = validateConformanceReceipt(receipt);
  if (!result.ok) throw new TypeError(result.reason);
  return digest(result.receipt);
}

module.exports = {
  CONFORMANCE_CONTRACT,
  CONFORMANCE_FIELDS,
  CONSUMER_NAMES,
  CONSUMER_STATUSES,
  conformanceDigest,
  createConformanceReceipt,
  validateConformanceReceipt,
};

