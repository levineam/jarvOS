'use strict';

// Adapter-facing boundary. This service authenticates, applies capability and
// disclosure policy, records approval attestations, and projects data. It does
// not dispatch commands or transition execution lifecycle state; reconciliation
// is the only owner of verified terminal outcomes.
const crypto = require('crypto');
const { createCommand, createRequest, toPublicProjection } = require('./contracts');

const READ_OPERATIONS = new Set(['list', 'inspect', 'evidence', 'approval-state']);
const CODING_READ_OPERATIONS = new Set(['listEvidence']);
const CODING_WORK_RUN_EVIDENCE_VERSION = 'jarvos-control-plane.coding-work-run-evidence.v1';
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CODING_OPERATIONS = new Set(['plan', 'work', 'compound', 'complete']);
const CODING_CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const CODING_PROVIDER_STATUSES = new Set(['verified', 'degraded', 'unsupported', 'unavailable']);
const CODING_PROVIDER_FIELDS = new Set(['id', 'version', 'pinDigest', 'harness', 'adapterVersion', 'status', 'observedAt']);
const CODING_ARTIFACT_FIELDS = new Set(['kind', 'reference', 'digest', 'path']);
const CODING_ARTIFACT_KINDS = new Set(['plan', 'work', 'compound']);
const AUTHORITY_FIELDS = new Set(['branch', 'worktree', 'worktreePath', 'approval', 'submissionReady', 'completion', 'owner', 'authority', 'terminalStatus', 'nextStep', 'pr', 'pullRequest']);
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function redactCodingText(value) {
  return String(value)
    .replace(/(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-)[^\s]+/gi, '[redacted]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
    .replace(/(?:\/|[A-Za-z]:[\\/])[^\s]+/g, '[private-path]');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCodingCode(value, label, { allowNull = true } = {}) {
  if (value === undefined || value === null) {
    if (allowNull) return null;
    throw new Error(`${label} is required`);
  }
  if (typeof value !== 'string' || !CODING_CODE.test(value)) throw new Error(`${label} must be a bounded public code`);
  return value;
}

function projectCodingEvidence(record) {
  return {
    version: CODING_WORK_RUN_EVIDENCE_VERSION,
    evidenceId: record.id,
    workRunId: record.workRunId,
    eventId: record.eventId,
    type: record.type,
    operation: record.operation || null,
    status: record.status || null,
    reasonCode: record.reasonCode || null,
    provider: record.provider ? {
      id: record.provider.id,
      version: record.provider.version,
      pinDigest: record.provider.pinDigest,
      harness: record.provider.harness,
      adapterVersion: record.provider.adapterVersion,
      status: record.provider.status,
    } : null,
    artifact: record.artifact ? {
      kind: record.artifact.kind,
      reference: record.artifact.reference,
      digest: record.artifact.digest,
    } : null,
    detail: Array.isArray(record.detail) ? record.detail.slice(0, 10).map((entry) => redactCodingText(entry).slice(0, 500)) : null,
    at: record.at,
  };
}

function normalizeCodingEvidence(input = {}, principal) {
  if (!isObject(input)) throw new Error('coding work-run evidence must be an object');
  for (const key of Object.keys(input)) {
    if (!['version', 'eventId', 'workRunId', 'type', 'operation', 'status', 'reasonCode', 'provider', 'artifact', 'detail', 'operationNonce', 'at'].includes(key)) {
      throw new Error(`coding work-run evidence.${key} is not allowed`);
    }
    if (AUTHORITY_FIELDS.has(key)) throw new Error(`coding work-run evidence.${key} is an authority-shaped field`);
  }
  if (input.version !== undefined && input.version !== 'jarvos-coding-work-run-event/v1') throw new Error('coding work-run evidence.version is incompatible');
  for (const field of ['eventId', 'workRunId']) if (!OPAQUE_ID.test(input[field] || '')) throw new Error(`coding work-run evidence.${field} must be opaque`);
  if (!['route', 'provider', 'artifact', 'recovery', 'terminal'].includes(input.type)) throw new Error('coding work-run evidence.type is invalid');
  if (input.operation !== undefined && input.operation !== null && !CODING_OPERATIONS.has(input.operation)) throw new Error('coding work-run evidence.operation is invalid');
  const status = normalizeCodingCode(input.status, 'coding work-run evidence.status');
  const reasonCode = normalizeCodingCode(input.reasonCode, 'coding work-run evidence.reasonCode');
  if (input.operationNonce !== undefined && !OPAQUE_ID.test(input.operationNonce || '')) throw new Error('coding work-run evidence.operationNonce must be opaque');
  if (input.provider !== undefined && input.provider !== null) {
    if (!isObject(input.provider)) throw new Error('coding work-run evidence.provider is invalid');
    for (const key of Object.keys(input.provider)) if (!CODING_PROVIDER_FIELDS.has(key)) throw new Error(`coding work-run evidence.provider.${key} is not allowed`);
    if (!OPAQUE_ID.test(input.provider.id || '') || typeof input.provider.version !== 'string' || input.provider.version.length > 64
      || !/^[a-f0-9]{64}$/i.test(input.provider.pinDigest || '') || !OPAQUE_ID.test(input.provider.harness || '')
      || !OPAQUE_ID.test(input.provider.adapterVersion || '') || !CODING_PROVIDER_STATUSES.has(input.provider.status)) {
      throw new Error('coding work-run evidence.provider is invalid');
    }
    if (input.provider.observedAt !== undefined && input.provider.observedAt !== null
      && (typeof input.provider.observedAt !== 'string' || Number.isNaN(Date.parse(input.provider.observedAt)))) {
      throw new Error('coding work-run evidence.provider.observedAt is invalid');
    }
  }
  if (input.artifact !== undefined && input.artifact !== null) {
    if (!isObject(input.artifact)) throw new Error('coding work-run evidence.artifact is invalid');
    for (const key of Object.keys(input.artifact)) if (!CODING_ARTIFACT_FIELDS.has(key)) throw new Error(`coding work-run evidence.artifact.${key} is not allowed`);
    if (!CODING_ARTIFACT_KINDS.has(input.artifact.kind) || typeof input.artifact.reference !== 'string'
      || !/^artifact:[A-Za-z0-9._-]{6,160}$/.test(input.artifact.reference) || !/^[a-f0-9]{64}$/i.test(input.artifact.digest || '')) {
      throw new Error('coding work-run evidence.artifact is invalid');
    }
  }
  const detail = input.detail === undefined || input.detail === null
    ? null
    : Array.isArray(input.detail) ? input.detail : [input.detail];
  if (detail && (detail.length > 10 || detail.some((entry) => typeof entry !== 'string' || entry.length > 500))) throw new Error('coding work-run evidence.detail must contain at most 10 bounded entries');
  return {
    id: id('coding-evidence'),
    version: 'jarvos-coding-work-run-event/v1',
    principal: { id: principal.id },
    workRunId: input.workRunId,
    eventId: input.eventId,
    type: input.type,
    operation: input.operation || null,
    status,
    reasonCode,
    provider: input.provider ? {
      id: input.provider.id,
      version: input.provider.version,
      pinDigest: input.provider.pinDigest,
      harness: input.provider.harness,
      adapterVersion: input.provider.adapterVersion,
      status: input.provider.status,
      observedAt: input.provider.observedAt || null,
    } : null,
    artifact: input.artifact ? {
      kind: input.artifact.kind,
      reference: input.artifact.reference,
      digest: input.artifact.digest,
    } : null,
    detail,
    operationNonce: input.operationNonce || null,
    at: input.at || new Date().toISOString(),
  };
}

function createApplicationService(options = {}) {
  if (!options.store) throw new Error('store is required');
  if (typeof options.resolveCredential !== 'function') throw new Error('resolveCredential is required');
  if (typeof options.canRead !== 'function') throw new Error('canRead policy is required');
  const clock = options.clock || (() => Date.now());
  const policy = options.policy || (() => ({ outcome: 'require_approval' }));
  const decidePolicy = typeof policy === 'function'
    ? policy
    : policy && typeof policy.decide === 'function'
      ? (request, principal) => policy.decide(request, principal)
      : null;
  if (!decidePolicy) throw new Error('policy must be a callback or expose decide');
  const stamp = () => new Date(clock()).toISOString();
  const authenticate = (input) => {
    const trusted = options.resolveCredential(input.credential);
    if (!trusted || !trusted.id) {
      const error = new Error('control-plane authentication failed');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    return { id: trusted.id, capabilities: [...new Set(trusted.capabilities || [])], maxSensitivity: trusted.maxSensitivity || 'internal' };
  };
  const has = (principal, required) => principal.capabilities.includes(required);
  const project = (record, principal) => toPublicProjection(record, { maxSensitivity: principal.maxSensitivity });
  const readable = (principal, record) => options.canRead(principal, record) === true;
  const requireReadable = (principal, record) => {
    if (!readable(principal, record)) throw new Error('control-plane read is not authorized for this record');
  };
  const requestFor = (state, requestId) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error(`request not found: ${requestId}`);
    return request;
  };
  const audit = (state, request, outcome, detail) => {
    const item = {
      id: id('evidence'), requestId: request.id, principal: request.principal,
      sensitivity: { level: (request.sensitivity && request.sensitivity.level) || 'internal' },
      outcome, detail: detail || null, observedAt: stamp(),
    };
    state.evidence.push(item);
    return item;
  };
  const currentFence = (state, actionKey) => (state.keyedFences && state.keyedFences[actionKey]) || 0;
  // Hash a structured tuple: principal identifiers and caller keys may both contain
  // delimiters, so concatenating them can make two distinct identities collide.
  const idempotencyKey = (principal, request, input) => crypto
    .createHash('sha256')
    .update(JSON.stringify([principal.id, input.idempotencyKey || request.actionKey]))
    .digest('hex');
  const maxIdempotencyEntries = Number.isInteger(options.maxIdempotencyEntries) && options.maxIdempotencyEntries > 0
    ? options.maxIdempotencyEntries
    : 1000;
  const pruneIdempotency = (state) => {
    const entries = Object.entries(state.idempotency)
      .map(([key, requestId]) => ({ key, request: state.requests.find((item) => item.id === requestId) }))
      .filter((entry) => entry.request)
      .sort((left, right) => Date.parse(left.request.createdAt) - Date.parse(right.request.createdAt));
    for (const entry of entries.slice(0, Math.max(0, entries.length - maxIdempotencyEntries))) delete state.idempotency[entry.key];
  };

  function execute(operation, input = {}) {
    const principal = authenticate(input);
    const state = options.store.load();
    state.keyedFences = state.keyedFences || {};
    state.idempotency = state.idempotency || {};
    state.codingEvidence = state.codingEvidence || [];
    state.codingEvidenceIndex = state.codingEvidenceIndex || Object.fromEntries(
      state.codingEvidence.map((item) => [`${item.workRunId}\u0000${item.eventId}`, item.id]),
    );

    if (CODING_READ_OPERATIONS.has(operation)) {
      if (!has(principal, 'control-plane.read')) throw new Error('control-plane read is not authorized');
      const evidence = state.codingEvidence
        .filter((item) => (!input.workRunId || item.workRunId === input.workRunId) && readable(principal, item))
        .map(projectCodingEvidence);
      return { ok: true, evidence };
    }

    if (READ_OPERATIONS.has(operation)) {
      if (!has(principal, 'control-plane.read')) throw new Error('control-plane read is not authorized');
      if (operation === 'list') {
        return { ok: true, requests: state.requests.filter((item) => readable(principal, item)).map((item) => project(item, principal)) };
      }
      const request = requestFor(state, input.requestId);
      requireReadable(principal, request);
      const evidence = state.evidence
        .filter((item) => item.requestId === request.id && readable(principal, item))
        .map((item) => project(item, principal));
      if (operation === 'inspect') return { ok: true, request: project(request, principal), evidence };
      if (operation === 'evidence') return { ok: true, evidence };
      return {
        ok: true,
        request: project(request, principal),
        approval: request.approval ? {
          actionKey: request.approval.actionKey,
          expiresAt: request.approval.expiresAt,
          usedAt: request.approval.usedAt || null,
        } : null,
      };
    }

    if (operation === 'recordEvidence') {
      if (!has(principal, 'control-plane.mutate')) throw new Error('control-plane mutation is not authorized');
      if (state.paused) throw new Error('control plane is paused');
      const evidence = normalizeCodingEvidence(input.evidence, principal);
      if (input.workRunId !== undefined && input.workRunId !== evidence.workRunId) throw new Error('coding work-run evidence.workRunId must match the request binding');
      if (typeof options.authorizeCodingEvidence !== 'function') throw new Error('coding work-run evidence authorization boundary is not configured');
      const authorized = options.authorizeCodingEvidence({
        principal,
        workRunId: evidence.workRunId,
        event: evidence,
        ownerId: input.ownerId || null,
        fence: input.fence,
      });
      if (authorized !== true && authorized?.ok !== true) throw new Error('coding work-run evidence write is not authorized');
      const evidenceKey = `${evidence.workRunId}\u0000${evidence.eventId}`;
      const duplicateId = state.codingEvidenceIndex[evidenceKey];
      const duplicate = duplicateId && state.codingEvidence.find((item) => item.id === duplicateId);
      if (duplicate) return { ok: true, deduped: true, evidence: projectCodingEvidence(duplicate) };
      state.codingEvidence.push(evidence);
      state.codingEvidenceIndex[evidenceKey] = evidence.id;
      options.store.save(state, state.revision);
      return { ok: true, deduped: false, evidence: projectCodingEvidence(evidence) };
    }

    if (!['createRequest', 'approve'].includes(operation)) throw new Error(`unknown operation: ${operation}`);
    if (operation === 'createRequest') {
      if (!has(principal, 'control-plane.mutate')) throw new Error('control-plane mutation is not authorized');
      if (state.paused) throw new Error('control plane is paused');
      const request = createRequest({ ...input, id: id('request'), principal, createdAt: stamp(), updatedAt: stamp() });
      const command = createCommand({
        requestId: request.id, managerId: input.managerId || 'adapter-request', resource: request.resource,
        mutationClass: request.mutationClass, desiredGeneration: request.desiredGeneration, commandSpec: request.commandSpec,
      });
      request.actionKey = command.actionKey;
      const decision = decidePolicy(request, principal) || {};
      const outcome = decision.outcome || 'require_approval';
      if (!['allow', 'deny', 'defer', 'require_approval'].includes(outcome)) throw new Error('policy returned an invalid outcome');
      const dedupeKey = idempotencyKey(principal, request, input);
      const existingId = state.idempotency[dedupeKey];
      if (existingId && !['deny', 'defer'].includes(outcome)) {
        const existing = requestFor(state, existingId);
        if (existing.principal.id !== principal.id) throw new Error('idempotency record is not owned by this principal');
        requireReadable(principal, existing);
        return { ok: true, deduped: true, request: project(existing, principal) };
      }
      const fence = currentFence(state, request.actionKey) + 1;
      state.keyedFences[request.actionKey] = fence;
      request.status = outcome === 'allow' ? 'approved' : outcome === 'deny' ? 'rejected' : outcome === 'defer' ? 'deferred' : 'approval_required';
      request.approval = outcome === 'require_approval' ? {
        actionKey: request.actionKey,
        requiredCapability: decision.requiredCapability || 'control-plane.approve',
        allowCreatorApproval: decision.allowCreatorApproval === true,
        expiresAt: decision.expiresAt || new Date(clock() + 300000).toISOString(),
        fence,
        usedAt: null,
      } : null;
      state.requests.push(request);
      state.idempotency[dedupeKey] = request.id;
      pruneIdempotency(state);
      audit(state, request, request.status, 'request accepted by authenticated application service');
      options.store.save(state, state.revision);
      return { ok: true, request: project(request, principal) };
    }

    const request = requestFor(state, input.requestId);
    requireReadable(principal, request);
    const approval = request.approval;
    if (!approval || request.status !== 'approval_required') throw new Error('request is not awaiting approval');
    if (!has(principal, approval.requiredCapability)) throw new Error('approval capability is not authorized');
    if (principal.id === request.principal.id && approval.allowCreatorApproval !== true) throw new Error('request creator cannot approve without explicit policy delegation');
    if (approval.actionKey !== request.actionKey || approval.fence !== input.fence || approval.fence !== currentFence(state, request.actionKey) || approval.usedAt || new Date(approval.expiresAt).getTime() <= clock()) {
      throw new Error('approval is stale, replayed, expired, or not bound to the current action fence');
    }
    approval.usedAt = stamp();
    request.status = 'approved';
    request.updatedAt = approval.usedAt;
    const item = audit(state, request, 'approved', 'command-bound approval consumed');
    options.store.save(state, state.revision);
    return { ok: true, request: project(request, principal), evidence: project(item, principal) };
  }

  return { execute };
}

function createMemoryApplicationStore() {
  let state = { revision: 0, paused: false, keyedFences: {}, idempotency: {}, requests: [], evidence: [], codingEvidence: [], codingEvidenceIndex: {} };
  return {
    load: () => structuredClone(state),
    save(next, expectedRevision) {
      if (state.revision !== expectedRevision) throw new Error('concurrent state mutation');
      state = { ...structuredClone(next), revision: state.revision + 1 };
    },
  };
}

module.exports = { CODING_WORK_RUN_EVIDENCE_VERSION, createApplicationService, createMemoryApplicationStore, projectCodingEvidence };
