#!/usr/bin/env node
// Package-owned canonical note writer for jarvos-secondbrain-notes.
// Input (stdin): { "title": "...", "content": "...", "frontmatter": {...} }
// Builds a note mutation for <vault-notes>/<title>.md. Execution is supplied
// by bridge/top-level composition; this package never writes vault Markdown.
// Output: { "written": true, "path": "...", "created": true|false, "journal": {...}, "knowledge": {...} }

'use strict';

const { existsSync, readFileSync } = require('fs');
const { createHash, randomUUID } = require('crypto');
const { join, relative, sep } = require('path');
const {
  artifactFromMutationResult,
  createArtifactReceipt,
} = require('../../../src/artifact-receipt');
const { cleanNoteContent } = require('../../../bridge/provenance/src/content-origin-contract');
const { getVaultNotesDir, loadConfig } = require('./lib/notes-config');
const { optimizeNoteKnowledge } = require('./knowledge-optimizer');
const {
  canonicalizeFrontmatter,
  CONTENT_ORIGIN_FIELDS,
  frontmatterToObject,
  parseFrontmatter,
  renderFrontmatter,
} = require('./lib/note-schema');

function todayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: loadConfig().user.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function sanitizeTitle(title) {
  return String(title || '').trim().replace(/[/\\:*?"<>|]/g, '-');
}

function noteFilePath(title) {
  return join(getVaultNotesDir(), `${sanitizeTitle(title)}.md`);
}

function buildNoteBody(title, content) {
  return String(content || '').startsWith('# ') ? String(content || '') : `# ${title}\n\n${content}`;
}

function hasContentOriginDeclaration(frontmatter = {}) {
  return CONTENT_ORIGIN_FIELDS.some((field) => frontmatter[field] !== undefined);
}

function hasExactBlock(content, block) {
  const expected = String(block || '').trim();
  return Boolean(expected && (`\n\n${String(content || '').trim()}\n\n`).includes(`\n\n${expected}\n\n`));
}

function appendBlock(content, block) {
  const source = String(content || '');
  const expected = String(block || '').trim();
  return hasExactBlock(source, expected)
    ? source
    : `${source.trimEnd()}\n\n${expected}\n`;
}

function provenanceDeclarationsDiffer(existing = {}, next = {}) {
  return CONTENT_ORIGIN_FIELDS.some((field) => JSON.stringify(existing[field]) !== JSON.stringify(next[field]));
}

// Metadata-only provenance repair needs the stored body to survive byte for
// byte, which the default render path cannot promise: `renderFrontmatter` ends
// with a blank separator line while a parsed remainder already carries its own
// leading bytes, so concatenating both inserts one. The capability below is
// opt-in and refuses rather than approximates, so no caller silently loses
// prose to it.
const NOTE_BODY_PRESERVATION_REFUSED = 'note_body_preservation_refused';

class NoteBodyPreservationError extends Error {
  constructor(reason) {
    super(`preserveExistingBodyBytes refused: ${reason}`);
    this.name = 'NoteBodyPreservationError';
    this.code = NOTE_BODY_PRESERVATION_REFUSED;
    this.reason = reason;
  }
}

// The raw parsed remainder, untrimmed: a note without frontmatter is all body,
// and an empty remainder is an empty body, not a missing one.
function rawBodyRemainder(content) {
  const text = String(content ?? '');
  const parsed = parseFrontmatter(text);
  return String(parsed?.remainder ?? text);
}

// Everything `parseFrontmatter` consumes before the remainder, taken from the
// renderer's own output rather than assumed: whatever the renderer emits past
// the closing fence is its remainder, and the stored note supplies its own.
function frontmatterBlockOf(rendered) {
  const parsed = parseFrontmatter(rendered);
  if (!parsed) return null;
  return rendered.slice(0, rendered.length - String(parsed.remainder ?? '').length);
}

// Canonical frontmatter in front of the existing remainder, unchanged. The
// result is re-parsed before it is returned, so the byte-for-byte guarantee is
// checked against the parser instead of argued from the renderer's shape.
function bodyPreservingContent(normalizedFrontmatter, existingContent) {
  const existingBodyBytes = rawBodyRemainder(existingContent);
  const block = frontmatterBlockOf(renderFrontmatter(normalizedFrontmatter));
  if (block === null) throw new NoteBodyPreservationError('body_bytes_not_reproducible');
  const nextContent = `${block}${existingBodyBytes}`;
  if (rawBodyRemainder(nextContent) !== existingBodyBytes) {
    throw new NoteBodyPreservationError('body_bytes_not_reproducible');
  }
  return nextContent;
}

function readExistingFrontmatter(filePath) {
  if (!existsSync(filePath)) return {};
  const existing = readFileSync(filePath, 'utf8');
  return frontmatterToObject(parseFrontmatter(existing));
}

// Receipt checks for a human declaration need the note content and the
// caller-injected source resolver; without a resolver the claim fails closed.
function originOptions({ title, content, resolveUserSource } = {}) {
  return {
    content: cleanNoteContent(String(content ?? ''), title),
    ...(typeof resolveUserSource === 'function' ? { resolveUserSource } : {}),
  };
}

function normalizeFrontmatter({ incoming = {}, existing = {}, preserveExistingProvenance = true, origin = {} } = {}) {
  const existingForNormalization = { ...existing };
  if (!preserveExistingProvenance) {
    for (const field of CONTENT_ORIGIN_FIELDS) delete existingForNormalization[field];
  }
  const canonical = canonicalizeFrontmatter({
    incomingFrontmatter: incoming,
    existingFrontmatter: existingForNormalization,
    today: todayDate(),
    origin,
  });

  if (canonical.errors?.length) {
    throw new Error(`Invalid note frontmatter: ${canonical.errors.join('; ')}`);
  }

  // jarvos_note_id is deliberately writer-owned: callers cannot choose it,
  // while an existing canonical note retains its stable identity.
  const normalizedFrontmatter = {
    ...canonical.frontmatter,
    jarvos_note_id: canonical.frontmatter.jarvos_note_id || randomUUID(),
  };
  // Reserved v1 fields are intentionally not persisted, even if a caller
  // supplied them through a lower-level adapter.
  delete normalizedFrontmatter.content_adoption;
  return normalizedFrontmatter;
}

function buildFrontmatter({ incomingFrontmatter = {}, existingFrontmatter = {}, preserveExistingProvenance = true } = {}) {
  return renderFrontmatter(normalizeFrontmatter({
    incoming: incomingFrontmatter,
    existing: existingFrontmatter,
    preserveExistingProvenance,
  }));
}

// Pure operation factory.  The package deliberately does not know which
// transport executes it; bridge and agent composition inject that executor.
//
// `preserveExistingBodyBytes` is a narrow, opt-in capability for a metadata-only
// provenance repair: the next content is canonical frontmatter in front of the
// stored body remainder, unchanged. It is permitted only for an existing note
// whose provenance frontmatter is being rewritten, with no append entry and with
// caller content that already matches the stored body. Any other use is refused
// with a `NoteBodyPreservationError` instead of dropping the caller's prose.
function createNoteMutationOperation({ operationId, vaultId, vaultRelativePath, title, content, frontmatter = {}, existingContent = '', existingFrontmatter = {}, appendEntry, sequence = 1, source, resolveUserSource, preserveExistingBodyBytes = false } = {}) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId is required for a note mutation');
  if (!vaultId || !vaultRelativePath) throw new Error('vaultId and vaultRelativePath are required for a note mutation');
  if (preserveExistingBodyBytes !== false && preserveExistingBodyBytes !== true) {
    throw new NoteBodyPreservationError('option_not_boolean');
  }
  if (preserveExistingBodyBytes) {
    if (!existingContent) throw new NoteBodyPreservationError('not_an_existing_note');
    if (appendEntry) throw new NoteBodyPreservationError('append_entry_unsupported');
  }
  const body = buildNoteBody(title, content);
  const existingBody = parseFrontmatter(existingContent)?.remainder || existingContent;
  const appendBody = appendEntry ? String(appendEntry).trim() : body;
  const materialBodyChange = Boolean(existingContent) && !hasExactBlock(existingBody, appendBody);
  // A material change means the caller is supplying prose the stored body does
  // not already contain, which preservation would silently discard.
  if (preserveExistingBodyBytes && materialBodyChange) throw new NoteBodyPreservationError('body_would_change');
  const preserveExistingProvenance = !(materialBodyChange && !hasContentOriginDeclaration(frontmatter));
  const normalizedFrontmatter = normalizeFrontmatter({
    incoming: frontmatter,
    existing: existingFrontmatter,
    preserveExistingProvenance,
    origin: originOptions({ title, content, resolveUserSource }),
  });
  const rendered = renderFrontmatter(normalizedFrontmatter) + body;
  const created = !existingContent;
  // Replace the whole note only when its stored provenance actually changes.
  // A material body change already drops undeclared provenance above, so an
  // unchanged declaration can keep the append-only transforms.
  const provenanceRewrite = Boolean(existingContent)
    && (hasContentOriginDeclaration(frontmatter) || hasContentOriginDeclaration(existingFrontmatter))
    && provenanceDeclarationsDiffer(existingFrontmatter, normalizedFrontmatter);
  if (provenanceRewrite) {
    // Compare-and-swap semantics are identical either way: the whole note is
    // replaced against the hash of the exact pre-state read above.
    const nextContent = preserveExistingBodyBytes
      ? bodyPreservingContent(normalizedFrontmatter, existingContent)
      : `${renderFrontmatter(normalizedFrontmatter)}${appendBlock(existingBody, appendBody).trimEnd()}\n`;
    return {
      schemaVersion: 1,
      operationId: operationId.trim(),
      vaultId,
      vaultRelativePath,
      sequence,
      operationKind: 'replace',
      content: nextContent,
      expectedContent: String(existingContent),
      expectedHash: createHash('sha256').update(String(existingContent), 'utf8').digest('hex'),
      noteId: normalizedFrontmatter.jarvos_note_id,
      ...(source ? { source } : {}),
    };
  }
  // Outside a provenance rewrite there is no whole-content replacement to make
  // byte-preserving, and an append transform is not a metadata-only repair.
  if (preserveExistingBodyBytes) throw new NoteBodyPreservationError('not_a_provenance_rewrite');
  const replayPayload = created
    ? null
    : appendEntry
      ? { noteId: normalizedFrontmatter.jarvos_note_id, entry: String(appendEntry).trim() }
      : { noteId: normalizedFrontmatter.jarvos_note_id, body };
  return {
    schemaVersion: 1,
    operationId: operationId.trim(),
    vaultId,
    vaultRelativePath,
    sequence,
    operationKind: created ? 'create' : 'transform',
    ...(created ? { content: rendered } : { transformName: appendEntry ? 'session-thread-append' : 'note-append-body', transformVersion: 1, replayPayload }),
    noteId: normalizedFrontmatter.jarvos_note_id,
    ...(source ? { source } : {}),
  };
}

function hasPersistedNoteBytes(filePath, receipt) {
  return Boolean(
    ['committed', 'already_satisfied', 'saved_locally_sync_pending'].includes(receipt?.status)
    && existsSync(filePath),
  );
}

function writeNoteFile({ title, content, frontmatter = {}, appendEntry, mutationExecutor, operationId, vaultId, vaultRoot, sequence = 1, source, resolveUserSource, preserveExistingBodyBytes = false }) {
  if (!title) throw new Error('title is required');
  if (content === undefined || content === null) throw new Error('content is required');
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('frontmatter must be an object when provided');
  }

  const safeName = sanitizeTitle(title);
  const notesDir = getVaultNotesDir();
  const filePath = noteFilePath(safeName);
  const created = !existsSync(filePath);
  const existingFrontmatter = readExistingFrontmatter(filePath);
  const body = buildNoteBody(title, content);
  const existingContent = created ? '' : readFileSync(filePath, 'utf8');
  const existingBody = parseFrontmatter(existingContent)?.remainder || existingContent;
  const appendBody = appendEntry ? String(appendEntry).trim() : buildNoteBody(title, content);
  const materialBodyChange = Boolean(existingContent) && !hasExactBlock(existingBody, appendBody);
  const preserveExistingProvenance = !(materialBodyChange && !hasContentOriginDeclaration(frontmatter));
  const normalizedFrontmatter = normalizeFrontmatter({
    incoming: frontmatter,
    existing: existingFrontmatter,
    preserveExistingProvenance,
    origin: originOptions({ title, content, resolveUserSource }),
  });
  if (typeof mutationExecutor !== 'function' || !vaultId || !vaultRoot || !operationId) {
    throw new Error('Canonical vault mutation composition is required; package note writes cannot modify Markdown directly');
  }
  const vaultRelativePath = relative(vaultRoot, filePath).split(sep).join('/');
  const operation = createNoteMutationOperation({
    operationId,
    vaultId,
    vaultRelativePath,
    title,
    content,
    frontmatter,
    existingContent,
    existingFrontmatter,
    appendEntry,
    sequence,
    source,
    resolveUserSource,
    // Opt-in metadata-only repair; the factory refuses it for anything else.
    preserveExistingBodyBytes,
  });
  const receipt = mutationExecutor(operation);
  const persistedOperation = receipt.operation || operation;
  const hasBytes = hasPersistedNoteBytes(filePath, receipt);
  const artifactReceipt = createArtifactReceipt({
    artifacts: [{
      record: artifactFromMutationResult({
        kind: 'note',
        vaultRelativePath,
        result: receipt,
      }),
      intent: 'user_requested',
    }],
  });
  const journal = { status: 'pending', linked: false, deferred: false, disabled: false, failed: false, reason: 'backlink dispatch is composed separately' };
  const knowledge = hasBytes
    ? optimizeNoteKnowledge({ filePath, notesDir, title: safeName, body, frontmatter: { ...normalizedFrontmatter, jarvos_note_id: persistedOperation.noteId }, created, journal })
    : null;

  return {
    written: ['committed', 'already_satisfied'].includes(receipt?.status),
    savedLocally: receipt?.status === 'saved_locally_sync_pending',
    path: filePath,
    title: safeName,
    created,
    noteId: persistedOperation.noteId,
    receipt,
    artifactReceipt,
    journal,
    knowledge,
    vaultRootDuplicate: null,
  };
}

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(input.trim());
    } catch (e) {
      console.error(JSON.stringify({ error: 'Invalid JSON input', detail: e.message }));
      process.exit(1);
    }

    try {
      const result = writeNoteFile(parsed);
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });
}

module.exports = {
  main,
  NOTE_BODY_PRESERVATION_REFUSED,
  NoteBodyPreservationError,
  buildFrontmatter,
  buildNoteBody,
  normalizeFrontmatter,
  createNoteMutationOperation,
  sanitizeTitle,
  noteFilePath,
  todayDate,
  writeNoteFile,
};

if (require.main === module) {
  main();
}
