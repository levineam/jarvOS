'use strict';

const { canonicalSubjectTuple, deriveSubjectIdentity } = require('./subject-identity');

const WORKSPACE_CONTRACT_VERSION = 'jarvos-workspace-manager.v1';
const CAPABILITY_STATES = ['disabled', 'observe-only', 'archive-enabled', 'cleanup-enabled'];
const HEALTH_STATES = ['healthy', 'degraded', 'disabled', 'incompatible', 'repairing'];
const DISPOSITIONS = ['preserve', 'needs_judgment', 'deferred', 'archive_candidate', 'archived', 'cleanup_candidate'];
const LIFECYCLE_OUTCOMES = ['landed', 'retained', 'cleaned'];
const RELEASE_CLEARANCE_CONTRACT_VERSION = 'jarvos-workspace-manager.release-clearance.v1';
const RELEASE_CLEARANCE_OUTCOMES = ['satisfied', 'not-required', 'pending', 'blocked', 'uncertain', 'incompatible'];
const RELEASE_CLEARANCE_FIELDS = Object.freeze([
  'version', 'sourceVersion', 'subjectIdentity', 'digest', 'observedAt', 'freshUntil', 'outcome',
  'generation', 'receiptId', 'currentPointerId',
]);
const OBSERVATION_STATE_FIELDS = Object.freeze([
  'clean', 'complete', 'dirty', 'conflicts', 'nestedRepository', 'detached',
  'missing', 'unknownOwnership', 'duplicateIdentity', 'protected', 'divergedRefs',
  'uniqueCommits', 'incomplete',
]);
const UNSAFE_OBSERVATION_STATES = Object.freeze([
  'dirty', 'conflicts', 'nestedRepository', 'detached', 'missing', 'unknownOwnership',
  'duplicateIdentity', 'protected', 'divergedRefs', 'uniqueCommits', 'incomplete',
]);
const MUTATION_CLASSES = Object.freeze({
  ARCHIVE_METADATA: 'workspace.archive-metadata',
  WORKTREE_REMOVE: 'workspace.worktree-remove',
  BRANCH_DELETE: 'workspace.branch-delete',
});
const OPAQUE_ID_FIELDS = ['repositoryId', 'checkoutId', 'worktreeId', 'branchId', 'candidateId', 'subjectIdentity', 'evidenceId'];
const FORBIDDEN_FIELD = /(?:transcript|message|body|content|prompt|credential|secret|token|password|api[_-]?key|tracker|paperclip|beads|path|command|config)/i;
const ABSOLUTE_PATH = /(?:^|[\s"'(=:])(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const SHA256 = /^[a-f0-9]{64}$/i;

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isOpaqueId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !ABSOLUTE_PATH.test(value); }
function normalizeTime(value, field) {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}
function collectPrivacyErrors(value, path = 'record', errors = []) {
  if (typeof value === 'string' && ABSOLUTE_PATH.test(value)) errors.push(`${path} must not contain an absolute path`);
  if (typeof value === 'string' && /(?:paperclip|beads)/i.test(value)) errors.push(`${path} must not contain tracker authority`);
  if (typeof value === 'string' && SECRET_VALUE.test(value)) errors.push(`${path} must not contain credentials or secrets`);
  if (Array.isArray(value)) value.forEach((entry, index) => collectPrivacyErrors(entry, `${path}[${index}]`, errors));
  if (isObject(value)) for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) errors.push(`${path}.${key} is not allowed in a public workspace record`);
    collectPrivacyErrors(entry, `${path}.${key}`, errors);
  }
  return errors;
}
function validatePublicWorkspaceRecord(record = {}) {
  if (!isObject(record)) return { ok: false, errors: ['public workspace record must be an object'] };
  const errors = collectPrivacyErrors(record);
  if (record.version !== WORKSPACE_CONTRACT_VERSION) errors.push(`record.version must be ${WORKSPACE_CONTRACT_VERSION}`);
  for (const field of OPAQUE_ID_FIELDS) if (record[field] != null && !isOpaqueId(record[field])) errors.push(`record.${field} must be an opaque identifier`);
  return { ok: errors.length === 0, errors };
}
function validateWorkspaceObservation(record = {}) {
  const validation = validatePublicWorkspaceRecord(record);
  const errors = [...validation.errors];
  for (const field of ['repositoryId', 'checkoutId', 'worktreeId', 'branchId', 'candidateId', 'subjectIdentity']) if (!isOpaqueId(record[field])) errors.push(`observation.${field} must be an opaque identifier`);
  for (const field of ['observedAt', 'freshUntil']) try { normalizeTime(record[field], `observation.${field}`); } catch (error) { errors.push(error.message); }
  if (record.freshUntil && record.observedAt && new Date(record.freshUntil) < new Date(record.observedAt)) errors.push('observation.freshUntil must not precede observedAt');
  if (!isObject(record.state)) errors.push('observation.state must be an object');
  else for (const [key, value] of Object.entries(record.state)) if (typeof value !== 'boolean') errors.push(`observation.state.${key} must be boolean`);
  return { ok: errors.length === 0, errors };
}
function isSafelyRemovableObservation(record = {}) {
  const state = record && record.state;
  if (!isObject(state) || Object.keys(state).some((key) => !OBSERVATION_STATE_FIELDS.includes(key))) return false;
  if (state.clean !== true || state.complete !== true) return false;
  // An omitted safety fact is an unknown fact. Preserve-first cleanup requires
  // every known unsafe condition to be explicitly observed as false.
  return UNSAFE_OBSERVATION_STATES.every((key) => state[key] === false);
}
function createWorkspaceObservation(input = {}) {
  const record = clone(input);
  record.version = input.version || WORKSPACE_CONTRACT_VERSION;
  record.observedAt = normalizeTime(input.observedAt, 'observation.observedAt');
  record.freshUntil = normalizeTime(input.freshUntil, 'observation.freshUntil');
  const validation = validateWorkspaceObservation(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return record;
}
function validateLifecycleEvidenceBinding(record = {}) {
  const validation = validatePublicWorkspaceRecord(record);
  const errors = [...validation.errors];
  if (typeof record.sourceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.sourceVersion)) errors.push('lifecycle evidence.sourceVersion must be a bounded source version');
  if (!isOpaqueId(record.subjectIdentity)) errors.push('lifecycle evidence.subjectIdentity must be an opaque identifier');
  if (typeof record.digest !== 'string' || !SHA256.test(record.digest)) errors.push('lifecycle evidence.digest must be a SHA-256 digest');
  for (const field of ['observedAt', 'freshUntil']) try { normalizeTime(record[field], `lifecycle evidence.${field}`); } catch (error) { errors.push(error.message); }
  if (!LIFECYCLE_OUTCOMES.includes(record.outcome)) errors.push(`lifecycle evidence.outcome must be one of: ${LIFECYCLE_OUTCOMES.join(', ')}`);
  if (record.freshUntil && record.observedAt && new Date(record.freshUntil) < new Date(record.observedAt)) errors.push('lifecycle evidence.freshUntil must not precede observedAt');
  return { ok: errors.length === 0, errors };
}
function createLifecycleEvidenceBinding(input = {}) {
  const record = clone(input);
  record.version = input.version || WORKSPACE_CONTRACT_VERSION;
  record.observedAt = normalizeTime(input.observedAt, 'lifecycle evidence.observedAt');
  record.freshUntil = normalizeTime(input.freshUntil, 'lifecycle evidence.freshUntil');
  if (typeof record.digest === 'string') record.digest = record.digest.toLowerCase();
  const validation = validateLifecycleEvidenceBinding(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return record;
}

function validateReleaseClearanceBinding(record = {}) {
  const validation = validatePublicWorkspaceRecord({ ...record, version: WORKSPACE_CONTRACT_VERSION });
  const errors = [...validation.errors];
  for (const field of Object.keys(record)) if (!RELEASE_CLEARANCE_FIELDS.includes(field)) errors.push(`release clearance.${field} is not allowed`);
  if (record.version !== RELEASE_CLEARANCE_CONTRACT_VERSION) errors.push(`release clearance.version must be ${RELEASE_CLEARANCE_CONTRACT_VERSION}`);
  if (typeof record.sourceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record.sourceVersion)) errors.push('release clearance.sourceVersion must be a bounded source version');
  if (!isOpaqueId(record.subjectIdentity)) errors.push('release clearance.subjectIdentity must be an opaque identifier');
  if (typeof record.digest !== 'string' || !SHA256.test(record.digest)) errors.push('release clearance.digest must be a SHA-256 digest');
  for (const field of ['observedAt', 'freshUntil']) try { normalizeTime(record[field], `release clearance.${field}`); } catch (error) { errors.push(error.message); }
  if (!RELEASE_CLEARANCE_OUTCOMES.includes(record.outcome)) errors.push(`release clearance.outcome must be one of: ${RELEASE_CLEARANCE_OUTCOMES.join(', ')}`);
  if (!Number.isInteger(record.generation) || record.generation < 1) errors.push('release clearance.generation must be a positive integer');
  for (const field of ['receiptId', 'currentPointerId']) if (record[field] != null && !isOpaqueId(record[field])) errors.push(`release clearance.${field} must be an opaque identifier`);
  if (record.freshUntil && record.observedAt && new Date(record.freshUntil) < new Date(record.observedAt)) errors.push('release clearance.freshUntil must not precede observedAt');
  return { ok: errors.length === 0, errors };
}

