'use strict';

// Explicit, curated named exports: the public surface is exactly the typed
// records, validators, and decision functions this contract documents. It
// intentionally omits generic or store-internal helpers (e.g. port-shape
// assertion internals, raw state constructors/validators, conflict-error
// factories, the reference backend factory) that are implementation detail,
// not part of the portable contract.

const { CAPACITY_OBSERVATION_VERSION, validateCapacityObservation, createCapacityObservation } = require('./observation');
const { CAPACITY_POLICY_VERSION, validateCapacityPolicy, createCapacityPolicy } = require('./policy');
const {
  CATALOG_CANDIDATE_VERSION,
  CANDIDATE_FLAGS,
  validateCandidate,
  isEligibleCandidate,
  validateCandidateSet,
  computeCandidateSetDigest,
} = require('./catalog');
const { RECLAIM_RECEIPT_VERSION, RECLAIM_OUTCOMES, validateReclaimReceipt, validateExternalReclaimEvidence } = require('./reclaim');
const { DISPOSITIONS, computeCapacityPreflight } = require('./preflight');
const {
  RESERVATION_STORE_SCHEMA_VERSION,
  RESERVATION_STATES,
  createReservationStore,
  createMemoryReservationStore,
  checkReservationStoreConformance,
} = require('./reservation-store');
const { assertCapacityObservationPort, assertExternalReclaimPort, assertReservationPort } = require('./ports');
const { CAPACITY_PREFLIGHT_RECEIPT_VERSION, TERMINAL_OUTCOMES, createCapacityPreflightReceipt, authorizeReclaimReservation } = require('./outcomes');

module.exports = {
  CAPACITY_OBSERVATION_VERSION,
  validateCapacityObservation,
  createCapacityObservation,
  CAPACITY_POLICY_VERSION,
  validateCapacityPolicy,
  createCapacityPolicy,
  CATALOG_CANDIDATE_VERSION,
  CANDIDATE_FLAGS,
  validateCandidate,
  isEligibleCandidate,
  validateCandidateSet,
  computeCandidateSetDigest,
  RECLAIM_RECEIPT_VERSION,
  RECLAIM_OUTCOMES,
  validateReclaimReceipt,
  validateExternalReclaimEvidence,
  DISPOSITIONS,
  computeCapacityPreflight,
  RESERVATION_STORE_SCHEMA_VERSION,
  RESERVATION_STATES,
  createReservationStore,
  createMemoryReservationStore,
  checkReservationStoreConformance,
  assertCapacityObservationPort,
  assertExternalReclaimPort,
  assertReservationPort,
  CAPACITY_PREFLIGHT_RECEIPT_VERSION,
  TERMINAL_OUTCOMES,
  createCapacityPreflightReceipt,
  authorizeReclaimReservation,
};
