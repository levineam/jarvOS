'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CONSTRAINED_GENERATION_CONTRACT_VERSION,
  DEFAULT_CONSTRAINED_GENERATION_BACKENDS,
  evaluateConstrainedGeneration,
} = require('../src/index.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'constrained-generation');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

test('recorded OpenClaw fixture preserves constrained-generation golden parity without backend admission', () => {
  const recorded = fixture('openclaw-recorded-success.json');
  const golden = fixture('openclaw-recorded-success.golden.json');
  assert.deepEqual(evaluateConstrainedGeneration(recorded), golden);
  assert.equal(golden.backend.verification, 'claimed-unverified');
  assert.equal(golden.effectiveModelReceipt.verified, false);
  assert.equal(golden.admitted, false);
});

test('constrained generation rejects every extracted safety failure from recorded evidence', () => {
  const valid = fixture('openclaw-recorded-success.json');
  const cases = [
    ['runtime proof', { runtimeProof: { ...valid.runtimeProof, receiptDigest: 'not-a-digest' } }, 'runtime_proof_invalid'],
    ['model mismatch', { observed: { ...valid.observed, model: 'gpt-5.6-sol' } }, 'effective_model_mismatch'],
    ['tool activity', { observed: { ...valid.observed, toolCallCount: 1 } }, 'tool_activity_detected'],
    ['fallback flag', { observed: { ...valid.observed, fallbackUsed: true } }, 'fallback_detected'],
    ['attempt rotation', { observed: { ...valid.observed, attempts: [{ provider: 'openai', model: 'gpt-5.6-sol' }] } }, 'fallback_detected'],
    ['usage absent', { observed: { ...valid.observed, usage: {} } }, 'observed_invalid'],
    ['delivery', { observed: { ...valid.observed, delivered: true } }, 'delivery_activity_detected'],
  ];
  for (const [label, change, reasonCode] of cases) {
    assert.deepEqual(evaluateConstrainedGeneration({ ...valid, ...change }), { ok: false, reasonCode }, label);
  }
});

test('an externally supplied verified claim cannot admit a backend through this extraction contract', () => {
  const recorded = fixture('openclaw-recorded-success.json');
  const backendOnly = evaluateConstrainedGeneration({ ...recorded, backend: { ...recorded.backend, verification: 'verified' } });
  assert.equal(backendOnly.ok, true);
  assert.equal(backendOnly.effectiveModelReceipt.verified, false);
  assert.equal(backendOnly.admitted, false);

  const claimedVerified = evaluateConstrainedGeneration({
    ...recorded,
    backend: { ...recorded.backend, verification: 'verified' },
    runtimeProof: { ...recorded.runtimeProof, status: 'verified' },
  });
  assert.equal(claimedVerified.ok, true);
  assert.equal(claimedVerified.effectiveModelReceipt.verified, false);
  assert.equal(claimedVerified.admitted, false);
  assert.equal(CONSTRAINED_GENERATION_CONTRACT_VERSION, 'jarvos-constrained-generation/v1');
});

test('the shipped contract starts all candidate backends as claimed-unverified', () => {
  assert.deepEqual(DEFAULT_CONSTRAINED_GENERATION_BACKENDS, [
    { id: 'openclaw', verification: 'claimed-unverified' },
    { id: 'hermes', verification: 'claimed-unverified' },
    { id: 'direct-provider', verification: 'claimed-unverified' },
  ]);
});
