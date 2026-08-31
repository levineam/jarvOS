'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const controlPlane = require('../src');
const { validateCapabilityLedger } = require('../../../scripts/lib/capability-ledger');
const {
  validateCandidate,
} = require('../../jarvos-secondbrain/packages/jarvos-ambient/src/intent/candidate-contract');

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures/foundation-contracts');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'manifest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateIdentitySet(fixture) {
  const errors = [];
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return ['identity set must be an object'];
  }
  for (const [kind, value] of Object.entries(fixture)) {
    errors.push(...controlPlane.validateIdentity(value, kind).map((error) => `${kind}: ${error}`));
  }
  for (const kind of controlPlane.IDENTITY_KINDS) {
    if (!Object.hasOwn(fixture, kind)) errors.push(`identity set is missing ${kind}`);
  }
  return errors;
}

const VALIDATORS = {
  identity: (fixture) => controlPlane.validateIdentity(fixture),
  'identity-set': validateIdentitySet,
  'capability-ledger': validateCapabilityLedger,
  candidate: validateCandidate,
  'promotion-receipt': controlPlane.validatePromotionReceipt,
};

test('foundation fixture manifest is closed, unique, and data-driven', () => {
  const manifest = readJson(MANIFEST_PATH);
  assert.equal(manifest.schemaVersion, 'jarvos.foundation-fixtures.v1');
  assert.deepEqual(Object.keys(manifest).sort(), ['cases', 'schemaVersion']);
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0);
  const names = new Set();
  const files = new Set();
  for (const entry of manifest.cases) {
    assert.deepEqual(Object.keys(entry).sort(), ['contract', 'file', 'name', 'valid']);
    assert.equal(typeof entry.name, 'string');
    assert.ok(!names.has(entry.name), `duplicate fixture name: ${entry.name}`);
    names.add(entry.name);
    assert.ok(Object.hasOwn(VALIDATORS, entry.contract), `unknown contract: ${entry.contract}`);
    assert.match(entry.file, /^[a-z0-9][a-z0-9.-]*\.json$/);
    assert.ok(!files.has(entry.file), `duplicate fixture file: ${entry.file}`);
    files.add(entry.file);
    assert.equal(typeof entry.valid, 'boolean');
    assert.ok(fs.existsSync(path.join(FIXTURE_DIR, entry.file)), `missing fixture: ${entry.file}`);
  }
});

test('foundation fixtures conform to their expected contract result', async (t) => {
  const manifest = readJson(MANIFEST_PATH);
  for (const entry of manifest.cases) {
    await t.test(entry.name, () => {
      const fixture = readJson(path.join(FIXTURE_DIR, entry.file));
      const errors = VALIDATORS[entry.contract](fixture);
      assert.ok(Array.isArray(errors), `${entry.name} validator must return an error array`);
      if (entry.valid) {
        assert.deepEqual(errors, [], `${entry.name}: ${errors.join('; ')}`);
      } else {
        assert.ok(errors.length > 0, `${entry.name} should fail closed`);
      }
    });
  }
});

test('the tracked capability ledger conforms to the ledger contract', () => {
  const ledger = readJson(path.join(ROOT, 'capability-ledger.json'));
  assert.deepEqual(validateCapabilityLedger(ledger), []);
});

test('control-plane and ambient agree on candidate identity grammar', () => {
  const valid = 'jarvos:candidate:example:c-identity-0001';
  const malformed = [
    'jarvos:candidate:example:has/path',
    'jarvos:candidate:example:percent%20value',
    'JARVOS:candidate:example:uppercase',
    'jarvos:artifact:example:c-identity-0001',
  ];
  assert.deepEqual(controlPlane.validateIdentity(valid, 'candidate'), []);
  const base = readJson(path.join(FIXTURE_DIR, 'candidate-valid-memory.json'));
  assert.deepEqual(validateCandidate({ ...base, candidateId: valid }), []);
  for (const candidateId of malformed) {
    assert.ok(controlPlane.validateIdentity(candidateId, 'candidate').length > 0, candidateId);
    assert.ok(validateCandidate({ ...base, candidateId }).length > 0, candidateId);
  }
});
