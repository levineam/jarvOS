'use strict';

module.exports = {
  name: 'memory-promotion',
  version: '0.1.0',
  description: 'Promote high-confidence durable salience into the configured memory system.',
  triggers: [
    {
      source: 'capture-router',
      when: {
        captured: true,
        destinations: ['memory'],
        confidence: {
          min: 0.8,
        },
      },
      action: 'write a compact memory record through the configured memory adapter',
      reason: 'Routing decides memory eligibility; the memory adapter owns persistence and deduplication.',
    },
  ],
  input: {
    type: 'object',
    additionalProperties: true,
    required: ['class', 'content', 'confidence'],
    properties: {
      class: { type: 'string', enum: ['decision', 'fact', 'preference', 'lesson'] },
      content: { type: 'string', minLength: 1 },
      rationale: { type: 'string' },
      source: { type: 'string' },
      confidence: { type: 'number', minimum: 0.8, maximum: 1 },
      noteRef: { type: 'string' },
    },
  },
  output: {
    type: 'object',
    additionalProperties: true,
    required: ['memory'],
    properties: {
      memory: {
        type: 'object',
        additionalProperties: true,
        required: ['class', 'content'],
        properties: {
          class: { type: 'string' },
          content: { type: 'string' },
          ref: { type: 'string' },
          skipped: { type: 'boolean' },
        },
      },
    },
  },
  capabilities: [
    {
      name: 'write-memory-record',
      description: 'Write or skip a compact memory record with adapter-owned deduplication.',
      writes: [
        {
          adapter: 'memory',
          operation: 'writeMemoryRecord',
          target: 'durable memory record',
        },
      ],
    },
  ],
  adapters: [
    {
      name: 'memory',
      module: 'jarvos-memory/src/index.js',
      role: 'durable memory writer and deduplication owner',
      required: true,
    },
  ],
};
