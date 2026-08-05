'use strict';

/**
 * Portable protected-resource mutation policy for jarvOS Control Plane.
 *
 * Public surface only: resource identity, mutation class, owning adapter,
 * decision/reason, and evidence/provenance concepts. Absolute personal paths
 * and runtime wiring belong in private host adapters.
 */

const {
  CONTRACT_VERSION,
  createEvidence,
  createPolicyDecision,
  digest,
} = require('../contracts');

const PROTECTED_RESOURCE_SCHEMA_VERSION = 'jarvos-control-plane.protected-resource.v1';
const PROTECTED_DECISION_SCHEMA_VERSION = 'jarvos-control-plane.protected-decision.v1';

const MUTATION_KINDS = Object.freeze([
  'raw-filesystem-write',
  'raw-filesystem-edit',
  'named-operation',
  'unknown',
]);

const DECISION_OUTCOMES = Object.freeze(['allow', 'deny', 'fail_closed']);

const IDENTITY_MATCHER_KINDS = Object.freeze([
  'daily-journal-file',
  'basename-pattern',
  'path-segment',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeAllowedOperations(operations) {
  if (!Array.isArray(operations)) {
    throw new Error('allowedOperations must be an array');
  }
  const normalized = [];
  const seen = new Set();
  for (const entry of operations) {
    let operationId;
    let owningAdapter = null;
    if (typeof entry === 'string') {
      operationId = assertNonEmptyString(entry, 'allowedOperations entry');
    } else if (isObject(entry)) {
      operationId = assertNonEmptyString(entry.id || entry.operation || entry.mutationClass, 'allowedOperations.id');
      if (entry.owningAdapter) owningAdapter = assertNonEmptyString(entry.owningAdapter, 'allowedOperations.owningAdapter');
    } else {
      throw new Error('allowedOperations entries must be strings or objects');
    }
    if (seen.has(operationId)) continue;
    seen.add(operationId);
    normalized.push({ id: operationId, owningAdapter });
  }
  return normalized;
}

function normalizeIdentityMatcher(matcher = {}) {
  if (!isObject(matcher)) throw new Error('identityMatcher must be an object');
  const kind = assertNonEmptyString(matcher.kind || 'daily-journal-file', 'identityMatcher.kind');
  if (!IDENTITY_MATCHER_KINDS.includes(kind)) {
    throw new Error(`identityMatcher.kind must be one of: ${IDENTITY_MATCHER_KINDS.join(', ')}`);
  }
  const normalized = { kind };
  if (kind === 'daily-journal-file') {
    normalized.parentName = assertNonEmptyString(matcher.parentName || 'Journal', 'identityMatcher.parentName');
    normalized.basenamePattern = assertNonEmptyString(
      matcher.basenamePattern || '^\\d{4}-\\d{2}-\\d{2}\\.md$',
      'identityMatcher.basenamePattern',
    );
  } else if (kind === 'basename-pattern') {
    normalized.basenamePattern = assertNonEmptyString(matcher.basenamePattern, 'identityMatcher.basenamePattern');
    if (matcher.parentName) normalized.parentName = assertNonEmptyString(matcher.parentName, 'identityMatcher.parentName');
  } else if (kind === 'path-segment') {
    normalized.segment = assertNonEmptyString(matcher.segment, 'identityMatcher.segment');
    normalized.mode = matcher.mode === 'contains' ? 'contains' : 'equals';
  }
  return normalized;
}

function normalizeSanctionedRoute(route = {}) {
  if (!isObject(route)) throw new Error('sanctionedRoute must be an object');
  return {
    summary: typeof route.summary === 'string' ? route.summary : 'Use the resource-owned mutation adapter',
    message: typeof route.message === 'string' ? route.message : '',
    commands: Array.isArray(route.commands) ? route.commands.map((item) => String(item)) : [],
    operations: Array.isArray(route.operations) ? route.operations.map((item) => String(item)) : [],
  };
}

/**
 * Create a portable protected-resource definition.
 * Must not include absolute personal filesystem paths.
 */
function createProtectedResourceDefinition(input = {}) {
  if (!isObject(input)) throw new Error('protected resource definition must be an object');
  const resourceId = assertNonEmptyString(input.resourceId || input.id, 'resourceId');
  const resourceType = assertNonEmptyString(input.resourceType || input.type || resourceId, 'resourceType');
  const owningAdapter = assertNonEmptyString(input.owningAdapter, 'owningAdapter');
  const definition = {
    schemaVersion: input.schemaVersion || PROTECTED_RESOURCE_SCHEMA_VERSION,
    contractVersion: input.contractVersion || CONTRACT_VERSION,
    resourceId,
    resourceType,
    displayName: input.displayName || resourceId,
    owningAdapter,
    mutationClasses: Array.isArray(input.mutationClasses)
      ? input.mutationClasses.map((item) => assertNonEmptyString(item, 'mutationClasses entry'))
      : [],
    allowedOperations: normalizeAllowedOperations(input.allowedOperations || []),
    identityMatcher: normalizeIdentityMatcher(input.identityMatcher || input.match || {}),
    sanctionedRoute: normalizeSanctionedRoute(input.sanctionedRoute || {}),
    sensitivity: input.sensitivity || { level: 'private' },
    provenance: input.provenance || null,
  };

  if (definition.schemaVersion !== PROTECTED_RESOURCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported protected-resource schemaVersion: ${definition.schemaVersion}`);
  }
  if (definition.allowedOperations.length === 0 && definition.mutationClasses.length === 0) {
    throw new Error('protected resources require allowedOperations or mutationClasses');
  }
  if (definition.mutationClasses.length === 0) {
    definition.mutationClasses = definition.allowedOperations.map((operation) => operation.id);
  }
  validateProtectedResourceDefinition(definition);
  return definition;
}

function validateProtectedResourceDefinition(definition = {}) {
  if (!isObject(definition)) throw new Error('protected resource definition must be an object');
  if (definition.schemaVersion !== PROTECTED_RESOURCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported protected-resource schemaVersion: ${definition.schemaVersion}`);
  }
  assertNonEmptyString(definition.resourceId, 'resourceId');
  assertNonEmptyString(definition.resourceType, 'resourceType');
  assertNonEmptyString(definition.owningAdapter, 'owningAdapter');
  normalizeAllowedOperations(definition.allowedOperations || []);
  normalizeIdentityMatcher(definition.identityMatcher || {});
  return { ok: true, definition };
}

/**
 * Match a portable path identity (segment list + basename) against a definition.
 * Host adapters supply already-canonicalized segments; absolute roots stay private.
 */
function matchProtectedResourceIdentity(definition, identity = {}) {
  const def = createProtectedResourceDefinition(definition);
  const matcher = def.identityMatcher;
  const basename = typeof identity.basename === 'string' ? identity.basename : '';
  const parentName = typeof identity.parentName === 'string' ? identity.parentName : '';
  const segments = Array.isArray(identity.segments)
    ? identity.segments.map((segment) => String(segment))
    : [];

  if (matcher.kind === 'daily-journal-file' || matcher.kind === 'basename-pattern') {
    let basenameOk = false;
    try {
      basenameOk = new RegExp(matcher.basenamePattern).test(basename);
    } catch {
      return { matched: false, reason: 'invalid-basename-pattern' };
    }
    if (!basenameOk) return { matched: false, reason: 'basename-mismatch' };
    if (matcher.parentName && parentName !== matcher.parentName) {
      // Also accept when the parent segment appears as the last directory segment.
      const lastDir = segments.length >= 2 ? segments[segments.length - 2] : parentName;
      if (lastDir !== matcher.parentName) {
        return { matched: false, reason: 'parent-mismatch' };
      }
    }
    return {
      matched: true,
      resourceId: def.resourceId,
      resourceType: def.resourceType,
      owningAdapter: def.owningAdapter,
      identity: {
        basename,
        parentName: matcher.parentName || parentName,
        date: matcher.kind === 'daily-journal-file' ? basename.replace(/\.md$/i, '') : null,
      },
    };
  }

  if (matcher.kind === 'path-segment') {
    const hit = matcher.mode === 'contains'
      ? segments.some((segment) => segment.includes(matcher.segment))
      : segments.includes(matcher.segment);
    return hit
      ? {
          matched: true,
          resourceId: def.resourceId,
          resourceType: def.resourceType,
          owningAdapter: def.owningAdapter,
          identity: { segments },
        }
      : { matched: false, reason: 'segment-mismatch' };
  }

  return { matched: false, reason: 'unsupported-matcher' };
}

function resolveOperationAllowance(definition, operation) {
  if (!operation) return null;
  const allowed = definition.allowedOperations || [];
  const found = allowed.find((entry) => entry.id === operation);
  if (!found) return null;
  return {
    operation: found.id,
    owningAdapter: found.owningAdapter || definition.owningAdapter,
  };
}

function buildDecisionMessage(definition, outcome, reasonCode) {
  if (outcome === 'allow') {
    return reasonCode === 'unprotected-target'
      ? 'Target is not a protected resource.'
      : `Allowed named operation via owning adapter ${definition?.owningAdapter || 'unknown'}.`;
  }
  const route = definition?.sanctionedRoute || {};
  const commands = (route.commands || []).join('; ');
  const operations = (definition?.allowedOperations || []).map((entry) => entry.id).join(', ');
  if (route.message) return route.message;
  return [
    `Protected resource "${definition?.resourceId || 'unknown'}" blocks raw filesystem mutation.`,
    route.summary || 'Use the resource-owned mutation adapter.',
    operations ? `Allowed operations: ${operations}.` : '',
    commands ? `Sanctioned commands: ${commands}.` : '',
    `Reason: ${reasonCode}.`,
  ].filter(Boolean).join(' ');
}

/**
 * Runtime-neutral protected-resource policy evaluation.
 *
 * @param {object} input
 * @param {object|null} input.resource - protected resource definition when matched
 * @param {object|null} input.resourceMatch - optional precomputed match metadata
 * @param {string} input.mutationKind - raw-filesystem-write|raw-filesystem-edit|named-operation|unknown
 * @param {string|null} input.operation - named operation id when mutationKind is named-operation
 * @param {boolean} input.policyAvailable - false forces fail-closed for protected targets
 * @param {object|null} input.actor - optional actor metadata
 * @param {object|null} input.target - opaque target metadata (no absolute path required)
 * @param {string|null} input.requestId
 * @returns {object} structured decision
 */
function evaluateProtectedMutation(input = {}) {
  if (!isObject(input)) throw new Error('evaluateProtectedMutation input must be an object');

  const mutationKind = input.mutationKind || 'unknown';
  if (!MUTATION_KINDS.includes(mutationKind)) {
    throw new Error(`mutationKind must be one of: ${MUTATION_KINDS.join(', ')}`);
  }

  const policyAvailable = input.policyAvailable !== false;
  const operation = input.operation == null ? null : assertNonEmptyString(String(input.operation), 'operation');
  const resource = input.resource ? createProtectedResourceDefinition(input.resource) : null;
  const resourceMatch = input.resourceMatch || (resource ? { matched: true, resourceId: resource.resourceId } : { matched: false });
  const protectedTarget = Boolean(resource && resourceMatch && resourceMatch.matched !== false);
  const createdAt = input.createdAt || new Date().toISOString();
  const requestId = input.requestId || digest({
    mutationKind,
    operation,
    resourceId: resource?.resourceId || null,
    target: input.target || null,
    createdAt,
  });

  let outcome = 'allow';
  let reasonCode = 'unprotected-target';
  let owningAdapter = null;
  let allowedOperation = null;

  if (!policyAvailable && protectedTarget) {
    outcome = 'fail_closed';
    reasonCode = 'policy-unavailable';
    owningAdapter = resource.owningAdapter;
  } else if (!policyAvailable && input.assumeProtectedOnPolicyOutage) {
    outcome = 'fail_closed';
    reasonCode = 'policy-unavailable';
  } else if (!protectedTarget) {
    outcome = 'allow';
    reasonCode = 'unprotected-target';
  } else if (mutationKind === 'named-operation') {
    allowedOperation = resolveOperationAllowance(resource, operation);
    if (!allowedOperation) {
      outcome = 'deny';
      reasonCode = operation ? 'unknown-operation' : 'missing-operation';
      owningAdapter = resource.owningAdapter;
    } else {
      outcome = 'allow';
      reasonCode = 'named-operation-allowed';
      owningAdapter = allowedOperation.owningAdapter;
    }
  } else if (mutationKind === 'raw-filesystem-write' || mutationKind === 'raw-filesystem-edit') {
    outcome = 'deny';
    reasonCode = mutationKind === 'raw-filesystem-write' ? 'raw-write-denied' : 'raw-edit-denied';
    owningAdapter = resource.owningAdapter;
  } else {
    outcome = 'fail_closed';
    reasonCode = 'unknown-mutation-kind';
    owningAdapter = resource.owningAdapter;
  }

  const message = buildDecisionMessage(resource, outcome, reasonCode);
  const decision = {
    schemaVersion: PROTECTED_DECISION_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    type: 'protected-resource-decision',
    id: digest({ requestId, outcome, reasonCode, createdAt }),
    requestId,
    createdAt,
    outcome,
    reasonCode,
    reason: message,
    message,
    resourceId: resource?.resourceId || null,
    resourceType: resource?.resourceType || null,
    owningAdapter,
    mutationKind,
    operation: operation || null,
    allowedOperation,
    sanctionedRoute: resource?.sanctionedRoute || null,
    policyAvailable,
    protectedTarget,
    actor: input.actor || null,
    target: input.target || null,
    resourceMatch: resourceMatch || null,
    evidence: {
      decisionDigest: null,
      provenance: {
        evaluator: 'jarvos-control-plane.protected-resource',
        contractVersion: CONTRACT_VERSION,
        resourceSchemaVersion: PROTECTED_RESOURCE_SCHEMA_VERSION,
      },
    },
  };
  decision.evidence.decisionDigest = digest({
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    resourceId: decision.resourceId,
    mutationKind: decision.mutationKind,
    operation: decision.operation,
  });

  // Also expose a control-plane policy-decision record shape for reconciliation callers.
  decision.policyDecision = createPolicyDecision({
    requestId,
    outcome: outcome === 'fail_closed' ? 'deny' : outcome,
    reason: message,
    constraints: {
      protectedResource: true,
      reasonCode,
      mutationKind,
      operation: operation || null,
      failClosed: outcome === 'fail_closed',
    },
    evidenceRefs: [decision.evidence.decisionDigest],
    createdAt,
    authority: owningAdapter ? { adapter: owningAdapter } : null,
  });

  return decision;
}

function createProtectedResourceEvidence(input = {}) {
  const decision = input.decision || null;
  return createEvidence({
    commandId: input.commandId || null,
    managerId: input.managerId || decision?.owningAdapter || 'protected-resource-gateway',
    verifier: input.verifier || 'protected-resource-policy',
    outcome: input.outcome || (decision ? `policy_${decision.outcome}` : 'observed'),
    observedAt: input.observedAt || new Date().toISOString(),
    postcondition: input.postcondition || null,
    data: {
      ...(input.data || {}),
      protectedResourceDecision: decision,
    },
    provenance: input.provenance || decision?.evidence?.provenance || null,
  });
}

function createProtectedResourceRegistry(definitions = []) {
  const resources = new Map();
  for (const definition of definitions) {
    const normalized = createProtectedResourceDefinition(definition);
    if (resources.has(normalized.resourceId)) {
      throw new Error(`Duplicate protected resource id: ${normalized.resourceId}`);
    }
    resources.set(normalized.resourceId, normalized);
  }

  function list() {
    return [...resources.values()];
  }

  function get(resourceId) {
    return resources.get(resourceId) || null;
  }

  function matchIdentity(identity) {
    for (const definition of resources.values()) {
      const match = matchProtectedResourceIdentity(definition, identity);
      if (match.matched) {
        return { definition, match };
      }
    }
    return null;
  }

  function evaluate(input = {}) {
    if (input.resourceId && !input.resource) {
      const definition = get(input.resourceId);
      return evaluateProtectedMutation({ ...input, resource: definition });
    }
    if (!input.resource && input.identity) {
      const found = matchIdentity(input.identity);
      if (!found) {
        return evaluateProtectedMutation({
          ...input,
          resource: null,
          resourceMatch: { matched: false },
        });
      }
      return evaluateProtectedMutation({
        ...input,
        resource: found.definition,
        resourceMatch: found.match,
      });
    }
    return evaluateProtectedMutation(input);
  }

  return {
    list,
    get,
    matchIdentity,
    evaluate,
    size: () => resources.size,
  };
}

module.exports = {
  PROTECTED_RESOURCE_SCHEMA_VERSION,
  PROTECTED_DECISION_SCHEMA_VERSION,
  MUTATION_KINDS,
  DECISION_OUTCOMES,
  IDENTITY_MATCHER_KINDS,
  createProtectedResourceDefinition,
  validateProtectedResourceDefinition,
  matchProtectedResourceIdentity,
  evaluateProtectedMutation,
  createProtectedResourceEvidence,
  createProtectedResourceRegistry,
};
