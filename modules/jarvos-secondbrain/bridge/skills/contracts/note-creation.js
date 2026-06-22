'use strict';

module.exports = {
  name: 'note-creation',
  version: '0.2.0',
  description: 'Capture note intents as Obsidian notes and link them from the daily journal.',
  triggers: [
    {
      source: 'keyword-router',
      when: {
        trigger: 'note',
      },
      action: 'create a standalone note and append its wikilink to the journal Notes section',
      reason: 'The keyword router treats note-prefixed captures as durable note requests.',
    },
    {
      source: 'capture-router',
      when: {
        path: 'salience_high',
        captured: true,
        destinations: ['journal', 'notes'],
      },
      action: 'create a standalone note for high-confidence non-idea salience',
      reason: 'The capture hook emits notes in destinations when a durable artifact was created.',
    },
    {
      source: 'capture-router',
      when: {
        path: 'capture_that',
        captured: true,
        destinations: ['journal', 'notes'],
      },
      action: 'create a standalone note from the selected prior message',
      reason: 'Retroactive capture can promote rich prior content directly into a note.',
    },
  ],
  input: {
    type: 'object',
    additionalProperties: true,
    required: ['text'],
    properties: {
      text: { type: 'string', minLength: 1 },
      content: { type: 'string' },
      title: { type: 'string' },
      trigger: { type: 'string', enum: ['note', 'decision', 'preference', 'fact', 'lesson'] },
      salienceClass: {
        type: 'string',
        enum: ['decision', 'belief_change', 'commitment', 'preference', 'factual_learning', 'lesson'],
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      frontmatter: { type: 'object' },
    },
  },
  output: {
    type: 'object',
    additionalProperties: true,
    required: ['note', 'noteLink', 'journalEntry', 'knowledge'],
    properties: {
      note: {
        type: 'object',
        additionalProperties: true,
        required: ['title'],
        properties: {
          title: { type: 'string' },
          path: { type: 'string' },
        },
      },
      noteLink: { type: 'string', pattern: '^\\[\\[.+\\]\\]$' },
      journalEntry: {
        type: 'object',
        additionalProperties: true,
        required: ['section', 'line'],
        properties: {
          section: { type: 'string' },
          line: { type: 'string', pattern: '^- \\[\\[.+\\]\\]$' },
        },
      },
      knowledge: {
        type: 'object',
        additionalProperties: true,
        required: ['qmdStatus'],
        properties: {
          qmdStatus: { type: 'string', enum: ['pending-refresh'] },
          qmdPendingPath: { type: 'string' },
        },
      },
    },
  },
  capabilities: [
    {
      name: 'create-obsidian-note',
      description: 'Create or update a markdown note with canonical notes frontmatter.',
      writes: [
        {
          adapter: 'obsidian',
          operation: 'writeNote',
          target: 'vault note',
        },
      ],
    },
    {
      name: 'link-note-from-journal',
      description: 'Append the new note wikilink under the daily journal Notes section.',
      writes: [
        {
          adapter: 'obsidian',
          operation: 'appendLineToJournalSection',
          target: '## 📝 Notes',
        },
      ],
    },
    {
      name: 'execute-note-journal-contract',
      description: 'Fail closed unless the note lands in canonical Notes, has canonical frontmatter, has exactly one journal backlink, and records QMD pending-refresh state.',
      writes: [
        {
          adapter: 'provenance',
          operation: 'writeNoteThroughContract',
          target: 'canonical note plus daily journal backlink',
        },
      ],
    },
  ],
  adapters: [
    {
      name: 'obsidian',
      module: 'jarvos-secondbrain/adapters/obsidian/src/vault-storage-adapter.js',
      role: 'note writer and journal backlink writer',
      required: true,
    },
    {
      name: 'notes',
      module: 'jarvos-secondbrain/packages/jarvos-secondbrain-notes/src/write-to-vault.js',
      role: 'canonical markdown note/frontmatter writer behind the Obsidian adapter',
      required: true,
    },
    {
      name: 'provenance',
      module: 'jarvos-secondbrain/bridge/provenance/src/note-journal-contract.js',
      role: 'shared executable contract for Michael, Claude Code, and Hermes note writes',
      required: true,
    },
  ],
};
