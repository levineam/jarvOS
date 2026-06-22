'use strict';

module.exports = {
  name: 'work-intake',
  version: '0.1.0',
  description: 'Turn commitments or explicit work requests into a tracked-work intake candidate.',
  triggers: [
    {
      source: 'classifier',
      when: {
        salienceClass: 'commitment',
        confidence: {
          min: 0.8,
        },
      },
      action: 'prepare a tracked-work draft for the configured work intake adapter',
      reason: 'Commitments should become visible work without the routing layer creating Paperclip issues directly.',
    },
    {
      source: 'capture-router',
      when: {
        path: 'work_intake',
        destinations: ['work'],
      },
      action: 'prepare an explicit work intake draft without applying side effects',
      reason: 'Hosts can route work to Paperclip or another tracker through an adapter.',
    },
  ],
  input: {
    type: 'object',
    additionalProperties: true,
    required: ['title', 'description'],
    properties: {
      title: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
      source: { type: 'string' },
      priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      status: { type: 'string', enum: ['backlog', 'todo', 'in_progress'] },
      salienceClass: { type: 'string', enum: ['commitment'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  },
  output: {
    type: 'object',
    additionalProperties: true,
    required: ['workIntake'],
    properties: {
      workIntake: {
        type: 'object',
        additionalProperties: true,
        required: ['title', 'status'],
        properties: {
          title: { type: 'string' },
          identifier: { type: 'string' },
          status: { type: 'string' },
          skipped: { type: 'boolean' },
        },
      },
    },
  },
  capabilities: [
    {
      name: 'ensure-tracked-work',
      description: 'Create or reuse a tracked-work item through the configured work system.',
      writes: [
        {
          adapter: 'paperclip',
          operation: 'ensureTrackedWork',
          target: 'work intake issue',
        },
      ],
    },
  ],
  adapters: [
    {
      name: 'paperclip',
      module: 'jarvos-secondbrain/bridge/paperclip/client.js',
      role: 'optional tracked-work intake adapter',
      required: false,
    },
  ],
};
