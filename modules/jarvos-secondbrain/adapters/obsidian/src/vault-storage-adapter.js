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
  ensureTodayJournal,
  localDate,
  mutateExistingJournal,
} = require('../../../packages/jarvos-secondbrain-journal/src/journal-lifecycle.js');
const {
  writeNoteFile,
} = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault.js');
const {
  getVaultJournalDir,
} = require('../../../bridge/provenance/src/lib/provenance-config.js');
const { resolveJournalConfig } = require('../../../bridge/config');
const { mutateJournalThroughObsidian } = require('../../../bridge/provenance/src/link-to-journal.js');
const IDEAS_HEADING = '## 💡 Ideas';
const NOTES_HEADING = '## 📝 Notes';
const FLAGGED_HEADING = '## 📌 Flagged';
const SIGNATURE = '— Edited by Jarvis';
const NOTES_PLACEHOLDER_RE = /^-\s+(?:No notes created(?: on .*)?|No notes today|No notes yet)$/i;

function journalConfig() {
  return resolveJournalConfig();
}

function todayDate(now = new Date()) {
  return localDate(now, journalConfig().timeZone);
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

function ensureJournalFile(journalPath, date, config = journalConfig()) {
  if (path.resolve(config.journalDir) !== path.resolve(path.dirname(journalPath))) {
    throw new Error('journal ensure target does not match configured journal directory');
  }
  const lifecycle = ensureTodayJournal(config);
  if (!lifecycle.ok || lifecycle.date !== date || !fs.existsSync(journalPath)) {
    throw new Error(`journal ensure ${lifecycle.outcome || 'failed'}`);
  }
  return lifecycle;
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

// Serialized into the Obsidian eval request. Keep this function self-contained
// so editor-owned mutation uses the latest vault content rather than a stale
// Node-side snapshot.
function appendLineMutation(current, input) {
  const heading = String(input.heading || '').trim();
  const line = String(input.line || '').trim();
  const signature = '— Edited by Jarvis';
  const placeholder = /^-\s+(?:No notes created(?: on .*)?|No notes today|No notes yet)$/i;
  const trim = (text) => {
    const lines = String(text || '').split(/\r?\n/);
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  };
  const range = (lines) => {
    let start = -1;
    let end = lines.length;
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed === heading) {
        start = index;
        continue;
      }
      if (start !== -1 && index > start && (/^##\s/.test(lines[index]) || trimmed === signature)) {
        end = index;
        break;
      }
    }
    return { start, end };
  };
  const insert = (lines) => {
    const insertAt = lines.findIndex((entry) => entry.trim() === signature);
    const section = [heading, '-', ''];
    return insertAt === -1
      ? [...lines, '', ...section]
      : [...lines.slice(0, insertAt), ...section, ...lines.slice(insertAt)];
  };

  let lines = String(current || '').split(/\r?\n/);
  let found = range(lines);
  if (found.start === -1) {
    lines = insert(lines);
    found = range(lines);
  }
  const sectionLines = lines.slice(found.start + 1, found.end);
  const existing = sectionLines.map((entry) => entry.trim()).filter(Boolean);
  if (existing.includes(line)) return { content: String(current || ''), alreadyPresent: true };
  const materialized = sectionLines.filter((entry) => {
    const trimmed = entry.trim();
    return trimmed !== '' && trimmed !== '-' && !placeholder.test(trimmed);
  });
  materialized.push(line);
  const rebuilt = [
    ...lines.slice(0, found.start + 1),
    ...(materialized.length ? materialized : ['-']),
    '',
    ...lines.slice(found.end),
  ].join('\n');
  return { content: `${trim(rebuilt)}\n`, alreadyPresent: false };
}

function createVaultStorageAdapter(options = {}) {
  const ownedJournalMutator = options.ownedJournalMutator || mutateJournalThroughObsidian;
  const allowUnsafeFilesystemWrites = options.allowUnsafeFilesystemWrites === true
    || process.env.JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE === '1';

  return {
    ensureJournal({ date = todayDate() } = {}) {
      const config = journalConfig();
      const journalDir = config.journalDir || getVaultJournalDir();
      const journalPath = path.join(journalDir, `${date}.md`);
      const existed = fs.existsSync(journalPath);
      const lifecycle = ensureJournalFile(journalPath, date, config);
      return { journalPath, existed, lifecycle };
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
        const config = journalConfig();
        if (date === localDate(new Date(), config.timeZone) && !allowUnsafeFilesystemWrites) {
          const mutation = ownedJournalMutator({
            journalPath,
            mutation: appendLineMutation,
            mutationPayload: { heading, line: String(line).trim() },
            verifyCommitted: (committed) => appendLineMutation(committed, {
              heading,
              line: String(line).trim(),
            }).content === committed,
          });
          return {
            journalPath,
            heading,
            line: String(line).trim(),
            alreadyPresent: Boolean(mutation.alreadyPresent),
            mutationOwner: mutation.mutationOwner || 'obsidian-vault-process',
          };
        }
        mutateExistingJournal({ journalPath, expectedContent: current, nextContent: finalContent });
      }

      return {
        journalPath,
        heading,
        line: String(line).trim(),
        alreadyPresent: appended.alreadyPresent,
        mutationOwner: appended.alreadyPresent ? 'existing-journal-content' : 'jarvos-filesystem',
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
