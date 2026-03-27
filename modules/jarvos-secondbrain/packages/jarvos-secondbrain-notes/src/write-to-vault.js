#!/usr/bin/env node
// Package-owned canonical note writer for jarvos-secondbrain-notes.
// Input (stdin): { "title": "...", "content": "...", "frontmatter": {...} }
// Writes to <vault-notes>/<title>.md.
// Output: { "written": true, "path": "..." }

'use strict';

const { mkdirSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const { getVaultNotesDir } = require('./lib/notes-config');

function buildFrontmatter(fm) {
  if (!fm || Object.keys(fm).length === 0) return '';
  const today = new Date().toISOString().slice(0, 10);
  const base = {
    created: today,
    updated: today,
    author: 'jarvis',
    ...fm,
  };
  const lines = Object.entries(base).map(([k, v]) => {
    if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function sanitizeTitle(title) {
  return String(title || '').trim().replace(/[/\\:*?"<>|]/g, '-');
}

function buildNoteBody(title, content) {
  return String(content || '').startsWith('# ') ? String(content || '') : `# ${title}\n\n${content}`;
}

function writeNoteFile({ title, content, frontmatter = {} }) {
  if (!title) throw new Error('title is required');
  if (content === undefined || content === null) throw new Error('content is required');

  const safeName = sanitizeTitle(title);
  const filePath = join(getVaultNotesDir(), `${safeName}.md`);
  const fmBlock = buildFrontmatter(frontmatter);
  const body = buildNoteBody(title, content);
  const fileContent = fmBlock + body;

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, fileContent, 'utf8');
  return { written: true, path: filePath, title: safeName };
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

module.exports = { main, buildFrontmatter, buildNoteBody, sanitizeTitle, writeNoteFile };

if (require.main === module) {
  main();
}
