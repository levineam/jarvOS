'use strict';

const { isObject, isOpaqueId, isSafeNonNegativeInt, collectPrivacyErrors, collectUnknownFieldErrors, digestOf } = require('./primitives');

const CATALOG_CANDIDATE_VERSION = 'jarvos-storage-janitor.candidate.v1';
const CANDIDATE_FLAGS = Object.freeze(['protected', 'unknown', 'active', 'dirty', 'transitionNeeded']);
const CATALOG_CANDIDATE_FIELDS = Object.freeze(['version', 'candidateId', 'kind', 'estimatedBytes', ...CANDIDATE_FLAGS]);

function validateCandidate(record) {
  try {
    const errors = collectPrivacyErrors(record);
    if (!isObject(record)) return { ok: false, errors: ['catalog candidate must be an object'] };
    errors.push(...collectUnknownFieldErrors(record, CATALOG_CANDIDATE_FIELDS, 'candidate'));
    if (record.version !== CATALOG_CANDIDATE_VERSION) errors.push(`candidate.version must be ${CATALOG_CANDIDATE_VERSION}`);
    if (!isOpaqueId(record.candidateId)) errors.push('candidate.candidateId must be an opaque identifier');
    if (!isOpaqueId(record.kind)) errors.push('candidate.kind must be an opaque resource kind');
    if (!isSafeNonNegativeInt(record.estimatedBytes)) errors.push('candidate.estimatedBytes must be a non-negative safe integer');
    for (const flag of CANDIDATE_FLAGS) if (typeof record[flag] !== 'boolean') errors.push(`candidate.${flag} must be boolean`);
    return { ok: errors.length === 0, errors };
  } catch (error) {
    return { ok: false, errors: [`candidate validation failed closed: ${error.message}`] };
  }
}

// A candidate is eligible only when every known unsafe condition is
// explicitly observed as false. An absent or non-boolean flag already fails
// validateCandidate, so eligibility here is the conjunction of exact,
// caller-supplied catalog facts -- never an inferred default.
function isEligibleCandidate(record) {
  const validation = validateCandidate(record);
  if (!validation.ok) return false;
  return CANDIDATE_FLAGS.every((flag) => record[flag] === false);
}

function validateCandidateSet(candidates) {
  try {
    if (!Array.isArray(candidates) || candidates.length === 0) return { ok: false, errors: ['candidate set must be a non-empty array'] };
    const errors = [];
    const seen = new Set();
    for (const [index, candidate] of candidates.entries()) {
      const validation = validateCandidate(candidate);
      if (!validation.ok) { errors.push(...validation.errors.map((e) => `candidates[${index}].${e}`)); continue; }
      if (!CANDIDATE_FLAGS.every((flag) => candidate[flag] === false)) errors.push(`candidates[${index}] (${candidate.candidateId}) is not eligible for credit`);
      if (seen.has(candidate.candidateId)) errors.push(`candidates[${index}] duplicates candidateId ${candidate.candidateId}`);
      seen.add(candidate.candidateId);
    }
    return { ok: errors.length === 0, errors };
  } catch (error) {
    return { ok: false, errors: [`candidate set validation failed closed: ${error.message}`] };
  }
}

// The digest fences reclaim evidence to the exact candidate set a caller
// proposed: order-independent so re-listing the same catalog can't mint a
// different fence, but sensitive to any membership or estimate change.
function computeCandidateSetDigest(candidates) {
  if (!Array.isArray(candidates)) throw new Error('candidate set must be an array');
  const canonical = [...candidates]
    .map((c) => ({ candidateId: c.candidateId, kind: c.kind, estimatedBytes: c.estimatedBytes }))
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));
  return digestOf(canonical);
}

module.exports = {
  CATALOG_CANDIDATE_VERSION,
  CANDIDATE_FLAGS,
  CATALOG_CANDIDATE_FIELDS,
  validateCandidate,
  isEligibleCandidate,
  validateCandidateSet,
  computeCandidateSetDigest,
};
