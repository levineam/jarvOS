'use strict';

// Bounded, cross-surface evidence that a governed promotion operation was
// attempted. This envelope reports an outcome; it does not authorize a write,
// prove destination-specific semantics, or embed raw content or host paths.

const { validateIdentity } = require('./identity');

const PROMOTION_RECEIPT_SCHEMA_VERSION = 'jarvos.promotion-receipt.v1';
const PROMOTION_RECEIPT_OPERATIONS = Object.freeze([
  'promotion', 'supersession', 'retraction', 'rollback', 'correction',
]);
const PROMOTION_RECEIPT_OUTCOMES = Object.freeze([
  'committed', 'already_satisfied', 'deferred', 'conflict', 'failed',
]);
const PROMOTION_AUTHORIZATION_MODES = Object.freeze([
  'user-reviewed', 'policy-automatic',
]);
const PROMOTION_DESTINATION_SURFACES = Object.freeze([
  'notes', 'journal', 'memory', 'ontology', 'projects', 'skills', 'work',
]);
const PROMOTION_REVERSAL_MODES = Object.freeze([
  'rollback', 'retraction', 'supersession', 'none',
]);
const PROMOTION_EVIDENCE_TYPES = Object.freeze([
  'destination-receipt', 'policy-decision', 'authorization', 'verification',
]);

const RECEIPT_KEYS = [
  'schemaVersion', 'receiptId', 'operation', 'outcome', 'candidateIds',
  'policyId', 'authorization', 'destination', 'recordedAt', 'evidence',
];
const AUTHORIZATION_KEYS = ['mode'];
const DESTINATION_KEYS = [
  'surface', 'artifactId', 'revisionBefore', 'revisionAfter', 'reversalMode',
];
const EVIDENCE_KEYS = ['type', 'ref', 'digest'];
const MAX_CANDIDATES = 64;
const MAX_EVIDENCE = 64;
const MAX_LOGICAL_REF_LENGTH = 256;
const MAX_REVISION_LENGTH = 256;
const LOGICAL_REF_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UTC_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

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

function isLogicalRef(value) {
  return isBoundedString(value, MAX_LOGICAL_REF_LENGTH)
    && LOGICAL_REF_PATTERN.test(value)
    && !value.includes('..')
    && !value.startsWith('file:');
}

function isRealUtcInstant(value) {
  if (typeof value !== 'string') return false;
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  return !Number.isNaN(Date.parse(value));
}

function validateAuthorization(authorization, errors) {
  if (!hasExactKeys(authorization, AUTHORIZATION_KEYS)) {
    errors.push('authorization must contain only mode');
    return;
  }
  if (!PROMOTION_AUTHORIZATION_MODES.includes(authorization.mode)) {
    errors.push('authorization has an unknown mode');
  }
}

function validateDestination(destination, outcome, errors) {
  if (!hasExactKeys(destination, DESTINATION_KEYS)) {
    errors.push('destination must contain only surface, artifactId, revisionBefore, revisionAfter, and reversalMode');
    return;
  }
  if (!PROMOTION_DESTINATION_SURFACES.includes(destination.surface)) {
    errors.push('destination has an unknown surface');
  }
  if (validateIdentity(destination.artifactId, 'artifact').length > 0) {
    errors.push('destination artifactId must be an artifact identity');
  }
  if (destination.revisionBefore !== null
    && (!isBoundedString(destination.revisionBefore, MAX_REVISION_LENGTH)
      || !isLogicalRef(destination.revisionBefore))) {
    errors.push('destination revisionBefore must be null or a bounded logical reference');
  }
  if (!PROMOTION_REVERSAL_MODES.includes(destination.reversalMode)) {
    errors.push('destination has an unknown reversalMode');
  }
  if (outcome === 'committed') {
    if (!isBoundedString(destination.revisionAfter, MAX_REVISION_LENGTH)
      || !isLogicalRef(destination.revisionAfter)) {
      errors.push('a committed receipt requires a bounded logical revisionAfter');
    }
  } else {
    if (destination.revisionAfter !== null) {
      errors.push('a non-committed receipt must set revisionAfter to null');
    }
    if (destination.reversalMode !== 'none') {
      errors.push('a non-committed receipt must set reversalMode to none');
    }
  }
}

