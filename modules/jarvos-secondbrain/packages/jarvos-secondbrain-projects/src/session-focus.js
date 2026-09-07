'use strict';

// Pure session-focus resolver: no filesystem, store, session-state file,
// Beads mutation, or registry mutation. Every input (principal, claim,
// execution link, existing binding, current canonical evidence, workspace
// link) is protected host evidence already fetched by the caller. This
// module only decides, from that evidence, what a session may focus on and
// whether that focus is writable.

const crypto = require('node:crypto');
const { validateExecutionReference } = require('./provider-contracts');

const SESSION_FOCUS_PRINCIPAL_CONTRACT = 'jarvos.session-focus-principal/v1';
const SESSION_FOCUS_BINDING_CONTRACT = 'jarvos.session-focus-binding/v1';
const SESSION_FOCUS_PROFILE = 'session-focus';

const PRINCIPAL_FIELDS = Object.freeze([
  'contract', 'route', 'profile', 'authorized', 'harnessId', 'sessionId', 'actorId',
  'workspaceId', 'workspaceDigest', 'tupleDigest', 'issuedAt', 'expiresAt', 'nonce', 'signature',
]);
const BINDING_FIELDS = Object.freeze([
  'contract', 'harnessId', 'sessionId', 'workspaceDigest', 'canonicalId', 'childCanonicalId',
  'workItemId', 'lastContextStamp', 'lastWorkRevision', 'lastPacketFingerprint',
]);
const CLAIM_FIELDS = Object.freeze(['workspaceId', 'itemId', 'revision', 'actorId']);
const WORKSPACE_LINK_FIELDS = Object.freeze(['canonicalId', 'childCanonicalId']);
const CURRENT_CANONICAL_FIELDS = Object.freeze([
  'canonicalId', 'canonicalKind', 'canonicalRevision', 'rootProjectId', 'breadcrumb', 'quarantined',
]);
const FOCUS_SOURCES = Object.freeze(['claim', 'binding', 'workspace-link', 'workspace-only', 'portfolio']);
const FOCUS_ACCESS = Object.freeze(['owned', 'read-only']);

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

