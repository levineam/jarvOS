'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const {
  DEFAULT_CONFIG,
  classifyReadiness,
  classifyProductFit,
  triageCodingWork,
} = require('../src/features/triage');

test('DEFAULT_CONFIG names no active release parent (no stale v0.3-era default)', () => {
  assert.equal(DEFAULT_CONFIG.activeReleaseIssue, null);
  assert.equal(DEFAULT_CONFIG.activeVersion, null);
});

test('a historical release-parent identifier is no longer auto-classified as the active release parent', () => {
  // SUP-1957 was the v0.3-era parent; docs/release-process.md says v0.3-era
  // parents are historical and "should not receive new candidates". With no
  // configured activeReleaseIssue, an issue merely sharing that identifier
  // must not be silently re-tagged as the active release parent.
  const productFit = classifyProductFit({ identifier: 'SUP-1957', title: 'Unrelated later issue' }, DEFAULT_CONFIG);
  assert.notEqual(productFit.classification, 'jarvos');
  assert.equal(productFit.reasons.includes('active release parent issue'), false);
});

test('triageCodingWork with unconfigured release intake is visibly incomplete, not silently ready', () => {
  const result = triageCodingWork(
    { identifier: 'SUP-9999', title: 'jarvOS control-plane change', labels: ['jarvos'] },
    { config: {} },
  );

  assert.equal(result.readiness.state, 'needs-triage');
  assert.notEqual(result.decision.action, 'apply');
});

test('triageCodingWork stays fail-closed (blocked) when release intake reports invalid-config', () => {
  const result = triageCodingWork(
    { identifier: 'SUP-9999', title: 'jarvOS control-plane change', labels: ['jarvos'] },
    { config: {}, releaseClassification: { classification: 'invalid-config', reasons: ['no active release parent configured'] } },
  );

  assert.equal(result.readiness.state, 'blocked');
  assert.equal(result.decision.action, 'fail-closed');
});

test('classifyReadiness still resolves ready once an explicit release classification is supplied', () => {
  const productFit = { classification: 'jarvos', matched: true, reasons: [] };
  const releaseFit = {
    classification: 'release-candidate',
    matched: true,
    labels: ['jarvos-release-candidate'],
    reasons: ['configured release parent'],
  };
  const readiness = classifyReadiness(productFit, releaseFit);
  assert.equal(readiness.state, 'ready');
});
