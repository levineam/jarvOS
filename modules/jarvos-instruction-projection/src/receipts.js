'use strict';

const {
  HARNESSES,
  REDACTED_RECEIPT_SCHEMA_VERSION,
  CONTRACT_VERSION,
  normalizeRedactedRoleReceipt,
} = require('./contracts');

const LOCAL_RECEIPT_SCHEMA_VERSION = 'jarvos.instruction-role-receipt-local/v1';

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,79}$/;

const LOCAL_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'id',
  'harness',
  'relativeTarget',
  'catalogGeneration',
  'generationDigest',
  'renderedDigest',
  'outputDigest',
]);

const REDACT_METADATA_KEYS = Object.freeze([
  'adapterVersion',
  'harnessVersion',
  'targetIdentityDigest',
  'checkedAt',
  'observedPrecedence',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function normalizeRelativeTarget(value) {
  const label = 'local receipt relativeTarget';
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
  if (value.includes('\\')) throw new Error(`${label} must not contain backslashes`);
  if (value.startsWith('/')) throw new Error(`${label} must not be an absolute path`);
  if (/^[A-Za-z]:/.test(value)) throw new Error(`${label} must not be an absolute path`);
  if (value === '.') throw new Error(`${label} must not be a dot path`);
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain empty, dot, or traversal segments`);
  }
  const normalized = segments.join('/');
  if (normalized !== value) throw new Error(`${label} must already be normalized`);
  return value;
}

function normalizeLocalReceipt(value) {
  const label = 'local receipt';
  assertObject(value, label);
  const keys = Object.keys(value);
  const allowedSet = new Set(LOCAL_RECEIPT_KEYS);
  const unknown = keys.filter((key) => !allowedSet.has(key));
  const missing = LOCAL_RECEIPT_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);
  if (value.schemaVersion !== LOCAL_RECEIPT_SCHEMA_VERSION) throw new Error(`${label}.schemaVersion is unsupported`);
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) throw new Error(`${label}.id must be a canonical id`);
  if (!HARNESSES.includes(value.harness)) throw new Error(`${label}.harness is invalid`);
  const relativeTarget = normalizeRelativeTarget(value.relativeTarget);
  return {
    schemaVersion: LOCAL_RECEIPT_SCHEMA_VERSION,
    id: value.id,
    harness: value.harness,
    relativeTarget,
    catalogGeneration: exactDigest(value.catalogGeneration, `${label}.catalogGeneration`),
    generationDigest: exactDigest(value.generationDigest, `${label}.generationDigest`),
    renderedDigest: exactDigest(value.renderedDigest, `${label}.renderedDigest`),
    outputDigest: exactDigest(value.outputDigest, `${label}.outputDigest`),
  };
}

function serializeLocalReceipt(value) {
  const normalized = normalizeLocalReceipt(value);
  const ordered = {};
  for (const key of LOCAL_RECEIPT_KEYS) ordered[key] = normalized[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function receiptRelativePath(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('receipt id must be a canonical id');
  return `.jarvos-instruction-projection/receipts/${id}.json`;
}

function normalizeObservedPrecedence(metadata) {
  if (!Object.hasOwn(metadata, 'observedPrecedence')) return { status: 'pending', digest: null };
  const label = 'redact metadata.observedPrecedence';
  const provided = metadata.observedPrecedence;
  assertObject(provided, label);
  const providedKeys = Object.keys(provided);
  if (providedKeys.length !== 2 || !Object.hasOwn(provided, 'status') || !Object.hasOwn(provided, 'digest')) {
    throw new Error(`${label} must contain exactly status and digest`);
  }
  if (!['pending', 'not_evaluable'].includes(provided.status)) {
    throw new Error(`${label}.status must be pending or not_evaluable`);
  }
  if (provided.digest !== null) throw new Error(`${label}.digest must be null`);
  return { status: provided.status, digest: null };
}

function redactLocalReceipt(localReceipt, metadata) {
  const local = normalizeLocalReceipt(localReceipt);
  const label = 'redact metadata';
  assertObject(metadata, label);
  const allowedSet = new Set(REDACT_METADATA_KEYS);
  const unknown = Object.keys(metadata).filter((key) => !allowedSet.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  for (const key of ['adapterVersion', 'harnessVersion', 'targetIdentityDigest', 'checkedAt']) {
    if (!Object.hasOwn(metadata, key)) throw new Error(`${label}.${key} is required`);
  }

  const observedPrecedence = normalizeObservedPrecedence(metadata);

  const built = {
    schemaVersion: REDACTED_RECEIPT_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    harness: local.harness,
    adapterVersion: metadata.adapterVersion,
    harnessVersion: metadata.harnessVersion,
    catalogGeneration: local.catalogGeneration,
    renderedDigest: local.renderedDigest,
    targetIdentity: { kind: 'digest', digest: metadata.targetIdentityDigest },
    observedPrecedence,
    states: {
      desired: local.generationDigest,
      projected: local.generationDigest,
      installed: local.generationDigest,
      loaded: null,
      parity: null,
    },
    projectionStatus: 'clean',
    loadStatus: 'load_pending',
    parityStatus: 'pending',
    checkedAt: metadata.checkedAt,
  };

  return normalizeRedactedRoleReceipt(built);
}

module.exports = {
  LOCAL_RECEIPT_SCHEMA_VERSION,
  normalizeRelativeTarget,
  normalizeLocalReceipt,
  serializeLocalReceipt,
  receiptRelativePath,
  redactLocalReceipt,
};
