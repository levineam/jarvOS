'use strict';

const { CAPABILITY_STATES, LIFECYCLE_OUTCOMES, MUTATION_CLASSES, createLifecycleEvidenceBinding, createReleaseClearanceBinding, createWorkspaceObservation, validateLifecycleEvidenceBinding, validateReleaseClearanceBinding, isSafelyRemovableObservation } = require('../contracts');

const CAPABILITY_RANK = Object.freeze({ disabled: 0, 'observe-only': 1, 'archive-enabled': 2, 'cleanup-enabled': 3 });
const SAFE_ACTIONS = new Set(['inventory', 'inspect', 'request_disposition', 'health', 'evidence']);
const SUPPORTED_MUTATION_CLASSES = new Set([MUTATION_CLASSES.ARCHIVE_METADATA, MUTATION_CLASSES.WORKTREE_REMOVE]);

function createWorkspacePolicy(input = {}) {
  const capabilityState = input.capabilityState || 'disabled';
  if (!CAPABILITY_STATES.includes(capabilityState)) throw new Error('policy.capabilityState must be a known capability state');
  const mutationClasses = input.mutationClasses || [];
  if (!Array.isArray(mutationClasses)) throw new Error('policy.mutationClasses must be an array');
  for (const mutationClass of mutationClasses) {
    if (!SUPPORTED_MUTATION_CLASSES.has(mutationClass)) throw new Error(`policy mutation class is not enabled: ${mutationClass}`);
    if (mutationClass === MUTATION_CLASSES.ARCHIVE_METADATA && CAPABILITY_RANK[capabilityState] < CAPABILITY_RANK['archive-enabled']) throw new Error('policy mutation class is not enabled by capabilityState');
    if (mutationClass === MUTATION_CLASSES.WORKTREE_REMOVE && CAPABILITY_RANK[capabilityState] < CAPABILITY_RANK['cleanup-enabled']) throw new Error('policy mutation class is not enabled by capabilityState');
  }
  return { version: input.version || 'jarvos-workspace-manager.v1', capabilityState, mutationClasses: [...new Set(mutationClasses)].sort() };
}

function classifyWorkspaceDisposition({ observation, lifecycleEvidence, releaseClearance, now = new Date().toISOString() } = {}) {
  const normalized = createWorkspaceObservation(observation);
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.getTime())) throw new Error('now must be an ISO timestamp');
  if (!isSafelyRemovableObservation(normalized)) return { disposition: 'preserve', reason: 'workspace observation is not safely removable' };
  if (new Date(normalized.freshUntil) < timestamp) return { disposition: 'deferred', reason: 'workspace observation is stale' };
  if (!lifecycleEvidence) return { disposition: 'deferred', reason: 'lifecycle evidence is unavailable' };
  const validation = validateLifecycleEvidenceBinding(lifecycleEvidence);
  if (!validation.ok) return { disposition: 'deferred', reason: 'lifecycle evidence is malformed' };
  const evidence = createLifecycleEvidenceBinding(lifecycleEvidence);
  if (evidence.subjectIdentity !== normalized.subjectIdentity) return { disposition: 'needs_judgment', reason: 'lifecycle evidence identity does not match workspace' };
  if (new Date(evidence.freshUntil) < timestamp) return { disposition: 'deferred', reason: 'lifecycle evidence is stale' };
  if (!LIFECYCLE_OUTCOMES.includes(evidence.outcome)) return { disposition: 'preserve', reason: 'lifecycle outcome is not admissible' };
  if (!releaseClearance) return { disposition: 'deferred', reason: 'release clearance is unavailable' };
  const releaseValidation = validateReleaseClearanceBinding(releaseClearance);
  if (!releaseValidation.ok) return { disposition: 'deferred', reason: 'release clearance is malformed' };
  const clearance = createReleaseClearanceBinding(releaseClearance);
  if (clearance.subjectIdentity !== normalized.subjectIdentity) return { disposition: 'needs_judgment', reason: 'release clearance identity does not match workspace' };
  if (new Date(clearance.freshUntil) < timestamp) return { disposition: 'deferred', reason: 'release clearance is stale' };
  if (!['satisfied', 'not-required'].includes(clearance.outcome)) return { disposition: 'preserve', reason: 'release clearance is not terminal' };
  return { disposition: 'cleanup_candidate', reason: 'fresh matched lifecycle and release clearance', lifecycleEvidence: evidence, releaseClearance: clearance, mutationClass: MUTATION_CLASSES.WORKTREE_REMOVE };
}

function authorizeWorkspaceAction({ actorKind, action, capabilityState = 'disabled' } = {}) {
  if (!CAPABILITY_STATES.includes(capabilityState)) return { outcome: 'deny', reason: 'unknown capability state' };
  if (!['human', 'agent', 'schedule', 'system'].includes(actorKind)) return { outcome: 'deny', reason: 'unknown actor kind' };
  if (SAFE_ACTIONS.has(action)) return CAPABILITY_RANK[capabilityState] >= CAPABILITY_RANK['observe-only'] ? { outcome: 'allow' } : { outcome: 'deny', reason: 'observation is disabled' };
  if (actorKind === 'agent' && ['approve', 'execute', 'cleanup'].includes(action)) return { outcome: 'deny', reason: 'agents cannot approve or execute workspace cleanup' };
  if (action === 'archive') return CAPABILITY_RANK[capabilityState] >= CAPABILITY_RANK['archive-enabled'] && ['human', 'agent'].includes(actorKind) ? { outcome: 'allow' } : { outcome: 'deny', reason: 'archive capability is unavailable' };
  if (action === 'cleanup') return CAPABILITY_RANK[capabilityState] >= CAPABILITY_RANK['cleanup-enabled'] && actorKind === 'human' ? { outcome: 'require_approval' } : { outcome: 'deny', reason: 'cleanup capability is unavailable' };
  return { outcome: 'deny', reason: 'action is not authorized' };
}

module.exports = { CAPABILITY_RANK, SUPPORTED_MUTATION_CLASSES, createWorkspacePolicy, classifyWorkspaceDisposition, authorizeWorkspaceAction };
