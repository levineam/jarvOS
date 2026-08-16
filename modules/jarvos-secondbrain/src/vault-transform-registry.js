'use strict';

const {
  cleanJournalEntryText,
  parseJournalEntry,
  parseJournalOriginMarker,
  renderJournalOriginMarker,
  stripJournalOriginMarkers,
} = require('../bridge/provenance/src/content-origin-contract');

function payloadBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

function lineTransform(content, { line }) {
  const source = String(content);
  return source.includes(line) ? source : `${source}${source.endsWith('\n') ? '' : '\n'}${line}\n`;
}

function hasNoteIdentity(content, noteId) {
  const match = String(content).match(/^---\r?\n[\s\S]*?^jarvos_note_id:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))[\s\S]*?^---/m);
  return (match?.[1] || match?.[2] || match?.[3] || '') === noteId;
}

function hasExactBlock(content, block) {
  const expected = String(block || '').trim();
  if (!expected) return false;
  return `\n\n${String(content).trim()}\n\n`.includes(`\n\n${expected}\n\n`);
}

function noteAppendTransform(content, { noteId, body }) {
  const source = String(content);
  if (!hasNoteIdentity(source, noteId)) return source;
  return hasExactBlock(source, body) ? source : `${source.trimEnd()}\n\n${body.trim()}\n`;
}

function sessionThreadAppendTransform(content, { noteId, entry }) {
  const source = String(content);
  const checkpoint = String(entry || '').trim();
  if (!hasNoteIdentity(source, noteId) || !checkpoint || hasExactBlock(source, checkpoint)) return source;
  return `${source.trimEnd()}\n\n${checkpoint}\n`;
}

function normalizeJournalHeading(heading) {
  const value = String(heading || '').trim().replace(/^##\s*/, '').trim();
  if (!value || /[\r\n]/.test(value)) throw new Error('Invalid journal section heading');
  return `## ${value === '🗂️ Notes Created' ? '📝 Notes' : value}`;
}

function journalSectionRange(lines, heading) {
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return { start: -1, end: -1 };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) { end = index; break; }
  }
  return { start, end };
}

function journalSectionLineTransform(content, { heading, line }) {
  const canonicalHeading = normalizeJournalHeading(heading);
  const canonicalLine = String(line).trim();
  let lines = String(content).split('\n');
  let range = journalSectionRange(lines, canonicalHeading);
  if (range.start === -1) {
    const trimmed = String(content).trimEnd();
    lines = `${trimmed}${trimmed ? '\n\n' : ''}${canonicalHeading}\n${canonicalLine}\n`.split('\n');
    return lines.join('\n');
  }
  const section = lines.slice(range.start + 1, range.end);
  if (section.some((entry) => entry.trim() === canonicalLine)) return String(content);
  const materialized = section.filter((entry) => entry.trim() !== '-' && entry.trim() !== '');
  materialized.push(canonicalLine);
  return [...lines.slice(0, range.start + 1), ...materialized, '', ...lines.slice(range.end)].join('\n');
}

function normalizedJournalOrigin(contentOrigin = {}) {
  const origin = String(contentOrigin.content_origin || '').trim().toLowerCase();
  const basis = String(contentOrigin.content_origin_basis || '').trim().toLowerCase();
  if (!origin || !basis) throw new Error('journal content-origin payload is required');
  if (contentOrigin.clean_text_digest && !/^[a-f0-9]{64}$/.test(String(contentOrigin.clean_text_digest))) {
    throw new Error('journal content-origin digest is invalid');
  }
  return {
    content_origin: origin,
    content_origin_basis: basis,
    human_evidence_eligible: contentOrigin.human_evidence_eligible === true && origin === 'human',
    ...(contentOrigin.clean_text_digest ? { clean_text_digest: String(contentOrigin.clean_text_digest) } : {}),
    ...(contentOrigin.source_ref ? { source_ref: String(contentOrigin.source_ref).trim() } : {}),
    ...(contentOrigin.user_source && typeof contentOrigin.user_source === 'object'
      ? { user_source: { ...contentOrigin.user_source } }
      : {}),
  };
}

