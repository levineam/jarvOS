'use strict';

const crypto = require('node:crypto');

const LEARNING_ELIGIBILITY_SCHEMA_VERSION = 'jarvos-coding-learning-eligibility/v1';
const LEARNING_OUTCOMES = Object.freeze(['eligible', 'not-eligible', 'declined', 'unavailable', 'failed', 'deferred']);
const LEARNING_CATEGORIES = new Set([
  'root-cause',
  'architecture-constraint',
  'failed-approach',
  'operational-lesson',
  'project-vocabulary',
  'routine',
  'cosmetic',
]);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const ABSOLUTE_PATH = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/;
const EMBEDDED_ABSOLUTE_PATH = /(?:^|\s)(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const PRIVATE_CONTENT = /(?:transcript|raw\s+message|message\s+body|credential|private\s+key|\.env(?:\.|\b)|(?:^|[\\/])(?:credentials?|secrets?|tokens?)(?:[\\/]|$))/i;
const MAX_SUMMARY_LENGTH = 500;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function safeText(value, label) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > MAX_SUMMARY_LENGTH) {
    return `${label} must be bounded text`;
  }
  if (/[\0\r\n]/.test(value) || ABSOLUTE_PATH.test(value) || EMBEDDED_ABSOLUTE_PATH.test(value) || SECRET_VALUE.test(value) || PRIVATE_CONTENT.test(value)) {
    return `${label} contains private or unsafe content`;
  }
  return null;
}

function normalizeSignal(signal, index = 0) {
  if (!isObject(signal)) return { ok: false, errors: [`learning signal ${index} must be an object`] };
  const errors = [];
  const category = typeof signal.category === 'string' ? signal.category : '';
  if (!LEARNING_CATEGORIES.has(category)) errors.push(`learning signal ${index}.category is unsupported`);
  const summaryError = safeText(signal.summary, `learning signal ${index}.summary`);
  if (summaryError) errors.push(summaryError);
  for (const key of Object.keys(signal)) {
    if (!['category', 'summary', 'evidenceDigest'].includes(key)) errors.push(`learning signal ${index}.${key} is unknown`);
  }
  if (signal.evidenceDigest !== undefined && !SHA256.test(signal.evidenceDigest || '')) errors.push(`learning signal ${index}.evidenceDigest must be a SHA-256 digest`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    signal: {
      category,
      summary: signal.summary.trim(),
      evidenceDigest: signal.evidenceDigest || digest(signal.summary.trim()),
    },
  };
}

function verifiedCodingOutcome(verification = {}) {
  if (!isObject(verification) || verification.status !== 'completed') return false;
  if (verification.submissionGate && verification.submissionGate.ready !== true) return false;
  if (!Array.isArray(verification.events)) return false;
  const requiredStages = ['claim', 'branch', 'sliceReview', 'holisticReview', 'fixRerun', 'pullRequest', 'postMergeSweep', 'verifyClose'];
  const events = new Map(verification.events.map((event) => [event.stage, event]));
  if (requiredStages.some((stage) => !events.has(stage))) return false;
  if (verification.events.some((event) => event.reattached === true && event.result?.liveConfirmed !== true)) return false;
  const verify = events.get('verifyClose');
  return Boolean(verify?.result?.ok !== false && ['closed', 'verified', 'done', 'completed'].includes(String(verify.result?.status || verify.status || '').toLowerCase()));
}

function evaluateLearningEligibility(input = {}) {
  const verification = input.verification || input.orchestration || null;
  if (input.declined === true || input.decline === true) {
    return {
      schemaVersion: LEARNING_ELIGIBILITY_SCHEMA_VERSION,
      status: 'declined',
      reasonCode: 'explicitly_declined',
      rationale: 'learning capture was explicitly declined',
    };
  }
  if (!verifiedCodingOutcome(verification)) {
    return {
      schemaVersion: LEARNING_ELIGIBILITY_SCHEMA_VERSION,
      status: 'not-eligible',
      reasonCode: 'coding_outcome_not_verified',
      rationale: 'learning capture requires a live, independently verified terminal coding result',
    };
  }

  const rawSignals = input.signals ?? input.learningSignals ?? input.learning;
  const signals = Array.isArray(rawSignals) ? rawSignals : rawSignals ? [rawSignals] : [];
  if (signals.length === 0) {
    return {
      schemaVersion: LEARNING_ELIGIBILITY_SCHEMA_VERSION,
      status: 'not-eligible',
      reasonCode: 'no_reusable_learning_signal',
      rationale: 'no reusable root cause, architecture constraint, failed approach, operational lesson, or project vocabulary term was supplied',
    };
  }

  const normalized = signals.map((signal, index) => normalizeSignal(signal, index));
  const invalid = normalized.find((entry) => !entry.ok);
  if (invalid) {
    return {
      schemaVersion: LEARNING_ELIGIBILITY_SCHEMA_VERSION,
      status: 'failed',
      reasonCode: 'unsafe_learning_signal',
      rationale: invalid.errors[0],
    };
  }
  const reusable = normalized.filter((entry) => !['routine', 'cosmetic'].includes(entry.signal.category));
  if (reusable.length === 0) {
    return {
      schemaVersion: LEARNING_ELIGIBILITY_SCHEMA_VERSION,
      status: 'not-eligible',
      reasonCode: 'routine_or_cosmetic_change',
      rationale: 'routine or cosmetic work does not create a reusable learning artifact',
    };
  }
  const selected = reusable[0].signal;
  return {
    schemaVersion: LEARNING_ELIGIBILITY_SCHEMA_VERSION,
    status: 'eligible',
    reasonCode: 'reusable_learning_signal',
    rationale: `selected ${selected.category} for one learning capture`,
    learning: selected,
    deferredCount: Math.max(0, reusable.length - 1),
  };
}

function screenLearningReceipt(receipt = {}) {
  const errors = [];
  if (!isObject(receipt)) return { ok: false, errors: ['learning receipt must be an object'] };
  for (const [label, value] of [['publicLabel', receipt.publicLabel], ...((receipt.diagnostics || []).map((value, index) => [`diagnostics[${index}]`, value]))]) {
    const error = safeText(value, `learning receipt.${label}`);
    if (error) errors.push(error);
  }
  if (!isObject(receipt.artifact) || !SHA256.test(receipt.artifact.digest || '') || !OPAQUE_ID.test(receipt.artifact.reference || '')) {
    errors.push('learning receipt artifact must contain an opaque reference and digest');
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  LEARNING_CATEGORIES: [...LEARNING_CATEGORIES],
  LEARNING_ELIGIBILITY_SCHEMA_VERSION,
  LEARNING_OUTCOMES: [...LEARNING_OUTCOMES],
  evaluateLearningEligibility,
  normalizeSignal,
  screenLearningReceipt,
  verifiedCodingOutcome,
};
