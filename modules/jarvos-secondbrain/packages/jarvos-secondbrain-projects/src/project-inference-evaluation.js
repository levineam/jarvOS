'use strict';

/**
 * Public-safe, engine-neutral contract for the one-time Project Inference
 * bakeoff.  Engines run outside this package.  They hand this module only
 * opaque fixture labels, candidate membership, bounded names, and measured
 * metadata; this module produces the deterministic receipt used to compare
 * the arms.
 */

const inferenceContracts = require('./project-inference-contracts');

const EVALUATION_CONTRACT = 'jarvos.project-inference-evaluation/v1';
const BAKEOFF_CONTRACT = 'jarvos.project-inference-bakeoff/v1';
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

// These values are deliberately frozen in the public contract.  A private
// runner may supply an evaluation revision, but it cannot lower the gate.
const THRESHOLDS = Object.freeze({
  replayStability: 1,
  knownProjectRecovery: 0.9,
  parentAccuracy: 0.85,
  criticalFalseMerges: 0,
  overallFalseMergeRate: 0.05,
  falseSplitRate: 0.10,
  privacyFailures: 0,
  nameMedian: 4,
  nameExemplarRegression: false,
});

const ENGINE_STATUSES = Object.freeze(['available', 'unavailable']);
const QUALIFICATIONS = Object.freeze(['qualifies', 'fails', 'not-evaluable']);
const DECISIONS = Object.freeze(['selected', 'no-engine', 'not-evaluable']);
const METRIC_STATUSES = Object.freeze(['pass', 'fail', 'not-evaluable']);
const NAME_RUBRIC_STATUSES = Object.freeze(['scored', 'unavailable', 'not-evaluable']);
const PRIVACY_STATUSES = Object.freeze(['verified', 'unavailable', 'not-evaluable']);
const RESOURCE_STATUSES = Object.freeze(['measured', 'unavailable', 'not-evaluable']);

const ARM_INPUT_FIELDS = Object.freeze([
  'evaluationRevision', 'engine', 'corpusSize', 'expectedLabels', 'candidateOutputs',
  'replayCandidateOutputs', 'nameRubric', 'privacyFailures', 'resourceCost',
]);
const ENGINE_FIELDS = Object.freeze(['engineId', 'engineRevision', 'status', 'configDigest', 'reason']);
const EXPECTED_LABEL_FIELDS = Object.freeze([
  'fixtureId', 'projectId', 'parentProjectId', 'expectedName', 'known', 'critical',
]);
const CANDIDATE_OUTPUT_FIELDS = Object.freeze(['outputId', 'fixtureIds', 'parentOutputId', 'name']);
const NAME_RUBRIC_FIELDS = Object.freeze(['status', 'scoreCount', 'median', 'mean', 'exemplarRegression']);
const PRIVACY_FAILURE_FIELDS = Object.freeze(['status', 'count']);
const RESOURCE_COST_FIELDS = Object.freeze(['status', 'wallMs', 'cpuMs', 'maxRssMb', 'modelCalls']);
const RECEIPT_FIELDS = Object.freeze([
  'contract', 'evaluationRevision', 'engineId', 'engineRevision', 'engineStatus', 'availabilityReason',
  'configDigest', 'corpusSize', 'expectedDigest', 'resultDigest', 'replayStability',
  'knownProjectRecovery', 'parentAccuracy', 'criticalFalseMerges', 'overallFalseMerges',
  'falseSplits', 'privacyFailures', 'nameRubric', 'resourceCost', 'thresholds',
  'qualification', 'failureReasons',
]);
const BAKEOFF_FIELDS = Object.freeze([
  'contract', 'evaluationRevision', 'arms', 'decision', 'selectedEngineId', 'selectionDigest',
]);

function isPlainObject(value) {
  return inferenceContracts.isPlainObject(value);
}

function clone(value) {
  return inferenceContracts.clone(value);
}

function stableStringify(value) {
  return inferenceContracts.stableStringify(value);
}

function stableDigest(value) {
  return inferenceContracts.stableDigest(value);
}

