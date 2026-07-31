'use strict';

const DISPATCH_CONTRACT_VERSION = 'jarvos-harness-dispatch.v1';
const CAPABILITY_PROFILE_VERSION = 'jarvos-harness-capability-profile.v1';
const SESSION_HANDOFF_CONTRACT_VERSION = 'jarvos-harness-session-handoff.v1';
const SOURCE_CLASSES = ['public', 'internal', 'private', 'secret'];
const DISPATCH_MODES = ['split', 'native_gateway'];
const LIFECYCLE_STATUSES = ['accepted', 'completed', 'delivered', 'failed', 'timed_out', 'ambiguous', 'cancelled', 'needs_input'];
const CODING_EXECUTION_AUTHORITIES = ['work-run', 'lease', 'fence', 'worktree', 'pr', 'review'];
const SAFE_CHILD_ENVIRONMENT = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorResult(errors) {
  return { ok: errors.length === 0, errors };
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function hasCodingExecutionAuthority(authorities = []) {
  return authorities.find((authority) => CODING_EXECUTION_AUTHORITIES.includes(String(authority).toLowerCase()));
}

function redactDiagnostics(value) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'sk-[REDACTED]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL)[A-Z0-9_]*)(\s*[:=]\s*)([^\s"']{8,})/gi, '$1$2[REDACTED]');
}

function sanitizeChildEnvironment(environment = process.env, options = {}) {
  const requested = new Set([...SAFE_CHILD_ENVIRONMENT, ...(options.allowlist || [])]);
  const sanitized = {};
  for (const name of requested) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL)/i.test(name)) continue;
    if (typeof environment[name] === 'string') sanitized[name] = environment[name];
  }
  return sanitized;
}

function validateCapabilityProfile(profile) {
  const errors = [];
  if (!isObject(profile)) return errorResult(['capability profile must be an object']);
  if (profile.version !== CAPABILITY_PROFILE_VERSION) errors.push(`capability profile.version must be ${CAPABILITY_PROFILE_VERSION}`);
  if (!profile.harness || typeof profile.harness !== 'string') errors.push('capability profile.harness is required');
  if (!Array.isArray(profile.authorities)) errors.push('capability profile.authorities must be an array');
  const forbidden = hasCodingExecutionAuthority(profile.authorities);
  if (forbidden) errors.push(`capability profile may not grant coding execution authority: ${forbidden}`);
  if (!Array.isArray(profile.toolActions)) {
    errors.push('capability profile.toolActions must be an array');
  } else {
    for (const [index, entry] of profile.toolActions.entries()) {
      if (!isObject(entry) || !entry.tool || !Array.isArray(entry.actions) || entry.actions.length === 0) {
        errors.push(`capability profile.toolActions[${index}] requires tool and non-empty actions`);
        continue;
      }
      if (entry.sourceClasses && (!Array.isArray(entry.sourceClasses) || entry.sourceClasses.some((value) => !SOURCE_CLASSES.includes(value)))) {
        errors.push(`capability profile.toolActions[${index}].sourceClasses must contain known source classes`);
      }
    }
  }
  if (!isObject(profile.egress) || !Array.isArray(profile.egress.providers) || !Array.isArray(profile.egress.endpoints) || !Array.isArray(profile.egress.sourceClasses)) {
    errors.push('capability profile.egress requires providers, endpoints, and sourceClasses arrays');
  } else if (profile.egress.sourceClasses.some((value) => !SOURCE_CLASSES.includes(value) || value === 'secret')) {
    errors.push('capability profile.egress.sourceClasses may contain only non-secret known source classes');
  }
  return errorResult(errors);
}

function validateDispatchIdentity(identity, request) {
  const errors = [];
  if (!isObject(identity)) return ['dispatch identity is required'];
  if (identity.kind !== 'opaque-capability') errors.push('dispatch identity.kind must be opaque-capability');
  for (const field of ['id', 'issuer', 'subject', 'harness', 'interactionWindowId', 'configurationRevision', 'expiresAt']) {
    if (!identity[field] || typeof identity[field] !== 'string') errors.push(`dispatch identity.${field} is required`);
  }
  if (!isSha256(identity.proofDigest)) errors.push('dispatch identity.proofDigest must be a SHA-256 digest');
  if (identity.harness && identity.harness !== request.harness) errors.push('dispatch identity.harness must match request.harness');
  if (identity.interactionWindowId && identity.interactionWindowId !== request.interactionWindowId) errors.push('dispatch identity.interactionWindowId must match request.interactionWindowId');
  if (identity.configurationRevision && identity.configurationRevision !== request.configurationRevision) errors.push('dispatch identity.configurationRevision must match request.configurationRevision');
  return errors;
}

