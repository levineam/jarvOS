'use strict';

// Public, data-only policy helpers. They intentionally receive opaque source
// IDs and never see source text, provider credentials, or host paths.
const ACTIVE_ASSISTANT_SEMANTIC_POLICY_VERSION = 'active-assistant-semantic-policy/v1';
const ACTIVE_ASSISTANT_NARRATIVE_POLICY_VERSION = 'active-assistant-semantic-policy/v2';
const TYPES = Object.freeze(new Set(['quoted_evidence', 'source_backed_observation', 'advisory_question']));
const GUARDED_CLAIM = /\b(?:can|can't|cannot|available|unavailable|sent|delivered|fulfilled|completed|finished|done|shipped|created|scheduled|drafted)\b/i;
const ACTIVE_MARKUP = /(?:https?:\/\/|mailto:|data:|javascript:|\[[^\]]+\]\([^)]*\)|<a\b|<img\b|!\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\])/i;
const APPROVAL_VOICE = /\b(?:prove|earn|deserve|win)\s+(?:my|your|our)?\s*(?:approval|goodness|fairness)\b/i;
const ASSISTANT_ACTION_CLAIM = /\b(?:I|we|the (?:assistant|system|bot)|Jarvis)\s+(?:sent|delivered|fulfilled|completed|finished|created|scheduled|drafted|wrote|saved)\b/i;
const DANGLING_SUBJECT = /^(?:that|this|it|those|these)\b/i;
const ANAPHORIC_QUESTION_SUBJECT = /^(?:is|are|was|were|does|do|did|would|could|should|can|will|has|have|had)\s+(?:that|this|it|those|these)\b/i;
const NARRATIVE_TYPES = Object.freeze(new Set(['source_backed_observation', 'cross_project_connection']));
const CLOSING_TYPOGRAPHY = /[”“’‘"')\]»›』】]+$/;

function reject(reasonCode) { return { ok: false, reasonCode }; }

// A claim may end with sentence punctuation followed by closing quotation or
// bracket typography (e.g. `clearer.”`); the punctuation just has to be the
// last non-typographic character.
function hasNarrativeClaimTerminalPunctuation(text) {
  const core = text.replace(CLOSING_TYPOGRAPHY, '');
  return core.length > 0 && /[.!。！]$/.test(core);
}

function validateSegment(row, { eligibleSourceIds = new Set() } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return reject('not_an_object');
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const type = typeof row.type === 'string' ? row.type.trim() : '';
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  const refs = Array.isArray(row.sourceRefs) ? row.sourceRefs.map((ref) => String(ref || '').trim()).filter(Boolean) : [];
  if (!id || !type || !text || !TYPES.has(type)) return reject('segment_shape_invalid');
  if (ACTIVE_MARKUP.test(text)) return reject('active_markup');
  if (APPROVAL_VOICE.test(text)) return reject('approval_seeking_voice');
  if (GUARDED_CLAIM.test(text)) return reject('guarded_claim');
  if (type !== 'advisory_question' && !refs.length) return reject('source_ref_required');
  if (new Set(refs).size !== refs.length || refs.some((ref) => !eligibleSourceIds.has(ref))) return reject('source_ref_ineligible');
  if (type === 'advisory_question' && !/[?？]$/.test(text)) return reject('advisory_not_a_question');
  if (/[.!?。！？](?:\s+|$)/.test(text.slice(0, -1))) return reject('not_atomic_proposition');
  return { ok: true, value: { id, type, text, sourceRefs: refs } };
}

function renderSegments(segments, greeting = 'Good morning, Sir!') {
  return [greeting, ...segments.map((segment) => segment.text)].join(' ');
}

function topic(segment) {
  return segment.text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
}

function wholeMessageValid(segments, { maxLength = 2000, greeting = 'Good morning, Sir!' } = {}) {
  if (!segments.length) return false;
  const topics = new Set();
  for (const segment of segments) {
    const key = topic(segment);
    if (key && topics.has(key)) return false;
    topics.add(key);
  }
  return renderSegments(segments, greeting).length <= maxLength;
}

function composeSegments(rows, options = {}) {
  const eligible = options.eligibleSourceIds instanceof Set ? options.eligibleSourceIds : new Set(options.eligibleSourceIds || []);
  if (!Array.isArray(rows) || rows.length > 6) return { ok: false, reasonCode: 'segment_cap_exceeded', accepted: [], rejected: [] };
  const valid = []; const rejected = [];
  rows.forEach((row, index) => {
    const result = validateSegment(row, { eligibleSourceIds: eligible });
    if (!result.ok) rejected.push({ id: row?.id || `segment:${index}`, index, reasonCode: result.reasonCode });
    else valid.push({ ...result.value, proposalIndex: index });
  });
  let best = null;
  for (let mask = 1; mask < (1 << valid.length); mask += 1) {
    const subset = valid.filter((_, index) => mask & (1 << index));
    if (!wholeMessageValid(subset, options)) continue;
    const indices = subset.map((segment) => segment.proposalIndex);
    const coverage = new Set(subset.flatMap((segment) => segment.sourceRefs)).size;
    if (!best || subset.length > best.subset.length || (subset.length === best.subset.length && coverage > best.coverage)
      || (subset.length === best.subset.length && coverage === best.coverage && indices.join(',') < best.indices.join(','))) best = { subset, indices, coverage };
  }
  if (!best) return { ok: false, reasonCode: 'whole_message_policy', accepted: [], rejected: [...rejected, ...valid.map((row) => ({ id: row.id, index: row.proposalIndex, reasonCode: 'whole_message_policy' }))] };
  const retained = new Set(best.subset.map((row) => row.id));
  for (const row of valid) if (!retained.has(row.id)) rejected.push({ id: row.id, index: row.proposalIndex, reasonCode: 'not_selected' });
  return { ok: true, accepted: best.subset.map(({ proposalIndex, ...row }) => row), rejected: rejected.sort((a, b) => a.index - b.index), message: renderSegments(best.subset, options.greeting) };
}

function validateNarrativeRow(row, { eligibleSourceIds = new Set(), question = false } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return reject('narrative_row_invalid');
  const allowed = question ? new Set(['id', 'text', 'sourceRefs']) : new Set(['id', 'type', 'text', 'sourceRefs']);
  if (Object.keys(row).some((key) => !allowed.has(key))) return reject('narrative_row_invalid');
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  const type = question ? 'advisory_question' : String(row.type || '').trim();
  const refs = Array.isArray(row.sourceRefs) ? row.sourceRefs.map((ref) => String(ref || '').trim()).filter(Boolean) : [];
  if (!id || !text || (!question && !NARRATIVE_TYPES.has(type))) return reject('narrative_row_invalid');
  if (ACTIVE_MARKUP.test(text)) return reject('active_markup');
  if (APPROVAL_VOICE.test(text)) return reject('approval_seeking_voice');
  if (ASSISTANT_ACTION_CLAIM.test(text)) return reject('unsupported_assistant_action');
  if (DANGLING_SUBJECT.test(text)) return reject('subject_not_named');
  if (!refs.length) return reject('source_ref_required');
  if (new Set(refs).size !== refs.length || refs.some((ref) => !eligibleSourceIds.has(ref))) return reject('source_ref_ineligible');
  if (question) {
    if (!/[?？]$/.test(text) || (text.match(/[?？]/g) || []).length !== 1) return reject('closing_question_invalid');
    if (ANAPHORIC_QUESTION_SUBJECT.test(text)) return reject('subject_not_named');
  } else if (/[?？]/.test(text) || !hasNarrativeClaimTerminalPunctuation(text)) {
    return reject('narrative_claim_invalid');
  }
  return { ok: true, value: question ? { id, text, sourceRefs: refs } : { id, type, text, sourceRefs: refs } };
}

function composeNarrative({ claims, closingQuestion }, options = {}) {
  const eligible = options.eligibleSourceIds instanceof Set ? options.eligibleSourceIds : new Set(options.eligibleSourceIds || []);
  if (!Array.isArray(claims) || claims.length < 2 || claims.length > 5 || !closingQuestion) {
    return { ok: false, reasonCode: 'narrative_shape_invalid', accepted: [], rejected: [] };
  }
  const rows = [...claims, closingQuestion];
  const ids = rows.map((row) => row?.id).filter(Boolean);
  if (new Set(ids).size !== rows.length) return { ok: false, reasonCode: 'narrative_id_duplicate', accepted: [], rejected: [] };
  const accepted = [];
  const rejected = [];
  claims.forEach((row, index) => {
    const result = validateNarrativeRow(row, { eligibleSourceIds: eligible });
    if (result.ok) accepted.push(result.value);
    else rejected.push({ id: row?.id || `claim:${index}`, index, reasonCode: result.reasonCode });
  });
  const question = validateNarrativeRow(closingQuestion, { eligibleSourceIds: eligible, question: true });
  if (!question.ok) rejected.push({ id: closingQuestion?.id || 'closing-question', index: claims.length, reasonCode: question.reasonCode });
  if (rejected.length) return { ok: false, reasonCode: 'narrative_policy_rejected', accepted: [], rejected };
  const greeting = options.greeting || 'Good morning, Sir!';
  const message = [greeting, ...accepted.map((row) => row.text), question.value.text].join(' ');
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : 1500;
  if (message.length > maxLength) return { ok: false, reasonCode: 'narrative_length_exceeded', accepted: [], rejected: [] };
  return { ok: true, accepted, closingQuestion: question.value, rejected: [], message };
}

module.exports = {
  ACTIVE_ASSISTANT_SEMANTIC_POLICY_VERSION,
  ACTIVE_ASSISTANT_NARRATIVE_POLICY_VERSION,
  TYPES,
  NARRATIVE_TYPES,
  validateSegment,
  validateNarrativeRow,
  renderSegments,
  composeSegments,
  composeNarrative,
};
