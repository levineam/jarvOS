'use strict';

// Portable, opaque identity contract for jarvOS entities. This module only
// checks the shape of an already-issued identifier. It never mints, resolves,
// dereferences, normalizes, or infers an identity, and it reads no host,
// process, environment, or network state. Each owning subsystem defines its own
// issuance: the Projects provider owns `project` identifiers, source adapters
// own source-event and session mapping, and a future enrollment flow owns mind,
// installation, host, and harness-instance issuance.

const IDENTITY_SCHEMA_VERSION = 'jarvos.identity.v1';
const IDENTITY_SCHEME = 'jarvos';
const MAX_IDENTITY_LENGTH = 256;

const IDENTITY_KINDS = Object.freeze([
  'mind',
  'installation',
  'host',
  'harness-instance',
  'session',
  'source-event',
  'candidate',
  'artifact',
  'project',
  'policy',
  'receipt',
]);

const IDENTITY_KIND_SET = new Set(IDENTITY_KINDS);
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validateIdentity(value, expectedKind) {
  const errors = [];
  if (expectedKind !== undefined && !IDENTITY_KIND_SET.has(expectedKind)) {
    errors.push('expected kind is not a known identity kind');
    return errors;
  }
  if (typeof value !== 'string') {
    errors.push('identity must be a string');
    return errors;
  }
  if (value.length === 0 || value.length > MAX_IDENTITY_LENGTH) {
    errors.push('identity length is out of range');
    return errors;
  }
  if (value !== value.toLowerCase()) {
    errors.push('identity must be lowercase');
  }
  const segments = value.split(':');
  if (segments.length !== 4) {
    errors.push('identity must have exactly four colon-delimited segments');
    return errors;
  }
  const [scheme, kind, namespace, opaque] = segments;
  if (scheme !== IDENTITY_SCHEME) {
    errors.push('identity scheme must be "jarvos"');
  }
  if (!IDENTITY_KIND_SET.has(kind)) {
    errors.push('identity kind is not a known kind');
  }
  if (!SEGMENT_PATTERN.test(namespace)) {
    errors.push('identity namespace is malformed');
  }
  if (!SEGMENT_PATTERN.test(opaque)) {
    errors.push('identity opaque segment is malformed');
  }
  if (expectedKind !== undefined && kind !== expectedKind) {
    errors.push('identity kind does not match the expected kind');
  }
  return errors;
}

function parseIdentity(value, expectedKind) {
  if (validateIdentity(value, expectedKind).length > 0) {
    return null;
  }
  const [scheme, kind, namespace, opaque] = value.split(':');
  return { scheme, kind, namespace, opaque };
}

function assertIdentity(value, expectedKind) {
  const errors = validateIdentity(value, expectedKind);
  if (errors.length > 0) {
    throw new TypeError(`invalid jarvos identity: ${errors.join('; ')}`);
  }
  return value;
}

module.exports = {
  IDENTITY_SCHEMA_VERSION,
  IDENTITY_KINDS,
  parseIdentity,
  validateIdentity,
  assertIdentity,
};
