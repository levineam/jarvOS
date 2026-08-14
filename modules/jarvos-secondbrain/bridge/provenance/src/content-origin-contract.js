'use strict';

const crypto = require('node:crypto');

const CONTENT_ORIGIN_SCHEMA_VERSION = 'jarvos-content-origin/v1';
const CONTENT_ORIGINS = Object.freeze(['human', 'assistant', 'mixed', 'unknown']);
const CONTENT_ORIGIN_BASES = Object.freeze([
  'verbatim_user',
  'user_derived',
  'assistant_generated',
  'mixed_composition',
  'unknown',
  'legacy_author',
]);

const BASIS_ORIGIN = Object.freeze({
  verbatim_user: 'human',
  user_derived: 'human',
  assistant_generated: 'assistant',
  mixed_composition: 'mixed',
  unknown: 'unknown',
});

const LEGACY_AUTHOR_ORIGINS = Object.freeze({
  andrew: 'human',
  jarvis: 'assistant',
  both: 'mixed',
});

const SHA256_RE = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function digestText(value) {
  return crypto.createHash('sha256').update(cleanText(value)).digest('hex');
}

function normalizedActorType(actor) {
  if (typeof actor === 'string') return actor;
  if (isPlainObject(actor)) return actor.type || actor.role || null;
  return null;
}

function normalizedCaptureEventId(event) {
  if (!isPlainObject(event)) return null;
  return event.capture_event_id || event.captureEventId || event.id || null;
}

function sourceReceipt(input) {
  const receipt = input?.user_source || input?.userSource || input?.source_reference || input?.sourceReference;
  return isPlainObject(receipt) ? receipt : null;
}

function invalidReceipt(reason) {
  return { ok: false, reason };
}

/**
 * Validate a user-source receipt against a resolver-owned capture record.
 * The resolver is deliberately injected so the public contract does not know
 * whether a harness stores source turns in a transcript, event store, or API.
 */
function validateUserSourceReceipt(receipt, options = {}) {
  if (!isPlainObject(receipt)) return invalidReceipt('missing');

  const required = ['capture_event_id', 'actor', 'source_digest', 'content_digest'];
  if (required.some((field) => typeof receipt[field] !== 'string' || !receipt[field].trim())) {
    return invalidReceipt('malformed');
  }
  if (receipt.actor !== 'user') return invalidReceipt('non_user_actor');
  if (!SHA256_RE.test(receipt.source_digest) || !SHA256_RE.test(receipt.content_digest)) {
    return invalidReceipt('malformed_digest');
  }
  if (options.captureEventId && receipt.capture_event_id !== options.captureEventId) {
    return invalidReceipt('capture_event_mismatch');
  }

  const content = cleanText(options.content);
  if (!content || digestText(content) !== receipt.content_digest) {
    return invalidReceipt('content_mismatch');
  }

  if (typeof options.resolveUserSource !== 'function') {
    return invalidReceipt('unresolved');
  }

  let source;
  try {
    source = options.resolveUserSource(receipt.capture_event_id);
  } catch (_error) {
    return invalidReceipt('unresolved');
  }
  if (!isPlainObject(source)) return invalidReceipt('unresolved');

  const sourceId = normalizedCaptureEventId(source);
  const sourceActor = normalizedActorType(source.actor ?? source);
  const sourceText = source.text ?? source.content ?? source.body;
  if (sourceId !== receipt.capture_event_id || sourceActor !== 'user' || typeof sourceText !== 'string') {
    return invalidReceipt('source_mismatch');
  }
  if (digestText(sourceText) !== receipt.source_digest) return invalidReceipt('source_digest_mismatch');

  return { ok: true, reason: null, source };
}

function unknownRecord(reason = 'unknown') {
  return {
    schema_version: CONTENT_ORIGIN_SCHEMA_VERSION,
    content_origin: 'unknown',
    content_origin_basis: 'unknown',
    human_evidence_eligible: false,
    ...(reason ? { normalization_reason: reason } : {}),
  };
}