function cleanJournalLine(line) {
  const cleaned = stripJournalOriginMarkers(String(line || '')).trim();
  return cleaned.startsWith('- ') ? cleaned : `- ${cleaned.replace(/^[-\s]+/, '')}`;
}

function journalOriginMarkerForLine(line, contentOrigin) {
  const cleanLine = cleanJournalLine(line);
  return renderJournalOriginMarker({
    cleanText: cleanLine.slice(2).trim(),
    ...contentOrigin,
  });
}

function matchingJournalBullet(lines, range, canonicalLine) {
  for (let index = range.start + 1; index < range.end; index += 1) {
    if (String(lines[index] || '').trim().startsWith('- ') && cleanJournalEntryText(lines[index]).trim() === canonicalLine) return index;
  }
  return -1;
}

function journalSectionLineOriginTransform(content, { heading, line, contentOrigin }) {
  const canonicalHeading = normalizeJournalHeading(heading);
  const canonicalLine = cleanJournalLine(line);
  const origin = normalizedJournalOrigin(contentOrigin);
  const marker = journalOriginMarkerForLine(canonicalLine, origin);
  const source = String(content);
  const lines = source.split('\n');
  const range = journalSectionRange(lines, canonicalHeading);

  if (range.start === -1) {
    const trimmed = source.trimEnd();
    return `${trimmed}${trimmed ? '\n\n' : ''}${canonicalHeading}\n${canonicalLine}\n${marker}\n`;
  }

  const matchingIndex = matchingJournalBullet(lines, range, canonicalLine);
  if (matchingIndex !== -1) {
    const entry = parseJournalEntry(lines, matchingIndex);
    // An existing unmarked bullet is the legacy/manual-human convention. It
    // already represents stronger evidence than a new non-human echo, so keep
    // it untouched and let the invariant treat the safe no-op as satisfied.
    if (!entry?.marker && !entry?.marker_line) return source;

    const existing = entry.origin;
    const newIsVerifiedHuman = origin.content_origin === 'human' && origin.human_evidence_eligible === true;
    const existingMarkerIsValid = Boolean(entry.marker && !entry.marker.normalization_reason);
    const existingIsVerifiedHuman = existingMarkerIsValid
      && existing.content_origin === 'human'
      && existing.human_evidence_eligible === true;
    if (existingIsVerifiedHuman && !newIsVerifiedHuman) return source;
    if (existingMarkerIsValid
      && existing.content_origin === origin.content_origin
      && existing.content_origin_basis === origin.content_origin_basis
      && existing.human_evidence_eligible === origin.human_evidence_eligible) return source;

    const next = [...lines];
    const markerCount = entry.marker_lines?.length || (entry.marker_line ? 1 : 0);
    if (markerCount > 0) next.splice(matchingIndex + 1, markerCount, marker);
    else next.splice(matchingIndex + 1, 0, marker);
    return next.join('\n');
  }

  const section = lines.slice(range.start + 1, range.end)
    .filter((entry) => entry.trim() !== '-' && entry.trim() !== '');
  section.push(canonicalLine, marker);
  return [...lines.slice(0, range.start + 1), ...section, '', ...lines.slice(range.end)].join('\n');
}

