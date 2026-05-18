'use strict';

const JOURNAL_ENTRY = 'journal-entry';
const NOTE_CREATION = 'note-creation';
const IDEA_PARKING = 'idea-parking';

const SKILL_CONTRACTS = Object.freeze({
  [JOURNAL_ENTRY]: Object.freeze({
    id: JOURNAL_ENTRY,
    purpose: 'Append a dated, human-reviewable line to a journal section.',
    input: Object.freeze({
      date: 'YYYY-MM-DD optional; defaults to the runtime local day',
      section: 'Journal section heading',
      line: 'Single markdown list item to append',
    }),
    output: Object.freeze({
      journalPath: 'Path to the dated journal file',
      heading: 'Section that received the line',
      line: 'Normalized line that was appended or found',
      alreadyPresent: 'Boolean idempotency signal',
    }),
  }),
  [NOTE_CREATION]: Object.freeze({
    id: NOTE_CREATION,
    purpose: 'Create an Obsidian-compatible markdown note and link it from the daily journal.',
    input: Object.freeze({
      title: 'Note title and filename stem',
      content: 'Markdown note body',
      frontmatter: 'Portable metadata object',
      date: 'YYYY-MM-DD optional; used for the journal backlink',
    }),
    output: Object.freeze({
      note: 'Written note metadata including path and title',
      journalEntry: 'Journal Notes section backlink append result',
    }),
  }),
  [IDEA_PARKING]: Object.freeze({
    id: IDEA_PARKING,
    purpose: 'Park an idea in the daily journal Ideas section, optionally with a durable note.',
    input: Object.freeze({
      summary: 'Idea text',
      title: 'Optional durable note title',
      substantive: 'Boolean signal for whether a standalone note should also be created',
      date: 'YYYY-MM-DD optional; used for the journal entry',
    }),
    output: Object.freeze({
      journalEntry: 'Journal Ideas section append result',
      note: 'Optional written note metadata when the idea is substantive',
    }),
  }),
});

function getSkillContract(id) {
  return SKILL_CONTRACTS[id] || null;
}

module.exports = {
  JOURNAL_ENTRY,
  NOTE_CREATION,
  IDEA_PARKING,
  SKILL_CONTRACTS,
  getSkillContract,
};
