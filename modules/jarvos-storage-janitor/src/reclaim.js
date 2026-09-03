'use strict';

const { isObject, isOpaqueId, isDigest, isSafeNonNegativeInt, normalizeTime, collectPrivacyErrors, collectUnknownFieldErrors } = require('./primitives');

const RECLAIM_RECEIPT_VERSION = 'jarvos-storage-janitor.reclaim-receipt.v1';
const RECLAIM_OUTCOMES = Object.freeze(['verified', 'no-effect', 'failed']);
const RECLAIM_RECEIPT_FIELDS = Object.freeze(['version', 'runId', 'policyDigest', 'candidateSetDigest', 'fence', 'dryRun', 'outcome', 'bytesReclaimed', 'observedAt']);

// The reservation idempotency key is derived from exactly this tuple
// (see outcomes.js): runId, policyDigest, candidateSetDigest, and fence
// identify the reclaim run, never an advisory field like
// maxCreditableBytes, so a changed advisory value cannot fork a second
// reservation for the same underlying identity.
const RECLAIM_IDENTITY_FIELDS = Object.freeze(['runId', 'policyDigest', 'candidateSetDigest', 'fence', 'maxCreditableBytes']);

function validateReclaimReceipt(record, label = 'receipt') {
  try {
    const errors = collectPrivacyErrors(record);
    if (!isObject(record)) return { ok: false, errors: [`${label} must be an object`] };
    errors.push(...collectUnknownFieldErrors(record, RECLAIM_RECEIPT_FIELDS, label));
    if (record.version !== RECLAIM_RECEIPT_VERSION) errors.push(`${label}.version must be ${RECLAIM_RECEIPT_VERSION}`);
    if (!isOpaqueId(record.runId)) errors.push(`${label}.runId must be an opaque identifier`);
    if (!isDigest(record.policyDigest)) errors.push(`${label}.policyDigest must be a SHA-256 digest`);
    if (!isDigest(record.candidateSetDigest)) errors.push(`${label}.candidateSetDigest must be a SHA-256 digest`);
    if (!Number.isInteger(record.fence) || record.fence < 0) errors.push(`${label}.fence must be a non-negative integer`);
    if (typeof record.dryRun !== 'boolean') errors.push(`${label}.dryRun must be boolean`);
    if (!RECLAIM_OUTCOMES.includes(record.outcome)) errors.push(`${label}.outcome must be one of: ${RECLAIM_OUTCOMES.join(', ')}`);
    if (!isSafeNonNegativeInt(record.bytesReclaimed)) errors.push(`${label}.bytesReclaimed must be a non-negative safe integer`);
    try { normalizeTime(record.observedAt, `${label}.observedAt`); } catch (error) { errors.push(error.message); }
    return { ok: errors.length === 0, errors };
  } catch (error) {
    return { ok: false, errors: [`${label} validation failed closed: ${error.message}`] };
  }
}

// Dry-run-first, exact-match, monotonic-fence semantics: a terminal receipt
// can only be trusted alongside a dry run that proposed the identical run,
// policy, and candidate set at the identical fence, observed strictly
// earlier. Anything looser would let a provider apply a mutation nobody
// previewed, or credit a fence the preflight decision no longer recognizes.
//
// Credited bytes are bounded three ways: a failed dry run or failed
// terminal receipt credits nothing; a no-effect dry-run or terminal receipt
// always credits zero even if either reports nonzero bytes; and a verified
// terminal receipt (with a verified dry run) is bounded by both the dry
// run's own preview (`bytesReclaimed`) and the caller-supplied
// `expected.maxCreditableBytes` tied to the exact candidate set, so no
// receipt can ever over-credit.
function validateExternalReclaimEvidence(evidence, expected = {}) {
  try {
    if (!isObject(evidence)) return { ok: false, errors: ['reclaim evidence must be an object'], creditedBytes: 0 };
    if (
      !isOpaqueId(expected.runId)
      || !isDigest(expected.policyDigest)
      || !isDigest(expected.candidateSetDigest)
      || !Number.isInteger(expected.fence) || expected.fence < 0
      || !isSafeNonNegativeInt(expected.maxCreditableBytes)
    ) {
      return { ok: false, errors: ['expected run, policy, candidate-set, fence, and maxCreditableBytes identity are required'], creditedBytes: 0 };
    }

    const errors = collectUnknownFieldErrors(expected, RECLAIM_IDENTITY_FIELDS, 'expected');
    const dryRunValidation = validateReclaimReceipt(evidence.dryRunReceipt, 'dryRunReceipt');
    if (!dryRunValidation.ok) errors.push(...dryRunValidation.errors);
    const terminalValidation = validateReclaimReceipt(evidence.terminalReceipt, 'terminalReceipt');
    if (!terminalValidation.ok) errors.push(...terminalValidation.errors);
    if (errors.length > 0) return { ok: false, errors, creditedBytes: 0 };

    const { dryRunReceipt, terminalReceipt } = evidence;
    if (dryRunReceipt.dryRun !== true) errors.push('dryRunReceipt.dryRun must be true');
    if (terminalReceipt.dryRun !== false) errors.push('terminalReceipt.dryRun must be false');

    for (const [field, expectedValue] of Object.entries({ runId: expected.runId, policyDigest: expected.policyDigest, candidateSetDigest: expected.candidateSetDigest })) {
      if (dryRunReceipt[field] !== expectedValue) errors.push(`dryRunReceipt.${field} does not match the expected ${field}`);
      if (terminalReceipt[field] !== expectedValue) errors.push(`terminalReceipt.${field} does not match the expected ${field}`);
    }

    for (const [label, receipt] of [['dryRunReceipt', dryRunReceipt], ['terminalReceipt', terminalReceipt]]) {
      if (receipt.fence !== expected.fence) {
        errors.push(receipt.fence < expected.fence
          ? `${label}.fence is stale relative to the expected fence`
          : `${label}.fence does not match the expected fence`);
      }
    }

    if (new Date(dryRunReceipt.observedAt).getTime() >= new Date(terminalReceipt.observedAt).getTime()) {
      errors.push('dryRunReceipt must be observed strictly before terminalReceipt (dry-run-first)');
    }

    if (errors.length > 0) return { ok: false, errors, creditedBytes: 0 };

    if (dryRunReceipt.outcome === 'failed') {
      return { ok: false, errors: ['dryRunReceipt outcome is failed; no bytes can be credited'], creditedBytes: 0 };
    }
    if (terminalReceipt.outcome === 'failed') {
      return { ok: false, errors: ['terminalReceipt outcome is failed; no bytes can be credited'], creditedBytes: 0 };
    }
    if (dryRunReceipt.outcome === 'no-effect' || terminalReceipt.outcome === 'no-effect') {
      return { ok: true, errors: [], creditedBytes: 0 };
    }

    const creditedBytes = Math.min(terminalReceipt.bytesReclaimed, dryRunReceipt.bytesReclaimed, expected.maxCreditableBytes);
    return { ok: true, errors: [], creditedBytes };
  } catch (error) {
    return { ok: false, errors: [`reclaim evidence validation failed closed: ${error.message}`], creditedBytes: 0 };
  }
}

module.exports = {
  RECLAIM_RECEIPT_VERSION,
  RECLAIM_OUTCOMES,
  RECLAIM_RECEIPT_FIELDS,
  RECLAIM_IDENTITY_FIELDS,
  validateReclaimReceipt,
  validateExternalReclaimEvidence,
};
