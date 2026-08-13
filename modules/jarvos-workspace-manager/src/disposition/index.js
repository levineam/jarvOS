'use strict';

const {
  WORKSPACE_CONTRACT_VERSION,
  createWorkspaceObservation,
  createLifecycleEvidenceBinding,
  validateLifecycleEvidenceBinding,
  isSafelyRemovableObservation,
} = require('../contracts');
const { classifyWorkspaceDisposition } = require('../policy');

const OBSERVATION_FIELDS = ['repositoryId', 'checkoutId', 'worktreeId', 'branchId', 'candidateId', 'subjectIdentity', 'observedAt', 'freshUntil'];

function normalizeGitObservation(input = {}) {
  const record = { version: WORKSPACE_CONTRACT_VERSION, state: {} };
  for (const field of OBSERVATION_FIELDS) if (input[field] !== undefined) record[field] = input[field];
  for (const [key, value] of Object.entries(input.state || {})) if (typeof value === 'boolean') record.state[key] = value;
  return createWorkspaceObservation(record);
}

function resolveDisposition({ observation, lifecycleResult, lifecycleEvidence, releaseClearanceResult, releaseClearance, now } = {}) {
  const normalized = normalizeGitObservation(observation);
  if (!isSafelyRemovableObservation(normalized)) {
    return { disposition: 'preserve', reason: 'workspace observation is not safely removable' };
  }
  if (lifecycleResult && lifecycleResult.available === false) return { disposition: 'deferred', reason: 'lifecycle evidence is unavailable' };
  const rawEvidence = lifecycleEvidence || lifecycleResult;
  if (!rawEvidence) return { disposition: 'deferred', reason: 'lifecycle evidence is unavailable' };
  const validation = validateLifecycleEvidenceBinding({ ...rawEvidence, version: rawEvidence.version || WORKSPACE_CONTRACT_VERSION });
  if (!validation.ok) return { disposition: 'deferred', reason: 'lifecycle evidence is malformed' };
  const clearanceResult = releaseClearance || releaseClearanceResult;
  if (clearanceResult && clearanceResult.status === 'admissible' && clearanceResult.binding) {
    return resolveDisposition({ observation: normalized, lifecycleEvidence: createLifecycleEvidenceBinding(rawEvidence), releaseClearance: clearanceResult.binding, now });
  }
  if (clearanceResult && (clearanceResult.available === false || clearanceResult.status === 'blocked')) {
    return { disposition: 'deferred', reason: 'release clearance is unavailable' };
  }
  const rawClearance = clearanceResult;
  return classifyWorkspaceDisposition({ observation: normalized, lifecycleEvidence: createLifecycleEvidenceBinding(rawEvidence), releaseClearance: rawClearance, now });
}

module.exports = { normalizeGitObservation, resolveDisposition };
