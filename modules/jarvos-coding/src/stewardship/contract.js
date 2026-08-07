'use strict';

const STEWARDSHIP_CONTRACT_VERSION = 'jarvos-stewardship.v1';
const OPAQUE_ID_FIELDS = ['projectId', 'sessionId', 'worktreeId', 'checkpointId', 'causalRunId', 'judgmentId'];
const FORBIDDEN_FIELD = /(?:transcript|message|body|content|prompt|credential|secret|token|password|api[_-]?key|paperclip|beads)/i;
const ABSOLUTE_PATH = /(?:^|[\s"'(=:])(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const LIFECYCLE_STATES = ['active', 'degraded', 'checkpointed', 'reconciling', 'landed', 'retained', 'cleaned', 'needs-judgment', 'stopped'];
const HARNESS_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOpaqueId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !ABSOLUTE_PATH.test(value);
}

function collectPrivacyErrors(value, path = 'record', errors = []) {
  if (typeof value === 'string' && ABSOLUTE_PATH.test(value)) errors.push(`${path} must not contain an absolute path`);
  if (typeof value === 'string' && /(?:paperclip|beads)/i.test(value)) errors.push(`${path} must not contain tracker authority`);
  if (typeof value === 'string' && SECRET_VALUE.test(value)) errors.push(`${path} must not contain credentials or secrets`);
  if (Array.isArray(value)) value.forEach((entry, index) => collectPrivacyErrors(entry, `${path}[${index}]`, errors));
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_FIELD.test(key)) errors.push(`${path}.${key} is not allowed in a public stewardship record`);
      collectPrivacyErrors(entry, `${path}.${key}`, errors);
    }
  }
  return errors;
}

function validatePublicRecord(record = {}) {
  const errors = [];
  if (!isObject(record)) return { ok: false, errors: ['public stewardship record must be an object'] };
  if (record.version !== STEWARDSHIP_CONTRACT_VERSION) errors.push(`record.version must be ${STEWARDSHIP_CONTRACT_VERSION}`);
  for (const field of OPAQUE_ID_FIELDS) {
    if (record[field] !== undefined && record[field] !== null && !isOpaqueId(record[field])) {
      errors.push(`record.${field} must be an opaque identifier`);
    }
  }
  if (record.lifecycle !== undefined && !LIFECYCLE_STATES.includes(record.lifecycle)) {
    errors.push(`record.lifecycle must be one of: ${LIFECYCLE_STATES.join(', ')}`);
  }
  if (record.checkpointAuthority !== undefined && record.checkpointAuthority !== 'stewardship-adapter') {
    errors.push('record.checkpointAuthority must be stewardship-adapter');
  }
  collectPrivacyErrors(record, 'record', errors);
  return { ok: errors.length === 0, errors };
}

function buildLifecycleOutcome(input = {}) {
  if (!isOpaqueId(input.projectId)) throw new Error('lifecycle outcome.projectId must be an opaque identifier');
  if (!isOpaqueId(input.sessionId)) throw new Error('lifecycle outcome.sessionId must be an opaque identifier');
  const outcome = {
    version: STEWARDSHIP_CONTRACT_VERSION,
    projectId: input.projectId,
    sessionId: input.sessionId,
    worktreeId: input.worktreeId || null,
    checkpointId: input.checkpointId || null,
    causalRunId: input.causalRunId || null,
    judgmentId: input.judgmentId || null,
    lifecycle: input.lifecycle || 'active',
    provenance: input.provenance === undefined || input.provenance === null
      ? null
      : { harness: normalizeHarnessProvenance(input.provenance.harness) },
    checkpointAuthority: input.checkpointAuthority || 'stewardship-adapter',
  };
  const validation = validatePublicRecord(outcome);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return outcome;
}

