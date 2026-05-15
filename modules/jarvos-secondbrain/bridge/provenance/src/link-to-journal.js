#!/usr/bin/env node
// Bridge-owned canonical note→journal linker.
// Input (stdin): { "noteTitle": "...", "section": "📝 Notes" }
// Finds today's journal, adds [[noteTitle]] under the specified section if not present.
// Output: { "linked": true, "journalPath": "...", "alreadyPresent": false }

'use strict';

const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const path = require('path');
const { getVaultJournalDir } = require('./lib/provenance-config');
const { getTimeZone } = require('../../config/jarvos-paths');
const {
  loadConfig,
  normalizeSections,
  renderJournal,
} = require('../../../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

function todayPath() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: getTimeZone() });
  return path.join(getVaultJournalDir(), `${today}.md`);
}

function dateFromJournalPath(journalPath) {
  const fromName = path.basename(journalPath, '.md');
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromName)) return fromName;
  return new Date().toLocaleDateString('en-CA', { timeZone: getTimeZone() });
}

function ensureJournalFile(journalPath, date = dateFromJournalPath(journalPath)) {
  if (existsSync(journalPath)) return;
  const config = loadConfig();
  const normalized = normalizeSections('', date, config);
  const rendered = renderJournal(date, config, normalized);
  mkdirSync(path.dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, rendered, 'utf8');
}

function linkNoteToJournal({ noteTitle, section = '📝 Notes', journalPath = todayPath(), createIfMissing = true }) {
  if (!noteTitle) {
    throw new Error('noteTitle is required');
  }

  if (!existsSync(journalPath)) {
    if (!createIfMissing) throw new Error(`Journal not found: ${journalPath}`);
    ensureJournalFile(journalPath);
  }

  const original = readFileSync(journalPath, 'utf8');
  const { content, alreadyPresent } = linkNoteInSection(original, noteTitle, section);

  if (content !== original) {
    writeFileSync(journalPath, content, 'utf8');
  }

  return { linked: true, journalPath, alreadyPresent };
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
      console.log(JSON.stringify(linkNoteToJournal(parsed)));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSectionName(section) {
  const stripped = String(section || '📝 Notes').trim().replace(/^##\s*/, '').trim();
  return stripped === '🗂️ Notes Created' ? '📝 Notes' : stripped;
}

function findSectionRange(lines, heading) {
  const sectionLineStart = lines.findIndex((line) => line.trim() === heading);
  if (sectionLineStart === -1) {
    return { sectionLineStart: -1, sectionLineEnd: -1 };
  }

  let sectionLineEnd = lines.length;
  for (let i = sectionLineStart + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      sectionLineEnd = i;
      break;
    }
  }
  return { sectionLineStart, sectionLineEnd };
}

function linkLineRegex(noteTitle) {
  return new RegExp(`^\\s*-\\s*\\[\\[${escapeRegex(noteTitle)}(?:\\|[^\\]]+)?\\]\\]\\s*$`);
}

function linkNoteInSection(journalMd, noteTitle, section = '📝 Notes') {
  const sectionName = normalizeSectionName(section);
  const heading = `## ${sectionName}`;
  const linkText = `- [[${noteTitle}]]`;
  const exactLinkLine = linkLineRegex(noteTitle);

  let lines = journalMd.split('\n');
  let { sectionLineStart, sectionLineEnd } = findSectionRange(lines, heading);

  if (sectionLineStart === -1) {
    const cleaned = lines.filter((line) => !exactLinkLine.test(line)).join('\n');
    const trimmed = cleaned.trimEnd();
    lines = `${trimmed}\n\n${heading}\n${linkText}\n`.split('\n');
    return { content: lines.join('\n'), alreadyPresent: false };
  }

  const before = lines.slice(0, sectionLineStart + 1).filter((line) => !exactLinkLine.test(line));
  const sectionLines = lines.slice(sectionLineStart + 1, sectionLineEnd);
  const after = lines.slice(sectionLineEnd).filter((line) => !exactLinkLine.test(line));
  const sectionHadLink = sectionLines.some((line) => exactLinkLine.test(line));

  const cleanedSection = sectionLines.filter((line) => {
    if (exactLinkLine.test(line)) return false;
    if (!sectionHadLink && line.trim() === '-') return false;
    return true;
  });

  const rebuilt = [
    ...before,
    linkText,
    ...cleanedSection,
    ...after,
  ];

  return {
    content: rebuilt.join('\n'),
    alreadyPresent: sectionHadLink,
  };
}

module.exports = {
  main,
  todayPath,
  escapeRegex,
  ensureJournalFile,
  linkNoteInSection,
  linkNoteToJournal,
  normalizeSectionName,
};

if (require.main === module) {
  main();
}
