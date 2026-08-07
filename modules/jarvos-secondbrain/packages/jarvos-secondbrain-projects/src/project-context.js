'use strict';

const crypto = require('node:crypto');

const CAPABILITY_TYPE = 'jarvos.project-context/v1';
const PURPOSE = 'managed-software-stewardship';
const AUDIENCE = 'jarvos-projects';
const INPUT_FIELDS = Object.freeze(['findingId', 'executionReference', 'releaseReference', 'visibility']);
const CAPABILITY_FIELDS = Object.freeze([
  'allowedVisibilities', 'audience', 'capabilityRevision', 'destinationSelectors', 'expiresAt',
  'issuedAt', 'purpose', 'type',
]);
const PRIVATE_VISIBILITIES = Object.freeze(['internal', 'mixed', 'private']);

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) { return isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function requiredString(value, name) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`); return value; }
function timestamp(value, name) { requiredString(value, name); if (Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`); return value; }
function privateDestination(selector) { return !/(^|[:._-])(external|public)(?=$|[:._-])/i.test(selector); }

/** Hash stable stewardship identities before crossing the Projects boundary. */
function deriveContextKey(input) {
  if (!exactKeys(input, INPUT_FIELDS)) throw new TypeError('project context input has unsupported fields');
  const canonical = INPUT_FIELDS.map((field) => requiredString(input[field], field)).join('\u0000');
  return `pcx_${crypto.createHash('sha256').update(`${CAPABILITY_TYPE}\u0000${canonical}`).digest('base64url')}`;
}

function validateSelectors(selectors) {
  if (!Array.isArray(selectors) || selectors.length !== 1 || selectors.some((selector) => typeof selector !== 'string' || !selector.trim())) throw new TypeError('destinationSelectors must contain one private/internal destination');
  if (selectors.some((selector) => selector.includes('/') || selector.includes('\\') || !privateDestination(selector))) throw new TypeError('destinationSelectors must contain one private/internal destination');
  return [...new Set(selectors)];
}

function validateVisibilities(visibilities) {
  if (!Array.isArray(visibilities) || !visibilities.length || visibilities.some((visibility) => !PRIVATE_VISIBILITIES.includes(visibility))) throw new TypeError('allowedVisibilities must be a non-empty private/internal or mixed array');
  return [...new Set(visibilities)].sort();
}

/** Shape a portable capability. No signer, vault, activation, or key state exists here. */
function issueProjectContext({ authorization, destinationSelectors, allowedVisibilities, capabilityRevision, issuedAt, expiresAt } = {}) {
  if (!authorization || authorization.allowed !== true) return { status: 'denied' };
  const capability = {
    type: CAPABILITY_TYPE,
    purpose: PURPOSE,
    audience: AUDIENCE,
    destinationSelectors: validateSelectors(destinationSelectors),
    allowedVisibilities: validateVisibilities(allowedVisibilities),
    capabilityRevision: requiredString(capabilityRevision, 'capabilityRevision'),
    issuedAt: timestamp(issuedAt, 'issuedAt'),
    expiresAt: timestamp(expiresAt, 'expiresAt'),
  };
  if (Date.parse(capability.expiresAt) <= Date.parse(capability.issuedAt)) throw new RangeError('expiresAt must be after issuedAt');
  return capability;
}

/** Verify portable bounded-policy facts; private host admission binds owner-only material. */
function verifyProjectContext(capability, { now = new Date().toISOString() } = {}) {
  if (!exactKeys(capability, CAPABILITY_FIELDS) || capability.type !== CAPABILITY_TYPE || capability.purpose !== PURPOSE || capability.audience !== AUDIENCE || typeof capability.capabilityRevision !== 'string' || Number.isNaN(Date.parse(capability.issuedAt)) || Number.isNaN(Date.parse(capability.expiresAt))) return { ok: false, reason: 'invalid-contract' };
  try { validateSelectors(capability.destinationSelectors); validateVisibilities(capability.allowedVisibilities); } catch (_) { return { ok: false, reason: 'invalid-contract' }; }
  const current = Date.parse(now);
  if (Number.isNaN(current)) return { ok: false, reason: 'invalid-contract' };
  if (current < Date.parse(capability.issuedAt)) return { ok: false, reason: 'not-yet-valid' };
  if (current >= Date.parse(capability.expiresAt)) return { ok: false, reason: 'expired' };
  return { ok: true, capability };
}

/** Run the context-only public projection port; it is never a task lifecycle. */
function projectContextProjection(capability, input, { now, project } = {}) {
  if (typeof project !== 'function') return { status: 'unavailable' };
  let contextKey;
  try { contextKey = deriveContextKey(input); } catch (_) { return { status: 'unavailable' }; }
  if (!verifyProjectContext(capability, { now }).ok) return { status: 'unavailable' };
  if (!capability.allowedVisibilities.includes(input.visibility)) return { status: 'denied' };
  try {
    const result = project({ capability, context: { contextKey, visibility: input.visibility } });
    const status = result && result.status;
    if (!['projected', 'deduped', 'denied', 'unavailable'].includes(status)) return { status: 'unavailable' };
    return status === 'projected' || status === 'deduped' ? { status, contextKey } : { status };
  } catch (_) { return { status: 'unavailable' }; }
}

module.exports = { AUDIENCE, CAPABILITY_FIELDS, CAPABILITY_TYPE, INPUT_FIELDS, PRIVATE_VISIBILITIES, PURPOSE, deriveContextKey, issueProjectContext, projectContextProjection, verifyProjectContext };
