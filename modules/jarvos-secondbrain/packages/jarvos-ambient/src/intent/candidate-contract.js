'use strict';

// Immutable, non-authoritative candidate envelope for the ambient intent layer.
// A candidate is a bounded proposal bound to eligible source evidence. It is a
// value, not a record: it carries no mutable status and cannot itself represent
// promotion, rejection, completion, or recall. It never carries raw transcript,
// note content, recall text, completion output, or a destination.

const CANDIDATE_SCHEMA_VERSION = 'jarvos.candidate.v1';

const CANDIDATE_TYPES = Object.freeze([
  'note-draft',
  'journal-suggestion',
  'memory-unit',
  'ontology-inquiry',
  'project-signal',
  'skill-proposal',
  'work-proposal',
]);

const CANDIDATE_AUTHORITY = 'non-authoritative';
const CANDIDATE_PRIVACY_TIERS = Object.freeze([
  'public',
  'local-private',
  'private',
  'sensitive',
]);
const CANDIDATE_SOURCE_TRUST = Object.freeze([
  'user-authored',
  'assistant-derived',
]);

const CANDIDATE_KEYS = [
  'schemaVersion', 'candidateId', 'candidateType', 'authority', 'sources',
  'privacyTier', 'sourceTrust', 'construction', 'dedupeKey', 'createdAt',
  'expiresAt', 'proposal',
];
const CONSTRUCTION_KEYS = ['extractorId', 'extractorVersion', 'eligibilityPolicyId'];
const SOURCE_KEYS = ['sourceEventId', 'evidenceDigest'];
const PROPOSAL_KEYS = ['title', 'summary'];

const MAX_IDENTITY_LENGTH = 256;
const MAX_SOURCES = 64;
const MAX_DEDUPE_KEY_LENGTH = 256;
const MAX_CONSTRUCTION_FIELD_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 2000;

const IDENTITY_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EVIDENCE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).every((key) => keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isIdentityOfKind(value, kind) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_LENGTH) return false;
  if (value !== value.toLowerCase()) return false;
  const segments = value.split(':');
  if (segments.length !== 4) return false;
  const [scheme, actualKind, namespace, opaque] = segments;
  if (scheme !== 'jarvos' || actualKind !== kind) return false;
  return IDENTITY_SEGMENT_PATTERN.test(namespace) && IDENTITY_SEGMENT_PATTERN.test(opaque);
}

