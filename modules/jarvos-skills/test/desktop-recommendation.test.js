'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectSkillSyncDesktop } = require('../src/desktop-recommendation');

const decision = (overrides = {}) => ({
  decisionReference: 'AbCdEfGhIjKlMnOpQrStUvWx',
  revision: 3,
  skill: 'newsletter-generator',
  options: ['share', 'keep-local', 'exclude', 'details'],
  affectedHarnesses: ['openclaw', 'claude'],
  ...overrides,
});
const at = '2026-09-16T18:30:00.000Z';

test('projects analysis_required with Generate recommendation and non-resolving Not now', () => {
  const projection = projectSkillSyncDesktop({ decisions: [decision()], generatedAt: at });
  assert.equal(projection.schema, 'jarvos.skill-sync-desktop-recommendations/v1');
  assert.equal(projection.version, 1);
  const item = projection.decisions[0];
  assert.equal(item.state, 'analysis_required');
  assert.equal(item.primaryAction.label, 'Generate recommendation');
  assert.match(item.primaryAction.operation.handle, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(item.primaryAction.operation.available, false);
  assert.equal(item.primaryAction.operation.reason, 'verified_host_adapter_unavailable');
  assert.deepEqual(item.affectedHarnesses, ['claude', 'openclaw']);
  assert.deepEqual(item.acknowledgement, {
    label: 'Not now', resolves: false,
    operation: {
      kind: 'acknowledge_skill_decision', decisionReference: decision().decisionReference, revision: 3,
      available: false, reason: 'verified_host_adapter_unavailable',
    },
  });
  assert.equal(JSON.stringify(projection).includes('/Users/'), false);
});

test('projects a current durable recommendation with an exact revalidated apply mapping', () => {
  const recommendation = {
    decisionReference: decision().decisionReference,
    revision: 3,
    generatedAt: '2026-09-16T18:20:00.000Z',
    decision: 'keep-local',
    rationale: 'This keeps the private capability available without widening distribution.',
    affectedHarnesses: ['claude', 'openclaw'],
    expectedResult: 'Existing local behavior remains available and shared copies stay unchanged.',
    materialRisk: 'Other harnesses will not gain this capability until the decision changes.',
    uncertainty: 'The source may become safe to share after a later reassessment.',
    alternatives: [
      { option: 'share', tradeoff: 'Wider availability, but only after the source is approved for distribution.' },
      { option: 'exclude', tradeoff: 'Removes the ambiguity, but the local capability is no longer managed here.' },
      { option: 'details', tradeoff: 'Requests more analysis and leaves the decision pending.' },
    ],
  };
  const projection = projectSkillSyncDesktop({
    decisions: [decision()],
    recommendations: [recommendation],
    capabilities: { resolveDecision: true, acknowledgeDecision: true },
    generatedAt: at,
  });
  const item = projection.decisions[0];
  assert.equal(item.state, 'recommendation_available');
  assert.equal(item.primaryAction.label, 'See recommendation');
  assert.equal(item.recommendation.decision, 'keep-local');
  assert.deepEqual(item.recommendation.applyOperation, {
    kind: 'resolve_skill_decision',
    decisionReference: decision().decisionReference,
    revision: 3,
    option: 'keep-local',
    revalidate: true,
    available: true,
  });
  assert.equal(item.acknowledgement.operation.available, true);
  assert.deepEqual(item.recommendation.alternatives.map((entry) => entry.option), ['share', 'exclude', 'details']);
});

test('invalidates a stale recommendation and returns to Generate recommendation', () => {
  const projection = projectSkillSyncDesktop({
    decisions: [decision({ revision: 4 })],
    recommendations: [{ decisionReference: decision().decisionReference, revision: 3 }],
    generatedAt: at,
  });
  assert.deepEqual(projection.decisions[0].freshness, {
    state: 'invalidated', invalidatedAt: at, reason: 'decision_revision_changed',
  });
  assert.equal(projection.decisions[0].state, 'analysis_required');
  assert.equal(projection.decisions[0].primaryAction.label, 'Generate recommendation');
  assert.equal(projection.decisions[0].recommendation, undefined);
});

test('rejects incomplete recommendations, unsafe display text, and unmapped alternatives', () => {
  const base = {
    decisionReference: decision().decisionReference,
    revision: 3,
    generatedAt: at,
    decision: 'share',
    rationale: 'Use the shared capability.',
    affectedHarnesses: ['claude', 'openclaw'],
    expectedResult: 'The capability becomes available where requested.',
    materialRisk: 'Distribution increases the exposed surface.',
    uncertainty: 'Compatibility may vary by harness.',
    alternatives: [
      { option: 'keep-local', tradeoff: 'Keeps distribution narrow.' },
      { option: 'exclude', tradeoff: 'Removes it from management.' },
      { option: 'details', tradeoff: 'Leaves the decision pending.' },
    ],
  };
  assert.throws(() => projectSkillSyncDesktop({
    decisions: [decision()], recommendations: [{ ...base, rationale: 'Inspect (/Users/example/secret) first.' }], generatedAt: at,
  }), /display-safe/u);
  assert.throws(() => projectSkillSyncDesktop({
    decisions: [decision()], recommendations: [{ ...base, alternatives: base.alternatives.slice(1) }], generatedAt: at,
  }), /alternatives/u);
  assert.throws(() => projectSkillSyncDesktop({
    decisions: [decision()], recommendations: [{ ...base, affectedHarnesses: ['claude'] }], generatedAt: at,
  }), /affectedHarnesses/u);
  assert.throws(() => projectSkillSyncDesktop({
    decisions: [decision(), decision()], generatedAt: at,
  }), /unique/u);
});
