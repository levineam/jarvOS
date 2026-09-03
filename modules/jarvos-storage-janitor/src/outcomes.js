'use strict';

const { isObject, isOpaqueId, isDigest, isSafeNonNegativeInt, isValidClockValue, normalizeTime, digestOf, collectUnknownFieldErrors, safeSum } = require('./primitives');
const { validateCapacityPolicy } = require('./policy');
const { DISPOSITIONS, computeCapacityPreflight } = require('./preflight');
const { validateExternalReclaimEvidence, RECLAIM_IDENTITY_FIELDS } = require('./reclaim');
const { assertReservationPort } = require('./ports');

const CAPACITY_PREFLIGHT_RECEIPT_VERSION = 'jarvos-storage-janitor.preflight-receipt.v1';
const TERMINAL_OUTCOMES = Object.freeze(['proceed', 'blocked', 'recommend_external_reclaim', 'reserved']);

// A preflight receipt may only wrap an actual preflight disposition
// (`proceed` / `blocked` / `recommend_external_reclaim`); `reserved` is a
// terminal outcome this package only produces from
// `authorizeReclaimReservation`, never from a preflight decision. When
// supplied, the receipt binds the decision to the policy's digest, the
// observation time, and a run/fence identity so it cannot be replayed
// against a different policy, moment, or reclaim run.
function createCapacityPreflightReceipt(preflightResult, context = {}) {
  try {
    if (!isObject(preflightResult) || !DISPOSITIONS.includes(preflightResult.disposition)) {
      return { ok: false, errors: ['preflight result is malformed or reports a non-preflight disposition'] };
    }

    const errors = [];

    let policyDigest = null;
    if (context.policy !== undefined) {
      const policyValidation = validateCapacityPolicy(context.policy);
      if (!policyValidation.ok) errors.push(...policyValidation.errors);
      else {
        try { policyDigest = digestOf(context.policy); } catch (error) { errors.push(`context.policy could not be digested: ${error.message}`); }
      }
    }

    let observedAt = null;
    if (context.observedAt !== undefined) {
      try { observedAt = normalizeTime(context.observedAt, 'context.observedAt'); } catch (error) { errors.push(error.message); }
    }

    let runId = null;
    if (context.runId !== undefined) {
      if (!isOpaqueId(context.runId)) errors.push('context.runId must be an opaque identifier');
      else runId = context.runId;
    }

    let fence = null;
    if (context.fence !== undefined) {
      if (!Number.isInteger(context.fence) || context.fence < 0) errors.push('context.fence must be a non-negative integer');
      else fence = context.fence;
    }

    if (errors.length > 0) return { ok: false, errors };

    return {
      version: CAPACITY_PREFLIGHT_RECEIPT_VERSION,
      outcome: preflightResult.disposition,
      ok: preflightResult.ok,
      pressure: preflightResult.pressure,
      candidateSetDigest: preflightResult.candidateSetDigest,
      errors: preflightResult.errors,
      policyDigest,
      observedAt,
      runId,
      fence,
    };
  } catch (error) {
    return { ok: false, errors: [`preflight receipt creation failed closed: ${error.message}`] };
  }
}

