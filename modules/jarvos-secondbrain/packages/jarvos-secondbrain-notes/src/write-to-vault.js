#!/usr/bin/env node
// Package-owned canonical note writer for jarvos-secondbrain-notes.
// Input (stdin): { "title": "...", "content": "...", "frontmatter": {...} }
// Writes to <vault-notes>/<title>.md.
// Output: { "written": true, "path": "...", "created": true|false, "journal": {...}, "knowledge": {...} }

'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const { getVaultNotesDir, loadConfig } = require('./lib/notes-config');
const { repairZeroByteVaultRootDuplicate } = require('./lib/vault-root-duplicate-guard');
const { optimizeNoteKnowledge } = require('./knowledge-optimizer');
const {
  canonicalizeFrontmatter,
  frontmatterToObject,
  parseFrontmatter,
  renderFrontmatter,
} = require('./lib/note-schema');
const { linkNoteToTodayJournal } = require('../../../bridge/provenance/src/link-to-journal');

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

  return canonical.frontmatter;
}

function buildFrontmatter({ incomingFrontmatter = {}, existingFrontmatter = {} } = {}) {
  return renderFrontmatter(normalizeFrontmatter({
    incoming: incomingFrontmatter,
    existing: existingFrontmatter,
  }));
}

function writeNoteFile({ title, content, frontmatter = {} }) {
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
  const fileContent = renderFrontmatter(normalizedFrontmatter) + body;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, fileContent, 'utf8');
  const vaultRootDuplicate = repairZeroByteVaultRootDuplicate({
    noteTitle: safeName,
    notesDir,
    notesFilePath: filePath,
  });

  let journal = { linked: false, skipped: true, reason: 'disabled by JARVOS_JOURNAL_BACKLINK=0' };
  if (process.env.JARVOS_JOURNAL_BACKLINK !== '0') {
    try {
      journal = linkNoteToTodayJournal(safeName, '📝 Notes');
    } catch (error) {
      journal = { linked: false, skipped: true, reason: error.message };
    }
  }

  const knowledge = optimizeNoteKnowledge({
    filePath,
    notesDir,
    title: safeName,
    body,
    frontmatter: normalizedFrontmatter,
    created,
    journal,
  });

  return { written: true, path: filePath, title: safeName, created, journal, knowledge, vaultRootDuplicate };
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
  sanitizeTitle,
  noteFilePath,
  todayDate,
  writeNoteFile,
};

if (require.main === module) {
  main();
}
