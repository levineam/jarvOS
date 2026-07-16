'use strict';

const {
  createPolicyDecision,
} = require('../contracts');

function createPolicyEngine(options = {}) {
  const allowlist = new Set(options.allowlist || []);
  const approvalRequired = new Set(options.approvalRequired || []);
  const denied = new Set(options.denied || []);
  const defaultOutcome = options.defaultOutcome || 'defer';
  const now = options.now || (() => new Date().toISOString());

  function keyFor(request) {
    return `${request.resource.type}:${request.mutationClass}`;
  }

  function decide(request, context = {}) {
    const key = keyFor(request);
    let outcome = defaultOutcome;
    let reason = 'No matching policy rule';

    if (denied.has(key) || denied.has(request.mutationClass)) {
      outcome = 'deny';
      reason = 'Mutation is denied by policy';
    } else if (approvalRequired.has(key) || approvalRequired.has(request.mutationClass)) {
      outcome = 'require_approval';
      reason = 'Mutation requires approval';
    } else if (allowlist.has(key) || allowlist.has(request.mutationClass)) {
      outcome = 'allow';
      reason = 'Mutation is explicitly allowlisted';
    }

    if (context.authorityUnavailable) {
      outcome = 'defer';
      reason = 'Authority cannot be evaluated';
    }

    return createPolicyDecision({
      requestId: request.id,
      outcome,
      reason,
      constraints: context.constraints || {},
      evidenceRefs: context.evidenceRefs || [],
      createdAt: now(),
      authority: context.authority || null,
    });
  }

  return { decide };
}

module.exports = {
  createPolicyEngine,
};
