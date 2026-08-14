'use strict';

const { createLandingPolicy, evaluateLandingPolicy } = require('./policy');

function createReconcilePolicy(input = {}) {
  const landing = createLandingPolicy(input);
  return {
    ...landing,
    reconcile: {
      mutationRequiresAuthority: true,
      ownershipIsMutationAuthority: false,
      publicActionsRequireExactHumanApproval: true,
    },
  };
}

function evaluateReconcilePolicy(policy, request = {}, verifyHumanApproval) {
  if (request.ownershipOnly === true) return { decision: 'candidate', reason: 'ownership-is-not-mutation-authority' };
  return evaluateLandingPolicy(policy, request, verifyHumanApproval);
}

module.exports = { createReconcilePolicy, evaluateReconcilePolicy };