function assertPlain(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function assertExactKeys(value, fields, label) {
  assertPlain(value, label);
  const expected = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} must contain exact fields: ${fields.join(', ')}`);
  }
}

function assertKnownKeys(value, fields, label) {
  assertPlain(value, label);
  const expected = new Set(fields);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function requiredString(value, field, { max = 160 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > max) throw new TypeError(`${field} is invalid`);
  if (/[\u0000\r\n]/.test(normalized)) throw new TypeError(`${field} contains control characters`);
  return normalized;
}

function opaque(value, field, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  const normalized = requiredString(value, field, { max: 256 });
  if (/[\s\\/]/.test(normalized) || /:\/\//.test(normalized) || normalized.startsWith('~')) {
    throw new TypeError(`${field} must be an opaque identifier without paths or locators`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) throw new TypeError(`${field} must be an opaque identifier`);
  return normalized;
}

function label(value, field, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be a label`);
  }
  const normalized = requiredString(value, field);
  if (normalized.startsWith('/') || normalized.startsWith('~') || /:\/\//.test(normalized)) {
    throw new TypeError(`${field} cannot contain a path or locator`);
  }
  return normalized.replace(/\s+/g, ' ');
}

function enumValue(value, field, values) {
  if (!values.includes(value)) throw new TypeError(`${field} must be one of: ${values.join(', ')}`);
  return value;
}

function digestOrNull(value, field, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new TypeError(`${field} must be a sha256 digest`);
    return null;
  }
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw new TypeError(`${field} must be a sha256 digest`);
  return value;
}

function positiveInteger(value, field, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be a positive integer`);
  }
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, field, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function finiteNumber(value, field, { nullable = false, min = 0, max = Infinity } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be a finite number`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`${field} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function normalizeList(value, field, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) throw new TypeError(`${field} must be an array`);
  const result = value.map((entry, index) => opaque(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} must not contain duplicates`);
  return result.sort((left, right) => left.localeCompare(right));
}

// Public receipts must not become a covert source-data channel.  Field names
// are checked recursively before any normalization so a rejected payload can
// never influence a digest or a metric.
const FORBIDDEN_FIELD = /(?:absolute|credential|diff|embedding|password|private|prompt|raw|secret|token|transcript|excerpt|body|locator)/i;
const ABSOLUTE_OR_LOCATOR = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)|:\/\//;

function rejectPrivateShape(value, path = 'input') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPrivateShape(entry, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'string' && ABSOLUTE_OR_LOCATOR.test(value)) throw new TypeError(`${path} contains a private path or locator`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) throw new TypeError(`${path}.${key} is not allowed in a public evaluation receipt`);
    rejectPrivateShape(child, `${path}.${key}`);
  }
}

function normalizeEngine(input) {
  // `reason` is derived for the normalized receipt and may be omitted by an
  // available arm.  All other engine fields are required, and unknown fields
  // remain rejected at this public boundary.
  assertKnownKeys(input, ENGINE_FIELDS, 'evaluation engine');
  if (!Object.prototype.hasOwnProperty.call(input, 'reason')) input = { ...input, reason: null };
  for (const field of ['engineId', 'engineRevision', 'status', 'configDigest']) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) throw new TypeError(`evaluation engine is missing ${field}`);
  }
  const status = enumValue(input.status, 'engine.status', ENGINE_STATUSES);
  const engineId = opaque(input.engineId, 'engine.engineId');
  const engineRevision = opaque(input.engineRevision, 'engine.engineRevision');
  const configDigest = digestOrNull(input.configDigest, 'engine.configDigest', { required: status === 'available' });
  const reason = input.reason === null ? null : label(input.reason, 'engine.reason', { nullable: true });
  if (status === 'available' && reason !== null) throw new TypeError('available engine cannot have an availability reason');
  if (status === 'unavailable' && reason === null) throw new TypeError('unavailable engine requires an availability reason');
  return { engineId, engineRevision, status, configDigest, reason };
}

