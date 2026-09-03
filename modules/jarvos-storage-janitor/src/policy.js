'use strict';

const { isObject, clone, isOpaqueId, isSafeNonNegativeInt, isSafePositiveInt, collectPrivacyErrors, collectUnknownFieldErrors } = require('./primitives');

const CAPACITY_POLICY_VERSION = 'jarvos-storage-janitor.policy.v1';
const CAPACITY_POLICY_FIELDS = Object.freeze(['version', 'policyId', 'requiredBytes', 'safetyMarginBytes']);

function validateCapacityPolicy(record) {
  try {
    const errors = collectPrivacyErrors(record);
    if (!isObject(record)) return { ok: false, errors: ['capacity policy must be an object'] };
    errors.push(...collectUnknownFieldErrors(record, CAPACITY_POLICY_FIELDS, 'policy'));
    if (record.version !== CAPACITY_POLICY_VERSION) errors.push(`policy.version must be ${CAPACITY_POLICY_VERSION}`);
    if (!isOpaqueId(record.policyId)) errors.push('policy.policyId must be an opaque identifier');
    // A required-bytes threshold of zero is not a capacity requirement at
    // all; reject it explicitly rather than let it silently trivialize
    // every preflight decision to `proceed`.
    if (!isSafePositiveInt(record.requiredBytes)) errors.push('policy.requiredBytes must be a positive safe integer');
    if (!isSafeNonNegativeInt(record.safetyMarginBytes)) errors.push('policy.safetyMarginBytes must be a non-negative safe integer');
    return { ok: errors.length === 0, errors };
  } catch (error) {
    return { ok: false, errors: [`policy validation failed closed: ${error.message}`] };
  }
}

function createCapacityPolicy(input = {}) {
  const record = clone(input);
  record.version = input.version || CAPACITY_POLICY_VERSION;
  const validation = validateCapacityPolicy(record);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return record;
}

module.exports = { CAPACITY_POLICY_VERSION, CAPACITY_POLICY_FIELDS, validateCapacityPolicy, createCapacityPolicy };
