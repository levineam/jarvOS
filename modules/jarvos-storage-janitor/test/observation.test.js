'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { validateCapacityObservation, createCapacityObservation } = require('../src/observation');

const BASE = {
  version: 'jarvos-storage-janitor.observation.v1',
  candidateSetId: null,
  observedAt: '2026-09-03T12:00:00.000Z',
  freshUntil: '2026-09-03T12:05:00.000Z',
  bytesAvailable: 627048448,
  bytesTotal: 1000000000000,
};

test('accepts a fresh, internally consistent observation', () => {
  const result = validateCapacityObservation(BASE);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('rejects a missing observation', () => {
  const result = validateCapacityObservation(undefined);
  assert.equal(result.ok, false);
});

test('rejects missing bytesAvailable', () => {
  const { bytesAvailable, ...rest } = BASE;
  const result = validateCapacityObservation(rest);
  assert.equal(result.ok, false);
});

test('rejects a stale observation relative to now', () => {
  const result = validateCapacityObservation(BASE, { now: '2026-09-03T12:10:00.000Z' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /stale|fresh/i.test(e)));
});

test('rejects an observation observed in the future', () => {
  const result = validateCapacityObservation(BASE, { now: '2026-09-03T11:00:00.000Z' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /future/i.test(e)));
});

test('rejects negative bytesAvailable', () => {
  const result = validateCapacityObservation({ ...BASE, bytesAvailable: -1 });
  assert.equal(result.ok, false);
});

test('rejects unsafe-integer bytesAvailable', () => {
  const result = validateCapacityObservation({ ...BASE, bytesAvailable: Number.MAX_SAFE_INTEGER + 10 });
  assert.equal(result.ok, false);
});

test('rejects a non-integer bytesAvailable', () => {
  const result = validateCapacityObservation({ ...BASE, bytesAvailable: 1.5 });
  assert.equal(result.ok, false);
});

test('rejects internally inconsistent bytesAvailable exceeding bytesTotal', () => {
  const result = validateCapacityObservation({ ...BASE, bytesAvailable: BASE.bytesTotal + 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /inconsistent|exceed/i.test(e)));
});

test('rejects freshUntil preceding observedAt', () => {
  const result = validateCapacityObservation({ ...BASE, freshUntil: '2026-09-03T11:59:00.000Z' });
  assert.equal(result.ok, false);
});

test('rejects a zoneless observedAt timestamp', () => {
  const result = validateCapacityObservation({ ...BASE, observedAt: '2026-09-03T12:00:00.000' });
  assert.equal(result.ok, false);
});

test('rejects an offset-relative (non-UTC) freshUntil timestamp', () => {
  const result = validateCapacityObservation({ ...BASE, freshUntil: '2026-09-03T13:05:00.000+01:00' });
  assert.equal(result.ok, false);
});

test('createCapacityObservation throws on invalid input', () => {
  assert.throws(() => createCapacityObservation({ ...BASE, bytesAvailable: -5 }));
});

test('createCapacityObservation normalizes valid input', () => {
  const observation = createCapacityObservation(BASE);
  assert.equal(observation.bytesAvailable, BASE.bytesAvailable);
  assert.equal(observation.version, BASE.version);
});

test('rejects an observation carrying an unrecognized extra field', () => {
  const result = validateCapacityObservation({ ...BASE, unexpectedField: 'x' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unexpectedField/.test(e)));
});

test('validateCapacityObservation fails closed on a cyclic record rather than crashing', () => {
  const cyclic = { ...BASE };
  cyclic.self = cyclic;
  const result = validateCapacityObservation(cyclic);
  assert.equal(result.ok, false);
});
