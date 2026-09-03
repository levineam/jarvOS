'use strict';

const test = require('node:test');
const assert = require('node:assert');

const janitor = require('../src/index');

test('the package surfaces the full public contract', () => {
  for (const name of [
    'CAPACITY_OBSERVATION_VERSION',
    'validateCapacityObservation',
    'createCapacityObservation',
    'CAPACITY_POLICY_VERSION',
    'validateCapacityPolicy',
    'createCapacityPolicy',
    'CATALOG_CANDIDATE_VERSION',
    'CANDIDATE_FLAGS',
    'validateCandidate',
    'isEligibleCandidate',
    'validateCandidateSet',
    'computeCandidateSetDigest',
    'RECLAIM_RECEIPT_VERSION',
    'RECLAIM_OUTCOMES',
    'validateReclaimReceipt',
    'validateExternalReclaimEvidence',
    'DISPOSITIONS',
    'computeCapacityPreflight',
    'RESERVATION_STORE_SCHEMA_VERSION',
    'RESERVATION_STATES',
    'createReservationStore',
    'createMemoryReservationStore',
    'checkReservationStoreConformance',
    'assertCapacityObservationPort',
    'assertExternalReclaimPort',
    'assertReservationPort',
    'CAPACITY_PREFLIGHT_RECEIPT_VERSION',
    'TERMINAL_OUTCOMES',
    'createCapacityPreflightReceipt',
    'authorizeReclaimReservation',
  ]) {
    assert.ok(name in janitor, `missing export: ${name}`);
  }
});

test('the package does not accidentally export generic or store-internal helpers', () => {
  for (const name of [
    'assertPortShape',
    'emptyState',
    'validateState',
    'createReservationConflictError',
    'createMemoryReservationBackend',
    'digestOf',
    'isObject',
    'clone',
    'isOpaqueId',
    'isDigest',
    'isSafeNonNegativeInt',
    'isSafePositiveInt',
    'isValidClockValue',
    'normalizeTime',
    'collectPrivacyErrors',
  ]) {
    assert.ok(!(name in janitor), `unexpected internal export: ${name}`);
  }
});
