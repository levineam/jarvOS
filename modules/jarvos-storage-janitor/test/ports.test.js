'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  assertCapacityObservationPort,
  assertExternalReclaimPort,
  assertReservationPort,
} = require('../src/ports');

test('a capacity observation port must expose observe()', () => {
  assert.throws(() => assertCapacityObservationPort({}));
  assert.doesNotThrow(() => assertCapacityObservationPort({ observe: () => {} }));
});

test('an external reclaim port must expose proposeDryRun() and execute()', () => {
  assert.throws(() => assertExternalReclaimPort({}));
  assert.throws(() => assertExternalReclaimPort({ proposeDryRun: () => {} }));
  assert.doesNotThrow(() => assertExternalReclaimPort({ proposeDryRun: () => {}, execute: () => {} }));
});

test('a reservation port must expose reserve(), consume(), release(), reap(), and get()', () => {
  assert.throws(() => assertReservationPort({ reserve: () => {} }));
  assert.throws(() => assertReservationPort({
    reserve: () => {}, consume: () => {}, reap: () => {}, get: () => {},
  }));
  assert.doesNotThrow(() => assertReservationPort({
    reserve: () => {}, consume: () => {}, release: () => {}, reap: () => {}, get: () => {},
  }));
});
