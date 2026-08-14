'use strict';

const {
  CONTENT_ORIGIN_SCHEMA_VERSION,
  CONTENT_ORIGINS,
  CONTENT_ORIGIN_BASES,
  cleanText,
  humanEvidenceEligible,
} = require('./content-origin-contract');

const EVIDENCE_PROJECTION_VERSION = 'jarvos-content-origin-evidence/v1';

function projectionUnknown(reason = 'unknown') {
  return {
    projection_version: EVIDENCE_PROJECTION_VERSION,
    content_origin_schema: CONTENT_ORIGIN_SCHEMA_VERSION,
    content_origin: 'unknown',
    content_origin_basis: 'unknown',
    human_evidence_eligible: false,
    ...(reason ? { projection_reason: reason } : {}),
  };
}

function projectEvidenceRecord(record = {}, options = {}) {
  const clean_text = cleanText(record.clean_text ?? record.cleanText ?? options.cleanText ?? record.text);
  const origin = record.content_origin;
  const basis = record.content_origin_basis;
  if (!clean_text || !CONTENT_ORIGINS.includes(origin) || !CONTENT_ORIGIN_BASES.includes(basis)) {
    return projectionUnknown('invalid_record');
  }
  if (basis === 'legacy_author' && origin === 'unknown') return projectionUnknown('invalid_legacy_record');

  return {
    projection_version: EVIDENCE_PROJECTION_VERSION,
    content_origin_schema: CONTENT_ORIGIN_SCHEMA_VERSION,
    clean_text,
    content_origin: origin,
    content_origin_basis: basis,
    human_evidence_eligible: origin === 'human' && humanEvidenceEligible(record, options),
  };
}

function projectEvidenceBatch(records = [], options = {}) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => projectEvidenceRecord(record, options));
}

function readEvidenceProjection(input = {}) {
  if (!input || input.projection_version !== EVIDENCE_PROJECTION_VERSION) {
    return { ok: false, reason: 'unknown_projection_version', record: projectionUnknown('unknown_projection_version') };
  }
  if (typeof input.clean_text !== 'string' || !input.clean_text.trim()) {
    return { ok: false, reason: 'missing_clean_text', record: projectionUnknown('missing_clean_text') };
  }
  if (!CONTENT_ORIGINS.includes(input.content_origin) || !CONTENT_ORIGIN_BASES.includes(input.content_origin_basis)) {
    return { ok: false, reason: 'invalid_origin', record: projectionUnknown('invalid_origin') };
  }
  if (typeof input.human_evidence_eligible !== 'boolean') {
    return { ok: false, reason: 'missing_eligibility', record: projectionUnknown('missing_eligibility') };
  }
  if (input.content_origin !== 'human' && input.human_evidence_eligible) {
    return { ok: false, reason: 'ineligible_origin_marked_eligible', record: projectionUnknown('ineligible_origin') };
  }
  return {
    ok: true,
    reason: null,
    record: {
      projection_version: EVIDENCE_PROJECTION_VERSION,
      content_origin_schema: CONTENT_ORIGIN_SCHEMA_VERSION,
      clean_text: cleanText(input.clean_text),
      content_origin: input.content_origin,
      content_origin_basis: input.content_origin_basis,
      human_evidence_eligible: input.human_evidence_eligible,
    },
  };
}

module.exports = {
  EVIDENCE_PROJECTION_VERSION,
  projectEvidenceRecord,
  projectEvidenceBatch,
  readEvidenceProjection,
};
