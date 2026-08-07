'use strict';

const REPOSITORY_KINDS = ['private', 'public', 'third-party'];
const PUBLIC_ACTIONS = ['merge', 'tag', 'publication'];
const PRIVATE_ACTIONS = ['merge', 'landing'];
const THIRD_PARTY_ACTIONS = ['patch', 'upstream-contribution'];

function createLandingPolicy(input = {}) {
  const repositoryKind = REPOSITORY_KINDS.includes(input.repositoryKind) ? input.repositoryKind : 'third-party';
  return {
    repositoryKind,
    privateAutoLandAuthorized: repositoryKind === 'private' && input.privateAutoLandAuthorized === true,
    thirdPartyPatchAllowed: repositoryKind === 'third-party' && input.thirdPartyPatchAllowed === true,
    thirdPartyUpstreamAllowed: repositoryKind === 'third-party' && input.thirdPartyUpstreamAllowed === true,
  };
}

function hasExactHumanApproval(approval, action) {
  return approval?.approved === true && approval.action === action;
}

function evaluateLandingPolicy(policyInput = {}, request = {}) {
  const policy = createLandingPolicy(policyInput);
  const action = request.action;
  if (policy.repositoryKind === 'private') {
    if (!PRIVATE_ACTIONS.includes(action)) return { decision: 'candidate', reason: 'private-action-not-authorized' };
    if (policy.privateAutoLandAuthorized) return { decision: 'auto-land', reason: 'explicit-private-auto-land-policy' };
    return { decision: 'candidate', reason: 'private-auto-land-not-authorized' };
  }
  if (policy.repositoryKind === 'public') {
    if (!PUBLIC_ACTIONS.includes(action)) return { decision: 'candidate', reason: 'public-action-not-authorized' };
    return hasExactHumanApproval(request.humanApproval, action)
      ? { decision: 'approved', reason: 'exact-human-approval' }
      : { decision: 'candidate', reason: 'exact-human-approval-required' };
  }
  if (!THIRD_PARTY_ACTIONS.includes(action)) return { decision: 'internal-only', reason: 'third-party-action-not-authorized' };
  const allowed = (action === 'patch' && policy.thirdPartyPatchAllowed)
    || (action === 'upstream-contribution' && policy.thirdPartyUpstreamAllowed);
  if (!allowed) return { decision: 'internal-only', reason: 'third-party-contribution-not-authorized' };
  return hasExactHumanApproval(request.humanApproval, action)
    ? { decision: 'approved', reason: 'exact-human-approval' }
    : { decision: 'candidate', reason: 'exact-human-approval-required' };
}

module.exports = { PRIVATE_ACTIONS, PUBLIC_ACTIONS, REPOSITORY_KINDS, THIRD_PARTY_ACTIONS, createLandingPolicy, evaluateLandingPolicy, hasExactHumanApproval };