function validateLifecycleSessions(outcomes = []) {
  const errors = [];
  const seen = new Set();
  for (const [index, outcome] of outcomes.entries()) {
    const validation = validatePublicRecord(outcome);
    errors.push(...validation.errors.map((error) => `outcomes[${index}]: ${error}`));
    if (outcome?.lifecycle !== 'active') continue;
    const key = `${outcome.projectId}\u0000${outcome.sessionId}`;
    if (seen.has(key)) errors.push(`outcomes[${index}] duplicates an active session identity`);
    seen.add(key);
  }
  return { ok: errors.length === 0, errors };
}

function normalizeGitEvidence(evidence = {}) {
  if (!isObject(evidence)) throw new Error('git evidence must be an object');
  const errors = [];
  for (const field of ['baseCommit', 'headCommit']) {
    if (evidence[field] !== undefined && evidence[field] !== null
      && (typeof evidence[field] !== 'string' || !GIT_OBJECT_ID.test(evidence[field]))) {
      errors.push(`git.${field} must be a full 40 or 64 hexadecimal object ID when provided`);
    }
  }
  for (const field of ['changedFiles', 'commits']) {
    if (evidence[field] !== undefined && !Array.isArray(evidence[field])) errors.push(`git.${field} must be an array when provided`);
  }
  if (Array.isArray(evidence.commits)) {
    for (const entry of evidence.commits) {
      if (typeof entry !== 'string' || !GIT_OBJECT_ID.test(entry)) errors.push('git.commits entries must be full 40 or 64 hexadecimal object IDs');
    }
  }
  if (Array.isArray(evidence.changedFiles)) {
    for (const entry of evidence.changedFiles) {
      if (typeof entry !== 'string' || !entry || entry.includes('\0') || entry.includes('\\')
        || entry.split('/').includes('..') || ABSOLUTE_PATH.test(entry)) {
        errors.push('git.changedFiles entries must be safe non-empty repo-relative paths');
      }
    }
  }
  if (evidence.clean !== undefined && typeof evidence.clean !== 'boolean') errors.push('git.clean must be boolean when provided');
  if (errors.length) throw new Error(errors.join('; '));
  const normalized = {
    baseCommit: evidence.baseCommit ? evidence.baseCommit.toLowerCase() : null,
    headCommit: evidence.headCommit ? evidence.headCommit.toLowerCase() : null,
    changedFiles: [...new Set(evidence.changedFiles || [])].sort(),
    commits: [...new Set((evidence.commits || []).map((entry) => entry.toLowerCase()))].sort(),
    clean: evidence.clean === true,
  };
  const privacyErrors = collectPrivacyErrors(normalized, 'git', []);
  if (privacyErrors.length) throw new Error(privacyErrors.join('; '));
  return normalized;
}

function normalizeHarnessProvenance(value) {
  if (typeof value !== 'string' || !HARNESS_LABEL.test(value)) throw new Error('harness provenance must be a bounded label');
  const errors = collectPrivacyErrors(value, 'harness provenance', []);
  if (errors.length) throw new Error(errors.join('; '));
  return value;
}

function buildReleaseClassificationInput(input = {}) {
  const git = input.git === undefined ? input : input.git;
  return {
    authoritative: {
      version: STEWARDSHIP_CONTRACT_VERSION,
      git: normalizeGitEvidence(git),
    },
    provenance: input.harness === undefined || input.harness === null ? null : { harness: normalizeHarnessProvenance(input.harness) },
  };
}

function classifyReleaseFromGitEvidence(input = {}) {
  const authoritative = input.authoritative || buildReleaseClassificationInput(input).authoritative;
  const git = normalizeGitEvidence(authoritative.git || {});
  return {
    version: STEWARDSHIP_CONTRACT_VERSION,
    classification: git.changedFiles.length || git.commits.length ? 'candidate' : 'no-change',
    git,
  };
}

module.exports = {
  OPAQUE_ID_FIELDS,
  LIFECYCLE_STATES,
  STEWARDSHIP_CONTRACT_VERSION,
  buildLifecycleOutcome,
  buildReleaseClassificationInput,
  classifyReleaseFromGitEvidence,
  isOpaqueId,
  normalizeHarnessProvenance,
  normalizeGitEvidence,
  validateLifecycleSessions,
  validatePublicRecord,
};