function normalizeExpectedLabels(input) {
  if (!Array.isArray(input) || input.length < 1) throw new TypeError('expectedLabels must be a non-empty array');
  const fixtureIds = new Set();
  const labels = input.map((entry, index) => {
    assertExactKeys(entry, EXPECTED_LABEL_FIELDS, `expectedLabels[${index}]`);
    const fixtureId = opaque(entry.fixtureId, `expectedLabels[${index}].fixtureId`);
    if (fixtureIds.has(fixtureId)) throw new TypeError('expectedLabels must not repeat fixtureId');
    fixtureIds.add(fixtureId);
    const projectId = opaque(entry.projectId, `expectedLabels[${index}].projectId`);
    const parentProjectId = opaque(entry.parentProjectId, `expectedLabels[${index}].parentProjectId`, { nullable: true });
    if (parentProjectId === projectId) throw new TypeError('expected label cannot parent itself');
    const expectedName = label(entry.expectedName, `expectedLabels[${index}].expectedName`, { nullable: true });
    if (typeof entry.known !== 'boolean') throw new TypeError(`expectedLabels[${index}].known must be boolean`);
    if (typeof entry.critical !== 'boolean') throw new TypeError(`expectedLabels[${index}].critical must be boolean`);
    return { fixtureId, projectId, parentProjectId, expectedName, known: entry.known, critical: entry.critical };
  });
  const projectIds = new Set(labels.map((entry) => entry.projectId));
  labels.forEach((entry) => {
    if (entry.parentProjectId && !projectIds.has(entry.parentProjectId)) {
      throw new TypeError(`expected parent ${entry.parentProjectId} has no fixture label`);
    }
  });
  return labels.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
}

function normalizeCandidateOutputs(input, fixtureIds, { nullable = false } = {}) {
  if (input === null || input === undefined) {
    if (nullable) return null;
    throw new TypeError('candidateOutputs must be an array');
  }
  if (!Array.isArray(input)) throw new TypeError('candidateOutputs must be an array');
  const knownFixtures = new Set(fixtureIds);
  const outputIds = new Set();
  const outputs = input.map((entry, index) => {
    assertExactKeys(entry, CANDIDATE_OUTPUT_FIELDS, `candidateOutputs[${index}]`);
    const outputId = opaque(entry.outputId, `candidateOutputs[${index}].outputId`);
    if (outputIds.has(outputId)) throw new TypeError('candidateOutputs must not repeat outputId');
    outputIds.add(outputId);
    const memberIds = normalizeList(entry.fixtureIds, `candidateOutputs[${index}].fixtureIds`, { min: 1 });
    memberIds.forEach((fixtureId) => {
      if (!knownFixtures.has(fixtureId)) throw new TypeError(`candidate output references unknown fixtureId: ${fixtureId}`);
    });
    const parentOutputId = opaque(entry.parentOutputId, `candidateOutputs[${index}].parentOutputId`, { nullable: true });
    if (parentOutputId === outputId) throw new TypeError('candidate output cannot parent itself');
    return {
      outputId,
      fixtureIds: memberIds,
      parentOutputId,
      name: label(entry.name, `candidateOutputs[${index}].name`),
    };
  });
  const ids = new Set(outputs.map((entry) => entry.outputId));
  outputs.forEach((entry) => {
    if (entry.parentOutputId && !ids.has(entry.parentOutputId)) {
      throw new TypeError(`candidate output parent does not exist: ${entry.parentOutputId}`);
    }
  });
  return outputs.sort((left, right) => left.outputId.localeCompare(right.outputId));
}

function normalizeNameRubric(input) {
  assertExactKeys(input, NAME_RUBRIC_FIELDS, 'nameRubric');
  const status = enumValue(input.status, 'nameRubric.status', NAME_RUBRIC_STATUSES);
  if (status !== 'scored') {
    if (input.scoreCount !== null || input.median !== null || input.mean !== null || input.exemplarRegression !== null) {
      throw new TypeError('unavailable name rubric values must be null');
    }
    return { status, scoreCount: null, median: null, mean: null, exemplarRegression: null };
  }
  const scoreCount = positiveInteger(input.scoreCount, 'nameRubric.scoreCount');
  const median = finiteNumber(input.median, 'nameRubric.median', { min: 1, max: 5 });
  const mean = finiteNumber(input.mean, 'nameRubric.mean', { min: 1, max: 5 });
  if (typeof input.exemplarRegression !== 'boolean') throw new TypeError('nameRubric.exemplarRegression must be boolean');
  return { status, scoreCount, median, mean, exemplarRegression: input.exemplarRegression };
}