function validateEvidence(evidence, index, errors) {
  const label = `evidence[${index}]`;
  if (!hasExactKeys(evidence, EVIDENCE_KEYS)) {
    errors.push(`${label} must contain only type, ref, and digest`);
    return;
  }
  if (!PROMOTION_EVIDENCE_TYPES.includes(evidence.type)) {
    errors.push(`${label} has an unknown type`);
  }
  if (!isLogicalRef(evidence.ref)) {
    errors.push(`${label} ref must be a bounded logical reference`);
  }
  if (typeof evidence.digest !== 'string' || !DIGEST_PATTERN.test(evidence.digest)) {
    errors.push(`${label} digest must be sha256:<64 hex>`);
  }
}

function validatePromotionReceipt(receipt) {
  const errors = [];
  if (!isPlainObject(receipt)) {
    errors.push('promotion receipt must be an object');
    return errors;
  }
  const allowedKeys = [...RECEIPT_KEYS, 'predecessorReceiptId'];
  if (!Object.keys(receipt).every((key) => allowedKeys.includes(key))) {
    errors.push('promotion receipt contains an unknown field');
  }
  for (const key of RECEIPT_KEYS) {
    if (!Object.hasOwn(receipt, key)) errors.push(`promotion receipt is missing ${key}`);
  }

  if (receipt.schemaVersion !== PROMOTION_RECEIPT_SCHEMA_VERSION) {
    errors.push('promotion receipt schemaVersion is unsupported');
  }
  if (validateIdentity(receipt.receiptId, 'receipt').length > 0) {
    errors.push('receiptId must be a receipt identity');
  }
  if (!PROMOTION_RECEIPT_OPERATIONS.includes(receipt.operation)) {
    errors.push('promotion receipt has an unknown operation');
  }
  if (!PROMOTION_RECEIPT_OUTCOMES.includes(receipt.outcome)) {
    errors.push('promotion receipt has an unknown outcome');
  }

  if (!Array.isArray(receipt.candidateIds) || receipt.candidateIds.length > MAX_CANDIDATES) {
    errors.push('candidateIds must be a bounded array');
  } else {
    const seen = new Set();
    receipt.candidateIds.forEach((candidateId, index) => {
      if (validateIdentity(candidateId, 'candidate').length > 0) {
        errors.push(`candidateIds[${index}] must be a candidate identity`);
      } else if (seen.has(candidateId)) {
        errors.push(`candidateIds[${index}] duplicates an earlier candidate identity`);
      } else {
        seen.add(candidateId);
      }
    });
  }
  if (receipt.operation === 'promotion') {
    if (!Array.isArray(receipt.candidateIds) || receipt.candidateIds.length === 0) {
      errors.push('promotion requires at least one candidateId');
    }
    if (Object.hasOwn(receipt, 'predecessorReceiptId')) {
      errors.push('promotion cannot declare a predecessorReceiptId');
    }
  } else if (PROMOTION_RECEIPT_OPERATIONS.includes(receipt.operation)) {
    if (!Object.hasOwn(receipt, 'predecessorReceiptId')
      || validateIdentity(receipt.predecessorReceiptId, 'receipt').length > 0) {
      errors.push('non-promotion operation requires a receipt predecessorReceiptId');
    }
  }

  if (validateIdentity(receipt.policyId, 'policy').length > 0) {
    errors.push('policyId must be a policy identity');
  }
  validateAuthorization(receipt.authorization, errors);
  validateDestination(receipt.destination, receipt.outcome, errors);
  if (!isRealUtcInstant(receipt.recordedAt)) {
    errors.push('recordedAt must be a real ISO UTC instant');
  }
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0 || receipt.evidence.length > MAX_EVIDENCE) {
    errors.push('evidence must be a bounded non-empty array');
  } else {
    receipt.evidence.forEach((entry, index) => validateEvidence(entry, index, errors));
  }
  return errors;
}

function assertPromotionReceipt(receipt) {
  const errors = validatePromotionReceipt(receipt);
  if (errors.length > 0) {
    throw new Error(`invalid jarvos promotion receipt: ${errors.join('; ')}`);
  }
  return receipt;
}

module.exports = {
  PROMOTION_RECEIPT_SCHEMA_VERSION,
  PROMOTION_RECEIPT_OPERATIONS,
  PROMOTION_RECEIPT_OUTCOMES,
  PROMOTION_AUTHORIZATION_MODES,
  PROMOTION_DESTINATION_SURFACES,
  PROMOTION_REVERSAL_MODES,
  PROMOTION_EVIDENCE_TYPES,
  validatePromotionReceipt,
  assertPromotionReceipt,
};
