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

module.exports = { createJarvosVaultTransforms, createVaultTransformRegistry };
