'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CONSTRAINED_GENERATION_CONTRACT_VERSION,
  DEFAULT_CONSTRAINED_GENERATION_BACKENDS,
  EFFECTIVE_MODEL_VERIFICATION,
  evaluateConstrainedGeneration,
} = require('../src/index.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'constrained-generation');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

test('OpenClaw-shaped contract fixture conforms without backend admission', () => {
  const recorded = fixture('openclaw-contract-success.json');
  const expected = fixture('openclaw-contract-success.expected.json');
  assert.deepEqual(evaluateConstrainedGeneration(recorded), expected);
  assert.equal(expected.backend.verification, 'claimed-unverified');
  assert.equal(expected.effectiveModelReceipt.verification, EFFECTIVE_MODEL_VERIFICATION);
  assert.equal(expected.admitted, false);
});

test('constrained generation rejects every extracted safety failure from fixture evidence', () => {
  const valid = fixture('openclaw-contract-success.json');
  const cases = [
    ['runtime proof', { runtimeProof: { ...valid.runtimeProof, receiptDigest: 'not-a-digest' } }, 'runtime_proof_invalid'],
    ['unproven runtime proof', { runtimeProof: { ...valid.runtimeProof, status: 'unproven' } }, 'runtime_proof_unproven'],
    ['caller-supplied runtime verification', { runtimeProof: { ...valid.runtimeProof, status: 'verified' } }, 'runtime_proof_untrusted'],
    ['caller-supplied backend verification', { backend: { ...valid.backend, verification: 'verified' } }, 'backend_verification_untrusted'],
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

test('the evaluator exposes only its explicit non-verification disposition', () => {
  const result = evaluateConstrainedGeneration(fixture('openclaw-contract-success.json'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.effectiveModelReceipt, {
    provider: 'openai', model: 'gpt-5.6-luna', verification: 'not-verified-by-jarvos',
  });
  assert.equal(result.admitted, false);
  assert.equal(CONSTRAINED_GENERATION_CONTRACT_VERSION, 'jarvos-constrained-generation/v1');
});

test('the shipped contract starts all candidate backends as claimed-unverified', () => {
  assert.deepEqual(DEFAULT_CONSTRAINED_GENERATION_BACKENDS, [
    { id: 'openclaw', verification: 'claimed-unverified' },
    { id: 'hermes', verification: 'claimed-unverified' },
    { id: 'direct-provider', verification: 'claimed-unverified' },
  ]);
});
