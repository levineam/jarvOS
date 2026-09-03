'use strict';

const { isValidClockValue } = require('./primitives');
const { validateCapacityObservation } = require('./observation');
const { validateCapacityPolicy } = require('./policy');
const { validateCandidateSet, computeCandidateSetDigest } = require('./catalog');

const DISPOSITIONS = Object.freeze(['proceed', 'blocked', 'recommend_external_reclaim']);

function safeSum(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  const sum = a + b;
  return Number.isSafeInteger(sum) ? sum : null;
}

// Any failure here is an unsafe write: a caller with no verdict must not
// proceed, so every rejection path returns `blocked` rather than throwing or
// returning an ambiguous `ok: false` with no disposition to act on.
function computeCapacityPreflight({ observation, policy, candidates, now } = {}) {
  try {
    const errors = [];

    // Freshness is meaningless without an explicit, validated clock: an
    // absent or malformed `now` fails closed rather than silently skipping
    // the freshness check the low-level observation validator would
    // otherwise defer to it.
    if (!isValidClockValue(now)) errors.push('preflight requires a valid explicit UTC ISO now');

    const observationValidation = validateCapacityObservation(observation, { now });
    if (!observationValidation.ok) errors.push(...observationValidation.errors);

    const policyValidation = validateCapacityPolicy(policy);
    if (!policyValidation.ok) errors.push(...policyValidation.errors);

    if (errors.length > 0) {
      return { ok: false, disposition: 'blocked', errors, pressure: null, candidateSetDigest: null };
    }

    const requiredTotal = safeSum(policy.requiredBytes, policy.safetyMarginBytes);
    if (requiredTotal === null) {
      return {
        ok: false,
        disposition: 'blocked',
        errors: ['policy.requiredBytes + policy.safetyMarginBytes overflows a safe integer'],
        pressure: null,
        candidateSetDigest: null,
      };
    }

    const pressure = { bytesAvailable: observation.bytesAvailable, requiredBytes: requiredTotal, deficitBytes: Math.max(0, requiredTotal - observation.bytesAvailable) };

    if (observation.bytesAvailable >= requiredTotal) {
      return { ok: true, disposition: 'proceed', errors: [], pressure, candidateSetDigest: null };
    }

    if (candidates !== undefined) {
      const candidateSetValidation = validateCandidateSet(candidates);
      if (!candidateSetValidation.ok) {
        return { ok: true, disposition: 'blocked', errors: candidateSetValidation.errors, pressure, candidateSetDigest: null };
      }

      let reclaimableBytes = 0;
      for (const candidate of candidates) {
        const summed = safeSum(reclaimableBytes, candidate.estimatedBytes);
        if (summed === null) {
          return {
            ok: true,
            disposition: 'blocked',
            errors: ['candidate estimatedBytes total overflows a safe integer'],
            pressure,
            candidateSetDigest: null,
          };
        }
        reclaimableBytes = summed;
      }

      if (reclaimableBytes >= pressure.deficitBytes) {
        return {
          ok: true,
          disposition: 'recommend_external_reclaim',
          errors: [],
          pressure,
          candidateSetDigest: computeCandidateSetDigest(candidates),
        };
      }

      return { ok: true, disposition: 'blocked', errors: ['candidate set cannot bridge the capacity deficit'], pressure, candidateSetDigest: null };
    }

    return { ok: true, disposition: 'blocked', errors: [], pressure, candidateSetDigest: null };
  } catch (error) {
    return { ok: false, disposition: 'blocked', errors: [`preflight failed closed: ${error.message}`], pressure: null, candidateSetDigest: null };
  }
}

module.exports = { DISPOSITIONS, computeCapacityPreflight };
