'use strict';

const {
  OPAQUE_ID_FIELDS,
  validatePublicWorkspaceRecord,
  validateWorkspaceObservation,
  projectWorkspaceRecord,
} = require('../contracts');

const OBSERVATION_FIELDS = [
  'version', 'repositoryId', 'checkoutId', 'worktreeId', 'branchId', 'candidateId',
  'subjectIdentity', 'observedAt', 'freshUntil', 'state',
];
const DISPOSITION_FIELDS = [
  'version', 'candidateId', 'disposition', 'mutationClass', 'evidenceId',
  'reason', 'observedAt', 'freshUntil', 'lifecycleEvidence',
];
const REQUEST_FIELDS = [
  'version', 'requestId', 'candidateId', 'operation', 'mutationClass',
  'status', 'reason', 'createdAt', 'expiresAt', 'targetFence',
];
const EXECUTION_FIELDS = [
  'version', 'requestId', 'candidateId', 'operation',
  'status', 'reason', 'createdAt', 'updatedAt', 'evidenceId',
];
const HEALTH_FIELDS = ['version', 'state', 'capabilityState', 'reason', 'observedAt'];
const EVIDENCE_FIELDS = [
  'version', 'evidenceId', 'requestId', 'candidateId', 'sourceVersion',
  'subjectIdentity', 'digest', 'observedAt', 'freshUntil', 'outcome',
];

function projectFields(record, fields) {
  const validation = validatePublicWorkspaceRecord(record || {});
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const projection = {};
  for (const field of fields) if (record[field] !== undefined) projection[field] = record[field];
  return projection;
}

function projectInventory(records = []) {
  if (!Array.isArray(records)) throw new Error('inventory must be an array');
  return records.map((item) => {
    const observation = item && item.observation ? item.observation : item;
    const validation = validateWorkspaceObservation(observation || {});
    if (!validation.ok) throw new Error(validation.errors.join('; '));
    return projectFields(observation, OBSERVATION_FIELDS);
  });
}

function projectInspection(record) {
  const validation = validateWorkspaceObservation(record || {});
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return projectFields(record, OBSERVATION_FIELDS);
}
function projectDispositionRequest(record) { return projectFields(record, DISPOSITION_FIELDS); }
function projectApprovalState(record) { return projectFields(record, REQUEST_FIELDS); }
function projectExecutionState(record) { return projectFields(record, EXECUTION_FIELDS); }
function projectHealth(record) { return projectFields(record, HEALTH_FIELDS); }
function projectEvidence(record) { return projectFields(record, EVIDENCE_FIELDS); }

function projectOperatorSurface(input = {}) {
  const surface = {
    inventory: projectInventory(input.inventory || []),
    inspection: input.inspection ? projectInspection(input.inspection) : null,
    disposition: input.disposition ? projectDispositionRequest(input.disposition) : null,
    approval: input.approval ? projectApprovalState(input.approval) : null,
    execution: input.execution ? projectExecutionState(input.execution) : null,
    health: input.health ? projectHealth(input.health) : null,
    evidence: input.evidence ? projectEvidence(input.evidence) : null,
  };
  return { human: surface, agent: structuredClone(surface) };
}

function projectAgentSurface(input = {}) { return projectOperatorSurface(input).agent; }
function projectHumanSurface(input = {}) { return projectOperatorSurface(input).human; }

module.exports = {
  OPAQUE_ID_FIELDS,
  projectAgentSurface,
  projectApprovalState,
  projectDispositionRequest,
  projectEvidence,
  projectExecutionState,
  projectHealth,
  projectHumanSurface,
  projectInspection,
  projectInventory,
  projectOperatorSurface,
  projectWorkspaceRecord,
};
