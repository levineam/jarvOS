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

function emptyOriginCounts() {
  return Object.fromEntries(CONTENT_ORIGINS.map((origin) => [origin, 0]));
}

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
const JOURNAL_MARKER_PREFIX = `<!-- ${CONTENT_ORIGIN_SCHEMA_VERSION} `;
const JOURNAL_MARKER_RE = /^<!--\s*jarvos-content-origin\/v1\s+([^\s>]+)\s*-->$/;

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
  const receipt = input?.user_source
    || input?.userSource
    || input?.content_origin_source
    || input?.source_reference
    || input?.sourceReference;
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

function contentOriginPairIsValid(contentOrigin, contentOriginBasis) {
  return CONTENT_ORIGINS.includes(contentOrigin)
    && CONTENT_ORIGIN_BASES.includes(contentOriginBasis)
    && contentOriginBasis !== 'legacy_author'
    && BASIS_ORIGIN[contentOriginBasis] === contentOrigin;
}

function encodeMarkerPayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeMarkerPayload(encoded) {
  try {
    const raw = String(encoded);
    const decoded = raw.startsWith('%7B') || raw.startsWith('%7b')
      ? JSON.parse(decodeURIComponent(raw))
      : JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return isPlainObject(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Render an invisible, line-adjacent journal marker. The marker contains no
 * source text; it binds only the clean bullet digest to the bounded origin
 * declaration and an opaque source reference.
 */
function renderJournalOriginMarker({ cleanText, clean_text_digest, content_origin, content_origin_basis, source_ref, human_evidence_eligible = false } = {}) {
  const origin = String(content_origin || '').trim().toLowerCase();
  const basis = String(content_origin_basis || '').trim().toLowerCase();
  if (!contentOriginPairIsValid(origin, basis)) throw new Error('Invalid journal content-origin declaration');
  const payload = {
    schema_version: CONTENT_ORIGIN_SCHEMA_VERSION,
    content_origin: origin,
    content_origin_basis: basis,
    clean_text_digest: clean_text_digest || digestText(cleanText),
    human_evidence_eligible: origin === 'human' && human_evidence_eligible === true,
    ...(source_ref ? { source_ref: String(source_ref).trim() } : {}),
  };
  return `${JOURNAL_MARKER_PREFIX}${encodeMarkerPayload(payload)} -->`;
}

function unknownJournalOrigin(reason = 'unknown') {
  return {
    content_origin: 'unknown',
    content_origin_basis: 'unknown',
    human_evidence_eligible: false,
    ...(reason ? { normalization_reason: reason } : {}),
  };
}

function parseJournalOriginMarker(marker, cleanText) {
  const match = String(marker || '').trim().match(JOURNAL_MARKER_RE);
  if (!match) return unknownJournalOrigin('missing_or_malformed_marker');
  const payload = decodeMarkerPayload(match[1]);
  if (!payload || payload.schema_version !== CONTENT_ORIGIN_SCHEMA_VERSION) return unknownJournalOrigin('invalid_marker_payload');
  if (!contentOriginPairIsValid(payload.content_origin, payload.content_origin_basis)) return unknownJournalOrigin('invalid_marker_origin');
  if (!SHA256_RE.test(String(payload.clean_text_digest || '')) || digestText(cleanText) !== payload.clean_text_digest) {
    return unknownJournalOrigin('marker_digest_mismatch');
  }
  if (payload.source_ref !== undefined && (typeof payload.source_ref !== 'string' || !payload.source_ref.trim())) {
    return unknownJournalOrigin('invalid_marker_source_ref');
  }
  return {
    schema_version: payload.schema_version,
    content_origin: payload.content_origin,
    content_origin_basis: payload.content_origin_basis,
    clean_text_digest: payload.clean_text_digest,
    human_evidence_eligible: payload.human_evidence_eligible === true && payload.content_origin === 'human',
    ...(payload.source_ref ? { source_ref: payload.source_ref } : {}),
  };
}

function stripJournalOriginMarkers(text) {
  return String(text || '')
    .replace(/<!--\s*jarvos-content-origin\/[^>]*-->\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n');
}

function cleanJournalEntryText(line) {
  return stripJournalOriginMarkers(String(line || '')).trim();
}

function parseJournalEntry(lines, index) {
  const source = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  const line = String(source[index] || '').trim();
  if (!line.startsWith('- ')) return null;
  const cleanText = cleanJournalEntryText(line);
  const markerLines = [];
  for (let markerIndex = index + 1; markerIndex < source.length; markerIndex += 1) {
    const candidate = String(source[markerIndex] || '').trim();
    if (!candidate.startsWith('<!-- jarvos-content-origin/')) break;
    markerLines.push(candidate);
  }
  const markerLine = markerLines[0] || null;
  const marker = markerLines.length === 1
    ? parseJournalOriginMarker(markerLine, cleanText.slice(2).trim())
    : markerLines.length > 1
      ? unknownJournalOrigin('duplicate_marker')
      : null;
  return {
    line,
    clean_text: cleanText.slice(2).trim(),
    marker_line: markerLine,
    marker_lines: markerLines,
    marker,
    origin: marker || (markerLines.length > 0 ? unknownJournalOrigin('malformed_or_duplicate_marker') : {
      content_origin: 'human',
      content_origin_basis: 'unknown',
      human_evidence_eligible: true,
      normalization_reason: 'unmarked_manual_entry',
    }),
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
    if (options.allowUnresolvedReceipt === true) return normalizeContentOriginForRead(input);
    return normalizeContentOrigin(input, options);
  }
  if (input.author) return resolveLegacyOrigin(input);
  return unknownRecord('missing_declaration');
}

function normalizeContentOriginForRead(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const origin = String(source.content_origin ?? source.contentOrigin ?? '').trim().toLowerCase();
  const basis = String(source.content_origin_basis ?? source.contentOriginBasis ?? '').trim().toLowerCase();
  if (!CONTENT_ORIGINS.includes(origin) || !CONTENT_ORIGIN_BASES.includes(basis) || basis === 'legacy_author' || BASIS_ORIGIN[basis] !== origin) {
    return unknownRecord('invalid_read_declaration');
  }
  const receipt = sourceReceipt(source);
  if (origin === 'human') {
    if (!receipt || receipt.actor !== 'user' || !SHA256_RE.test(String(receipt.source_digest || '')) || !SHA256_RE.test(String(receipt.content_digest || ''))) {
      return unknownRecord('invalid_read_receipt');
    }
  }
  return {
    schema_version: CONTENT_ORIGIN_SCHEMA_VERSION,
    content_origin: origin,
    content_origin_basis: basis,
    ...(receipt ? { user_source: { ...receipt } } : {}),
    human_evidence_eligible: origin === 'human' && source.human_evidence_eligible === true,
  };
}

module.exports = {
  CONTENT_ORIGIN_SCHEMA_VERSION,
  CONTENT_ORIGINS,
  CONTENT_ORIGIN_BASES,
  emptyOriginCounts,
  BASIS_ORIGIN,
  LEGACY_AUTHOR_ORIGINS,
  cleanText,
  digestText,
  validateUserSourceReceipt,
  normalizeContentOrigin,
  frontmatterForContentOrigin,
  JOURNAL_MARKER_PREFIX,
  renderJournalOriginMarker,
  parseJournalOriginMarker,
  stripJournalOriginMarkers,
  cleanJournalEntryText,
  parseJournalEntry,
  normalizeContentOriginWithLegacy,
  normalizeContentOriginForRead,
  resolveLegacyOrigin,
  humanEvidenceEligible,
};
