'use strict';

const assert = require('assert');
const test = require('node:test');
const { assertStewardshipAdapter, STEWARDSHIP_ADAPTER_VERSION, validateStewardshipAdapter } = require('../src');

function adapter(overrides = {}) {
  return {
    version: STEWARDSHIP_ADAPTER_VERSION,
    harness: 'example-harness',
    isolationMode: 'native',
    isolatedWorktrees: true,
    startOrResume() {},
    heartbeat() {},
    checkpoint() {},
    stop() {},
    nextTurnInput() {},
    ...overrides,
  };
}

test('an isolated adapter with next-turn input does not require a pre-edit hook', () => {
  const result = validateStewardshipAdapter(adapter());
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(assertStewardshipAdapter(adapter()).isolationMode, 'native');
});

test('a missing required lifecycle capability has one actionable reason', () => {
  const incomplete = adapter();
  delete incomplete.heartbeat;
  const result = validateStewardshipAdapter(incomplete);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['adapter must implement heartbeat']);
});

test('adapter identity is versioned and bounded without a fixed harness enum', () => {
  assert.deepEqual(validateStewardshipAdapter(adapter({ version: 'v0' })).errors, [
    `adapter.version must be ${STEWARDSHIP_ADAPTER_VERSION}`,
  ]);
  assert.deepEqual(validateStewardshipAdapter(adapter({ harness: '/local/harness' })).errors, [
    'adapter.harness must be a bounded identifier',
  ]);
  assert.equal(validateStewardshipAdapter(adapter({ harness: 'new-neutral-host.1' })).ok, true);
});
