'use strict';

module.exports = {
  name: 'idea-parking',
  version: '0.3.0',
  description: 'Optional contract for parking low-confidence capture candidates in a caller-provided review queue instead of promoting them as canonical notes.',
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
      action: 'park the candidate only when a caller explicitly provides a review queue',
      reason: 'Medium-confidence ideas can remain reviewable for opt-in workflows without adding an unclear default journal section.',
    },
    {
      source: 'capture-router',
      when: {
        path: 'salience_medium_ignored',
        captured: false,
      },
      action: 'park the ignored candidate in review state when the capture caller opts into parking',
      reason: 'The default capture route ignores medium-confidence candidates; opt-in callers can still review them elsewhere.',
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
    required: ['text', 'confidence', 'reviewQueue'],
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
      reviewQueue: {
        type: 'string',
        minLength: 1,
        description: 'Caller-owned queue or surface. The default journal no longer supplies one.',
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
        required: ['queue', 'line', 'status'],
        properties: {
          queue: { type: 'string' },
          line: { type: 'string' },
          status: { type: 'string', enum: ['parked-for-review'] },
        },
      },
    },
  },
  capabilities: [
    {
      name: 'park-review-candidate',
      description: 'Append a low-confidence capture candidate to an explicit review queue without creating a canonical note.',
      writes: [
        {
          adapter: 'review-queue',
          operation: 'parkReviewCandidate',
          target: 'caller-provided review queue',
        },
      ],
    },
  ],
  adapters: [
    {
      name: 'review-queue',
      module: 'caller-provided',
      role: 'optional review queue writer; not the default journal',
      required: true,
    },
  ],
};
