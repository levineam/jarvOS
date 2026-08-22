'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'project-inference');
const CASE_DIR = path.join(FIXTURE_DIR, 'cases');
const BASELINE_CONTRACT = 'jarvos.project-inference-baseline/v1';
const CASE_CONTRACT = 'jarvos.project-inference-case/v1';
const CASE_IDS = [
  'book',
  'portfolio',
  'software',
  'ambiguity',
  'correction-verified',
  'correction-unverified',
  'duplicate',
  'unavailable-source',
  'prompt-injection',
];
const SOURCE_CLASSES = ['note', 'chat', 'execution', 'release', 'stewardship'];
const COVERAGE_STATES = ['fresh', 'stale', 'partial', 'unknown', 'unavailable', 'healthy-empty'];
const OBSERVATION_KEYS = [
  'observationId',
  'evidenceId',
  'sourceClass',
  'occurredAt',
  'observedAt',
  'sourceRevision',
  'sensitivity',
  'coverageState',
  'contentDigest',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalize(value)).digest('hex');
}

function withoutDigest(value, field) {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function loadPack() {
  const manifest = readJson(path.join(FIXTURE_DIR, 'manifest.json'));
  const cases = CASE_IDS.map((caseId) => readJson(path.join(CASE_DIR, `${caseId}.json`)));
  return { manifest, cases };
}

function caseMap(cases) {
  return new Map(cases.map((caseData) => [caseData.caseId, caseData]));
}

function emptyStateCounts() {
  return Object.fromEntries(COVERAGE_STATES.map((state) => [state, 0]));
}

function expectedCoverage(cases) {
  const byState = emptyStateCounts();
  const bySourceClass = Object.fromEntries(SOURCE_CLASSES.map((sourceClass) => [sourceClass, emptyStateCounts()]));
  for (const caseData of cases) {
    for (const coverage of caseData.coverage) {
      byState[coverage.state] += 1;
      bySourceClass[coverage.sourceClass][coverage.state] += 1;
    }
  }
  return { byState, bySourceClass };
}

function fixtureSnapshot() {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else files.push([entryPath, sha256(fs.readFileSync(entryPath, 'utf8'))]);
    }
  }
  visit(FIXTURE_DIR);
  return files;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, (key, child) => visit(`${index}.${key}`, child)));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
}

test('baseline manifest and case index freeze a versioned evaluation pack', () => {
  const { manifest, cases } = loadPack();
  assert.equal(manifest.contract, BASELINE_CONTRACT);
  assert.equal(manifest.engineRevision, null);
  assert.equal(manifest.caseCount, CASE_IDS.length);
  assert.deepEqual(manifest.caseIndex.map((entry) => entry.caseId), CASE_IDS);
  assert.equal(manifest.caseIndex.length, CASE_IDS.length);

  const byId = caseMap(cases);
  const actualCaseIds = [...byId.keys()];
  assert.deepEqual(actualCaseIds, CASE_IDS);
  for (const entry of manifest.caseIndex) {
    const caseData = byId.get(entry.caseId);
    assert.equal(entry.observationCount, caseData.observations.length);
    assert.equal(entry.contentDigest, caseData.contentDigest);
  }

  assert.equal(manifest.stableDigest, sha256(withoutDigest(manifest, 'stableDigest')));
  assert.deepEqual(manifest.coverage, expectedCoverage(cases));
});
test('each case uses the public portable observation shape and stable content digest', () => {
  const { cases } = loadPack();
  assert.deepEqual(cases.map((caseData) => caseData.caseId), CASE_IDS);

  for (const caseData of cases) {
    assert.equal(caseData.contract, CASE_CONTRACT);
    assert.equal(caseData.engineRevision, null);
    assert.equal(caseData.contentDigest, sha256(withoutDigest(caseData, 'contentDigest')));
    assert.ok(Array.isArray(caseData.coverage));

    const coverageByClass = new Map();
    for (const coverage of caseData.coverage) {
      assert.deepEqual(Object.keys(coverage).sort(), ['sourceClass', 'state']);
      assert.ok(SOURCE_CLASSES.includes(coverage.sourceClass));
      assert.ok(COVERAGE_STATES.includes(coverage.state));
      assert.equal(coverageByClass.has(coverage.sourceClass), false);
      coverageByClass.set(coverage.sourceClass, coverage.state);
    }

    for (const observation of caseData.observations) {
      assert.deepEqual(Object.keys(observation).sort(), [...OBSERVATION_KEYS].sort());
      assert.match(observation.observationId, /^obs_[a-z0-9_]+$/);
      assert.match(observation.evidenceId, /^ev_[a-z0-9_]+$/);
      assert.ok(SOURCE_CLASSES.includes(observation.sourceClass));
      assert.match(observation.occurredAt, /^2026-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ$/);
      assert.match(observation.observedAt, /^2026-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ$/);
      assert.equal(Number.isNaN(Date.parse(observation.occurredAt)), false);
      assert.equal(Number.isNaN(Date.parse(observation.observedAt)), false);
      assert.match(observation.sourceRevision, /^fixture-[a-z-]+-r\d+$/);
      assert.equal(observation.sensitivity, 'public-fixture');
      assert.equal(observation.coverageState, coverageByClass.get(observation.sourceClass));
      assert.match(observation.contentDigest, /^[a-f0-9]{64}$/);
    }
  }
});

