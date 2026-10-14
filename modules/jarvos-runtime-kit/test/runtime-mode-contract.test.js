'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  RUNTIME_MODE_CONTRACT_VERSION,
  loadRuntimeModeConfig,
  validateRuntimeModeContract,
} = require('../src/index.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'runtime-modes');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

test('validates declaration-only fixtures for every runtime mode', () => {
  for (const mode of ['none', 'hermes', 'openclaw', 'multi']) {
    const result = validateRuntimeModeContract(fixture(mode));
    assert.equal(result.ok, true, `${mode}: ${result.errors.join('\n')}`);
  }
});

test('rejects two Telegram update consumers before any runtime can be activated', () => {
  const result = validateRuntimeModeContract(fixture('duplicate-telegram-consumers'));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Telegram update consumer/);
});

test('loads existing configs through the additive none compatibility path', () => {
  const result = loadRuntimeModeConfig({ runtime: 'openclaw', runtimeAdapters: { openclaw: { kind: 'openclaw' } } });
  assert.equal(result.ok, true, result.errors?.join('\n'));
  assert.equal(result.source, 'legacy-default');
  assert.deepEqual(result.runtimeMode, {
    version: RUNTIME_MODE_CONTRACT_VERSION,
    mode: 'none', installedAdapters: [], workloadRoutes: [], capabilityTruth: [],
  });
});

test('requires explicit evidence for every declared capability truth', () => {
  const invalid = fixture('hermes');
  invalid.capabilityTruth[0].evidence = [];
  const result = validateRuntimeModeContract(invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /evidence must be a non-empty array/);
});

test('rejects evidence fields outside the shipped schema', () => {
  const invalid = fixture('hermes');
  invalid.capabilityTruth[0].evidence[0].typo = true;
  const result = validateRuntimeModeContract(invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /requires kind and detail/);
});
