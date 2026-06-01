#!/usr/bin/env node
// Package-owned canonical note writer for jarvos-secondbrain-notes.
// Input (stdin): { "title": "...", "content": "...", "frontmatter": {...} }
// Writes to <vault-notes>/<title>.md, links it from the journal, and emits KB sidecars.
// Output: { "written": true, "path": "...", "journal": {...}, "knowledge": {...} }

'use strict';

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const { getVaultNotesDir } = require('./lib/notes-config');
const { repairZeroByteVaultRootDuplicate } = require('./lib/vault-root-duplicate-guard');
const { optimizeNoteKnowledge } = require('./knowledge-optimizer');
const { linkNoteToJournal } = require('../../../bridge/provenance/src/link-to-journal');

const REQUIRED_FRONTMATTER = ['status', 'type', 'project', 'created', 'updated', 'author'];

function todayDate() {
  const today = new Date().toISOString().slice(0, 10);
  return today;
}

function parseFrontmatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(String(content || ''));
  if (!match) return {};

  const fields = {};
  for (const line of match[1].split('\n')) {
    const item = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!item) continue;
    fields[item[1]] = parseFrontmatterValue(item[2].trim());
  }
  return fields;
}

function parseFrontmatterValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^["']|["']$/g, '');
  }
}

function normalizeFrontmatter({ incoming = {}, existing = {} } = {}) {
  const today = todayDate();
  const base = {
    status: 'draft',
    type: 'note',
    project: 'jarvOS',
    created: existing.created || today,
    updated: today,
    author: 'jarvis',
    ...existing,
    ...incoming,
  };

  base.updated = today;
  for (const key of REQUIRED_FRONTMATTER) {
    if (base[key] === undefined || base[key] === null || base[key] === '') {
      if (key === 'created' || key === 'updated') base[key] = today;
      else if (key === 'author') base[key] = 'jarvis';
      else if (key === 'status') base[key] = 'draft';
      else if (key === 'type') base[key] = 'note';
      else if (key === 'project') base[key] = 'jarvOS';
    }
  }

  return base;
}

function renderFrontmatterValue(value) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return JSON.stringify(text);
}

function buildFrontmatter(fm) {
  const base = normalizeFrontmatter({ incoming: fm || {} });
  const lines = Object.entries(base).map(([k, v]) => {
    return `${k}: ${renderFrontmatterValue(v)}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function sanitizeTitle(title) {
  return String(title || '').trim().replace(/[/\\:*?"<>|]/g, '-');
}

function buildNoteBody(title, content) {
  return String(content || '').startsWith('# ') ? String(content || '') : `# ${title}\n\n${content}`;
}

function noteFilePath(title) {
  return join(getVaultNotesDir(), `${sanitizeTitle(title)}.md`);
}

function readExistingFrontmatter(filePath) {
  if (!existsSync(filePath)) return {};
  return parseFrontmatter(readFileSync(filePath, 'utf8'));
}

function writeNoteFile({
  title,
  content,
  frontmatter = {},
  section = '📝 Notes',
  createJournalIfMissing = true,
} = {}) {
  if (!title) throw new Error('title is required');
  if (content === undefined || content === null) throw new Error('content is required');
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error('frontmatter must be an object when provided');
  }

  const safeName = sanitizeTitle(title);
  const notesDir = getVaultNotesDir();
  const filePath = noteFilePath(safeName);
  const created = !existsSync(filePath);
  const normalizedFrontmatter = normalizeFrontmatter({
    incoming: frontmatter,
    existing: readExistingFrontmatter(filePath),
  });
  const fmBlock = buildFrontmatter(normalizedFrontmatter);
  const body = buildNoteBody(title, content);
  const fileContent = fmBlock + body;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, fileContent, 'utf8');
  const vaultRootDuplicate = repairZeroByteVaultRootDuplicate({
    noteTitle: safeName,
    notesDir,
    notesFilePath: filePath,
  });

  let journal = { linked: false, skipped: true, reason: 'disabled by JARVOS_JOURNAL_BACKLINK=0' };
  if (process.env.JARVOS_JOURNAL_BACKLINK !== '0') {
    journal = linkNoteToJournal({
      noteTitle: safeName,
      section,
      createIfMissing: createJournalIfMissing,
    });
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
  noteFilePath,
  parseFrontmatter,
  sanitizeTitle,
  todayDate,
  writeNoteFile,
};

if (require.main === module) {
  main();
}
