'use strict';

module.exports = {
  name: 'idea-parking',
  version: '0.2.0',
  description: 'Park low-confidence capture candidates for review instead of promoting them as canonical notes.',
  triggers: [
    {
      source: 'classifier',
      when: {
        salienceClass: 'idea',
        confidence: {
          min: 0.5,
          max: 0.799,
        },
      },
      action: 'append the candidate to the journal Flagged section for human review',
      reason: 'Medium-confidence ideas should remain visible without polluting durable notes.',
    },
    {
      source: 'capture-router',
      when: {
        path: 'salience_medium_ignored',
        captured: false,
      },
      action: 'park the ignored candidate in review state when the capture caller opts into parking',
      reason: 'The capture hook already exposes the advisory medium-confidence path.',
    },
    {
      source: 'capture-router',
      when: {
        path: 'capture_that_no_content',
        captured: false,
      },
      action: 'park the failed retroactive capture command as review context when there is enough caller context',
      reason: 'A failed retroactive command is a review signal, not a canonical note.',
    },
  ],
  input: {
    type: 'object',
    additionalProperties: true,
    required: ['text', 'confidence'],
    properties: {
      text: { type: 'string', minLength: 1 },
      content: { type: 'string' },
      title: { type: 'string' },
      salienceClass: {
        type: 'string',
        enum: ['idea', 'decision', 'belief_change', 'commitment', 'preference', 'factual_learning', 'lesson'],
      },
      confidence: { type: 'number', minimum: 0.5, maximum: 0.799 },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      signals: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
  output: {
    type: 'object',
    additionalProperties: true,
    required: ['reviewEntry'],
    properties: {
      reviewEntry: {
        type: 'object',
        additionalProperties: true,
        required: ['section', 'line', 'status'],
        properties: {
          section: { type: 'string', const: '## 📌 Flagged' },
          line: { type: 'string' },
          status: { type: 'string', enum: ['parked-for-review'] },
        },
      },
    },
  },
  capabilities: [
    {
      name: 'park-review-candidate',
      description: 'Append a low-confidence capture candidate to a review queue without creating a canonical note.',
      writes: [
        {
          adapter: 'obsidian',
          operation: 'appendLineToJournalSection',
          target: '## 📌 Flagged',
        },
      ],
    },
  ],
  adapters: [
    {
      name: 'obsidian',
      module: 'jarvos-secondbrain/adapters/obsidian/src/vault-storage-adapter.js',
      role: 'journal review queue writer',
      required: true,
    },
  ],
};
