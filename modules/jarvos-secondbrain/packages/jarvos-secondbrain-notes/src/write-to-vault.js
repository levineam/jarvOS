#!/usr/bin/env node
// Package-owned canonical note writer for jarvos-secondbrain-notes.
// Input (stdin): { "title": "...", "content": "...", "frontmatter": {...} }
// Builds a note mutation for <vault-notes>/<title>.md. Execution is supplied
// by bridge/top-level composition; this package never writes vault Markdown.
// Output: { "written": true, "path": "...", "created": true|false, "journal": {...}, "knowledge": {...} }

'use strict';

const { existsSync, readFileSync } = require('fs');
const { randomUUID } = require('crypto');
const { join, relative, sep } = require('path');
const {
  artifactFromMutationResult,
  createArtifactReceipt,
} = require('../../../src/artifact-receipt');
const { getVaultNotesDir, loadConfig } = require('./lib/notes-config');
const { optimizeNoteKnowledge } = require('./knowledge-optimizer');
const {
  canonicalizeFrontmatter,
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

function readExistingFrontmatter(filePath) {
  if (!existsSync(filePath)) return {};
  const existing = readFileSync(filePath, 'utf8');
  return frontmatterToObject(parseFrontmatter(existing));
}

function normalizeFrontmatter({ incoming = {}, existing = {} } = {}) {
  const canonical = canonicalizeFrontmatter({
    incomingFrontmatter: incoming,
    existingFrontmatter: existing,
    today: todayDate(),
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

function buildFrontmatter({ incomingFrontmatter = {}, existingFrontmatter = {} } = {}) {
  return renderFrontmatter(normalizeFrontmatter({
    incoming: incomingFrontmatter,
    existing: existingFrontmatter,
  }));
}

// Pure operation factory.  The package deliberately does not know which
// transport executes it; bridge and agent composition inject that executor.
function createNoteMutationOperation({ operationId, vaultId, vaultRelativePath, title, content, frontmatter = {}, existingContent = '', existingFrontmatter = {}, appendEntry, sequence = 1, source } = {}) {
  if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('operationId is required for a note mutation');
  if (!vaultId || !vaultRelativePath) throw new Error('vaultId and vaultRelativePath are required for a note mutation');
  const normalizedFrontmatter = normalizeFrontmatter({ incoming: frontmatter, existing: existingFrontmatter });
  const body = buildNoteBody(title, content);
  const rendered = renderFrontmatter(normalizedFrontmatter) + body;
  const created = !existingContent;
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

function writeNoteFile({ title, content, frontmatter = {}, appendEntry, mutationExecutor, operationId, vaultId, vaultRoot, sequence = 1, source }) {
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
  const normalizedFrontmatter = normalizeFrontmatter({
    incoming: frontmatter,
    existing: existingFrontmatter,
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
    existingContent: created ? '' : readFileSync(filePath, 'utf8'),
    existingFrontmatter,
    appendEntry,
    sequence,
    source,
  });
  const receipt = mutationExecutor(operation);
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
    ? optimizeNoteKnowledge({ filePath, notesDir, title: safeName, body, frontmatter: { ...normalizedFrontmatter, jarvos_note_id: operation.noteId }, created, journal })
    : null;

  return {
    written: ['committed', 'already_satisfied'].includes(receipt?.status),
    savedLocally: receipt?.status === 'saved_locally_sync_pending',
    path: filePath,
    title: safeName,
    created,
    noteId: operation.noteId,
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