test('the nine cases cover happy paths, ambiguity, corrections, duplicates, outage, and rejected input', () => {
  const { cases } = loadPack();
  const byId = caseMap(cases);

  assert.equal(byId.get('book').expected.canonicalName, 'Swarm Theory Book');
  assert.equal(byId.get('book').expected.kind, 'project');
  assert.equal(byId.get('portfolio').expected.canonicalName, 'Amazing Abundance Portfolio');
  assert.deepEqual(byId.get('portfolio').expected.aliases, ['AAF', 'Amazing Abundance Fund', 'AAF Observatory']);
  assert.equal(byId.get('software').expected.canonicalName, 'jarvOS');
  assert.equal(byId.get('ambiguity').expected.decision, 'quarantine');
  assert.deepEqual(byId.get('ambiguity').expected.alternatives, ['jarvOS', 'Proof of Value']);
  assert.equal(byId.get('unavailable-source').expected.decision, 'not-evaluable');
  assert.equal(byId.get('unavailable-source').expected.negativeEvidenceAllowed, false);
  assert.equal(byId.get('prompt-injection').expected.accepted, false);
  assert.equal(byId.get('prompt-injection').expected.behavior, 'rejected-raw');
});

test('manifest counts unique observations and source classes without double-counting the duplicate case', () => {
  const { manifest, cases } = loadPack();
  const observations = cases.flatMap((caseData) => caseData.observations);
  const byObservationId = new Map();
  for (const observation of observations) {
    const prior = byObservationId.get(observation.observationId);
    if (prior) assert.deepEqual(observation, prior);
    byObservationId.set(observation.observationId, observation);
  }

  assert.equal(observations.length, 14);
  assert.equal(manifest.corpusObservationCount, byObservationId.size);
  assert.equal(manifest.corpusObservationCount, observations.length - 1);
  assert.deepEqual(manifest.uniqueSourceClassCounts, {
    note: 3,
    chat: 4,
    execution: 2,
    release: 2,
    stewardship: 2,
  });

  const duplicate = cases.find((caseData) => caseData.caseId === 'duplicate');
  assert.equal(duplicate.observations.length, 1);
  assert.equal(duplicate.observations[0].observationId, 'obs_public_book_note_001');
  assert.equal(duplicate.expected.decision, 'deduplicate');
});

test('verified and unverified corrections remain structurally distinct', () => {
  const { cases } = loadPack();
  const verified = cases.find((caseData) => caseData.caseId === 'correction-verified');
  const unverified = cases.find((caseData) => caseData.caseId === 'correction-unverified');

  assert.equal(verified.correction.operation, 'rename');
  assert.equal(verified.correction.targetAlias, 'AAF Observatory');
  assert.equal(verified.correction.assertedCanonicalName, 'Amazing Abundance Portfolio');
  assert.equal(verified.correction.attestation.status, 'verified');
  assert.equal(verified.expected.mutationAllowed, true);

  assert.deepEqual(unverified.correction.operation, verified.correction.operation);
  assert.deepEqual(unverified.correction.targetAlias, verified.correction.targetAlias);
  assert.equal(unverified.correction.attestation.status, 'unverified');
  assert.equal(unverified.expected.mutationAllowed, false);
  assert.notEqual(verified.correction.attestation.status, unverified.correction.attestation.status);
});

test('fixtures contain no private or raw-source fields and do not import or mutate production code', () => {
  const before = fixtureSnapshot();
  const pack = loadPack();
  const after = fixtureSnapshot();
  assert.deepEqual(after, before);

  const forbiddenKey = /(?:absolute|credential|diff|embedding|password|path|private|prompt|raw|secret|token|transcript)/i;
  const absolutePath = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
  walk(pack, (key, value) => {
    assert.doesNotMatch(key, forbiddenKey, `forbidden portable field: ${key}`);
    if (typeof value === 'string') assert.doesNotMatch(value, absolutePath, `absolute path leaked: ${value}`);
  });

  const productionRoot = `${path.sep}modules${path.sep}jarvos-secondbrain${path.sep}packages${path.sep}jarvos-secondbrain-projects${path.sep}src${path.sep}`;
  const loadedProductionModules = Object.keys(require.cache).filter((modulePath) => modulePath.includes(productionRoot));
  assert.deepEqual(loadedProductionModules, []);
});