function normalizePrivacyFailures(input) {
  assertExactKeys(input, PRIVACY_FAILURE_FIELDS, 'privacyFailures');
  const status = enumValue(input.status, 'privacyFailures.status', PRIVACY_STATUSES);
  if (status !== 'verified') {
    if (input.count !== null) throw new TypeError('unavailable privacy failure count must be null');
    return { status, count: null };
  }
  return { status, count: nonNegativeInteger(input.count, 'privacyFailures.count') };
}

function normalizeResourceCost(input) {
  assertExactKeys(input, RESOURCE_COST_FIELDS, 'resourceCost');
  const status = enumValue(input.status, 'resourceCost.status', RESOURCE_STATUSES);
  if (status !== 'measured') {
    if (input.wallMs !== null || input.cpuMs !== null || input.maxRssMb !== null || input.modelCalls !== null) {
      throw new TypeError('unavailable resource cost values must be null');
    }
    return { status, wallMs: null, cpuMs: null, maxRssMb: null, modelCalls: null };
  }
  return {
    status,
    wallMs: finiteNumber(input.wallMs, 'resourceCost.wallMs'),
    cpuMs: finiteNumber(input.cpuMs, 'resourceCost.cpuMs'),
    maxRssMb: finiteNumber(input.maxRssMb, 'resourceCost.maxRssMb'),
    modelCalls: nonNegativeInteger(input.modelCalls, 'resourceCost.modelCalls'),
  };
}

function metricRate(numerator, denominator, threshold, {
  higherIsBetter = true,
  numeratorField = 'numerator',
  denominatorField = 'denominator',
} = {}) {
  if (!denominator) return { status: 'not-evaluable', [numeratorField]: null, [denominatorField]: null, rate: null };
  const rate = numerator / denominator;
  const pass = higherIsBetter ? rate >= threshold : rate <= threshold;
  return { status: pass ? 'pass' : 'fail', [numeratorField]: numerator, [denominatorField]: denominator, rate };
}

function metricCount(count, field, { threshold = 0 } = {}) {
  const pass = count <= threshold;
  return { status: pass ? 'pass' : 'fail', count };
}

function notEvaluableMetrics() {
  return {
    replayStability: { status: 'not-evaluable', stable: null },
    knownProjectRecovery: { status: 'not-evaluable', recovered: null, total: null, rate: null },
    parentAccuracy: { status: 'not-evaluable', correct: null, total: null, rate: null },
    criticalFalseMerges: { status: 'not-evaluable', count: null },
    overallFalseMerges: { status: 'not-evaluable', count: null, total: null, rate: null },
    falseSplits: { status: 'not-evaluable', count: null, total: null, rate: null },
  };
}

function metricFailureReasons(metrics, nameRubric, privacyFailures) {
  const reasons = [];
  for (const [field, metric] of Object.entries(metrics)) {
    if (metric.status === 'fail') reasons.push(field);
    if (field === 'replayStability' && metric.status === 'not-evaluable') reasons.push('replay-not-evaluable');
  }
  if (nameRubric.status === 'fail') reasons.push('name-rubric');
  if (nameRubric.status === 'not-evaluable') reasons.push('name-rubric-not-evaluable');
  if (privacyFailures.status === 'fail') reasons.push('privacy-boundary');
  if (privacyFailures.status === 'not-evaluable') reasons.push('privacy-not-evaluable');
  return [...new Set(reasons)].sort();
}

