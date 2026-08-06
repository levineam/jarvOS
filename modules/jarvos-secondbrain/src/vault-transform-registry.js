'use strict';

function payloadBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }

function lineTransform(content, { line }) {
  const source = String(content);
  return source.includes(line) ? source : `${source}${source.endsWith('\n') ? '' : '\n'}${line}\n`;
}

function hasNoteIdentity(content, noteId) {
  const match = String(content).match(/^---\r?\n[\s\S]*?^jarvos_note_id:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))[\s\S]*?^---/m);
  return (match?.[1] || match?.[2] || match?.[3] || '') === noteId;
}

function noteAppendTransform(content, { noteId, body }) {
  const source = String(content);
  if (!hasNoteIdentity(source, noteId)) return source;
  return source.includes(body) ? source : `${source.trimEnd()}\n\n${body.trim()}\n`;
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

// These are the portable, reviewable transforms used by U4 callers.  The
// adapter has matching fixed cases; callers never supply executable source.
function createJarvosVaultTransforms() {
  return createVaultTransformRegistry([
    {
      name: 'append-line', version: 1, maxPayloadBytes: 4096,
      validatePayload: (p) => typeof p?.line === 'string' && p.line.trim().startsWith('- '),
      normalizePayload: (p) => ({ line: p.line.trim() }),
      applyNode: (content, payload) => lineTransform(content, payload),
      applyObsidian: (content, payload) => lineTransform(content, payload),
      invariant: (content, payload) => String(content).includes(payload.line),
    },
    {
      name: 'note-append-body', version: 1, maxPayloadBytes: 256 * 1024,
      validatePayload: (p) => typeof p?.noteId === 'string' && p.noteId.length > 0 && typeof p?.body === 'string' && p.body.trim().length > 0,
      normalizePayload: (p) => ({ noteId: p.noteId.trim(), body: p.body.trim() }),
      applyNode: (content, payload) => noteAppendTransform(content, payload),
      applyObsidian: (content, payload) => noteAppendTransform(content, payload),
      invariant: (content, payload) => hasNoteIdentity(content, payload.noteId) && String(content).includes(payload.body),
    },
    {
      name: 'journal-section-line', version: 1, maxPayloadBytes: 8192,
      validatePayload: (p) => typeof p?.heading === 'string' && typeof p?.line === 'string' && p.line.trim().startsWith('- ') && !/[\r\n]/.test(p.line),
      normalizePayload: (p) => ({ heading: normalizeJournalHeading(p.heading), line: p.line.trim() }),
      applyNode: (content, payload) => journalSectionLineTransform(content, payload),
      applyObsidian: (content, payload) => journalSectionLineTransform(content, payload),
      invariant: (content, payload) => {
        const lines = String(content).split('\n'); const range = journalSectionRange(lines, normalizeJournalHeading(payload.heading));
        return range.start !== -1 && lines.slice(range.start + 1, range.end).some((line) => line.trim() === payload.line);
      },
    },
    {
      name: 'journal-backlink', version: 1, maxPayloadBytes: 8192,
      validatePayload: (p) => typeof p?.linkTarget === 'string' && p.linkTarget.trim() && !/[\r\n\[\]]/.test(p.linkTarget) && (p.section === undefined || typeof p.section === 'string') && (p.noteId === undefined || typeof p.noteId === 'string'),
      normalizePayload: (p) => ({ linkTarget: p.linkTarget.trim(), section: normalizeJournalHeading(p.section || '📝 Notes'), ...(p.noteId ? { noteId: p.noteId.trim() } : {}) }),
      applyNode: (content, payload) => journalBacklinkTransform(content, payload),
      applyObsidian: (content, payload) => journalBacklinkTransform(content, payload),
      invariant: journalBacklinkSatisfied,
    },
  ]);
}

function createVaultTransformRegistry(descriptors = []) {
  const entries = new Map();
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1) throw new Error('Invalid transform descriptor');
    if (typeof descriptor.validatePayload !== 'function' || typeof descriptor.normalizePayload !== 'function' || typeof descriptor.applyNode !== 'function' || typeof descriptor.applyObsidian !== 'function' || descriptor.applyNode === descriptor.applyObsidian || typeof descriptor.invariant !== 'function') throw new Error('Transform descriptor requires distinct fixed Node and Obsidian code functions');
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
  function apply(content, operation, implementation) { const prepared = prepare(operation); return descriptorFor(prepared)[implementation](String(content), prepared.replayPayload); }
  function isSatisfied(content, operation) { const prepared = prepare(operation); return descriptorFor(prepared).invariant(String(content), prepared.replayPayload) === true; }
  function assertConformance(fixtures) {
    for (const fixture of fixtures) {
      const node = apply(fixture.content, fixture.operation, 'applyNode');
      const obsidian = apply(fixture.content, fixture.operation, 'applyObsidian');
      if (node !== obsidian || isSatisfied(node, fixture.operation) !== isSatisfied(obsidian, fixture.operation)) throw new Error('Node and Obsidian transform conformance failed');
    }
  }
  return Object.freeze({ applyNode: (content, operation) => apply(content, operation, 'applyNode'), applyObsidian: (content, operation) => apply(content, operation, 'applyObsidian'), assertConformance, isSatisfied, prepare, quarantine });
}

module.exports = { createJarvosVaultTransforms, createVaultTransformRegistry, journalBacklinkSatisfied, journalBacklinkTransform, journalSectionLineTransform, normalizeJournalHeading };
