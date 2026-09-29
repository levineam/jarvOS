'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  assertStewardshipAdapter,
  STEWARDSHIP_ADAPTER_VERSION,
  classifyLifecyclePresence,
  isPresenceRecorded,
  validateNextTurnInput,
  validatePresenceReport,
  validateStewardshipAdapter,
  withLifecyclePresence,
} = require('../src');

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

test('the portable next-turn contract accepts only a bounded public judgment', () => {
  const input = {
    prompt: 'A recovery window is ready. Which safe next step should be displayed?',
    choices: ['Wait for confirmation', 'Prepare a dry run'],
    default: 'Wait for confirmation',
    correlation: 'judgment-42',
  };
  assert.deepEqual(validateNextTurnInput(input), { ok: true, value: input });
  assert.equal(validateNextTurnInput({
    prompt: 'The prepared public candidate passed its checks. Should jarvOS publish it?',
    choices: ['Keep it prepared', 'Publish the release'],
    default: 'Keep it prepared',
    correlation: 'judgment-publication-42',
  }).ok, true);
});

test('the portable next-turn contract rejects private or route-bearing data', () => {
  const base = {
    prompt: 'A recovery window is ready. Which safe next step should be displayed?',
    choices: ['Wait for confirmation', 'Prepare a dry run'],
    default: 'Wait for confirmation',
    correlation: 'judgment-42',
  };
  for (const input of [
    { ...base, prompt: 'Read /Users/alice/private-router before deciding.' },
    { ...base, prompt: 'Use the api key from the router.' },
    { ...base, prompt: 'Paperclip says this is ready.' },
    { ...base, prompt: 'The raw Agent Mail transcript says this is ready.' },
    { ...base, route: 'private-router' },
    { ...base, correlation: 'secret-judgment-42' },
    { ...base, choices: ['Wait for confirmation', 'Prepare a dry run', 'Escalate', 'Use a local route'] },
  ]) {
    assert.equal(validateNextTurnInput(input).ok, false);
  }
});

test('an admitted session with a recorded presence report is recorded', () => {
  const result = { available: true, pendingInSessionInput: false, presence: { status: 'recorded' } };
  assert.deepEqual(classifyLifecyclePresence(result), { status: 'recorded' });
  assert.equal(isPresenceRecorded(result), true);
  assert.deepEqual(withLifecyclePresence('startOrResume', result).presence, { status: 'recorded' });
});

test('degraded presence keeps the session admitted and names the reason', () => {
  for (const reason of ['coordination_unavailable', 'authentication_unavailable']) {
    const result = { available: true, pendingInSessionInput: false, presence: { status: 'degraded', reason } };
    const classified = withLifecyclePresence('heartbeat', result);
    assert.equal(classified.available, true, 'coordination outage must not withdraw admission');
    assert.deepEqual(classified.presence, { status: 'degraded', reason });
    assert.equal(isPresenceRecorded(classified), false);
  }
});

test('a missing or malformed presence report is never treated as recorded', () => {
  const unreported = { status: 'degraded', reason: 'presence_unreported' };
  for (const presence of [
    undefined,
    null,
    'recorded',
    {},
    { status: 'recorded', extra: true },
    { status: 'degraded' },
    { status: 'degraded', reason: 'presence_unreported' },
    { status: 'degraded', reason: 'anything-else' },
    { status: 'active' },
  ]) {
    const result = { available: true, pendingInSessionInput: false, presence };
    assert.deepEqual(classifyLifecyclePresence(result), unreported, JSON.stringify(presence));
    assert.equal(isPresenceRecorded(result), false);
  }
  assert.deepEqual(classifyLifecyclePresence({ available: true }), unreported);
  assert.equal(validatePresenceReport({ status: 'recorded' }).ok, true);
  assert.equal(validatePresenceReport(undefined).ok, false);
});

test('an unavailable bridge is degraded, and classification never throws', () => {
  const outage = { status: 'degraded', reason: 'coordination_unavailable' };
  assert.deepEqual(classifyLifecyclePresence({ available: false, presence: { status: 'recorded' } }), outage);
  for (const value of [undefined, null, 'x', 7, []]) {
    assert.deepEqual(classifyLifecyclePresence(value), outage);
  }
  const unrelated = { available: true };
  assert.equal(withLifecyclePresence('checkpoint', unrelated), unrelated, 'only start/resume and heartbeat carry presence');
});
