'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const evaluation = require('../src/project-inference-evaluation');

const DIGEST = 'a'.repeat(64);

function expectedLabels(overrides = []) {
  return [
    {
      fixtureId: 'book',
      projectId: 'project-book',
      parentProjectId: null,
      expectedName: 'Swarm Theory Book',
      known: true,
      critical: true,
    },
    {
      fixtureId: 'portfolio',
      projectId: 'project-portfolio',
      parentProjectId: null,
      expectedName: 'Amazing Abundance Portfolio',
      known: true,
      critical: false,
    },
    {
      fixtureId: 'software',
      projectId: 'project-software',
      parentProjectId: null,
      expectedName: 'jarvOS',
      known: true,
      critical: false,
    },
    {
      fixtureId: 'release-child',
      projectId: 'project-release',
      parentProjectId: 'project-software',
      expectedName: 'Release work',
      known: true,
      critical: false,
    },
    ...overrides,
  ];
}

function candidates(overrides = {}) {
  return [
    {
      outputId: 'cluster-book',
      fixtureIds: ['book'],
      parentOutputId: null,
      name: 'Swarm Theory Book',
    },
    {
      outputId: 'cluster-portfolio',
      fixtureIds: ['portfolio'],
      parentOutputId: null,
      name: 'Amazing Abundance Portfolio',
    },
    {
      outputId: 'cluster-software',
      fixtureIds: ['software'],
      parentOutputId: null,
      name: 'jarvOS',
    },
    {
      outputId: 'cluster-release',
      fixtureIds: ['release-child'],
      parentOutputId: 'cluster-software',
      name: 'Release work',
    },
    ...((overrides.extra || [])),
  ].map((candidate) => ({ ...candidate, ...(overrides[candidate.outputId] || {}) }));
}

function armInput(overrides = {}) {
  return {
    evaluationRevision: 'bakeoff-v1',
    engine: {
      engineId: 'baseline',
      engineRevision: 'baseline-v1',
      status: 'available',
      configDigest: DIGEST,
    },
    corpusSize: 4,
    expectedLabels: expectedLabels(),
    candidateOutputs: candidates(),
    replayCandidateOutputs: candidates(),
    nameRubric: {
      status: 'scored',
      scoreCount: 4,
      median: 4,
      mean: 4.25,
      exemplarRegression: false,
    },
    privacyFailures: {
      status: 'verified',
      count: 0,
    },
    resourceCost: {
      status: 'measured',
      wallMs: 12,
      cpuMs: 8,
      maxRssMb: 32,
      modelCalls: 0,
    },
    ...overrides,
  };
}

test('a qualifying baseline emits the frozen thresholds and selected-ready metrics', () => {
  const receipt = evaluation.scoreInferenceArm(armInput());

  assert.equal(receipt.contract, evaluation.EVALUATION_CONTRACT);
  assert.equal(receipt.qualification, 'qualifies');
  assert.equal(receipt.corpusSize, 4);
  assert.equal(receipt.configDigest, DIGEST);
  assert.match(receipt.resultDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.replayStability, { status: 'pass', stable: true });
  assert.deepEqual(receipt.knownProjectRecovery, { status: 'pass', recovered: 4, total: 4, rate: 1 });
  assert.deepEqual(receipt.parentAccuracy, { status: 'pass', correct: 4, total: 4, rate: 1 });
  assert.deepEqual(receipt.criticalFalseMerges, { status: 'pass', count: 0 });
  assert.deepEqual(receipt.overallFalseMerges, { status: 'pass', count: 0, total: 4, rate: 0 });
  assert.deepEqual(receipt.falseSplits, { status: 'pass', count: 0, total: 4, rate: 0 });
  assert.deepEqual(receipt.privacyFailures, { status: 'pass', count: 0 });
  assert.deepEqual(receipt.nameRubric, {
    status: 'pass', scoreCount: 4, median: 4, mean: 4.25, exemplarRegression: false,
  });
  assert.deepEqual(receipt.resourceCost, armInput().resourceCost);
  assert.deepEqual(receipt.thresholds, evaluation.THRESHOLDS);
});

test('failed metrics fail closed and do not get represented as zero', () => {
  const input = armInput({
    candidateOutputs: candidates({
      extra: [{
        outputId: 'cluster-merge',
        fixtureIds: ['book', 'portfolio'],
        parentOutputId: null,
        name: 'Mixed work',
      }],
    }),
    replayCandidateOutputs: candidates(),
    nameRubric: {
      status: 'scored', scoreCount: 4, median: 3, mean: 3, exemplarRegression: true,
    },
    privacyFailures: { status: 'verified', count: 1 },
  });

  const receipt = evaluation.scoreInferenceArm(input);
  assert.equal(receipt.qualification, 'fails');
  assert.equal(receipt.overallFalseMerges.status, 'fail');
  assert.equal(receipt.overallFalseMerges.count, 1);
  assert.equal(receipt.criticalFalseMerges.status, 'fail');
  assert.equal(receipt.privacyFailures.status, 'fail');
  assert.equal(receipt.nameRubric.status, 'fail');
  assert.equal(receipt.replayStability.status, 'fail');
});

