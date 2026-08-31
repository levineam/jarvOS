'use strict';

// Capability truth ledger contract. Records are assertions with evidence
// pointers, not discovery, activation proof, or live probes. The validator
// reads no repository, host, process, or network state. It checks only the
// shape and bounds of an in-memory ledger and never infers one truth dimension
// from another.

const CAPABILITY_LEDGER_SCHEMA_VERSION = 'jarvos.capability-ledger.v1';

const SPECIFICATION_STATES = Object.freeze(['absent', 'draft', 'canonical']);
const IMPLEMENTATION_STATES = Object.freeze(['absent', 'partial', 'complete']);
const REPOSITORY_STATES = Object.freeze(['local-only', 'draft-pr', 'merged', 'released']);
const VERIFICATION_STATES = Object.freeze(['untested', 'fixture-proven', 'clean-install-proven', 'live-canary-proven']);
const ACTIVATION_STATES = Object.freeze(['inactive', 'test-fixture', 'disposable', 'enrolled-host', 'production', 'unknown']);
const AUTHORITY_STATES = Object.freeze(['none', 'read-only', 'proposed', 'active', 'conflicted']);
const EVIDENCE_TYPES = Object.freeze(['repo-path', 'pull-request', 'test', 'document', 'commit']);

const RECORD_KEYS = [
  'capabilityId', 'title', 'specification', 'implementation', 'repository',
  'verification', 'activation', 'authority', 'evidence', 'assertedOn', 'notes',
];
const REQUIRED_RECORD_KEYS = RECORD_KEYS.filter((key) => key !== 'notes');
const MAX_RECORDS = 256;
const MAX_EVIDENCE = 32;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTES_LENGTH = 1000;
const MAX_REF_LENGTH = 256;
const CAPABILITY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidEvidenceRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > MAX_REF_LENGTH) return false;
  if (/\s/.test(ref)) return false;
  if (ref.startsWith('/') || ref.startsWith('\\')) return false;
  if (/^[a-z]:[\\/]/i.test(ref)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return false;
  return !ref.split(/[\\/]/).includes('..');
}

function validateEvidenceEntry(entry, index, recordLabel, errors) {
  const label = `${recordLabel}.evidence[${index}]`;
  if (!hasOnlyKeys(entry, ['type', 'ref'])
    || !Object.hasOwn(entry, 'type') || !Object.hasOwn(entry, 'ref')) {
    errors.push(`${label} must contain only type and ref`);
    return;
  }
  if (!EVIDENCE_TYPES.includes(entry.type)) {
    errors.push(`${label} has an unknown evidence type`);
  }
  if (!isValidEvidenceRef(entry.ref)) {
    errors.push(`${label} ref must be a bounded, relative, scheme-free reference`);
  }
}

function validateRecord(record, index, seenIds, errors) {
  const label = `records[${index}]`;
  if (!isPlainObject(record)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (!hasOnlyKeys(record, RECORD_KEYS)) {
    errors.push(`${label} contains an unknown field`);
  }
  for (const key of REQUIRED_RECORD_KEYS) {
    if (!Object.hasOwn(record, key)) errors.push(`${label} is missing ${key}`);
  }
  if (typeof record.capabilityId !== 'string' || !CAPABILITY_ID_PATTERN.test(record.capabilityId)) {
    errors.push(`${label} capabilityId must be a bounded lowercase slug`);
  } else if (seenIds.has(record.capabilityId)) {
    errors.push(`${label} duplicates an earlier capabilityId`);
  } else {
    seenIds.add(record.capabilityId);
  }
  if (!isBoundedString(record.title, MAX_TITLE_LENGTH)) {
    errors.push(`${label} title must be a bounded non-empty string`);
  }
  if (!SPECIFICATION_STATES.includes(record.specification)) errors.push(`${label} has an unknown specification state`);
  if (!IMPLEMENTATION_STATES.includes(record.implementation)) errors.push(`${label} has an unknown implementation state`);
  if (!REPOSITORY_STATES.includes(record.repository)) errors.push(`${label} has an unknown repository state`);
  if (!VERIFICATION_STATES.includes(record.verification)) errors.push(`${label} has an unknown verification state`);
  if (!ACTIVATION_STATES.includes(record.activation)) errors.push(`${label} has an unknown activation state`);
  if (!AUTHORITY_STATES.includes(record.authority)) errors.push(`${label} has an unknown authority state`);
  if (!Array.isArray(record.evidence) || record.evidence.length === 0 || record.evidence.length > MAX_EVIDENCE) {
    errors.push(`${label} evidence must be a bounded non-empty array`);
  } else {
    record.evidence.forEach((entry, evidenceIndex) => validateEvidenceEntry(entry, evidenceIndex, label, errors));
  }
  if (!isDate(record.assertedOn)) {
    errors.push(`${label} assertedOn must be an ISO calendar date`);
  }
  if (Object.hasOwn(record, 'notes') && !isBoundedString(record.notes, MAX_NOTES_LENGTH)) {
    errors.push(`${label} notes must be a bounded non-empty string when present`);
  }
}

function validateCapabilityLedger(ledger) {
  const errors = [];
  if (!isPlainObject(ledger)) {
    errors.push('ledger must be an object');
    return errors;
  }
  if (!hasOnlyKeys(ledger, ['schemaVersion', 'records'])) {
    errors.push('ledger contains an unknown top-level field');
  }
  if (ledger.schemaVersion !== CAPABILITY_LEDGER_SCHEMA_VERSION) {
    errors.push('ledger schemaVersion is unsupported');
  }
  if (!Array.isArray(ledger.records) || ledger.records.length === 0 || ledger.records.length > MAX_RECORDS) {
    errors.push('ledger records must be a bounded non-empty array');
    return errors;
  }
  const seenIds = new Set();
  ledger.records.forEach((record, index) => validateRecord(record, index, seenIds, errors));
  return errors;
}

function assertCapabilityLedger(ledger) {
  const errors = validateCapabilityLedger(ledger);
  if (errors.length > 0) {
    throw new Error(`invalid capability ledger: ${errors.join('; ')}`);
  }
  return ledger;
}

module.exports = {
  CAPABILITY_LEDGER_SCHEMA_VERSION,
  SPECIFICATION_STATES,
  IMPLEMENTATION_STATES,
  REPOSITORY_STATES,
  VERIFICATION_STATES,
  ACTIVATION_STATES,
  AUTHORITY_STATES,
  EVIDENCE_TYPES,
  validateCapabilityLedger,
  assertCapabilityLedger,
};