function scoreAvailableArm({ expectedLabels, candidateOutputs, replayCandidateOutputs, nameRubric, privacyFailures, resourceCost }) {
  const expectedByFixture = new Map(expectedLabels.map((labelEntry) => [labelEntry.fixtureId, labelEntry]));
  const projects = new Map();
  expectedLabels.forEach((entry) => {
    if (!projects.has(entry.projectId)) {
      projects.set(entry.projectId, {
        parentProjectId: entry.parentProjectId,
        known: entry.known,
        critical: entry.critical,
      });
    } else {
      const project = projects.get(entry.projectId);
      if (project.parentProjectId !== entry.parentProjectId) throw new TypeError(`project ${entry.projectId} has conflicting expected parents`);
      project.known = project.known || entry.known;
      project.critical = project.critical || entry.critical;
    }
  });

  const outputById = new Map(candidateOutputs.map((entry) => [entry.outputId, entry]));
  const assignments = new Map();
  candidateOutputs.forEach((output) => {
    output.fixtureIds.forEach((fixtureId) => {
      const list = assignments.get(fixtureId) || [];
      list.push(output.outputId);
      assignments.set(fixtureId, list.sort());
    });
  });
  const projectOutputs = new Map();
  for (const [fixtureId, outputIds] of assignments) {
    const expected = expectedByFixture.get(fixtureId);
    const list = projectOutputs.get(expected.projectId) || new Set();
    outputIds.forEach((outputId) => list.add(outputId));
    projectOutputs.set(expected.projectId, list);
  }
  const knownProjects = [...projects.entries()].filter(([, project]) => project.known).sort(([left], [right]) => left.localeCompare(right));
  const recovered = knownProjects.filter(([projectId]) => projectOutputs.has(projectId)).length;
  const knownProjectRecovery = metricRate(recovered, knownProjects.length, THRESHOLDS.knownProjectRecovery, {
    numeratorField: 'recovered', denominatorField: 'total',
  });
  const parentResults = knownProjects.map(([projectId, expectedProject]) => {
    const outputIds = [...(projectOutputs.get(projectId) || [])].sort();
    if (!outputIds.length) return false;
    const primary = outputById.get(outputIds[0]);
    const parentOutput = primary.parentOutputId ? outputById.get(primary.parentOutputId) : null;
    const parentProjects = parentOutput
      ? [...new Set(parentOutput.fixtureIds.map((fixtureId) => expectedByFixture.get(fixtureId).projectId))].sort()
      : [];
    if (expectedProject.parentProjectId === null) return parentProjects.length === 0;
    return parentProjects.length === 1 && parentProjects[0] === expectedProject.parentProjectId;
  });
  const parentAccuracy = metricRate(parentResults.filter(Boolean).length, parentResults.length, THRESHOLDS.parentAccuracy, {
    numeratorField: 'correct', denominatorField: 'total',
  });

  let overallMergeCount = 0;
  let criticalMergeCount = 0;
  for (const output of candidateOutputs) {
    const projectIds = new Set(output.fixtureIds.map((fixtureId) => expectedByFixture.get(fixtureId).projectId));
    if (projectIds.size > 1) {
      overallMergeCount += 1;
      if ([...projectIds].some((projectId) => projects.get(projectId).critical)) criticalMergeCount += 1;
    }
  }
  const criticalFalseMerges = metricCount(criticalMergeCount, 'criticalFalseMerges', { threshold: THRESHOLDS.criticalFalseMerges });
  const overallFalseMerges = metricRate(overallMergeCount, knownProjects.length, THRESHOLDS.overallFalseMergeRate, {
    higherIsBetter: false, numeratorField: 'count', denominatorField: 'total',
  });
  const splitCount = knownProjects.filter(([projectId]) => (projectOutputs.get(projectId) || new Set()).size > 1).length;
  const falseSplits = metricRate(splitCount, knownProjects.length, THRESHOLDS.falseSplitRate, {
    higherIsBetter: false, numeratorField: 'count', denominatorField: 'total',
  });

  const replayStability = replayCandidateOutputs === null
    ? { status: 'not-evaluable', stable: null }
    : (() => {
      const expectedDigest = stableDigest(candidateOutputs);
      const replayDigest = stableDigest(replayCandidateOutputs);
      const stable = expectedDigest === replayDigest;
      return { status: stable ? 'pass' : 'fail', stable };
    })();
  const metrics = { replayStability, knownProjectRecovery, parentAccuracy, criticalFalseMerges, overallFalseMerges, falseSplits };
  const privacyMetric = privacyFailures.status === 'verified'
    ? metricCount(privacyFailures.count, 'privacyFailures', { threshold: THRESHOLDS.privacyFailures })
    : { status: 'not-evaluable', count: null };
  const nameMetric = nameRubric.status === 'scored'
    ? {
      status: nameRubric.median >= THRESHOLDS.nameMedian && !nameRubric.exemplarRegression ? 'pass' : 'fail',
      scoreCount: nameRubric.scoreCount,
      median: nameRubric.median,
      mean: nameRubric.mean,
      exemplarRegression: nameRubric.exemplarRegression,
    }
    : { status: 'not-evaluable', scoreCount: null, median: null, mean: null, exemplarRegression: null };
  const failureReasons = metricFailureReasons(metrics, nameMetric, privacyMetric);
  const notEvaluable = Object.values(metrics).some((metric) => metric.status === 'not-evaluable')
    || nameMetric.status === 'not-evaluable' || privacyMetric.status === 'not-evaluable';
  const qualification = notEvaluable ? 'not-evaluable' : failureReasons.length ? 'fails' : 'qualifies';
  return {
    ...metrics,
    privacyFailures: privacyMetric,
    nameRubric: nameMetric,
    resourceCost,
    qualification,
    failureReasons,
  };
}

