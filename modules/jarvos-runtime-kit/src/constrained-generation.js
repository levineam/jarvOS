'use strict';

// A declaration/evaluation contract only. It does not resolve a backend,
// invoke a provider, or change any existing runtime route. Backends remain
// responsible for collecting their own receipts; jarvOS can evaluate the
// redacted evidence using the same constraints everywhere.
const CONSTRAINED_GENERATION_CONTRACT_VERSION = 'jarvos-constrained-generation/v1';
const BACKEND_VERIFICATION_STATES = Object.freeze(['claimed-unverified', 'verified']);
const RUNTIME_PROOF_STATES = Object.freeze(['unproven', 'recorded-fixture', 'verified']);
const USAGE_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']);
// This is intentionally not a router or an install inventory. It prevents a
// declaration-only extraction from implying that any candidate backend has
// received the later, backend-specific verification required for admission.
const DEFAULT_CONSTRAINED_GENERATION_BACKENDS = Object.freeze([
  Object.freeze({ id: 'openclaw', verification: 'claimed-unverified' }),
  Object.freeze({ id: 'hermes', verification: 'claimed-unverified' }),
  Object.freeze({ id: 'direct-provider', verification: 'claimed-unverified' }),
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9._-]{0,127}$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function invalid(reasonCode) {
  return Object.freeze({ ok: false, reasonCode });
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).every((key) => keys.includes(key));
}

function validUsage(usage) {
  return isObject(usage)
    && Object.keys(usage).length > 0
    && Object.keys(usage).every((key) => USAGE_FIELDS.includes(key)
      && Number.isSafeInteger(usage[key]) && usage[key] >= 0);
}

function validAttempt(attempt, request) {
  return exactKeys(attempt, ['provider', 'model'])
    && attempt.provider === request.provider
    && attempt.model === request.model;
}

/**
 * Evaluate a redacted constrained-generation receipt. A successful return
 * proves only that this record satisfies the portable constraints. It never
 * promotes a backend from claimed-unverified to verified.
 */
function evaluateConstrainedGeneration(record) {
  if (!exactKeys(record, ['version', 'backend', 'request', 'runtimeProof', 'observed'])) return invalid('record_invalid');
  if (record.version !== CONSTRAINED_GENERATION_CONTRACT_VERSION) return invalid('version_unsupported');

  const { backend, request, runtimeProof, observed } = record;
  if (!exactKeys(backend, ['id', 'verification']) || !isIdentifier(backend.id)
    || !BACKEND_VERIFICATION_STATES.includes(backend.verification)) return invalid('backend_invalid');
  if (!exactKeys(request, ['provider', 'model', 'reasoningEffort'])
    || !isIdentifier(request.provider) || !isIdentifier(request.model) || !isIdentifier(request.reasoningEffort)) return invalid('request_invalid');
  if (!exactKeys(runtimeProof, ['status', 'receiptDigest'])
    || !RUNTIME_PROOF_STATES.includes(runtimeProof.status) || !isDigest(runtimeProof.receiptDigest)) return invalid('runtime_proof_invalid');
  if (runtimeProof.status === 'unproven') return invalid('runtime_proof_unproven');
  if (!exactKeys(observed, [
    'provider', 'model', 'reasoningEffort', 'toolCallCount', 'delivered', 'fallbackUsed', 'attempts', 'usage', 'outputDigest',
  ])) return invalid('observed_invalid');
  if (!isIdentifier(observed.provider) || !isIdentifier(observed.model) || !isIdentifier(observed.reasoningEffort)
    || !Number.isSafeInteger(observed.toolCallCount) || observed.toolCallCount < 0
    || typeof observed.delivered !== 'boolean' || typeof observed.fallbackUsed !== 'boolean'
    || !Array.isArray(observed.attempts) || observed.attempts.length === 0 || observed.attempts.length > 16
    || !validUsage(observed.usage) || !isDigest(observed.outputDigest)) return invalid('observed_invalid');
  if (observed.provider !== request.provider || observed.model !== request.model) return invalid('effective_model_mismatch');
  if (observed.reasoningEffort !== request.reasoningEffort) return invalid('reasoning_effort_mismatch');
  if (observed.toolCallCount !== 0) return invalid('tool_activity_detected');
  if (observed.delivered !== false) return invalid('delivery_activity_detected');
  if (observed.fallbackUsed !== false || observed.attempts.some((attempt) => !validAttempt(attempt, request))) return invalid('fallback_detected');

  return Object.freeze({
    ok: true,
    contractVersion: CONSTRAINED_GENERATION_CONTRACT_VERSION,
    backend: Object.freeze({ id: backend.id, verification: backend.verification }),
    runtimeProof: Object.freeze({ status: runtimeProof.status, receiptDigest: runtimeProof.receiptDigest }),
    // This evaluator authenticates nothing. Even an externally supplied
    // `verified` claim stays non-admitting until a future backend-specific
    // verifier binds it to an actual runtime.
    effectiveModelReceipt: Object.freeze({ provider: observed.provider, model: observed.model, verified: false }),
    usage: Object.freeze({ ...observed.usage }),
    constraints: Object.freeze({ runtimeProofPresent: true, zeroToolAssurance: true, exactModel: true, noFallback: true, usageEvidencePresent: true, deliveryDenied: true }),
    // Contract-fixture conformance cannot make a live harness admission
    // claim. A future explicit verifier owns promotion.
    admitted: false,
  });
}

module.exports = {
  BACKEND_VERIFICATION_STATES,
  CONSTRAINED_GENERATION_CONTRACT_VERSION,
  DEFAULT_CONSTRAINED_GENERATION_BACKENDS,
  RUNTIME_PROOF_STATES,
  evaluateConstrainedGeneration,
};
