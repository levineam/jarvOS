'use strict';

module.exports = {
  name: 'journal-entry',
  version: '0.2.0',
  description: 'Capture idea and thought intents as dated journal entries.',
  triggers: [
    {
      source: 'keyword-router',
      when: {
        trigger: 'idea',
      },
      action: 'append captured idea text to the journal Ideas section',
      reason: 'The keyword router treats idea-prefixed captures as journal-first material.',
    },
    {
      source: 'classifier',
      when: {
        salienceClass: 'idea',
        confidence: {
          min: 0.8,
        },
      },
      action: 'append high-confidence thought capture to the journal Ideas section',
      reason: 'High-confidence idea classifications are intentional thought captures.',
    },
    {
      source: 'capture-router',
      when: {
        path: 'capture_that',
        captured: true,
        destinations: ['journal'],
      },
      action: 'append retroactively selected content to the appropriate journal section',
      reason: 'The capture hook reports journal in destinations when the selected context was written.',
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
      trigger: { type: 'string', enum: ['idea'] },
      salienceClass: { type: 'string', enum: ['idea'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    },
  },
  output: {
    type: 'object',
    additionalProperties: true,
    required: ['journalEntry'],
    properties: {
      journalEntry: {
        type: 'object',
        additionalProperties: true,
        required: ['section', 'line'],
        properties: {
          section: { type: 'string' },
          line: { type: 'string' },
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
      },
    },
  },
  capabilities: [
    {
      name: 'append-journal-line',
      description: 'Append one normalized line to the daily journal without creating a standalone note.',
      writes: [
        {
          adapter: 'obsidian',
          operation: 'appendLineToJournalSection',
          target: '## 💡 Ideas',
        },
      ],
    },
  ],
  adapters: [
    {
      name: 'obsidian',
      module: 'jarvos-secondbrain/adapters/obsidian/src/vault-storage-adapter.js',
      role: 'journal section writer',
      required: true,
    },
  ],
};