function normalizeArmInput(input) {
  rejectPrivateShape(input);
  assertKnownKeys(input, ARM_INPUT_FIELDS, 'evaluation arm');
  const evaluationRevision = opaque(input.evaluationRevision, 'evaluationRevision');
  const engine = normalizeEngine(input.engine);
  if (!Number.isInteger(input.corpusSize) || input.corpusSize < 0) throw new TypeError('corpusSize must be a non-negative integer');
  const expectedLabels = normalizeExpectedLabels(input.expectedLabels);
  const fixtureIds = expectedLabels.map((entry) => entry.fixtureId);
  const candidateOutputs = normalizeCandidateOutputs(input.candidateOutputs, fixtureIds, { nullable: engine.status === 'unavailable' });
  const replayCandidateOutputs = normalizeCandidateOutputs(input.replayCandidateOutputs, fixtureIds, { nullable: engine.status === 'unavailable' });
  const nameRubric = normalizeNameRubric(input.nameRubric);
  const privacyFailures = normalizePrivacyFailures(input.privacyFailures);
  const resourceCost = normalizeResourceCost(input.resourceCost);
  if (engine.status === 'available' && candidateOutputs === null) throw new TypeError('available engine requires candidateOutputs');
  return { evaluationRevision, engine, corpusSize: input.corpusSize, expectedLabels, candidateOutputs, replayCandidateOutputs, nameRubric, privacyFailures, resourceCost };
}

function scoreInferenceArm(input) {
  const normalized = normalizeArmInput(input);
  const { evaluationRevision, engine, corpusSize, expectedLabels, candidateOutputs, replayCandidateOutputs, nameRubric, privacyFailures, resourceCost } = normalized;
  const expectedDigest = stableDigest(expectedLabels);
  const metrics = engine.status === 'unavailable'
    ? {
      ...notEvaluableMetrics(),
      privacyFailures: { status: 'not-evaluable', count: null },
      nameRubric: { status: 'not-evaluable', scoreCount: null, median: null, mean: null, exemplarRegression: null },
      resourceCost: { status: 'not-evaluable', wallMs: null, cpuMs: null, maxRssMb: null, modelCalls: null },
      qualification: 'not-evaluable',
      failureReasons: ['engine-unavailable'],
    }
    : scoreAvailableArm({ expectedLabels, candidateOutputs, replayCandidateOutputs, nameRubric, privacyFailures, resourceCost });
  const receiptWithoutDigest = {
    contract: EVALUATION_CONTRACT,
    evaluationRevision,
    engineId: engine.engineId,
    engineRevision: engine.engineRevision,
    engineStatus: engine.status,
    availabilityReason: engine.reason,
    configDigest: engine.configDigest,
    corpusSize,
    expectedDigest,
    resultDigest: null,
    ...metrics,
    thresholds: THRESHOLDS,
  };
  const resultDigest = stableDigest({
    ...receiptWithoutDigest,
    resultDigest: null,
    candidateOutputs: candidateOutputs || null,
  });
  return { ...receiptWithoutDigest, resultDigest };
}

