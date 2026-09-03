'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { validateCapacityPolicy, createCapacityPolicy } = require('../src/policy');

const BASE = {
  version: 'jarvos-storage-janitor.policy.v1',
  policyId: 'policy:default',
  requiredBytes: 1073741824,
  safetyMarginBytes: 104857600,
};

test('accepts a well-formed policy', () => {
  const result = validateCapacityPolicy(BASE);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('rejects a missing policy', () => {
  assert.equal(validateCapacityPolicy(undefined).ok, false);
});

test('rejects a non-opaque policyId', () => {
  const result = validateCapacityPolicy({ ...BASE, policyId: '/resource/example' });
  assert.equal(result.ok, false);
});

test('rejects negative requiredBytes', () => {
  const result = validateCapacityPolicy({ ...BASE, requiredBytes: -1 });
  assert.equal(result.ok, false);
});

test('rejects a zero requiredBytes', () => {
  const result = validateCapacityPolicy({ ...BASE, requiredBytes: 0 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /requiredBytes/.test(e)));
});

test('rejects a non-integer safetyMarginBytes', () => {
  const result = validateCapacityPolicy({ ...BASE, safetyMarginBytes: 1.2 });
  assert.equal(result.ok, false);
});

test('accepts a zero safetyMarginBytes', () => {
  const result = validateCapacityPolicy({ ...BASE, safetyMarginBytes: 0 });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('createCapacityPolicy throws on invalid input', () => {
  assert.throws(() => createCapacityPolicy({ ...BASE, requiredBytes: -1 }));
});

test('createCapacityPolicy normalizes valid input', () => {
  const policy = createCapacityPolicy(BASE);
  assert.equal(policy.policyId, BASE.policyId);
});

test('rejects a policy carrying an unrecognized extra field', () => {
  const result = validateCapacityPolicy({ ...BASE, unexpectedField: 'x' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unexpectedField/.test(e)));
});

test('validateCapacityPolicy fails closed on a cyclic record rather than crashing', () => {
  const cyclic = { ...BASE };
  cyclic.self = cyclic;
  const result = validateCapacityPolicy(cyclic);
  assert.equal(result.ok, false);
});
