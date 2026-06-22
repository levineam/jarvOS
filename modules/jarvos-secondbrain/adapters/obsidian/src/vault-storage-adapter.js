#!/usr/bin/env node
/**
 * Obsidian/vault-backed storage adapter for jarvos-secondbrain routing flows.
 *
 * Adapter contract:
 * - ensureJournal({ date? })
 * - appendLineToJournalSection({ heading, line, date? })
 * - writeNote({ title, content, frontmatter? })
 * - linkNoteToJournal({ noteTitle, date? })
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  loadConfig,
  normalizeSections,
  renderJournal,
} = require('../../../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
const {
  writeNoteFile,
} = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault.js');
const {
  getVaultJournalDir,
} = require('../../../bridge/provenance/src/lib/provenance-config.js');
const IDEAS_HEADING = '## 💡 Ideas';
const NOTES_HEADING = '## 📝 Notes';
const FLAGGED_HEADING = '## 📌 Flagged';
const SIGNATURE = '— Edited by Jarvis';
const NOTES_PLACEHOLDER_RE = /^-\s+(?:No notes created(?: on .*)?|No notes today|No notes yet)$/i;

function todayDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function trimOuterBlankLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function findSectionRange(lines, heading) {
  let sectionLineStart = -1;
  let sectionLineEnd = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === heading) {
      sectionLineStart = i;
      continue;
    }
    if (sectionLineStart !== -1 && i > sectionLineStart) {
      if (/^##\s/.test(lines[i]) || trimmed === SIGNATURE) {
        sectionLineEnd = i;
        break;
      }
    }
  }

  return { sectionLineStart, sectionLineEnd };
}

function ensureJournalFile(journalPath, date) {
  if (fs.existsSync(journalPath)) {
    return fs.readFileSync(journalPath, 'utf8');
  }

  const config = loadConfig();
  const normalized = normalizeSections('', date, config);
  const rendered = renderJournal(date, config, normalized);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(journalPath, rendered, 'utf8');
  return rendered;
}

function appendLineToSectionContent(contentLines, line) {
  const trimmedLine = String(line || '').trim();
  const existingTrimmed = contentLines.map((entry) => entry.trim()).filter(Boolean);
  if (existingTrimmed.includes(trimmedLine)) {
    return { contentLines, alreadyPresent: true };
  }

  const materialized = contentLines.filter((entry) => {
    const trimmed = entry.trim();
    return trimmed !== '' && trimmed !== '-' && !NOTES_PLACEHOLDER_RE.test(trimmed);
  });
  materialized.push(trimmedLine);

  return {
    contentLines: materialized.length ? materialized : ['-'],
    alreadyPresent: false,
  };
}

function insertMissingSection(lines, heading) {
  const insertAt = lines.findIndex((line) => line.trim() === SIGNATURE);
  const insertion = [heading, '-', ''];
  if (insertAt === -1) {
    return [...lines, '', ...insertion];
  }
  return [
    ...lines.slice(0, insertAt),
    ...insertion,
    ...lines.slice(insertAt),
  ];
}

function createVaultStorageAdapter() {
  return {
    ensureJournal({ date = todayDate() } = {}) {
      const journalDir = getVaultJournalDir();
      const journalPath = path.join(journalDir, `${date}.md`);
      const existed = fs.existsSync(journalPath);
      ensureJournalFile(journalPath, date);
      return { journalPath, existed };
    },

    appendLineToJournalSection({ heading, line, date = todayDate() }) {
      if (!heading) throw new Error('heading is required');
      if (!line || !String(line).trim()) throw new Error('line is required');

      const { journalPath } = this.ensureJournal({ date });
      const current = fs.readFileSync(journalPath, 'utf8');
      let lines = current.split(/\r?\n/);
      let range = findSectionRange(lines, heading);

      if (range.sectionLineStart === -1) {
        lines = insertMissingSection(lines, heading);
        range = findSectionRange(lines, heading);
      }

      const existingSection = lines.slice(range.sectionLineStart + 1, range.sectionLineEnd);
      const appended = appendLineToSectionContent(existingSection, line);
      const rebuilt = [
        ...lines.slice(0, range.sectionLineStart + 1),
        ...appended.contentLines,
        '',
        ...lines.slice(range.sectionLineEnd),
      ].join('\n');
      const finalContent = trimOuterBlankLines(rebuilt) + '\n';

      if (!appended.alreadyPresent) {
        fs.writeFileSync(journalPath, finalContent, 'utf8');
      }

      return {
        journalPath,
        heading,
        line: String(line).trim(),
        alreadyPresent: appended.alreadyPresent,
      };
    },

    writeNote({ title, content, frontmatter = {} }) {
      const previous = process.env.JARVOS_JOURNAL_BACKLINK;
      process.env.JARVOS_JOURNAL_BACKLINK = '0';
      try {
        return writeNoteFile({ title, content, frontmatter });
      } finally {
        if (previous === undefined) delete process.env.JARVOS_JOURNAL_BACKLINK;
        else process.env.JARVOS_JOURNAL_BACKLINK = previous;
      }
    },

    linkNoteToJournal({ noteTitle, date = todayDate(), heading = NOTES_HEADING }) {
      if (!noteTitle) throw new Error('noteTitle is required');
      return this.appendLineToJournalSection({
        heading,
        line: `- [[${noteTitle}]]`,
        date,
      });
    },
  };
}

module.exports = {
  createVaultStorageAdapter,
  IDEAS_HEADING,
  NOTES_HEADING,
  FLAGGED_HEADING,
  todayDate,
};