function normalizeContentOrigin(input = {}, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const origin = String(source.content_origin ?? source.contentOrigin ?? '').trim().toLowerCase();
  const basis = String(source.content_origin_basis ?? source.contentOriginBasis ?? '').trim().toLowerCase();

  if (!origin && !basis) return unknownRecord('missing_declaration');
  if (!CONTENT_ORIGINS.includes(origin) || !CONTENT_ORIGIN_BASES.includes(basis)) {
    return unknownRecord('invalid_enum');
  }
  if (basis === 'legacy_author') return unknownRecord('legacy_basis_requires_read_time_resolution');
  if (BASIS_ORIGIN[basis] !== origin) return unknownRecord('origin_basis_mismatch');
  if (origin === 'human') {
    const validation = validateUserSourceReceipt(sourceReceipt(source), options);
    if (!validation.ok) return unknownRecord(`invalid_user_source:${validation.reason}`);
  }

  const result = {
    schema_version: CONTENT_ORIGIN_SCHEMA_VERSION,
    content_origin: origin,
    content_origin_basis: basis,
    human_evidence_eligible: origin === 'human',
  };
  const receipt = sourceReceipt(source);
  if (receipt && origin === 'human') result.user_source = { ...receipt };
  return result;
}

function frontmatterForContentOrigin(input = {}, options = {}) {
  const normalized = normalizeContentOrigin(input, options);
  return {
    content_origin_schema: normalized.schema_version,
    content_origin: normalized.content_origin,
    content_origin_basis: normalized.content_origin_basis,
    ...(normalized.user_source ? { content_origin_source: { ...normalized.user_source } } : {}),
    human_evidence_eligible: normalized.human_evidence_eligible,
  };
}

function resolveLegacyOrigin(input = {}) {
  const author = String(input.author || '').trim().toLowerCase();
  const sourceAgent = String(input.source_agent || input.sourceAgent || '').trim().toLowerCase();
  const sourceActor = normalizedActorType(input.source_actor || input.sourceActor || input.actor);
  const agentEvidence = sourceActor === 'assistant'
    || Boolean(sourceAgent && !['andrew', 'human', 'manual'].includes(sourceAgent));

  if (!LEGACY_AUTHOR_ORIGINS[author] || (author === 'andrew' && agentEvidence)) {
    return { content_origin: 'unknown', content_origin_basis: 'unknown' };
  }
  return {
    content_origin: LEGACY_AUTHOR_ORIGINS[author],
    content_origin_basis: 'legacy_author',
  };
}

function humanEvidenceEligible(record = {}, options = {}) {
  if (!isPlainObject(record) || record.content_origin !== 'human') return false;
  if (record.human_evidence_eligible === true) return true;
  if (record.content_origin_basis === 'legacy_author') return options.allowLegacyFallback === true;
  if (options.manualEntry === true) return true;
  if (!record.user_source) return false;
  const validation = validateUserSourceReceipt(record.user_source, options);
  return validation.ok;
}

function normalizeContentOriginWithLegacy(input = {}, options = {}) {
  if (input.content_origin || input.contentOrigin || input.content_origin_basis || input.contentOriginBasis) {
    return normalizeContentOrigin(input, options);
  }
  if (input.author) return resolveLegacyOrigin(input);
  return unknownRecord('missing_declaration');
}

module.exports = {
  CONTENT_ORIGIN_SCHEMA_VERSION,
  CONTENT_ORIGINS,
  CONTENT_ORIGIN_BASES,
  BASIS_ORIGIN,
  LEGACY_AUTHOR_ORIGINS,
  cleanText,
  digestText,
  validateUserSourceReceipt,
  normalizeContentOrigin,
  frontmatterForContentOrigin,
  normalizeContentOriginWithLegacy,
  resolveLegacyOrigin,
  humanEvidenceEligible,
};
