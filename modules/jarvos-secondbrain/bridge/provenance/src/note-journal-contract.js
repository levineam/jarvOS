#!/usr/bin/env node
// Executable Obsidian note <-> journal contract for AI personalities.

'use strict';

const fs = require('fs');
const path = require('path');
const { writeNoteFile, todayDate } = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault');
const { sourcePathFor } = require('../../../packages/jarvos-secondbrain-notes/src/knowledge-optimizer');
const { getVaultNotesDir, getVaultJournalDir } = require('./lib/provenance-config');
const { frontmatterToObject, parseFrontmatter } = require('../../../packages/jarvos-secondbrain-notes/src/lib/note-schema');

const SUPPORTED_PERSONALITIES = new Set(['michael', 'claude-code', 'hermes', 'codex']);

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInsideDir(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function countJournalBacklinks(journalMd, title) {
  const re = new RegExp(`(^|\\n)\\s*-\\s*\\[\\[${escapeRegex(title)}(?:\\|[^\\]]+)?\\]\\]\\s*(?=\\n|$)`, 'g');
  const matches = String(journalMd || '').match(re);
  return matches ? matches.length : 0;
}

function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('input must be a JSON object');
  }
  const personality = String(input.personality || '').trim().toLowerCase();
  if (!SUPPORTED_PERSONALITIES.has(personality)) {
    throw new Error(`unsupported personality "${input.personality || ''}"; expected one of ${[...SUPPORTED_PERSONALITIES].join(', ')}`);
  }
  if (!input.title || typeof input.title !== 'string') throw new Error('title is required');
  if (input.content === undefined || input.content === null) throw new Error('content is required');
  if (input.frontmatter !== undefined && (!input.frontmatter || typeof input.frontmatter !== 'object' || Array.isArray(input.frontmatter))) {
    throw new Error('frontmatter must be an object when provided');
  }
  return {
    personality,
    title: input.title,
    content: String(input.content),
    frontmatter: {
      ...(input.frontmatter || {}),
      source_personality: personality,
      contract: 'obsidian-note-journal-v1',
    },
  };
}

function verifyContract(result, personality) {
  const notesDir = getVaultNotesDir();
  const journalDir = getVaultJournalDir();
  const journalPath = path.join(journalDir, `${todayDate()}.md`);
  const failures = [];

  if (!isInsideDir(notesDir, result.path)) {
    failures.push(`note path is outside canonical Notes dir: ${result.path}`);
  }

  const noteMd = fs.existsSync(result.path) ? fs.readFileSync(result.path, 'utf8') : '';
  const fm = frontmatterToObject(parseFrontmatter(noteMd));
  for (const field of ['status', 'type', 'project', 'created', 'updated', 'author']) {
    if (fm[field] === undefined) failures.push(`missing canonical frontmatter field: ${field}`);
  }
  if (fm.source_personality !== personality) failures.push(`frontmatter source_personality mismatch: ${fm.source_personality || '(missing)'}`);
  if (fm.contract !== 'obsidian-note-journal-v1') failures.push(`frontmatter contract mismatch: ${fm.contract || '(missing)'}`);

  if (!fs.existsSync(journalPath)) {
    failures.push(`journal does not exist: ${journalPath}`);
  } else {
    const journalMd = fs.readFileSync(journalPath, 'utf8');
    const backlinkCount = countJournalBacklinks(journalMd, result.title);
    if (backlinkCount !== 1) failures.push(`expected exactly one journal backlink for [[${result.title}]], found ${backlinkCount}`);
  }

  const qmdPendingPath = result.knowledge?.qmdPendingPath;
  if (!qmdPendingPath || !fs.existsSync(qmdPendingPath)) {
    failures.push('missing QMD pending-refresh queue');
  } else {
    const qmd = readJson(qmdPendingPath);
    const sourcePath = sourcePathFor(result.path, notesDir);
    const pending = qmd.entries?.[sourcePath];
    if (!pending) failures.push(`missing QMD pending-refresh entry for ${sourcePath}`);
    else if (pending.status !== 'pending-refresh') failures.push(`QMD status is ${pending.status}, expected pending-refresh`);
  }

  if (result.knowledge?.qmdStatus !== 'pending-refresh') {
    failures.push(`writer returned QMD status ${result.knowledge?.qmdStatus || '(missing)'}, expected pending-refresh`);
  }

  return {
    ok: failures.length === 0,
    failures,
    notePath: result.path,
    journalPath,
    qmdPendingPath,
    frontmatter: fm,
  };
}

function writeNoteThroughContract(rawInput) {
  const input = parseInput(rawInput);
  const result = writeNoteFile({
    title: input.title,
    content: input.content,
    frontmatter: input.frontmatter,
  });
  const verification = verifyContract(result, input.personality);
  if (!verification.ok) {
    const err = new Error(`note/journal contract failed: ${verification.failures.join('; ')}`);
    err.result = result;
    err.verification = verification;
    throw err;
  }
  return {
    personality: input.personality,
    written: result.written,
    title: result.title,
    created: result.created,
    notePath: verification.notePath,
    journalPath: verification.journalPath,
    qmdPendingPath: verification.qmdPendingPath,
    journalBacklink: `[[${result.title}]]`,
    qmdStatus: result.knowledge.qmdStatus,
    verification,
  };
}

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(input.trim() || '{}');
      process.stdout.write(`${JSON.stringify(writeNoteThroughContract(parsed), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        error: error.message,
        failures: error.verification?.failures || [],
      }, null, 2)}\n`);
      process.exit(1);
    }
  });
}

module.exports = {
  SUPPORTED_PERSONALITIES,
  countJournalBacklinks,
  main,
  parseInput,
  verifyContract,
  writeNoteThroughContract,
};

if (require.main === module) {
  main();
}
