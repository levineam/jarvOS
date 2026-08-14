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
const { resolveJournalConfig } = require('../../../bridge/config');
const { mutateJournalThroughObsidian } = require('../../../bridge/provenance/src/obsidian-mutation.js');
const IDEAS_HEADING = '## 💡 Ideas';
const NOTES_HEADING = '## 📝 Notes';
const FLAGGED_HEADING = '## 📌 Flagged';

function journalConfig() {
  return resolveJournalConfig();
}

function todayDate(now = new Date(), config = journalConfig()) {
  return localDate(now, config.timeZone);
}

function assertJournalDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('journal date must be ISO format YYYY-MM-DD');
  }
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
    ensureJournal({ date, now, config: suppliedConfig } = {}) {
      const config = suppliedConfig || journalConfig();
      const operationNow = now instanceof Date ? now : new Date(now || Date.now());
      const effectiveDate = date || todayDate(operationNow, config);
      assertJournalDate(effectiveDate);
      const journalDir = config.journalDir;
      const journalPath = path.join(journalDir, `${effectiveDate}.md`);
      if (effectiveDate !== todayDate(operationNow, config)) {
        throw new Error('journal ensure supports only the current local date');
      }
      const existed = fs.existsSync(journalPath);
      const lifecycle = ensureTodayJournal({ ...config, journalPath, now: operationNow });
      if (!lifecycle.ok || lifecycle.date !== effectiveDate || !lifecycle.journalPath || !fs.existsSync(lifecycle.journalPath)) {
        throw new Error(`journal ensure ${lifecycle.outcome || 'failed'}`);
      }
      return { journalPath: lifecycle.journalPath, existed, lifecycle };
    },

    appendLineToJournalSection({ heading, line, date, now } = {}) {
      if (!heading) throw new Error('heading is required');
      if (!line || !String(line).trim()) throw new Error('line is required');

      const config = journalConfig();
      const operationNow = now instanceof Date ? now : new Date(now || Date.now());
      const effectiveDate = date || todayDate(operationNow, config);
      assertJournalDate(effectiveDate);
      const journalPath = path.join(config.journalDir, `${effectiveDate}.md`);
      if (effectiveDate === todayDate(operationNow, config)) {
        this.ensureJournal({ date: effectiveDate, now: operationNow, config });
      } else if (!fs.existsSync(journalPath)) {
        throw new Error('journal append supports past dates only when the journal already exists');
      }
      const current = fs.readFileSync(journalPath, 'utf8');
      const mutationInput = { heading, line: String(line).trim() };
      const appended = appendLineMutation(current, mutationInput);

      if (!appended.alreadyPresent) {
        if (effectiveDate === localDate(operationNow, config.timeZone) && !allowUnsafeFilesystemWrites) {
          const mutation = ownedJournalMutator({
            journalPath,
            mutation: appendLineMutation,
            mutationPayload: mutationInput,
            verifyCommitted: (committed) => appendLineMutation(committed, mutationInput).content === committed,
          });
          return {
            journalPath,
            heading,
            line: String(line).trim(),
            alreadyPresent: Boolean(mutation.alreadyPresent),
            mutationOwner: mutation.mutationOwner || 'obsidian-vault-process',
          };
        }
        mutateExistingJournal({ journalPath, expectedContent: current, nextContent: appended.content });
      }

      return {
        journalPath,
        heading,
        line: String(line).trim(),
        alreadyPresent: Boolean(appended.alreadyPresent),
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

    linkNoteToJournal({ noteTitle, date, now, heading = NOTES_HEADING }) {
      if (!noteTitle) throw new Error('noteTitle is required');
      return this.appendLineToJournalSection({
        heading,
        line: `- [[${noteTitle}]]`,
        date,
        now,
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
