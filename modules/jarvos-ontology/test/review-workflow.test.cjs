'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  canPromoteCandidate,
  promoteReviewedCandidate,
  resolveInquiry,
} = require('../src/review-workflow.cjs');

function reviewedCandidate(overrides = {}) {
  return {
    id: 'candidate-1',
    type: 'ontology-candidate',
    status: 'reviewing',
    signal_type: 'belief',
    source: { type: 'CaptureEvent v2', ref: 'cap_123' },
    created_at: '2026-06-25T00:00:00.000Z',
    updated_at: '2026-06-25T00:00:00.000Z',
    reviewed_at: '2026-06-25T01:00:00.000Z',
    reviewer: 'codex',
    confidence: 0.8,
    proposed_target: 'beliefs',
    proposal: 'The user values source-backed systems.',
    ...overrides,
  };
}

test('approved candidate can promote into the target ontology section', () => {
  const applied = [];
  const result = promoteReviewedCandidate(reviewedCandidate(), {
    targetAnchor: 'B7',
    apply: (entry) => applied.push(entry),
  });

  assert.equal(result.ok, true);
  assert.equal(result.promoted, true);
  assert.equal(result.target, 'beliefs');
  assert.equal(result.nextRecord.status, 'promoted');
  assert.equal(result.nextRecord.outcome.ontology_anchor, 'B7');
  assert.equal(applied[0].content, 'The user values source-backed systems.');
});

test('candidate missing source evidence cannot promote', () => {
  const check = canPromoteCandidate(reviewedCandidate({ source: {} }));
  assert.equal(check.ok, false);
  assert.match(check.errors.join('\n'), /source\.type and source\.ref/);
});

test('dismissed or stale candidates cannot promote', () => {
  for (const status of ['dismissed', 'stale', 'promoted']) {
    const result = promoteReviewedCandidate(reviewedCandidate({ status }));
    assert.equal(result.ok, false, status);
    assert.match(result.errors.join('\n'), /closed|reviewing/);
  }
});

test('inquiry can resolve without ontology promotion', () => {
  const result = resolveInquiry({
    id: 'inquiry-1',
    type: 'ontology-inquiry',
    status: 'reviewing',
    question: 'What value explains this?',
    source: { type: 'note', ref: 'Notes/Example.md' },
    owner: 'user',
    links: { notes: ['Notes/Example.md'] },
  }, {
    resolution: 'Evidence is not durable enough for ontology promotion yet.',
    resolvedAt: '2026-06-25T02:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.nextRecord.status, 'resolved');
  assert.match(result.nextRecord.resolution, /not durable enough/);
});