function validateDispatchRequest(request) {
  const errors = [];
  if (!isObject(request)) return errorResult(['dispatch request must be an object']);
  if (request.version !== DISPATCH_CONTRACT_VERSION) errors.push(`dispatch request.version must be ${DISPATCH_CONTRACT_VERSION}`);
  for (const field of ['dispatchId', 'interactionWindowId', 'harness', 'adapterVersion', 'configurationRevision', 'deadlineAt']) {
    if (!request[field] || typeof request[field] !== 'string') errors.push(`dispatch request.${field} is required`);
  }
  if (!DISPATCH_MODES.includes(request.mode)) errors.push(`dispatch request.mode must be one of: ${DISPATCH_MODES.join(', ')}`);
  errors.push(...validateDispatchIdentity(request.identity, request));
  const profileResult = validateCapabilityProfile(request.capabilityProfile);
  errors.push(...profileResult.errors);
  if (request.capabilityProfile?.harness && request.capabilityProfile.harness !== request.harness) errors.push('capability profile.harness must match request.harness');
  if (!isObject(request.context) || !Array.isArray(request.context.sources)) {
    errors.push('dispatch request.context.sources must be an array');
  } else if (request.context.sources.some((source) => !isObject(source) || !SOURCE_CLASSES.includes(source.sourceClass))) {
    errors.push('dispatch request.context.sources must use known source classes');
  }
  for (const field of ['routeIdentity', 'gatewayIdentity', 'routeCredentialRevision']) {
    if (request[field] !== undefined && request[field] !== null
      && (typeof request[field] !== 'string' || !request[field])) {
      errors.push(`dispatch request.${field} must be a non-empty string when provided`);
    }
  }
  const forbidden = hasCodingExecutionAuthority(request.authorities || []);
  if (forbidden) errors.push(`dispatch request may not grant coding execution authority: ${forbidden}`);
  return errorResult(errors);
}

function authorizeToolCall(request, access = {}, options = {}) {
  const validation = validateDispatchRequest(request);
  if (!validation.ok) return { ok: false, code: 'invalid_dispatch_request', errors: validation.errors };
  if (typeof options.verifyIdentity !== 'function' || options.verifyIdentity(request.identity, request) !== true) {
    return { ok: false, code: 'identity_not_authorized' };
  }
  const match = request.capabilityProfile.toolActions.find((entry) => entry.tool === access.tool && entry.actions.includes(access.action));
  if (!match) return { ok: false, code: 'tool_not_allowed' };
  if (access.sourceClass && match.sourceClasses && !match.sourceClasses.includes(access.sourceClass)) {
    return { ok: false, code: 'source_class_not_allowed' };
  }
  return { ok: true, code: 'allowed' };
}

function endpointAllowed(endpoint, configuredEndpoints) {
  try {
    const target = new URL(endpoint);
    return configuredEndpoints.some((configured) => {
      const allowed = new URL(configured);
      const allowedPath = allowed.pathname.replace(/\/$/, '');
      const pathMatches = allowedPath === ''
        || target.pathname === allowedPath
        || target.pathname.startsWith(`${allowedPath}/`);
      return target.origin === allowed.origin && pathMatches;
    });
  } catch {
    return false;
  }
}

function buildEgressPacket(request, destination = {}) {
  const validation = validateDispatchRequest(request);
  if (!validation.ok) return { ok: false, code: 'invalid_dispatch_request', errors: validation.errors };
  const egress = request.capabilityProfile.egress;
  if (!egress.providers.includes(destination.provider) || !endpointAllowed(destination.endpoint, egress.endpoints)) {
    return { ok: false, code: 'egress_not_allowed' };
  }
  const sources = request.context.sources
    .filter((source) => source.sourceClass !== 'secret' && egress.sourceClasses.includes(source.sourceClass))
    .map((source) => ({
      sourceClass: source.sourceClass,
      label: source.label || 'unlabeled-source',
      untrusted: source.untrusted !== false,
      content: redactDiagnostics(source.content),
    }));
  return { ok: true, packet: { version: DISPATCH_CONTRACT_VERSION, provider: destination.provider, endpoint: destination.endpoint, sources } };
}

