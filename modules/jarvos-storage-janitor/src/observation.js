'use strict';

const { isObject, clone, isOpaqueId, isSafeNonNegativeInt, normalizeTime, collectPrivacyErrors, collectUnknownFieldErrors } = require('./primitives');

const CAPACITY_OBSERVATION_VERSION = 'jarvos-storage-janitor.observation.v1';
const CAPACITY_OBSERVATION_FIELDS = Object.freeze(['version', 'candidateSetId', 'observedAt', 'freshUntil', 'bytesAvailable', 'bytesTotal']);

function validateCapacityObservation(record, options = {}) {
  try {
    const errors = collectPrivacyErrors(record);
    if (!isObject(record)) return { ok: false, errors: ['capacity observation must be an object'] };
    errors.push(...collectUnknownFieldErrors(record, CAPACITY_OBSERVATION_FIELDS, 'observation'));
    if (record.version !== CAPACITY_OBSERVATION_VERSION) errors.push(`observation.version must be ${CAPACITY_OBSERVATION_VERSION}`);
    if (record.candidateSetId != null && !isOpaqueId(record.candidateSetId)) errors.push('observation.candidateSetId must be an opaque identifier');
    if (!isSafeNonNegativeInt(record.bytesAvailable)) errors.push('observation.bytesAvailable must be a non-negative safe integer');
    if (!isSafeNonNegativeInt(record.bytesTotal)) errors.push('observation.bytesTotal must be a non-negative safe integer');
    if (isSafeNonNegativeInt(record.bytesAvailable) && isSafeNonNegativeInt(record.bytesTotal) && record.bytesAvailable > record.bytesTotal) {
      errors.push('observation is internally inconsistent: bytesAvailable must not exceed bytesTotal');
    }
    let observedAt = null;
    let freshUntil = null;
    try { observedAt = normalizeTime(record.observedAt, 'observation.observedAt'); } catch (error) { errors.push(error.message); }
    try { freshUntil = normalizeTime(record.freshUntil, 'observation.freshUntil'); } catch (error) { errors.push(error.message); }
    if (observedAt && freshUntil && new Date(freshUntil) < new Date(observedAt)) errors.push('observation.freshUntil must not precede observedAt');

    // Freshness is relative to a caller-supplied clock, not the process wall
    // clock: a low-level structural validator must stay deterministic, so
    // stale/future checks only run when a `now` is explicitly provided (as
    // preflight always does, and always with a validated `now`).
    if (observedAt && options.now !== undefined) {
      const now = new Date(options.now);
      if (Number.isNaN(now.getTime())) errors.push('preflight clock is invalid');
      else {
        if (new Date(observedAt).getTime() > now.getTime()) errors.push('observation.observedAt must not be in the future');
        else if (freshUntil && new Date(freshUntil).getTime() <= now.getTime()) errors.push('observation is stale: freshUntil has passed');
      }
    }

    return { ok: errors.length === 0, errors };
  } catch (error) {
    return { ok: false, errors: [`observation validation failed closed: ${error.message}`] };
  }
}

function createCapacityObservation(input = {}) {
  const record = clone(input);
  record.version = input.version || CAPACITY_OBSERVATION_VERSION;
  const validation = validateCapacityObservation(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  record.observedAt = new Date(record.observedAt).toISOString();
  record.freshUntil = new Date(record.freshUntil).toISOString();
  return record;
}

module.exports = { CAPACITY_OBSERVATION_VERSION, CAPACITY_OBSERVATION_FIELDS, validateCapacityObservation, createCapacityObservation };