function timestamp(value, field) {
  requiredString(value, field);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function opaque(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /\s|[\\/]|:\/\//.test(value)) {
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  return value.trim();
}

function nullableOpaque(value, field) {
  return value === null ? null : opaque(value, field);
}

function nullableString(value, field) {
  return value === null ? null : requiredString(value, field);
}

function validateCanonicalId(value, field) {
  const normalized = requiredString(value, field);
  if (!/^(?:prj|out)_[0-9]{6,}$/.test(normalized)) throw new TypeError(`${field} must be a canonical project or outcome ID`);
  return normalized;
}

function nullableCanonicalId(value, field) {
  return value === null ? null : validateCanonicalId(value, field);
}

function validateDigest(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a sha256 digest`);
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

// Every HMAC/signing/workspace-digest path runs through here. An empty
// string, empty Buffer, or empty Uint8Array is indistinguishable from "no
// secret" and must never silently produce a verifiable signature.
function isNonEmptySecret(secret) {
  if (typeof secret === 'string') return secret.length > 0;
  if (Buffer.isBuffer(secret) || secret instanceof Uint8Array) return secret.length > 0;
  return false;
}

function hmac(value, secret) {
  if (!isNonEmptySecret(secret)) throw new TypeError('hostSecret must be a non-empty string or byte array');
  return crypto.createHmac('sha256', secret).update(stableStringify(value)).digest('base64url');
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionFocusWorkspaceDigest(workspaceId, hostSecret) {
  return hmac({ contract: SESSION_FOCUS_PRINCIPAL_CONTRACT, kind: 'workspace-digest', workspaceId: opaque(workspaceId, 'workspaceId') }, hostSecret);
}

function unsignedPrincipalFields(principal) {
  return Object.fromEntries(PRINCIPAL_FIELDS.filter((field) => field !== 'signature').map((field) => [field, principal[field]]));
}

// Shape-only normalization. This never decides whether a principal is
// authorized to resolve focus -- that is verifySessionFocusPrincipal's job,
// and every rejection there collapses to one non-enumerating reason.
function validateSessionFocusPrincipal(principal) {
  if (!exactKeys(principal, PRINCIPAL_FIELDS)) throw new TypeError('session-focus principal has unsupported fields');
  if (principal.contract !== SESSION_FOCUS_PRINCIPAL_CONTRACT) throw new TypeError('session-focus principal has an unsupported contract');
  if (typeof principal.authorized !== 'boolean') throw new TypeError('session-focus principal authorized must be boolean');
  const normalized = {
    contract: SESSION_FOCUS_PRINCIPAL_CONTRACT,
    route: opaque(principal.route, 'principal.route'),
    profile: requiredString(principal.profile, 'principal.profile'),
    authorized: principal.authorized,
    harnessId: opaque(principal.harnessId, 'principal.harnessId'),
    sessionId: nullableOpaque(principal.sessionId, 'principal.sessionId'),
    actorId: opaque(principal.actorId, 'principal.actorId'),
    workspaceId: opaque(principal.workspaceId, 'principal.workspaceId'),
    workspaceDigest: requiredString(principal.workspaceDigest, 'principal.workspaceDigest'),
    tupleDigest: validateDigest(principal.tupleDigest, 'principal.tupleDigest'),
    issuedAt: timestamp(principal.issuedAt, 'principal.issuedAt'),
    expiresAt: timestamp(principal.expiresAt, 'principal.expiresAt'),
    nonce: requiredString(principal.nonce, 'principal.nonce'),
    signature: requiredString(principal.signature, 'principal.signature'),
  };
  if (Date.parse(normalized.expiresAt) <= Date.parse(normalized.issuedAt)) throw new RangeError('principal.expiresAt must be after principal.issuedAt');
  return normalized;
}

// The private host issues this envelope after capability validation. Public
// callers cannot self-authorize merely by knowing IDs: the signature and the
// workspace digest are both keyed by a host secret the caller never receives
// or persists.
function createSessionFocusPrincipal({
  hostSecret,
  route,
  profile = SESSION_FOCUS_PROFILE,
  harnessId,
  sessionId,
  actorId,
  workspaceId,
  tupleDigest,
  issuedAt,
  expiresAt,
  nonce = crypto.randomBytes(16).toString('base64url'),
} = {}) {
  const unsigned = {
    contract: SESSION_FOCUS_PRINCIPAL_CONTRACT,
    route: opaque(route, 'route'),
    profile: requiredString(profile, 'profile'),
    authorized: true,
    harnessId: opaque(harnessId, 'harnessId'),
    sessionId: nullableOpaque(sessionId, 'sessionId'),
    actorId: opaque(actorId, 'actorId'),
    workspaceId: opaque(workspaceId, 'workspaceId'),
    workspaceDigest: sessionFocusWorkspaceDigest(workspaceId, hostSecret),
    tupleDigest: validateDigest(tupleDigest, 'tupleDigest'),
    issuedAt: timestamp(issuedAt, 'issuedAt'),
    expiresAt: timestamp(expiresAt, 'expiresAt'),
    nonce: requiredString(nonce, 'nonce'),
  };
  if (Date.parse(unsigned.expiresAt) <= Date.parse(unsigned.issuedAt)) throw new RangeError('expiresAt must be after issuedAt');
  const signature = hmac(unsigned, hostSecret);
  return validateSessionFocusPrincipal({ ...unsigned, signature });
}

function verifySessionFocusPrincipal(principal, {
  hostSecret,
  expectedProfile = SESSION_FOCUS_PROFILE,
  expectedRoute,
  expectedTupleDigest,
  now = new Date().toISOString(),
} = {}) {
  try {
    const normalized = validateSessionFocusPrincipal(principal);
    if (!isNonEmptySecret(hostSecret)) return { ok: false, reason: 'unauthorized' };
    if (normalized.authorized !== true) return { ok: false, reason: 'unauthorized' };
    if (normalized.profile !== expectedProfile) return { ok: false, reason: 'unauthorized' };
    // Route and tuple are required verification inputs, not optional
    // filters: a caller that omits either can never authenticate a
    // principal, and a principal signed for a different route or tuple is
    // rejected the same non-enumerating way as a forged signature.
    if (typeof expectedRoute !== 'string' || !expectedRoute.trim() || normalized.route !== expectedRoute) return { ok: false, reason: 'unauthorized' };
    if (typeof expectedTupleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedTupleDigest) || normalized.tupleDigest !== expectedTupleDigest) return { ok: false, reason: 'unauthorized' };
    const expectedSignature = hmac(unsignedPrincipalFields(normalized), hostSecret);
    if (!constantTimeEqual(expectedSignature, normalized.signature)) return { ok: false, reason: 'unauthorized' };
    const expectedWorkspaceDigest = sessionFocusWorkspaceDigest(normalized.workspaceId, hostSecret);
    if (!constantTimeEqual(expectedWorkspaceDigest, normalized.workspaceDigest)) return { ok: false, reason: 'unauthorized' };
    const current = Date.parse(now);
    if (Number.isNaN(current)) return { ok: false, reason: 'unauthorized' };
    if (current < Date.parse(normalized.issuedAt) || current >= Date.parse(normalized.expiresAt)) return { ok: false, reason: 'unauthorized' };
    return { ok: true, principal: normalized };
  } catch (_) {
    return { ok: false, reason: 'unauthorized' };
  }
}

function validateSessionFocusClaim(claim) {
  if (!exactKeys(claim, CLAIM_FIELDS)) throw new TypeError('session-focus claim has unsupported fields');
  return {
    workspaceId: opaque(claim.workspaceId, 'claim.workspaceId'),
    itemId: requiredString(claim.itemId, 'claim.itemId'),
    revision: requiredString(claim.revision, 'claim.revision'),
    actorId: opaque(claim.actorId, 'claim.actorId'),
  };
}

function validateSessionFocusBinding(binding) {
  if (!exactKeys(binding, BINDING_FIELDS)) throw new TypeError('session-focus binding has unsupported fields');
  if (binding.contract !== SESSION_FOCUS_BINDING_CONTRACT) throw new TypeError('session-focus binding has an unsupported contract');
  const canonicalId = validateCanonicalId(binding.canonicalId, 'binding.canonicalId');
  if (!canonicalId.startsWith('prj_')) throw new TypeError('binding.canonicalId must identify a Project');
  return {
    contract: SESSION_FOCUS_BINDING_CONTRACT,
    harnessId: opaque(binding.harnessId, 'binding.harnessId'),
    sessionId: opaque(binding.sessionId, 'binding.sessionId'),
    workspaceDigest: requiredString(binding.workspaceDigest, 'binding.workspaceDigest'),
    canonicalId,
    childCanonicalId: nullableCanonicalId(binding.childCanonicalId, 'binding.childCanonicalId'),
    workItemId: nullableString(binding.workItemId, 'binding.workItemId'),
    lastContextStamp: nullableString(binding.lastContextStamp, 'binding.lastContextStamp'),
    lastWorkRevision: nullableString(binding.lastWorkRevision, 'binding.lastWorkRevision'),
    lastPacketFingerprint: nullableString(binding.lastPacketFingerprint, 'binding.lastPacketFingerprint'),
  };
}

// Additive pure factory: no filesystem, store, binding-candidate side
// effect, or persistence of any kind. It only stamps the binding contract
// and delegates entirely to shape validation; the private session bridge
// CAS is what actually attaches a validated value to a session. A weak
// session (sessionId: null) can never be the input here -- binding
// validation itself rejects it, since a binding always requires a stable
// session identity.
function createSessionFocusBinding(input) {
  if (!isPlainObject(input) || Object.prototype.hasOwnProperty.call(input, 'contract')) {
    throw new TypeError('session-focus binding input must not assert its own contract');
  }
  return validateSessionFocusBinding({ ...input, contract: SESSION_FOCUS_BINDING_CONTRACT });
}

function validateSessionFocusWorkspaceLink(link) {
  if (!exactKeys(link, WORKSPACE_LINK_FIELDS)) throw new TypeError('session-focus workspace link has unsupported fields');
  const canonicalId = validateCanonicalId(link.canonicalId, 'workspaceLink.canonicalId');
  if (!canonicalId.startsWith('prj_')) throw new TypeError('workspaceLink.canonicalId must identify a Project');
  return {
    canonicalId,
    childCanonicalId: nullableCanonicalId(link.childCanonicalId, 'workspaceLink.childCanonicalId'),
  };
}

// The shape of a freshly re-read (not binding-cached) canonical registry
// record, exactly as needed to prove a target ID is still current, still
// rooted where a binding or claim expects, and not quarantined.
function validateCurrentCanonicalRecord(record) {
  if (!exactKeys(record, CURRENT_CANONICAL_FIELDS)) throw new TypeError('current canonical record has unsupported fields');
  const canonicalId = validateCanonicalId(record.canonicalId, 'currentCanonical.canonicalId');
  const rootProjectId = validateCanonicalId(record.rootProjectId, 'currentCanonical.rootProjectId');
  if (!rootProjectId.startsWith('prj_')) throw new TypeError('currentCanonical.rootProjectId must identify a Project');
  if (!['project', 'outcome'].includes(record.canonicalKind)) throw new TypeError('currentCanonical.canonicalKind is invalid');
  if ((record.canonicalKind === 'project') !== canonicalId.startsWith('prj_')) throw new TypeError('currentCanonical kind and id do not agree');
  if (!Number.isInteger(record.canonicalRevision) || record.canonicalRevision < 1) throw new TypeError('currentCanonical.canonicalRevision is invalid');
  if (typeof record.quarantined !== 'boolean') throw new TypeError('currentCanonical.quarantined must be boolean');
  return {
    canonicalId,
    canonicalKind: record.canonicalKind,
    canonicalRevision: record.canonicalRevision,
    rootProjectId,
    breadcrumb: requiredString(record.breadcrumb, 'currentCanonical.breadcrumb'),
    quarantined: record.quarantined,
  };
}

function lookupCurrentCanonical(records, targetId) {
  if (!isPlainObject(records) || !Object.prototype.hasOwnProperty.call(records, targetId)) return null;
  try {
    const record = validateCurrentCanonicalRecord(records[targetId]);
    return record.canonicalId === targetId ? record : null;
  } catch (_) {
    return null;
  }
}

function buildFocusScope(canonicalId, childCanonicalId) {
  if (!canonicalId) return { projectIds: [], outcomeIds: [], includeDescendants: true };
  const targetId = childCanonicalId || canonicalId;
  const isOutcome = targetId.startsWith('out_');
  return {
    projectIds: isOutcome ? [] : [targetId],
    outcomeIds: isOutcome ? [targetId] : [],
    includeDescendants: true,
  };
}

function focusCandidate({
  source, access, canonicalId, childCanonicalId = null, workItemId = null, breadcrumb,
}) {
  return {
    source, access, canonicalId, childCanonicalId, workItemId, breadcrumb,
    scope: buildFocusScope(canonicalId, childCanonicalId),
  };
}

// Priority 1 (R7): an exact active claim in the workspace, regardless of
// owner, plus its canonical execution link. Unlike a stale/foreign binding,
// a claim that is present but inconsistent is a typed conflict and never
// falls through to a lower-priority branch.
function evaluateClaim({
  claim, executionLink, principal, currentCanonicalRecords,
}) {
  let normalizedClaim;
  let normalizedLink;
  try {
    normalizedClaim = validateSessionFocusClaim(claim);
    normalizedLink = validateExecutionReference(executionLink).reference;
  } catch (_) {
    return { candidate: null, conflict: 'FOCUS_CLAIM_INVALID' };
  }
  if (normalizedClaim.workspaceId !== principal.workspaceId || normalizedLink.workspaceId !== principal.workspaceId) {
    return { candidate: null, conflict: 'FOCUS_CLAIM_WORKSPACE_MISMATCH' };
  }
  if (normalizedClaim.itemId !== normalizedLink.itemId) {
    return { candidate: null, conflict: 'FOCUS_CLAIM_ITEM_MISMATCH' };
  }
  if (normalizedClaim.revision !== normalizedLink.itemRevision) {
    return { candidate: null, conflict: 'FOCUS_CLAIM_STALE' };
  }
  const record = lookupCurrentCanonical(currentCanonicalRecords, normalizedLink.canonical.id);
  if (!record || record.quarantined === true) {
    return { candidate: null, conflict: 'FOCUS_CLAIM_CANONICAL_MISMATCH' };
  }
  // The execution link's canonical revision must be exactly current, not
  // just present: a claim item revision can match while the canonical
  // record it points at has since moved on.
  if (record.canonicalRevision !== normalizedLink.canonical.revision) {
    return { candidate: null, conflict: 'FOCUS_CLAIM_CANONICAL_STALE' };
  }
  const canonicalId = record.rootProjectId;
  const childCanonicalId = record.canonicalId === record.rootProjectId ? null : record.canonicalId;
  // A weak session (principal.sessionId === null) can resolve a claim into
  // useful focus but can never own it, even when the actor matches exactly.
  const owned = normalizedClaim.actorId === principal.actorId && principal.sessionId !== null;
  return {
    candidate: focusCandidate({
      source: 'claim',
      access: owned ? 'owned' : 'read-only',
      canonicalId,
      childCanonicalId,
      workItemId: normalizedClaim.itemId,
      breadcrumb: record.breadcrumb,
    }),
    conflict: null,
  };
}

// Priority 2 (R7): an existing verified session binding. Once the host
// supplies an existingBinding, any problem with it -- malformed shape,
// foreign harness/session/workspace, missing/wrong-root current canonical
// evidence, or a quarantined current record -- is a terminal typed conflict.
// It never silently falls through to workspace link or portfolio: a broken
// binding for this exact session is host-visible evidence of a problem, not
// an invitation to guess a different focus.
function evaluateBinding({ binding, principal, currentCanonicalRecords }) {
  let normalized;
  try {
    normalized = validateSessionFocusBinding(binding);
  } catch (_) {
    return { candidate: null, conflict: 'FOCUS_BINDING_INVALID' };
  }
  if (normalized.harnessId !== principal.harnessId
    || normalized.sessionId !== principal.sessionId
    || normalized.workspaceDigest !== principal.workspaceDigest) {
    return { candidate: null, conflict: 'FOCUS_BINDING_MISMATCH' };
  }
  const targetId = normalized.childCanonicalId || normalized.canonicalId;
  const record = lookupCurrentCanonical(currentCanonicalRecords, targetId);
  if (!record || record.rootProjectId !== normalized.canonicalId || record.quarantined === true) {
    return { candidate: null, conflict: 'FOCUS_BINDING_CANONICAL_MISMATCH' };
  }
  return {
    candidate: focusCandidate({
      source: 'binding',
      access: 'read-only',
      canonicalId: normalized.canonicalId,
      childCanonicalId: normalized.childCanonicalId,
      workItemId: normalized.workItemId,
      breadcrumb: record.breadcrumb,
    }),
    conflict: null,
  };
}

// Priority 3 (R7): an unambiguous workspace/repository link stored on the
// canonical Project record. The caller resolves ambiguity/absence before
// calling this module (session-focus.js performs no registry lookups); pass
// null when no link exists and the string 'ambiguous' when more than one
// canonical Project record claims the same workspace. Once a workspace link
// value (other than null/absent) is supplied, ambiguity, a malformed link,
// or stale/quarantined current canonical evidence is a terminal typed
// conflict -- only a genuinely absent link falls through to the unknown
// portfolio/workspace-only fallback.
function evaluateWorkspaceLink({ workspaceLink, currentCanonicalRecords }) {
  let normalized;
  try {
    normalized = validateSessionFocusWorkspaceLink(workspaceLink);
  } catch (_) {
    return { candidate: null, conflict: 'FOCUS_WORKSPACE_LINK_INVALID' };
  }
  const targetId = normalized.childCanonicalId || normalized.canonicalId;
  const record = lookupCurrentCanonical(currentCanonicalRecords, targetId);
  if (!record || record.rootProjectId !== normalized.canonicalId || record.quarantined === true) {
    return { candidate: null, conflict: 'FOCUS_WORKSPACE_LINK_STALE' };
  }
  return {
    candidate: focusCandidate({
      source: 'workspace-link',
      access: 'read-only',
      canonicalId: normalized.canonicalId,
      childCanonicalId: normalized.childCanonicalId,
      breadcrumb: record.breadcrumb,
    }),
    conflict: null,
  };
}

function portfolioFocus() {
  return focusCandidate({
    source: 'portfolio', access: 'read-only', canonicalId: null, childCanonicalId: null, breadcrumb: null,
  });
}

// A weak session (principal.sessionId === null) with no exact claim or
// workspace-link evidence gets bounded unknown/read-only focus, distinct
// from the stable-session portfolio fallback: it never carries whole-
// portfolio scope inferred from an identity the principal does not actually
// have.
function workspaceOnlyFocus() {
  return focusCandidate({
    source: 'workspace-only', access: 'read-only', canonicalId: null, childCanonicalId: null, breadcrumb: null,
  });
}

// Pure resolution over already-fetched protected host evidence. Only an
// exact actor-owned current claim can ever produce focus.access === 'owned';
// every other branch -- claim by a foreign actor, binding, workspace link,
// or the portfolio fallback -- is read-only.
function resolveSessionFocus(input = {}) {
  const {
    principal,
    hostSecret,
    now = new Date().toISOString(),
    expectedRoute,
    expectedTupleDigest,
    claim = null,
    executionLink = null,
    existingBinding = null,
    currentCanonicalRecords = {},
    workspaceLink = null,
  } = input;

  const verified = verifySessionFocusPrincipal(principal, {
    hostSecret, expectedRoute, expectedTupleDigest, now,
  });
  if (!verified.ok) {
    return {
      status: 'unavailable', code: 'FOCUS_UNAUTHORIZED', reason: 'session focus is unavailable', focus: null,
    };
  }
  const authenticated = verified.principal;

  if (claim !== null && claim !== undefined) {
    const evaluated = evaluateClaim({
      claim, executionLink, principal: authenticated, currentCanonicalRecords,
    });
    if (evaluated.conflict) {
      return {
        status: 'conflict', code: evaluated.conflict, reason: 'session focus conflict', focus: null,
      };
    }
    if (evaluated.candidate) {
      return {
        status: 'ok', code: null, reason: null, focus: evaluated.candidate,
      };
    }
  }

  // A weak session (principal.sessionId === null) has no stable identity to
  // key a binding by and cannot use or create one; an existingBinding
  // supplied alongside a weak-session principal is simply not consulted,
  // not treated as a foreign-binding conflict.
  if (existingBinding !== null && existingBinding !== undefined && authenticated.sessionId !== null) {
    const evaluated = evaluateBinding({ binding: existingBinding, principal: authenticated, currentCanonicalRecords });
    if (evaluated.conflict) {
      return {
        status: 'conflict', code: evaluated.conflict, reason: 'session focus conflict', focus: null,
      };
    }
    if (evaluated.candidate) {
      return {
        status: 'ok', code: null, reason: null, focus: evaluated.candidate,
      };
    }
  }

  if (workspaceLink === 'ambiguous') {
    return {
      status: 'conflict', code: 'FOCUS_WORKSPACE_LINK_AMBIGUOUS', reason: 'session focus conflict', focus: null,
    };
  }
  if (workspaceLink !== null && workspaceLink !== undefined) {
    const evaluated = evaluateWorkspaceLink({ workspaceLink, currentCanonicalRecords });
    if (evaluated.conflict) {
      return {
        status: 'conflict', code: evaluated.conflict, reason: 'session focus conflict', focus: null,
      };
    }
    if (evaluated.candidate) {
      return {
        status: 'ok', code: null, reason: null, focus: evaluated.candidate,
      };
    }
  }

  return {
    status: 'ok',
    code: null,
    reason: null,
    focus: authenticated.sessionId === null ? workspaceOnlyFocus() : portfolioFocus(),
  };
}

module.exports = {
  SESSION_FOCUS_PRINCIPAL_CONTRACT,
  SESSION_FOCUS_BINDING_CONTRACT,
  SESSION_FOCUS_PROFILE,
  PRINCIPAL_FIELDS,
  BINDING_FIELDS,
  CLAIM_FIELDS,
  WORKSPACE_LINK_FIELDS,
  CURRENT_CANONICAL_FIELDS,
  FOCUS_SOURCES,
  FOCUS_ACCESS,
  createSessionFocusPrincipal,
  verifySessionFocusPrincipal,
  validateSessionFocusPrincipal,
  createSessionFocusBinding,
  validateSessionFocusBinding,
  validateSessionFocusClaim,
  validateSessionFocusWorkspaceLink,
  validateCurrentCanonicalRecord,
  sessionFocusWorkspaceDigest,
  resolveSessionFocus,
};