function journalSectionLineOriginSatisfied(content, { heading, line, contentOrigin }) {
  const canonicalHeading = normalizeJournalHeading(heading);
  const canonicalLine = cleanJournalLine(line);
  const expected = normalizedJournalOrigin(contentOrigin);
  const lines = String(content).split('\n');
  const range = journalSectionRange(lines, canonicalHeading);
  if (range.start === -1) return false;
  const index = matchingJournalBullet(lines, range, canonicalLine);
  if (index === -1) return false;
  const entry = parseJournalEntry(lines, index);
  if (entry && !entry.marker && !entry.marker_line) return true;
  const actual = entry?.marker ? parseJournalOriginMarker(entry.marker_line, entry.clean_text) : null;
  return Boolean(actual
    && !actual.normalization_reason
    && actual.content_origin === expected.content_origin
    && actual.content_origin_basis === expected.content_origin_basis
    && actual.human_evidence_eligible === expected.human_evidence_eligible);
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function backlinkLineRegex(linkTarget) { return new RegExp(`^\\s*-\\s*\\[\\[${escapeRegex(linkTarget)}(?:\\|[^\\]]+)?\\]\\]\\s*$`); }

// A backlink is identified by the resolved vault-relative wikilink target, not
// by a display title. That makes retries after a rename deterministic while the
// queue keeps the note id used to resolve the target.
function journalBacklinkTransform(content, { linkTarget, section }) {
  const canonicalHeading = normalizeJournalHeading(section || '📝 Notes');
  const linkText = `- [[${linkTarget}]]`;
  const exactLink = backlinkLineRegex(linkTarget);
  let lines = String(content).split('\n');
  const range = journalSectionRange(lines, canonicalHeading);
  if (range.start === -1) {
    const cleaned = lines.filter((line) => !exactLink.test(line)).join('\n').trimEnd();
    return `${cleaned}${cleaned ? '\n\n' : ''}${canonicalHeading}\n${linkText}\n`;
  }
  const before = lines.slice(0, range.start + 1).filter((line) => !exactLink.test(line));
  const sectionLines = lines.slice(range.start + 1, range.end);
  const after = lines.slice(range.end).filter((line) => !exactLink.test(line));
  const hadLink = sectionLines.some((line) => exactLink.test(line));
  const cleanedSection = sectionLines.filter((line) => !exactLink.test(line) && (hadLink || line.trim() !== '-'));
  return [...before, linkText, ...cleanedSection, ...after].join('\n');
}

function journalBacklinkSatisfied(content, payload) {
  const heading = normalizeJournalHeading(payload.section || '📝 Notes');
  const lines = String(content).split('\n');
  const range = journalSectionRange(lines, heading);
  if (range.start === -1) return false;
  const exactLink = backlinkLineRegex(payload.linkTarget);
  const sectionCount = lines.slice(range.start + 1, range.end).filter((line) => exactLink.test(line)).length;
  const totalCount = lines.filter((line) => exactLink.test(line)).length;
  return sectionCount === 1 && totalCount === 1;
}

// These are the portable, reviewable Node transforms used by reconciliation
// and deterministic tests. The adapter has matching fixed evaluator cases;
// callers never supply executable source.
function createJarvosVaultTransforms() {
  return createVaultTransformRegistry([
    {
      name: 'append-line', version: 1, maxPayloadBytes: 4096,
      validatePayload: (p) => typeof p?.line === 'string' && p.line.trim().startsWith('- '),
      normalizePayload: (p) => ({ line: p.line.trim() }),
      applyNode: (content, payload) => lineTransform(content, payload),
      invariant: (content, payload) => String(content).includes(payload.line),
    },
    {
      name: 'note-append-body', version: 1, maxPayloadBytes: 256 * 1024,
      validatePayload: (p) => typeof p?.noteId === 'string' && p.noteId.length > 0 && typeof p?.body === 'string' && p.body.trim().length > 0,
      normalizePayload: (p) => ({ noteId: p.noteId.trim(), body: p.body.trim() }),
      applyNode: (content, payload) => noteAppendTransform(content, payload),
      invariant: (content, payload) => hasNoteIdentity(content, payload.noteId) && hasExactBlock(content, payload.body),
    },
    {
      name: 'session-thread-append', version: 1, maxPayloadBytes: 64 * 1024,
      validatePayload: (p) => typeof p?.noteId === 'string' && p.noteId.length > 0 && typeof p?.entry === 'string' && p.entry.trim().length > 0,
      normalizePayload: (p) => ({ noteId: p.noteId.trim(), entry: p.entry.trim() }),
      applyNode: (content, payload) => sessionThreadAppendTransform(content, payload),
      invariant: (content, payload) => hasNoteIdentity(content, payload.noteId) && hasExactBlock(content, payload.entry),
    },
    {
      name: 'journal-section-line', version: 1, maxPayloadBytes: 8192,
      validatePayload: (p) => typeof p?.heading === 'string' && typeof p?.line === 'string' && p.line.trim().startsWith('- ') && !/[\r\n]/.test(p.line),
      normalizePayload: (p) => ({ heading: normalizeJournalHeading(p.heading), line: p.line.trim() }),
      applyNode: (content, payload) => journalSectionLineTransform(content, payload),
      invariant: (content, payload) => {
        const lines = String(content).split('\n'); const range = journalSectionRange(lines, normalizeJournalHeading(payload.heading));
        return range.start !== -1 && lines.slice(range.start + 1, range.end).some((line) => line.trim() === payload.line);
      },
    },
    {
      name: 'journal-section-line', version: 2, maxPayloadBytes: 16 * 1024,
      validatePayload: (p) => typeof p?.heading === 'string'
        && typeof p?.line === 'string'
        && p.line.trim().startsWith('- ')
        && !/[\r\n]/.test(p.line)
        && p.contentOrigin
        && typeof p.contentOrigin === 'object',
      normalizePayload: (p) => ({
        heading: normalizeJournalHeading(p.heading),
        line: cleanJournalLine(p.line),
        contentOrigin: normalizedJournalOrigin(p.contentOrigin),
      }),
      applyNode: (content, payload) => journalSectionLineOriginTransform(content, payload),
      invariant: (content, payload) => journalSectionLineOriginSatisfied(content, payload),
    },
    {
      name: 'journal-backlink', version: 1, maxPayloadBytes: 8192,
      validatePayload: (p) => typeof p?.linkTarget === 'string' && p.linkTarget.trim() && !/[\r\n\[\]]/.test(p.linkTarget) && (p.section === undefined || typeof p.section === 'string') && (p.noteId === undefined || typeof p.noteId === 'string'),
      normalizePayload: (p) => ({ linkTarget: p.linkTarget.trim(), section: normalizeJournalHeading(p.section || '📝 Notes'), ...(p.noteId ? { noteId: p.noteId.trim() } : {}) }),
      applyNode: (content, payload) => journalBacklinkTransform(content, payload),
      invariant: journalBacklinkSatisfied,
    },
  ]);
}

function createVaultTransformRegistry(descriptors = []) {
  const entries = new Map();
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1) throw new Error('Invalid transform descriptor');
    if (typeof descriptor.validatePayload !== 'function' || typeof descriptor.normalizePayload !== 'function' || typeof descriptor.applyNode !== 'function' || typeof descriptor.invariant !== 'function') throw new Error('Transform descriptor requires a fixed Node implementation and invariant');
    if (!Number.isSafeInteger(descriptor.maxPayloadBytes) || descriptor.maxPayloadBytes < 1) throw new Error('Transform descriptor requires maxPayloadBytes');
    const key = `${descriptor.name}@${descriptor.version}`;
    if (entries.has(key)) throw new Error(`Duplicate transform ${key}`);
    entries.set(key, Object.freeze({ ...descriptor }));
  }

  function descriptorFor({ transformName, transformVersion }) { return entries.get(`${transformName}@${transformVersion}`); }
  function prepare(operation) {
    const descriptor = descriptorFor(operation);
    if (!descriptor) throw new Error('Unknown transform name or version; operation must be quarantined');
    const replayPayload = descriptor.normalizePayload(operation.replayPayload);
    if (!descriptor.validatePayload(replayPayload) || payloadBytes(replayPayload) > descriptor.maxPayloadBytes) throw new Error('Invalid replay payload');
    return Object.freeze({ transformName: descriptor.name, transformVersion: descriptor.version, replayPayload });
  }
  function quarantine(operation) {
    const descriptor = descriptorFor(operation);
    if (!descriptor) return { status: 'quarantined', reason: 'unknown_transform_version' };
    try { prepare(operation); return null; } catch { return { status: 'quarantined', reason: 'invalid_replay_payload' }; }
  }
  function applyNode(content, operation) { const prepared = prepare(operation); return descriptorFor(prepared).applyNode(String(content), prepared.replayPayload); }
  function isSatisfied(content, operation) { const prepared = prepare(operation); return descriptorFor(prepared).invariant(String(content), prepared.replayPayload) === true; }
  return Object.freeze({ applyNode, isSatisfied, prepare, quarantine });
}

module.exports = {
  createJarvosVaultTransforms,
  createVaultTransformRegistry,
  journalBacklinkSatisfied,
  journalBacklinkTransform,
  journalSectionLineOriginSatisfied,
  journalSectionLineOriginTransform,
  journalSectionLineTransform,
  normalizeJournalHeading,
  sessionThreadAppendTransform,
};