function createReleaseClearanceBinding(input = {}) {
  const record = clone(input);
  record.version = input.version || RELEASE_CLEARANCE_CONTRACT_VERSION;
  record.observedAt = normalizeTime(input.observedAt, 'release clearance.observedAt');
  record.freshUntil = normalizeTime(input.freshUntil, 'release clearance.freshUntil');
  if (typeof record.digest === 'string') record.digest = record.digest.toLowerCase();
  const validation = validateReleaseClearanceBinding(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return record;
}
function validateWorkspaceHealth(record = {}) {
  const validation = validatePublicWorkspaceRecord(record);
  const errors = [...validation.errors];
  if (!HEALTH_STATES.includes(record.state)) errors.push(`health.state must be one of: ${HEALTH_STATES.join(', ')}`);
  if (!CAPABILITY_STATES.includes(record.capabilityState)) errors.push(`health.capabilityState must be one of: ${CAPABILITY_STATES.join(', ')}`);
  try { normalizeTime(record.observedAt, 'health.observedAt'); } catch (error) { errors.push(error.message); }
  return { ok: errors.length === 0, errors };
}
function createWorkspaceHealth(input = {}) {
  const record = { version: input.version || WORKSPACE_CONTRACT_VERSION, state: input.state, capabilityState: input.capabilityState, observedAt: normalizeTime(input.observedAt, 'health.observedAt') };
  const validation = validateWorkspaceHealth(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return record;
}
function createDispositionDecision(input = {}) {
  const observation = createWorkspaceObservation(input.observation);
  if (!DISPOSITIONS.includes(input.disposition)) throw new Error(`disposition must be one of: ${DISPOSITIONS.join(', ')}`);
  const evidence = input.lifecycleEvidence == null ? null : createLifecycleEvidenceBinding(input.lifecycleEvidence);
  const releaseClearance = input.releaseClearance == null ? null : createReleaseClearanceBinding(input.releaseClearance);
  if (input.disposition === 'cleanup_candidate' && !evidence) throw new Error('cleanup_candidate requires lifecycle evidence');
  if (input.disposition === 'cleanup_candidate' && !releaseClearance) throw new Error('cleanup_candidate requires release clearance');
  if (releaseClearance && releaseClearance.subjectIdentity !== observation.subjectIdentity) throw new Error('release clearance identity does not match workspace');
  if (input.disposition === 'cleanup_candidate' && !['satisfied', 'not-required'].includes(releaseClearance.outcome)) throw new Error('cleanup_candidate requires terminal release clearance');
  const mutationClass = input.disposition === 'cleanup_candidate' ? MUTATION_CLASSES.WORKTREE_REMOVE : null;
  return { version: WORKSPACE_CONTRACT_VERSION, candidateId: observation.candidateId, disposition: input.disposition, evidenceId: input.evidenceId || null, lifecycleEvidence: evidence, releaseClearance, mutationClass };
}
function projectWorkspaceRecord(record = {}) {
  const validation = validatePublicWorkspaceRecord(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const projection = {};
  for (const field of ['version', ...OPAQUE_ID_FIELDS, 'sourceVersion', 'digest', 'disposition', 'mutationClass', 'capabilityState', 'state', 'observedAt', 'freshUntil', 'outcome']) if (record[field] !== undefined) projection[field] = record[field];
  if (record.releaseClearance !== undefined) projection.releaseClearance = createReleaseClearanceBinding(record.releaseClearance);
  return projection;
}
const projectHumanWorkspaceRecord = projectWorkspaceRecord;
const projectAgentWorkspaceRecord = projectWorkspaceRecord;

module.exports = { WORKSPACE_CONTRACT_VERSION, RELEASE_CLEARANCE_CONTRACT_VERSION, RELEASE_CLEARANCE_OUTCOMES, RELEASE_CLEARANCE_FIELDS, CAPABILITY_STATES, HEALTH_STATES, DISPOSITIONS, LIFECYCLE_OUTCOMES, OBSERVATION_STATE_FIELDS, UNSAFE_OBSERVATION_STATES, MUTATION_CLASSES, OPAQUE_ID_FIELDS, isOpaqueId, canonicalSubjectTuple, deriveSubjectIdentity, collectPrivacyErrors, validatePublicWorkspaceRecord, validateWorkspaceObservation, isSafelyRemovableObservation, createWorkspaceObservation, validateLifecycleEvidenceBinding, createLifecycleEvidenceBinding, validateReleaseClearanceBinding, createReleaseClearanceBinding, validateWorkspaceHealth, createWorkspaceHealth, createDispositionDecision, projectWorkspaceRecord, projectHumanWorkspaceRecord, projectAgentWorkspaceRecord };
