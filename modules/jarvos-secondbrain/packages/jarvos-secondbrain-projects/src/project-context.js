'use strict';

const crypto = require('node:crypto');

const CAPABILITY_TYPE = 'jarvos.project-context/v1';
const PURPOSE = 'managed-software-stewardship';
const AUDIENCE = 'jarvos-projects';
const INPUT_FIELDS = Object.freeze(['findingId', 'executionReference', 'releaseReference', 'visibility']);
const RECEIPT_FIELDS = Object.freeze([
  'activationEnvelopeDigest', 'audience', 'capabilityRevision', 'contextKey', 'destinationSelectors', 'expiresAt',
  'issuedAt', 'purpose', 'signature', 'type', 'visibility',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function timestamp(value, name) {
  requiredString(value, name);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`);
  return value;
}

/**
 * Hash stable stewardship identities before crossing the Projects boundary.
 * The source identifiers are deliberately never placed in a receipt.
 */
function deriveContextKey(input) {
  if (!exactKeys(input, INPUT_FIELDS)) throw new TypeError('project context input has unsupported fields');
  const canonical = INPUT_FIELDS.map((field) => requiredString(input[field], field)).join('\u0000');
  return `pcx_${crypto.createHash('sha256').update(`${CAPABILITY_TYPE}\u0000${canonical}`).digest('base64url')}`;
}

function validateSelectors(selectors) {
  if (!Array.isArray(selectors) || !selectors.length || selectors.some((selector) => typeof selector !== 'string' || !selector.trim())) {
    throw new TypeError('destinationSelectors must be a non-empty string array');
  }
  // Paths are host-private implementation details, not portable selectors.
  if (selectors.some((selector) => selector.includes('/') || selector.includes('\\'))) {
    throw new TypeError('destinationSelectors must not contain local paths');
  }
  return [...new Set(selectors)];
}

/**
 * Build the fixed, portable portion passed to an external signer. `sign` is an
 * injected boundary: this package neither reads nor retains signing material.
 */
function issueProjectContext({
  input,
  authorization,
  destinationSelectors,
  capabilityRevision,
  activationEnvelopeDigest,
  issuedAt,
  expiresAt,
  sign,
} = {}) {
  // An indistinguishable denial is intentional: callers learn neither the
  // destination set nor whether an omitted destination would have existed.
  if (!authorization || authorization.allowed !== true) return { status: 'denied' };
  if (typeof sign !== 'function') throw new TypeError('sign must be an external signer function');

  const receipt = {
    type: CAPABILITY_TYPE,
    purpose: PURPOSE,
    audience: AUDIENCE,
    contextKey: deriveContextKey(input),
    visibility: requiredString(input.visibility, 'visibility'),
    destinationSelectors: validateSelectors(destinationSelectors),
    capabilityRevision: requiredString(capabilityRevision, 'capabilityRevision'),
    activationEnvelopeDigest: requiredString(activationEnvelopeDigest, 'activationEnvelopeDigest'),
    issuedAt: timestamp(issuedAt, 'issuedAt'),
    expiresAt: timestamp(expiresAt, 'expiresAt'),
  };
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) throw new RangeError('expiresAt must be after issuedAt');

  const signature = sign(Object.freeze({ ...receipt }));
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(signature)) {
    throw new TypeError('external signer must return a portable encoded signature');
  }
  return { ...receipt, signature };
}

/**
 * Verify public contract facts before calling the pinned external verifier.
 * The verifier owns cryptography and revocation material; this package only
 * defines the portable boundary and never loads keys or revocation files.
 */
function verifyProjectContext(receipt, { now = new Date().toISOString(), verify, isRevoked, activationEnvelopeDigest } = {}) {
  if (!exactKeys(receipt, RECEIPT_FIELDS)
    || receipt.type !== CAPABILITY_TYPE
    || receipt.purpose !== PURPOSE
    || receipt.audience !== AUDIENCE
    || typeof receipt.contextKey !== 'string'
    || !receipt.contextKey.startsWith('pcx_')
    || !Array.isArray(receipt.destinationSelectors)
    || receipt.destinationSelectors.some((selector) => typeof selector !== 'string' || selector.includes('/') || selector.includes('\\'))
    || typeof receipt.visibility !== 'string'
    || typeof receipt.capabilityRevision !== 'string'
    || typeof receipt.activationEnvelopeDigest !== 'string'
    || typeof activationEnvelopeDigest !== 'string' || !activationEnvelopeDigest.trim()
    || typeof receipt.signature !== 'string'
    || !/^[A-Za-z0-9_-]+={0,2}$/.test(receipt.signature)
    || Number.isNaN(Date.parse(receipt.issuedAt))
    || Number.isNaN(Date.parse(receipt.expiresAt))) return { ok: false, reason: 'invalid-contract' };
  if (receipt.activationEnvelopeDigest !== activationEnvelopeDigest) return { ok: false, reason: 'activation-envelope-mismatch' };
  if (Date.parse(now) >= Date.parse(receipt.expiresAt)) return { ok: false, reason: 'expired' };
  if (typeof isRevoked === 'function' && isRevoked(receipt) === true) return { ok: false, reason: 'revoked' };
  if (typeof verify !== 'function' || verify(receipt) !== true) return { ok: false, reason: 'forged' };
  return { ok: true, receipt };
}

/** Run the context-only public projection port; it is never a task lifecycle. */
function projectContextProjection(receipt, { project } = {}) {
  if (typeof project !== 'function') return { status: 'unavailable' };
  try {
    const result = project(receipt);
    const status = result && result.status;
    if (!['projected', 'deduped', 'denied', 'unavailable'].includes(status)) return { status: 'unavailable' };
    return status === 'projected' || status === 'deduped'
      ? { status, contextKey: receipt.contextKey }
      : { status };
  } catch {
    return { status: 'unavailable' };
  }
}

module.exports = {
  CAPABILITY_TYPE,
  PURPOSE,
  AUDIENCE,
  INPUT_FIELDS,
  RECEIPT_FIELDS,
  deriveContextKey,
  issueProjectContext,
  verifyProjectContext,
  projectContextProjection,
};
