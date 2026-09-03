'use strict';

const crypto = require('node:crypto');

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ABSOLUTE_PATH = /(?:^|[\s"'(=:])(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;

// UTC-only ISO-8601: a caller-supplied clock or timestamp must carry an
// explicit `Z` offset. A zoneless or offset-relative string is ambiguous
// about which instant it names and must fail closed rather than be
// interpreted by the platform's local timezone.
const UTC_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const MAX_TRAVERSAL_DEPTH = 32;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// The OPAQUE_ID character class never admits '/' or '\\', so any string
// matching it cannot also match ABSOLUTE_PATH; a separate path check here
// would be unreachable and is intentionally omitted.
function isOpaqueId(value) {
  return typeof value === 'string' && OPAQUE_ID.test(value);
}

function isDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function isSafeNonNegativeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidClockValue(value) {
  return typeof value === 'string' && UTC_ISO_TIMESTAMP.test(value) && !Number.isNaN(new Date(value).getTime());
}

function normalizeTime(value, field) {
  if (!isValidClockValue(value)) {
    throw new Error(`${field} must be a UTC ISO-8601 timestamp with an explicit Z offset (e.g. 2026-09-03T12:00:00.000Z)`);
  }
  return new Date(value).toISOString();
}

// Recursively sorts object keys and rejects cyclic references, excessive
// depth, and values that cannot be canonicalized (BigInt, function, symbol,
// undefined, non-finite or unsafe numbers). Semantically equal objects with
// different key insertion order canonicalize identically; a `seen` set is
// added to and removed from per-branch so a shared (non-cyclic) reference
// between siblings is not mistaken for a cycle.
function canonicalizeForDigest(value, seen = new WeakSet(), depth = 0) {
  if (depth > MAX_TRAVERSAL_DEPTH) throw new Error('value exceeds the maximum depth for digesting');
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new Error('value contains a non-finite number');
    if (!Number.isSafeInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error('value contains an unsafe number');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('value contains a circular reference');
    seen.add(value);
    const result = value.map((entry) => canonicalizeForDigest(entry, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  if (isObject(value)) {
    if (seen.has(value)) throw new Error('value contains a circular reference');
    seen.add(value);
    const keys = Object.keys(value).sort();
    const result = {};
    for (const key of keys) result[key] = canonicalizeForDigest(value[key], seen, depth + 1);
    seen.delete(value);
    return result;
  }
  throw new Error(`value contains an unsupported type for digesting: ${type}`);
}

// A digest is always a lowercase hex SHA-256, produced over a canonical
// (key-sorted, cycle-safe) form so semantically equal objects hash
// identically regardless of caller-supplied insertion order.
function digestOf(value) {
  if (typeof value === 'string') return crypto.createHash('sha256').update(value).digest('hex');
  const canonical = canonicalizeForDigest(value);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// Bounded, cycle-safe traversal: never throws on cyclic, shared-reference,
// or too-deep caller input. It reports a structural error instead of
// crashing so preflight/receipt validation can always fail closed.
function collectPrivacyErrors(value, path = 'record', errors = [], seen = new WeakSet(), depth = 0) {
  if (depth > MAX_TRAVERSAL_DEPTH) {
    errors.push(`${path} exceeds the maximum nesting depth`);
    return errors;
  }
  if (typeof value === 'string') {
    if (ABSOLUTE_PATH.test(value)) errors.push(`${path} must not contain an absolute path`);
    if (SECRET_VALUE.test(value)) errors.push(`${path} must not contain credentials or secrets`);
    return errors;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) { errors.push(`${path} contains a circular reference`); return errors; }
    seen.add(value);
    value.forEach((entry, index) => collectPrivacyErrors(entry, `${path}[${index}]`, errors, seen, depth + 1));
    seen.delete(value);
    return errors;
  }
  if (isObject(value)) {
    if (seen.has(value)) { errors.push(`${path} contains a circular reference`); return errors; }
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      collectPrivacyErrors(entry, `${path}.${key}`, errors, seen, depth + 1);
    }
    seen.delete(value);
    return errors;
  }
  return errors;
}

// Strict allowlist enforcement: every public typed record validator names
// its exact accepted fields, so an unrecognized property (typo, forked
// shape, or a field a caller hoped would ride along unvalidated) is
// rejected rather than silently passed through to a digest or a persisted
// record.
function collectUnknownFieldErrors(record, allowedFields, label) {
  if (!isObject(record)) return [];
  const allowed = new Set(allowedFields);
  return Object.keys(record)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label}.${key} is not a recognized field`);
}

module.exports = {
  OPAQUE_ID,
  SHA256,
  UTC_ISO_TIMESTAMP,
  isObject,
  clone,
  isOpaqueId,
  isDigest,
  isSafeNonNegativeInt,
  isSafePositiveInt,
  isValidClockValue,
  normalizeTime,
  digestOf,
  collectPrivacyErrors,
  collectUnknownFieldErrors,
};
