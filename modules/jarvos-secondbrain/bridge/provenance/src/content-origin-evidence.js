'use strict';

const {
  CONTENT_ORIGIN_SCHEMA_VERSION,
  CONTENT_ORIGINS,
  CONTENT_ORIGIN_BASES,
  cleanText,
  cleanNoteContent,
  normalizeContentOriginWithLegacy,
  sourceReceipt,
  validateUserSourceReceipt,
  parseJournalEntry,
} = require('./content-origin-contract');
const { frontmatterToObject, parseFrontmatter } = require('../../../packages/jarvos-secondbrain-notes/src/lib/note-schema');

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

function verifiedHumanEvidenceProjection(record, clean_text, options = {}) {
  if (record.content_origin !== 'human'
    || !['verbatim_user', 'user_derived'].includes(record.content_origin_basis)
    || record.human_evidence_eligible !== true) return null;
  const receipt = sourceReceipt(record);
  const validation = validateUserSourceReceipt(receipt, {
    content: clean_text,
    resolveUserSource: options.resolveUserSource,
    basis: record.content_origin_basis,
  });
  if (!validation.ok) return null;
  return {
    projection_version: EVIDENCE_PROJECTION_VERSION,
    capture_event_id: receipt.capture_event_id,
    actor: 'user',
    source_digest: receipt.source_digest,
    content_digest: receipt.content_digest,
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

  const human_evidence_projection = verifiedHumanEvidenceProjection(record, clean_text, options);
  return {
    projection_version: EVIDENCE_PROJECTION_VERSION,
    content_origin_schema: CONTENT_ORIGIN_SCHEMA_VERSION,
    clean_text,
    content_origin: origin,
    content_origin_basis: basis,
    human_evidence_eligible: Boolean(human_evidence_projection),
    ...(human_evidence_projection ? { human_evidence_projection } : {}),
  };
}

function projectJournalEntriesFromMarkdown(markdown, { date = null, section = 'ideas', resolveUserSource } = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const entries = [];
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    if (/^##\s/.test(current)) {
      inSection = section === 'ideas' ? /💡|ideas/i.test(current) : section === 'notes' ? /📝|notes/i.test(current) : true;
      continue;
    }
    if (!inSection || !current.trim().startsWith('- ')) continue;
    const entry = parseJournalEntry(lines, index);
    if (!entry) continue;
    const projected = projectEvidenceRecord({
      clean_text: entry.clean_text,
      content_origin: entry.origin.content_origin,
      content_origin_basis: entry.origin.content_origin_basis,
      user_source: entry.origin.user_source,
      human_evidence_eligible: entry.origin.human_evidence_eligible === true,
    }, { resolveUserSource });
    entries.push({
      ...projected,
      date: date || null,
      source_id: `journal:${date || 'unknown'}:${index}`,
      // Boolean only: a read-only audit needs to count declared versus
      // undeclared bullets without any consumer touching raw marker text.
      marker_present: Boolean(entry.marker_line),
    });
    index += entry.marker_lines?.length || (entry.marker_line ? 1 : 0);
  }
  return entries;
}

function projectNoteMarkdown(markdown, { sourcePath = null, title = null, resolveUserSource } = {}) {
  const parsed = parseFrontmatter(String(markdown || ''));
  const frontmatter = parsed ? frontmatterToObject(parsed) : {};
  const clean_text = cleanText(parsed?.remainder || markdown);
  const normalized = normalizeContentOriginWithLegacy(frontmatter, {
    content: cleanNoteContent(clean_text, title),
    resolveUserSource,
  });
  const projected = projectEvidenceRecord({
    clean_text,
    content_origin: normalized.content_origin,
    content_origin_basis: normalized.content_origin_basis,
    user_source: normalized.user_source,
    human_evidence_eligible: normalized.human_evidence_eligible === true,
  }, { resolveUserSource });
  return {
    ...projected,
    source_id: `note:${sourcePath || title || 'unknown'}`,
    source_path: sourcePath || null,
    title: title || null,
  };
}

function projectEvidenceBatch(records = [], options = {}) {
  if (!Array.isArray(records)) return [];
  return records.map((record) => projectEvidenceRecord(record, options));
}

function readEvidenceProjection(input = {}, options = {}) {
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
  if (input.content_origin === 'human' || input.human_evidence_eligible || input.human_evidence_projection) {
    const evidence = input.human_evidence_projection;
    if (input.content_origin !== 'human'
      || !['verbatim_user', 'user_derived'].includes(input.content_origin_basis)
      || !input.human_evidence_eligible
      || !evidence
      || evidence.projection_version !== EVIDENCE_PROJECTION_VERSION) {
      return { ok: false, reason: 'unverified_human_evidence', record: projectionUnknown('unverified_human_evidence') };
    }
    const { digestText } = require('./content-origin-contract');
    const validation = validateUserSourceReceipt({
      capture_event_id: evidence.capture_event_id,
      actor: evidence.actor,
      source_digest: evidence.source_digest,
      content_digest: evidence.content_digest,
    }, {
      content: input.clean_text,
      resolveUserSource: options.resolveUserSource,
      basis: input.content_origin_basis,
    });
    if (!validation.ok || evidence.content_digest !== digestText(input.clean_text)) {
      return { ok: false, reason: 'unverified_human_evidence', record: projectionUnknown('unverified_human_evidence') };
    }
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
      ...(input.human_evidence_projection ? { human_evidence_projection: { ...input.human_evidence_projection } } : {}),
    },
  };
}

module.exports = {
  EVIDENCE_PROJECTION_VERSION,
  projectEvidenceRecord,
  projectEvidenceBatch,
  projectJournalEntriesFromMarkdown,
  projectNoteMarkdown,
  readEvidenceProjection,
};
