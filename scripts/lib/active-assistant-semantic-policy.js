'use strict';

// Public, data-only policy helpers. They intentionally receive opaque source
// IDs and never see source text, provider credentials, or host paths.
const ACTIVE_ASSISTANT_SEMANTIC_POLICY_VERSION = 'active-assistant-semantic-policy/v1';
const TYPES = Object.freeze(new Set(['quoted_evidence', 'source_backed_observation', 'advisory_question']));
const GUARDED_CLAIM = /\b(?:can|can't|cannot|available|unavailable|sent|delivered|fulfilled|completed|finished|done|shipped|created|scheduled|drafted)\b/i;
const ACTIVE_MARKUP = /(?:https?:\/\/|mailto:|data:|javascript:|\[[^\]]+\]\([^)]*\)|<\/?[a-z][^>]*>|!\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\])/i;
const APPROVAL_VOICE = /\b(?:prove|earn|deserve|win)\s+(?:my|your|our)?\s*(?:approval|goodness|fairness)\b/i;

function reject(reasonCode) { return { ok: false, reasonCode }; }

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

module.exports = { ACTIVE_ASSISTANT_SEMANTIC_POLICY_VERSION, TYPES, validateSegment, renderSegments, composeSegments };