// A one-time reservation is how this module proves ENOSPC-safety without an
// unbounded probe write: instead of writing a large file to see whether it
// fits, the caller authorizes a byte-accounted credit for the policy's full
// required total (including safety margin), backed by verified dry-run-first
// reclaim evidence and a fresh sufficient remeasurement, then spends that
// credit atomically. The capacity pool and its limit are explicit,
// caller-supplied typed inputs -- this package never invents a default
// capacity pool or limit.
async function authorizeReclaimReservation({ evidence, expected, remeasurement, policy, now, expiresAt, poolId, capacityLimitBytes, reservationStore } = {}) {
  try {
    const errors = [];

    if (!isValidClockValue(now)) errors.push('authorization requires a valid explicit UTC ISO now');

    const policyValidation = validateCapacityPolicy(policy);
    if (!policyValidation.ok) errors.push(...policyValidation.errors);

    let policyDigest = null;
    if (policyValidation.ok) {
      try { policyDigest = digestOf(policy); } catch (error) { errors.push(`policy could not be digested: ${error.message}`); }
    }

    if (
      !isObject(expected)
      || !isOpaqueId(expected.runId)
      || !isDigest(expected.policyDigest)
      || !isDigest(expected.candidateSetDigest)
      || !Number.isInteger(expected.fence) || expected.fence < 0
      || !isSafeNonNegativeInt(expected.maxCreditableBytes)
    ) {
      errors.push('expected run, policy, candidate-set, fence, and maxCreditableBytes identity are required');
    } else {
      errors.push(...collectUnknownFieldErrors(expected, RECLAIM_IDENTITY_FIELDS, 'expected'));
      if (policyDigest !== null && expected.policyDigest !== policyDigest) {
        errors.push('expected.policyDigest does not match the supplied policy');
      }
    }

    if (!isOpaqueId(poolId) || !isSafeNonNegativeInt(capacityLimitBytes)) {
      errors.push('poolId and capacityLimitBytes are required explicit typed inputs');
    }

    try {
      assertReservationPort(reservationStore);
    } catch (error) {
      errors.push(`a conforming reservation-persistence port is required: ${error.message}`);
    }

    if (errors.length > 0) return { ok: false, outcome: 'blocked', errors, reservation: null };

    const evidenceValidation = validateExternalReclaimEvidence(evidence, expected);
    if (!evidenceValidation.ok) return { ok: false, outcome: 'blocked', errors: evidenceValidation.errors, reservation: null };
    if (evidenceValidation.creditedBytes <= 0) {
      return { ok: false, outcome: 'blocked', errors: ['reclaim evidence credited zero bytes'], reservation: null };
    }

    const remeasured = computeCapacityPreflight({ observation: remeasurement, policy, now });
    if (remeasured.disposition !== 'proceed') {
      return { ok: false, outcome: 'blocked', errors: remeasured.errors.length > 0 ? remeasured.errors : ['remeasurement is not fresh and sufficient'], reservation: null };
    }

    // Reserve the full required total, including the safety margin, so an
    // authorized reservation actually covers the policy's declared
    // requirement rather than only its base requiredBytes.
    const requiredTotal = safeSum(policy.requiredBytes, policy.safetyMarginBytes);
    if (requiredTotal === null) {
      return { ok: false, outcome: 'blocked', errors: ['policy.requiredBytes + policy.safetyMarginBytes overflows a safe integer'], reservation: null };
    }

    // The reservation identity is exactly this tuple, never the entire
    // caller-supplied `expected` record: `maxCreditableBytes` (and any
    // future advisory field) is credit-bounding guidance, not part of what
    // makes a reclaim run/policy/candidate-set/fence identity distinct, so
    // it must not be able to fork a second reservation for that identity.
    const reservationIdentity = {
      runId: expected.runId,
      policyDigest: expected.policyDigest,
      candidateSetDigest: expected.candidateSetDigest,
      fence: expected.fence,
    };
    let idempotencyKey;
    try {
      idempotencyKey = `reserve:${digestOf(reservationIdentity)}`;
    } catch (error) {
      return { ok: false, outcome: 'blocked', errors: [`reservation identity could not be digested: ${error.message}`], reservation: null };
    }

    let reserveResult;
    try {
      reserveResult = await reservationStore.reserve({
        idempotencyKey,
        amountBytes: requiredTotal,
        fenceGeneration: expected.fence,
        poolId,
        capacityLimitBytes,
        expiresAt,
        now,
      });
    } catch (error) {
      // Even an off-contract adapter that throws instead of returning a
      // typed result must not escape authorization as an unhandled
      // rejection; it fails closed to `blocked`.
      return { ok: false, outcome: 'blocked', errors: [`reservation-persistence port failed: ${error.message}`], reservation: null };
    }

    if (!reserveResult || !reserveResult.ok) {
      return {
        ok: false,
        outcome: 'blocked',
        errors: (reserveResult && reserveResult.errors) || [(reserveResult && reserveResult.reason) || 'reservation denied'],
        reservation: null,
      };
    }
    return { ok: true, outcome: 'reserved', errors: [], reservation: reserveResult.reservation, creditedBytes: evidenceValidation.creditedBytes };
  } catch (error) {
    return { ok: false, outcome: 'blocked', errors: [`authorization failed closed: ${error.message}`], reservation: null };
  }
}

module.exports = { CAPACITY_PREFLIGHT_RECEIPT_VERSION, TERMINAL_OUTCOMES, createCapacityPreflightReceipt, authorizeReclaimReservation };