function createLifecycleReceipt(input = {}) {
  const errors = [];
  if (!input.dispatchId || typeof input.dispatchId !== 'string') errors.push('lifecycle receipt.dispatchId is required');
  if (!DISPATCH_MODES.includes(input.mode)) errors.push(`lifecycle receipt.mode must be one of: ${DISPATCH_MODES.join(', ')}`);
  if (!LIFECYCLE_STATUSES.includes(input.status)) errors.push(`lifecycle receipt.status must be one of: ${LIFECYCLE_STATUSES.join(', ')}`);
  if (input.contentDigest && !isSha256(input.contentDigest)) errors.push('lifecycle receipt.contentDigest must be a SHA-256 digest');
  if (input.mode === 'split' && (input.transportMessageId || input.routeIdentity || input.gatewayIdentity)) {
    errors.push('split lifecycle receipt must not contain transport authority');
  }
  if (input.mode === 'split' && input.status === 'delivered') errors.push('split lifecycle receipt cannot be delivered');
  if (input.mode === 'native_gateway' && input.status === 'delivered') {
    for (const field of ['transportMessageId', 'routeIdentity', 'gatewayIdentity', 'routeCredentialRevision', 'generationSessionReference', 'conversationSessionReference']) {
      if (!input[field] || typeof input[field] !== 'string') errors.push(`native gateway delivered receipt.${field} is required`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    receipt: {
      version: DISPATCH_CONTRACT_VERSION,
      dispatchId: input.dispatchId,
      mode: input.mode,
      status: input.status,
      contentDigest: input.contentDigest || null,
      generationSessionReference: input.generationSessionReference || null,
      conversationSessionReference: input.conversationSessionReference || null,
      transportMessageId: input.transportMessageId || null,
      routeIdentity: input.routeIdentity || null,
      gatewayIdentity: input.gatewayIdentity || null,
      routeCredentialRevision: input.routeCredentialRevision || null,
      diagnostics: redactDiagnostics(input.diagnostics),
    },
  };
}

function validateSessionHandoff(input = {}) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['session handoff must be an object'] };
  if (input.version !== SESSION_HANDOFF_CONTRACT_VERSION) errors.push(`session handoff.version must be ${SESSION_HANDOFF_CONTRACT_VERSION}`);
  for (const field of ['handoffId', 'sourceHarness', 'targetHarness', 'threadId', 'checkpointDigest']) {
    if (!input[field] || typeof input[field] !== 'string') errors.push(`session handoff.${field} is required`);
  }
  if (input.contextDigest && !isSha256(input.contextDigest)) errors.push('session handoff.contextDigest must be a SHA-256 digest');
  if (!isSha256(input.checkpointDigest)) errors.push('session handoff.checkpointDigest must be a SHA-256 digest');
  if (input.transcript !== undefined || input.messages !== undefined || input.rawText !== undefined) {
    errors.push('session handoff may carry references and digests, not raw transcript content');
  }
  if (input.sourceGroups !== undefined && (!Array.isArray(input.sourceGroups) || input.sourceGroups.some((group) => typeof group !== 'string'))) {
    errors.push('session handoff.sourceGroups must be an array of strings');
  }
  return errorResult(errors);
}

function createSessionHandoff(input = {}) {
  const normalized = {
    version: SESSION_HANDOFF_CONTRACT_VERSION,
    handoffId: input.handoffId,
    sourceHarness: input.sourceHarness,
    targetHarness: input.targetHarness,
    threadId: input.threadId,
    checkpointDigest: input.checkpointDigest,
    contextDigest: input.contextDigest || null,
    sourceGroups: Array.isArray(input.sourceGroups) ? [...input.sourceGroups] : [],
    currentWorkIdentity: input.currentWorkIdentity || null,
    sessionReference: input.sessionReference || null,
    evidenceDigest: input.evidenceDigest || null,
  };
  const validation = validateSessionHandoff(normalized);
  if (!validation.ok) return validation;
  return { ok: true, handoff: normalized };
}

module.exports = {
  CAPABILITY_PROFILE_VERSION,
  CODING_EXECUTION_AUTHORITIES,
  DISPATCH_CONTRACT_VERSION,
  DISPATCH_MODES,
  LIFECYCLE_STATUSES,
  SESSION_HANDOFF_CONTRACT_VERSION,
  SOURCE_CLASSES,
  authorizeToolCall,
  buildEgressPacket,
  createLifecycleReceipt,
  createSessionHandoff,
  redactDiagnostics,
  sanitizeChildEnvironment,
  validateSessionHandoff,
  validateCapabilityProfile,
  validateDispatchRequest,
};