test('an unavailable engine yields typed not-evaluable metrics and no zero scores', () => {
  const receipt = evaluation.scoreInferenceArm(armInput({
    engine: {
      engineId: 'hdbscan',
      engineRevision: 'hdbscan-v1',
      status: 'unavailable',
      configDigest: null,
      reason: 'local-runtime-unavailable',
    },
    candidateOutputs: null,
    replayCandidateOutputs: null,
    nameRubric: { status: 'not-evaluable', scoreCount: null, median: null, mean: null, exemplarRegression: null },
    privacyFailures: { status: 'not-evaluable', count: null },
    resourceCost: { status: 'not-evaluable', wallMs: null, cpuMs: null, maxRssMb: null, modelCalls: null },
  }));

  assert.equal(receipt.qualification, 'not-evaluable');
  assert.equal(receipt.configDigest, null);
  assert.deepEqual(receipt.replayStability, { status: 'not-evaluable', stable: null });
  assert.deepEqual(receipt.knownProjectRecovery, { status: 'not-evaluable', recovered: null, total: null, rate: null });
  assert.deepEqual(receipt.parentAccuracy, { status: 'not-evaluable', correct: null, total: null, rate: null });
  assert.deepEqual(receipt.criticalFalseMerges, { status: 'not-evaluable', count: null });
  assert.deepEqual(receipt.overallFalseMerges, { status: 'not-evaluable', count: null, total: null, rate: null });
  assert.deepEqual(receipt.falseSplits, { status: 'not-evaluable', count: null, total: null, rate: null });
  assert.deepEqual(receipt.privacyFailures, { status: 'not-evaluable', count: null });
  assert.equal(receipt.nameRubric.status, 'not-evaluable');
  assert.equal(receipt.resourceCost.status, 'not-evaluable');
});

test('reordered inputs produce the same result digest and replay result', () => {
  const input = armInput({
    expectedLabels: expectedLabels().reverse(),
    candidateOutputs: candidates().reverse(),
    replayCandidateOutputs: candidates().reverse(),
  });
  const reordered = armInput();
  const first = evaluation.scoreInferenceArm(input);
  const second = evaluation.scoreInferenceArm(reordered);
  assert.equal(first.resultDigest, second.resultDigest);
  assert.deepEqual(first.replayStability, { status: 'pass', stable: true });
});

test('privacy-shaped raw fields and paths are rejected at the public boundary', () => {
  assert.throws(() => evaluation.scoreInferenceArm(armInput({
    candidateOutputs: [{
      outputId: 'cluster-book',
      fixtureIds: ['book'],
      parentOutputId: null,
      name: 'Swarm Theory Book',
      raw: 'private transcript excerpt',
    }],
  })), /unsupported|private|raw/i);

  assert.throws(() => evaluation.scoreInferenceArm(armInput({
    expectedLabels: [{
      fixtureId: 'book',
      projectId: 'project-book',
      parentProjectId: null,
      expectedName: '/Users/andrew/private-note.md',
      known: true,
      critical: true,
    }],
  })), /path|locator|label/i);
});

test('selection receipt distinguishes selected, no-engine, and not-evaluable', () => {
  const selected = evaluation.createBakeoffReceipt({
    evaluationRevision: 'bakeoff-v1',
    arms: [armInput()],
  });
  assert.equal(selected.decision, 'selected');
  assert.equal(selected.selectedEngineId, 'baseline');

  const failed = evaluation.createBakeoffReceipt({
    evaluationRevision: 'bakeoff-v1',
    arms: [armInput({
      candidateOutputs: candidates({ extra: [{ outputId: 'merge', fixtureIds: ['book', 'portfolio'], parentOutputId: null, name: 'Mixed' }] }),
    })],
  });
  assert.equal(failed.decision, 'no-engine');
  assert.equal(failed.selectedEngineId, null);

  const unavailable = evaluation.createBakeoffReceipt({
    evaluationRevision: 'bakeoff-v1',
    arms: [armInput({
      engine: { engineId: 'hdbscan', engineRevision: 'hdbscan-v1', status: 'unavailable', configDigest: null, reason: 'missing-local-runtime' },
      candidateOutputs: null,
      replayCandidateOutputs: null,
      nameRubric: { status: 'not-evaluable', scoreCount: null, median: null, mean: null, exemplarRegression: null },
      privacyFailures: { status: 'not-evaluable', count: null },
      resourceCost: { status: 'not-evaluable', wallMs: null, cpuMs: null, maxRssMb: null, modelCalls: null },
    })],
  });
  assert.equal(unavailable.decision, 'not-evaluable');
  assert.equal(unavailable.selectedEngineId, null);
});
