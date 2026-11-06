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

function cleanNoteContent(value, title) {
  const text = cleanText(value);
  const heading = String(title || '').trim();
  if (!heading || !text.startsWith(`# ${heading}\n`)) return text;
  return text.slice(heading.length + 3).trim();
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
  if (options.basis === 'verbatim_user' && receipt.source_digest !== receipt.content_digest) {
    return invalidReceipt('verbatim_mismatch');
  }

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
    const validation = validateUserSourceReceipt(sourceReceipt(source), { ...options, basis });
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
 * source text; it binds the clean bullet digest to the bounded origin
 * declaration and, for human evidence, a compact user-source receipt.
 */
function renderJournalOriginMarker({ cleanText, clean_text_digest, content_origin, content_origin_basis, source_ref, user_source, human_evidence_eligible = false } = {}) {
  const origin = String(content_origin || '').trim().toLowerCase();
  const basis = String(content_origin_basis || '').trim().toLowerCase();
  if (!contentOriginPairIsValid(origin, basis)) throw new Error('Invalid journal content-origin declaration');
  const receipt = sourceReceipt({ user_source });
  if (origin === 'human' && !receipt) throw new Error('Human journal origin requires a user-source receipt');
  const markerReceipt = receipt
    ? {
      capture_event_id: String(receipt.capture_event_id || '').trim(),
      actor: receipt.actor,
      source_digest: String(receipt.source_digest || '').trim(),
      content_digest: digestText(cleanText),
    }
    : null;
  if (markerReceipt) {
    const validation = validateUserSourceReceipt(markerReceipt, { content: cleanText });
    if (validation.reason !== 'unresolved') throw new Error(`Invalid journal user-source receipt: ${validation.reason}`);
  }
  const markerSourceRef = source_ref ? String(source_ref).trim() : markerReceipt?.capture_event_id;
  if (markerSourceRef && markerReceipt && markerSourceRef !== markerReceipt.capture_event_id) {
    throw new Error('Journal source reference must match the user-source capture event');
  }
  const payload = {
    schema_version: CONTENT_ORIGIN_SCHEMA_VERSION,
    content_origin: origin,
    content_origin_basis: basis,
    clean_text_digest: clean_text_digest || digestText(cleanText),
    human_evidence_eligible: origin === 'human' && human_evidence_eligible === true,
    ...(markerSourceRef ? { source_ref: markerSourceRef } : {}),
    ...(markerReceipt ? { user_source: markerReceipt } : {}),
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
  if (payload.content_origin === 'human') {
    const validation = validateUserSourceReceipt(payload.user_source, { content: cleanText });
    if (validation.reason !== 'unresolved') return unknownJournalOrigin(`invalid_marker_user_source:${validation.reason}`);
    if (payload.source_ref !== payload.user_source.capture_event_id) return unknownJournalOrigin('marker_source_ref_mismatch');
  }
  return {
    schema_version: payload.schema_version,
    content_origin: payload.content_origin,
    content_origin_basis: payload.content_origin_basis,
    clean_text_digest: payload.clean_text_digest,
    human_evidence_eligible: payload.human_evidence_eligible === true && payload.content_origin === 'human',
    ...(payload.source_ref ? { source_ref: payload.source_ref } : {}),
    ...(payload.user_source ? { user_source: { ...payload.user_source } } : {}),
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

function normalizeJournalEntry(line) {
  if (typeof line !== 'string') throw new Error('Invalid journal entry');
  const normalized = line.replace(/\r\n/g, '\n');
  const text = normalized.trim();
  if (!text.startsWith('- ') || /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/.test(normalized)
    || /<!--|-->|jarvos-content-origin\//i.test(text)) throw new Error('Invalid journal entry');
  const logical = text.slice(2);
  for (const part of logical.split('\n')) {
    if (/^\s*(?:#{1,6}(?:\s|$)|[-+*](?:\s|$)|\d+[.)](?:\s|$)|>|`{3,}|~{3,}|(?:[-*_]\s*){3,}$|=+\s*$)/.test(part)) throw new Error('Invalid journal entry');
  }
  if (!logical.trim()) throw new Error('Invalid journal entry');
  return { text: logical, line: '- ' + logical.split('\n').map((part, index) => index && part ? '  ' + part : part).join('\n') };
}

function parseJournalEntry(lines, index) {
  const source = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  const at = position => String(source[position] || '').replace(/\r$/, '');
  const line = at(index).trimStart();
  if (!line.startsWith('- ')) return null;
  const parts = [stripJournalOriginMarkers(line).slice(2)];
  let end = index + 1;
  while (end < source.length) {
    if (at(end).startsWith('  ')) { parts.push(at(end).slice(2)); end += 1; continue; }
    if (at(end) === '') {
      let next = end;
      while (next < source.length && at(next) === '') next += 1;
      if (at(next).startsWith('  ')) {
        parts.push(...Array(next - end).fill(''), at(next).slice(2)); end = next + 1; continue;
      }
    }
    break;
  }
  const text = parts.join('\n').trim();
  const markerStart = end;
  const markerLines = [];
  while (end < source.length && at(end).trim().startsWith('<!-- jarvos-content-origin/')) {
    markerLines.push(at(end).trim()); end += 1;
  }
  let heading = '';
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (/^##\s/.test(at(cursor).trimStart())) { heading = at(cursor).trim(); break; }
  }
  const markerLine = markerLines[0] || null;
  const marker = markerLines.length === 1
    ? parseJournalOriginMarker(markerLine, text)
    : markerLines.length > 1 ? unknownJournalOrigin('duplicate_marker') : null;
  return {
    line, start: index, end, marker_start: markerStart,
    clean_text: text, marker_line: markerLine, marker_lines: markerLines, marker,
    origin: marker || (heading === '## 💡 Ideas' ? unknownJournalOrigin('no_origin_recorded_in_file') : {
      content_origin: 'human', content_origin_basis: 'unknown', human_evidence_eligible: true,
      normalization_reason: 'unmarked_manual_entry',
    }),
  };
}

function journalOriginContractProgram() {
  return `const CONTENT_ORIGIN_SCHEMA_VERSION = ${JSON.stringify(CONTENT_ORIGIN_SCHEMA_VERSION)};
const CONTENT_ORIGINS = ${JSON.stringify(CONTENT_ORIGINS)};
const CONTENT_ORIGIN_BASES = ${JSON.stringify(CONTENT_ORIGIN_BASES)};
const BASIS_ORIGIN = ${JSON.stringify(BASIS_ORIGIN)};
const SHA256_RE = ${SHA256_RE}; const JOURNAL_MARKER_PREFIX = ${JSON.stringify(JOURNAL_MARKER_PREFIX)};
const JOURNAL_MARKER_RE = ${JOURNAL_MARKER_RE};
// Only the requested entry can match; its digest was computed before dispatch.
const digestText = value => cleanText(value) === cleanText(input.replayPayload.line.slice(2)) ? input.replayPayload.contentOrigin.clean_text_digest : '';
const encodeMarkerPayload = value => btoa(unescape(encodeURIComponent(JSON.stringify(value)))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
const decodeMarkerPayload = value => { try { const token = String(value); const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((token.length + 3) % 4); return JSON.parse(token.startsWith('%7') ? decodeURIComponent(token) : new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0)))); } catch { return null; } };
${[isPlainObject, cleanText, sourceReceipt, invalidReceipt, normalizedActorType, normalizedCaptureEventId, validateUserSourceReceipt, contentOriginPairIsValid, renderJournalOriginMarker, unknownJournalOrigin, parseJournalOriginMarker, stripJournalOriginMarkers, cleanJournalEntryText, normalizeJournalEntry, parseJournalEntry].join('\n')}`;
}

// content_origin_drafting is an append-only history of who drafted or edited
// the content. Model identity is recorded beside the origin, never used to
// establish it: a served model only says which model ran, not whose words
// these are. Nothing here infers a model from environment, defaults, or actor.
const CONTENT_ORIGIN_DRAFTING_FIELD = 'content_origin_drafting';
const DRAFTING_KINDS = Object.freeze(['assistant_draft', 'assistant_edit', 'user_source']);
const ASSISTANT_DRAFTING_KINDS = Object.freeze(['assistant_draft', 'assistant_edit']);
const MODEL_EVIDENCE = Object.freeze(['declared', 'served', 'unknown']);

function draftingError(reason) {
  return { ok: false, reason, entries: null };
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

// `fresh` entries are caller declarations: a served claim must resolve through
// the injected resolveServedModel. Persisted entries were verified when they
// were written and are only checked structurally, so history stays unchanged.
function normalizeDraftingEntry(entry, { fresh = false, resolveServedModel } = {}) {
  if (!isPlainObject(entry)) return draftingError('entry_not_object');
  const kind = String(entry.kind ?? '').trim();
  if (!DRAFTING_KINDS.includes(kind)) return draftingError('invalid_kind');
  if (kind === 'user_source') {
    if (!nonEmptyString(entry.capture_event_id) || entry.actor !== 'user'
      || !SHA256_RE.test(String(entry.source_digest || ''))
      || (entry.content_digest !== undefined && !SHA256_RE.test(String(entry.content_digest)))) {
      return draftingError('invalid_user_source_receipt');
    }
    return {
      ok: true,
      entry: {
        kind,
        capture_event_id: entry.capture_event_id.trim(),
        actor: 'user',
        source_digest: entry.source_digest,
        ...(entry.content_digest !== undefined ? { content_digest: entry.content_digest } : {}),
        ...(nonEmptyString(entry.harness) ? { harness: entry.harness.trim() } : {}),
      },
    };
  }
  if (!nonEmptyString(entry.harness)) return draftingError('missing_harness');
  if (entry.model !== undefined && !nonEmptyString(entry.model)) return draftingError('invalid_model');
  const model = entry.model === undefined ? 'unknown' : entry.model.trim();
  const evidence = entry.model_evidence === undefined
    ? (model === 'unknown' ? 'unknown' : 'declared')
    : String(entry.model_evidence).trim();
  if (!MODEL_EVIDENCE.includes(evidence)) return draftingError('invalid_model_evidence');
  if ((model === 'unknown') !== (evidence === 'unknown')) return draftingError('model_evidence_conflict');
  if (evidence !== 'served' && entry.served_ref !== undefined) return draftingError('served_ref_without_served_evidence');
  if (evidence === 'served') {
    if (!nonEmptyString(entry.served_ref)) return draftingError('missing_served_ref');
    if (fresh) {
      if (typeof resolveServedModel !== 'function') return draftingError('served_unresolved');
      let served;
      try {
        served = resolveServedModel(entry.served_ref.trim());
      } catch (_error) {
        return draftingError('served_unresolved');
      }
      const servedModel = typeof served === 'string' ? served : served?.model;
      if (!nonEmptyString(servedModel)) return draftingError('served_unresolved');
      if (servedModel.trim() !== model) return draftingError('served_model_conflict');
    }
  }
  return {
    ok: true,
    entry: {
      kind,
      harness: entry.harness.trim(),
      model,
      model_evidence: evidence,
      ...(evidence === 'served' ? { served_ref: entry.served_ref.trim() } : {}),
    },
  };
}

function normalizeDraftingList(value, options = {}) {
  if (value === undefined || value === null || value === '') return { ok: true, reason: null, entries: [] };
  if (!Array.isArray(value)) return draftingError('drafting_not_array');
  const entries = [];
  for (const raw of value) {
    const result = normalizeDraftingEntry(raw, options);
    if (!result.ok) return result;
    entries.push(result.entry);
  }
  return { ok: true, reason: null, entries };
}

function appendDraftingEntries(history, additions) {
  const seen = new Set(history.map((entry) => JSON.stringify(entry)));
  const merged = [...history];
  for (const entry of additions) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

// Record a superseded human receipt as a historical user_source entry. It is
// never a current receipt and never grants human eligibility. Malformed history
// is returned untouched so the merge still rejects it.
function appendHistoricalReceipt(history, previousReceipt) {
  if (!isPlainObject(previousReceipt)) return history;
  const receipt = normalizeDraftingEntry({ ...previousReceipt, kind: 'user_source' });
  const parsed = normalizeDraftingList(history);
  if (!receipt.ok || !parsed.ok) return history;
  return appendDraftingEntries(parsed.entries, [receipt.entry]);
}

function hasAssistantContribution(entries = []) {
  return entries.some((entry) => ASSISTANT_DRAFTING_KINDS.includes(entry.kind));
}

/**
 * Merge persisted drafting history with a fresh caller declaration for the
 * origin the write is about to persist. Persisted history comes first and is
 * never dropped: an empty array, omission, or human adoption cannot erase a
 * past assistant contribution. Returns { ok, reason, entries }.
 */
function mergeContentOriginDrafting({ existing, incoming, origin, previousReceipt } = {}, options = {}) {
  const persisted = normalizeDraftingList(existing);
  if (!persisted.ok) return draftingError(`invalid_persisted_drafting:${persisted.reason}`);
  // A caller resending stored entries (for example a metadata-only repair) is
  // not making a fresh claim, so only entries new to the history re-resolve.
  const stored = new Set(persisted.entries.map((entry) => JSON.stringify(entry)));
  const structural = normalizeDraftingList(incoming);
  if (!structural.ok) return draftingError(`invalid_drafting:${structural.reason}`);
  const declared = normalizeDraftingList(
    structural.entries.filter((entry) => !stored.has(JSON.stringify(entry))),
    { fresh: true, resolveServedModel: options.resolveServedModel },
  );
  if (!declared.ok) return draftingError(`invalid_drafting:${declared.reason}`);
  let entries = appendDraftingEntries(persisted.entries, declared.entries);
  if (origin === 'human' && hasAssistantContribution(entries)) {
    return draftingError('human_origin_with_assistant_history');
  }
  // A prior human receipt survives any change away from human as history only.
  if (origin !== 'human') entries = appendHistoricalReceipt(entries, previousReceipt);
  // Assistant/mixed content with no recorded contribution gets an explicitly
  // unknown one rather than a fabricated harness or model.
  if ((origin === 'assistant' || origin === 'mixed') && !hasAssistantContribution(entries)) {
    entries = appendDraftingEntries(entries, [{
      kind: origin === 'assistant' ? 'assistant_draft' : 'assistant_edit',
      harness: 'unknown',
      model: 'unknown',
      model_evidence: 'unknown',
    }]);
  }
  return { ok: true, reason: null, entries };
}

// A note stored as assistant/mixed before drafting history existed still had
// an AI contributor. Seed one explicitly unknown entry so a later declaration
// (including human adoption) cannot erase that involvement. Malformed history
// is returned untouched so the merge still rejects it.
function seedDraftingHistory(history, origin) {
  if (origin !== 'assistant' && origin !== 'mixed') return history;
  const parsed = normalizeDraftingList(history);
  if (!parsed.ok || hasAssistantContribution(parsed.entries)) return history;
  return [...parsed.entries, {
    kind: origin === 'assistant' ? 'assistant_draft' : 'assistant_edit',
    harness: 'unknown',
    model: 'unknown',
    model_evidence: 'unknown',
  }];
}

// Combine every alias a caller used (top-level drafting, content_origin_drafting,
// frontmatter) so none silently hides another. Any non-array alias rejects;
// duplicates are removed later by the merge.
function collectDraftingDeclarations(...values) {
  const present = values.filter((value) => value !== undefined && value !== null);
  if (present.some((value) => !Array.isArray(value))) return draftingError('drafting_not_array');
  return { ok: true, reason: null, entries: present.length ? present.flat() : undefined };
}

// Read-side check: malformed history or a human record with assistant history
// is ineligible as human evidence.
function contentOriginDraftingAllowsHuman(value) {
  const parsed = normalizeDraftingList(value);
  return parsed.ok && !hasAssistantContribution(parsed.entries);
}

function recordDraftingHistory(record) {
  return record[CONTENT_ORIGIN_DRAFTING_FIELD] ?? record.contentOriginDrafting;
}

// Every read normalizer funnels through this so knowledge, evidence, and audit
// consumers all drop human eligibility on assistant or malformed history.
function withDraftingEligibility(normalized, input) {
  if (!normalized?.human_evidence_eligible || contentOriginDraftingAllowsHuman(recordDraftingHistory(input))) {
    return normalized;
  }
  return { ...normalized, human_evidence_eligible: false, normalization_reason: 'drafting_history_excludes_human_evidence' };
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
  if (!contentOriginDraftingAllowsHuman(recordDraftingHistory(record))) return false;
  if (record.human_evidence_eligible === true) return true;
  if (record.content_origin_basis === 'legacy_author') return options.allowLegacyFallback === true;
  if (options.manualEntry === true) return true;
  if (!record.user_source) return false;
  const validation = validateUserSourceReceipt(record.user_source, options);
  return validation.ok;
}

function normalizeContentOriginWithLegacy(input = {}, options = {}) {
  if (input.content_origin || input.contentOrigin || input.content_origin_basis || input.contentOriginBasis) {
    if (options.allowUnresolvedReceipt === true) return normalizeContentOriginForRead(input, options);
    return withDraftingEligibility(normalizeContentOrigin(input, options), input);
  }
  if (input.author) return resolveLegacyOrigin(input);
  return unknownRecord('missing_declaration');
}

function normalizeContentOriginForRead(input = {}, options = {}) {
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
    if (options.content !== undefined && digestText(options.content) !== receipt.content_digest) {
      return unknownRecord('read_content_digest_mismatch');
    }
  }
  return withDraftingEligibility({
    schema_version: CONTENT_ORIGIN_SCHEMA_VERSION,
    content_origin: origin,
    content_origin_basis: basis,
    ...(receipt ? { user_source: { ...receipt } } : {}),
    human_evidence_eligible: origin === 'human' && source.human_evidence_eligible === true,
  }, source);
}

module.exports = {
  CONTENT_ORIGIN_SCHEMA_VERSION,
  CONTENT_ORIGINS,
  CONTENT_ORIGIN_BASES,
  emptyOriginCounts,
  BASIS_ORIGIN,
  LEGACY_AUTHOR_ORIGINS,
  cleanText,
  cleanNoteContent,
  digestText,
  sourceReceipt,
  validateUserSourceReceipt,
  normalizeContentOrigin,
  contentOriginPairIsValid,
  frontmatterForContentOrigin,
  JOURNAL_MARKER_PREFIX,
  renderJournalOriginMarker,
  parseJournalOriginMarker,
  stripJournalOriginMarkers,
  cleanJournalEntryText,
  parseJournalEntry,
  normalizeJournalEntry,
  journalOriginContractProgram,
  normalizeContentOriginWithLegacy,
  normalizeContentOriginForRead,
  resolveLegacyOrigin,
  humanEvidenceEligible,
  CONTENT_ORIGIN_DRAFTING_FIELD,
  DRAFTING_KINDS,
  MODEL_EVIDENCE,
  normalizeDraftingEntry,
  normalizeDraftingList,
  mergeContentOriginDrafting,
  collectDraftingDeclarations,
  seedDraftingHistory,
  appendHistoricalReceipt,
  hasAssistantContribution,
  contentOriginDraftingAllowsHuman,
};
