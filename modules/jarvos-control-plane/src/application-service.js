'use strict';

// Adapter-facing boundary: credentials resolve to trusted principals here;
// caller-declared authority is never accepted as an authorization source.
const crypto = require('crypto');
const { createCommand, createRequest, toPublicProjection } = require('./contracts');

const TERMINAL = new Set(['rejected', 'cancelled', 'satisfied', 'failed', 'unverifiable']);
const READ_OPERATIONS = new Set(['list', 'inspect', 'evidence', 'approval-state']);
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;

function createApplicationService(options = {}) {
  if (!options.store) throw new Error('store is required');
  if (typeof options.resolveCredential !== 'function') throw new Error('resolveCredential is required');
  const clock = options.clock || (() => Date.now());
  const policy = options.policy || (() => ({ outcome: 'require_approval', requiredCapability: 'control-plane.mutate' }));
  const stamp = () => new Date(clock()).toISOString();
  const authenticate = (input) => {
    const trusted = options.resolveCredential(input.credential);
    if (!trusted || !trusted.id) { const error = new Error('control-plane authentication failed'); error.code = 'AUTH_REQUIRED'; throw error; }
    return { id: trusted.id, capabilities: [...new Set(trusted.capabilities || [])], maxSensitivity: trusted.maxSensitivity || 'internal' };
  };
  const has = (principal, required) => principal.capabilities.includes(required);
  const project = (record, principal) => toPublicProjection(record, { maxSensitivity: principal.maxSensitivity });
  const requestFor = (state, requestId) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) throw new Error(`request not found: ${requestId}`);
    return request;
  };
  const evidence = (state, requestId, outcome, detail) => {
    const item = { id: id('evidence'), requestId, outcome, detail: detail || null, observedAt: stamp() };
    state.evidence.push(item); return item;
  };
  function execute(operation, input = {}) {
    const principal = authenticate(input);
    const state = options.store.load();
    if (READ_OPERATIONS.has(operation)) {
      if (!has(principal, 'control-plane.read')) throw new Error('control-plane read is not authorized');
      if (operation === 'list') return { ok: true, requests: state.requests.map((item) => project(item, principal)) };
      const request = requestFor(state, input.requestId);
      if (operation === 'inspect') return { ok: true, request: project(request, principal), evidence: state.evidence.filter((item) => item.requestId === request.id) };
      if (operation === 'evidence') return { ok: true, evidence: state.evidence.filter((item) => item.requestId === request.id) };
      return { ok: true, requestId: request.id, status: request.status, approval: request.approval ? { expiresAt: request.approval.expiresAt, usedAt: request.approval.usedAt || null } : null };
    }
    if (!['createRequest', 'approve', 'mutate'].includes(operation)) throw new Error(`unknown operation: ${operation}`);
    if (!has(principal, 'control-plane.mutate')) throw new Error('control-plane mutation is not authorized');
    if (operation === 'createRequest') {
      if (state.paused) throw new Error('control plane is paused');
      const request = createRequest({ ...input, id: id('request'), principal, createdAt: stamp(), updatedAt: stamp() });
      const command = createCommand({ requestId: request.id, managerId: input.managerId || 'adapter-request', resource: request.resource, mutationClass: request.mutationClass, desiredGeneration: request.desiredGeneration, commandSpec: request.commandSpec });
      const decision = policy(request, principal);
      const requiredCapability = decision.requiredCapability || 'control-plane.mutate';
      request.actionKey = command.actionKey;
      request.status = decision.outcome === 'allow' ? 'approved'
        : decision.outcome === 'deny' ? 'rejected'
          : decision.outcome === 'defer' ? 'deferred'
            : 'approval_required';
      request.approval = decision.outcome === 'require_approval'
        ? { actionKey: command.actionKey, requiredCapability, expiresAt: decision.expiresAt || new Date(clock() + 300000).toISOString(), fence: state.fence + 1, usedAt: null }
        : null;
      state.fence += 1; state.requests.push(request); evidence(state, request.id, request.status, 'request accepted by authenticated application service');
      options.store.save(state, state.revision); return { ok: true, request: project(request, principal) };
    }
    const request = requestFor(state, input.requestId);
    if (TERMINAL.has(request.status)) throw new Error(`cannot ${operation} terminal request: ${request.status}`);
    if (operation === 'approve') {
      const approval = request.approval;
      if (!approval || request.status !== 'approval_required') throw new Error('request is not awaiting approval');
      if (approval.actionKey !== request.actionKey || approval.fence !== input.fence || approval.fence !== state.fence || approval.usedAt || new Date(approval.expiresAt).getTime() <= clock()) throw new Error('approval is stale, replayed, expired, or not bound to the current fence');
      if (!has(principal, approval.requiredCapability)) throw new Error('approval capability is not authorized');
      approval.usedAt = stamp(); request.status = 'approved'; request.updatedAt = approval.usedAt;
      const item = evidence(state, request.id, 'approved', 'command-bound approval consumed'); options.store.save(state, state.revision);
      return { ok: true, request: project(request, principal), evidence: item };
    }
    if (request.status !== 'approved') throw new Error('request requires a fresh approval');
    if (input.fence !== state.fence) throw new Error('stale fence');
    request.status = 'satisfied'; request.updatedAt = stamp(); const item = evidence(state, request.id, 'satisfied', 'mutation accepted at current fence'); options.store.save(state, state.revision);
    return { ok: true, request: project(request, principal), evidence: item };
  }
  return { execute };
}

function createMemoryApplicationStore() {
  let state = { revision: 0, paused: false, fence: 0, requests: [], evidence: [] };
  return { load: () => structuredClone(state), save(next, expectedRevision) { if (state.revision !== expectedRevision) throw new Error('concurrent state mutation'); state = { ...structuredClone(next), revision: state.revision + 1 }; } };
}

module.exports = { createApplicationService, createMemoryApplicationStore };
