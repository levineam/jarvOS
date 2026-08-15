'use strict';

const crypto = require('node:crypto');
const { normalizeSignal, verifiedCodingOutcome } = require('../providers/learning-eligibility');

// Signals are deliberately derived from the authoritative completion object,
// never accepted from a tool caller.  The orchestrator may attach a bounded
// candidate after its own submission gate has passed.
function deriveLearningSignal(verification = {}) {
  if (!verifiedCodingOutcome(verification)) {
    return { ok: false, status: 'not-eligible', reasonCode: 'coding_outcome_not_verified' };
  }
  const candidate = verification.learning?.learning || verification.learningSignal
    || (verification.nonRoutine === true || verification.submissionGate?.nonRoutine === true ? {
      category: 'operational-lesson',
      summary: 'Authoritative submission evidence must remain attached to verified non-routine coding work.',
    } : null);
  if (!candidate) return { ok: false, status: 'not-eligible', reasonCode: 'no_reusable_learning_signal' };
  const normalized = normalizeSignal(candidate);
  if (!normalized.ok) return { ok: false, status: 'unsafe', reasonCode: 'unsafe_learning_signal', errors: normalized.errors };
  return {
    ok: true,
    signal: {
      ...normalized.signal,
      evidenceDigest: normalized.signal.evidenceDigest || crypto.createHash('sha256').update(JSON.stringify(verification.submissionGate || verification.events)).digest('hex'),
    },
  };
}

module.exports = { deriveLearningSignal };