function validateEvaluationReceipt(input) {
  try {
    rejectPrivateShape(input);
    assertExactKeys(input, RECEIPT_FIELDS, 'evaluation receipt');
    if (input.contract !== EVALUATION_CONTRACT) throw new TypeError('evaluation receipt contract is unsupported');
    if (!QUALIFICATIONS.includes(input.qualification)) throw new TypeError('evaluation receipt qualification is unsupported');
    if (!DIGEST_PATTERN.test(input.resultDigest)) throw new TypeError('evaluation receipt resultDigest must be a sha256 digest');
    if (input.configDigest !== null && !DIGEST_PATTERN.test(input.configDigest)) throw new TypeError('evaluation receipt configDigest must be a sha256 digest or null');
    if (!['available', 'unavailable'].includes(input.engineStatus)) throw new TypeError('evaluation receipt engineStatus is unsupported');
    if (!isPlainObject(input.thresholds) || stableStringify(input.thresholds) !== stableStringify(THRESHOLDS)) {
      throw new TypeError('evaluation receipt thresholds do not match the frozen gate');
    }
    if (!Array.isArray(input.failureReasons) || input.failureReasons.some((reason) => typeof reason !== 'string')) {
      throw new TypeError('evaluation receipt failureReasons must be an array of strings');
    }
    return { ok: true, receipt: clone(input) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function normalizeSelectionOrder(order, engineIds) {
  if (order === undefined || order === null) return [...engineIds].sort((left, right) => left.localeCompare(right));
  const normalized = normalizeList(order, 'selectionOrder', { min: 1 });
  if (normalized.length !== engineIds.length || normalized.some((engineId) => !engineIds.includes(engineId))) {
    throw new TypeError('selectionOrder must contain each arm engineId exactly once');
  }
  return normalized;
}

function selectInferenceEngine(receipts, { evaluationRevision = null, selectionOrder = null } = {}) {
  if (!Array.isArray(receipts) || !receipts.length) {
    return {
      contract: BAKEOFF_CONTRACT,
      evaluationRevision: evaluationRevision === null ? null : opaque(evaluationRevision, 'evaluationRevision'),
      arms: [], decision: 'not-evaluable', selectedEngineId: null,
      selectionDigest: stableDigest({ contract: BAKEOFF_CONTRACT, evaluationRevision, arms: [], decision: 'not-evaluable', selectedEngineId: null }),
    };
  }
  const normalized = receipts.map((receipt, index) => {
    const result = validateEvaluationReceipt(receipt);
    if (!result.ok) throw new TypeError(`arm ${index} is invalid: ${result.error}`);
    return result.receipt;
  });
  const engineIds = normalized.map((receipt) => receipt.engineId);
  if (new Set(engineIds).size !== engineIds.length) throw new TypeError('bakeoff arms must not repeat engineId');
  const revision = evaluationRevision === null ? normalized[0].evaluationRevision : opaque(evaluationRevision, 'evaluationRevision');
  if (normalized.some((receipt) => receipt.evaluationRevision !== revision)) throw new TypeError('bakeoff arms must share evaluationRevision');
  const order = normalizeSelectionOrder(selectionOrder, engineIds);
  const qualifying = new Set(normalized.filter((receipt) => receipt.qualification === 'qualifies').map((receipt) => receipt.engineId));
  const hasNotEvaluable = normalized.some((receipt) => receipt.qualification === 'not-evaluable');
  const decision = qualifying.size
    ? 'selected'
    : hasNotEvaluable ? 'not-evaluable' : 'no-engine';
  const selectedEngineId = decision === 'selected' ? order.find((engineId) => qualifying.has(engineId)) : null;
  const arms = [...normalized].sort((left, right) => left.engineId.localeCompare(right.engineId));
  const base = { contract: BAKEOFF_CONTRACT, evaluationRevision: revision, arms, decision, selectedEngineId };
  return { ...base, selectionDigest: stableDigest(base) };
}

function createBakeoffReceipt({ evaluationRevision, arms, selectionOrder = null } = {}) {
  if (!Array.isArray(arms)) throw new TypeError('arms must be an array');
  const receipts = arms.map((arm) => scoreInferenceArm(arm));
  return selectInferenceEngine(receipts, { evaluationRevision, selectionOrder });
}

module.exports = {
  ARM_INPUT_FIELDS,
  BAKEOFF_CONTRACT,
  BAKEOFF_FIELDS,
  CANDIDATE_OUTPUT_FIELDS,
  DECISIONS,
  ENGINE_FIELDS,
  ENGINE_STATUSES,
  EVALUATION_CONTRACT,
  EXPECTED_LABEL_FIELDS,
  METRIC_STATUSES,
  QUALIFICATIONS,
  RECEIPT_FIELDS,
  THRESHOLDS,
  createBakeoffReceipt,
  scoreInferenceArm,
  selectInferenceEngine,
  stableDigest,
  stableStringify,
  validateEvaluationReceipt,
};