function isoInstantMs(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetSign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  if (offsetSign && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function validateSourceEntry(entry, index, seen, errors) {
  const label = `sources[${index}]`;
  if (!hasExactKeys(entry, SOURCE_KEYS)) {
    errors.push(`${label} must contain only sourceEventId and evidenceDigest`);
    return;
  }
  if (!isIdentityOfKind(entry.sourceEventId, 'source-event')) {
    errors.push(`${label} sourceEventId must be a source-event identity`);
  } else if (seen.has(entry.sourceEventId)) {
    errors.push(`${label} duplicates an earlier sourceEventId`);
  } else {
    seen.add(entry.sourceEventId);
  }
  if (typeof entry.evidenceDigest !== 'string' || !EVIDENCE_DIGEST_PATTERN.test(entry.evidenceDigest)) {
    errors.push(`${label} evidenceDigest must be sha256:<64 hex>`);
  }
}

function validateConstruction(construction, errors) {
  if (!hasExactKeys(construction, CONSTRUCTION_KEYS)) {
    errors.push('construction must contain only extractorId, extractorVersion, and eligibilityPolicyId');
    return;
  }
  if (!isBoundedString(construction.extractorId, MAX_CONSTRUCTION_FIELD_LENGTH)) {
    errors.push('construction.extractorId must be a bounded non-empty string');
  }
  if (!isBoundedString(construction.extractorVersion, MAX_CONSTRUCTION_FIELD_LENGTH)) {
    errors.push('construction.extractorVersion must be a bounded non-empty string');
  }
  if (!isIdentityOfKind(construction.eligibilityPolicyId, 'policy')) {
    errors.push('construction.eligibilityPolicyId must be a policy identity');
  }
}

function validateProposal(proposal, errors) {
  if (!hasExactKeys(proposal, PROPOSAL_KEYS)) {
    errors.push('proposal must contain only title and summary');
    return;
  }
  if (!isBoundedString(proposal.title, MAX_TITLE_LENGTH)) {
    errors.push('proposal.title must be a bounded non-empty string');
  }
  if (!isBoundedString(proposal.summary, MAX_SUMMARY_LENGTH)) {
    errors.push('proposal.summary must be a bounded non-empty string');
  }
}

function validateCandidate(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) {
    errors.push('candidate must be an object');
    return errors;
  }
  if (!Object.keys(candidate).every((key) => CANDIDATE_KEYS.includes(key))) {
    errors.push('candidate contains an unknown field');
  }
  for (const key of CANDIDATE_KEYS) {
    if (!Object.hasOwn(candidate, key)) errors.push(`candidate is missing ${key}`);
  }

  if (candidate.schemaVersion !== CANDIDATE_SCHEMA_VERSION) {
    errors.push('candidate schemaVersion is unsupported');
  }
  if (!isIdentityOfKind(candidate.candidateId, 'candidate')) {
    errors.push('candidate candidateId must be a candidate identity');
  }
  if (!CANDIDATE_TYPES.includes(candidate.candidateType)) {
    errors.push('candidate has an unknown candidateType');
  }
  if (candidate.authority !== CANDIDATE_AUTHORITY) {
    errors.push('candidate authority must be the literal "non-authoritative"');
  }
  if (!CANDIDATE_PRIVACY_TIERS.includes(candidate.privacyTier)) {
    errors.push('candidate has an unknown or ineligible privacyTier');
  }
  if (!CANDIDATE_SOURCE_TRUST.includes(candidate.sourceTrust)) {
    errors.push('candidate has an unknown or ineligible sourceTrust');
  }
  if (!isBoundedString(candidate.dedupeKey, MAX_DEDUPE_KEY_LENGTH)) {
    errors.push('candidate dedupeKey must be a bounded non-empty string');
  }

  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0 || candidate.sources.length > MAX_SOURCES) {
    errors.push('candidate sources must be a bounded non-empty array');
  } else {
    const seen = new Set();
    candidate.sources.forEach((entry, index) => validateSourceEntry(entry, index, seen, errors));
  }

  if (!isPlainObject(candidate.construction)) {
    errors.push('candidate construction must be an object');
  } else {
    validateConstruction(candidate.construction, errors);
  }

  if (!isPlainObject(candidate.proposal)) {
    errors.push('candidate proposal must be an object');
  } else {
    validateProposal(candidate.proposal, errors);
  }

  const createdMs = isoInstantMs(candidate.createdAt);
  const expiresMs = isoInstantMs(candidate.expiresAt);
  if (createdMs === null) errors.push('candidate createdAt must be a real ISO instant');
  if (expiresMs === null) errors.push('candidate expiresAt must be a real ISO instant');
  if (createdMs !== null && expiresMs !== null && expiresMs <= createdMs) {
    errors.push('candidate expiresAt must be later than createdAt');
  }

  return errors;
}

function assertCandidate(candidate) {
  const errors = validateCandidate(candidate);
  if (errors.length > 0) {
    throw new Error(`invalid jarvos candidate: ${errors.join('; ')}`);
  }
  return candidate;
}

module.exports = {
  CANDIDATE_SCHEMA_VERSION,
  CANDIDATE_TYPES,
  CANDIDATE_AUTHORITY,
  CANDIDATE_PRIVACY_TIERS,
  CANDIDATE_SOURCE_TRUST,
  validateCandidate,
  assertCandidate,
};
