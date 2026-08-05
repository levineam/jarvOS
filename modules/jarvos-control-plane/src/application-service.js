'use strict';

// Adapter-facing boundary. This service authenticates, applies capability and
// disclosure policy, records approval attestations, and projects data. It does
// not dispatch commands or transition execution lifecycle state; reconciliation
// is the only owner of verified terminal outcomes.
const crypto = require('crypto');
const { createCommand, createRequest, toPublicProjection } = require('./contracts');

const READ_OPERATIONS = new Set(['list', 'inspect', 'evidence', 'approval-state']);
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

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
  let state = { revision: 0, paused: false, keyedFences: {}, idempotency: {}, requests: [], evidence: [] };
  return {
    load: () => structuredClone(state),
    save(next, expectedRevision) {
      if (state.revision !== expectedRevision) throw new Error('concurrent state mutation');
      state = { ...structuredClone(next), revision: state.revision + 1 };
    },
  };
}

module.exports = { createApplicationService, createMemoryApplicationStore };
