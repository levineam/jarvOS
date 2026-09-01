'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const {
  HARNESS_CONFORMANCE_TIERS,
  HARNESS_CONFORMANCE_VERSION,
  validateHarnessConformanceRegistry,
  validateRuntimeModeContract,
} = require('../src/index.js');
const { validateConfigShape } = require('../../../lib/jarvos-cli.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const digest = 'a'.repeat(64);

function proactiveRuntimeMode(facts) {
  return {
    version: 'jarvos-runtime-mode/v1',
    mode: 'multi',
    installedAdapters: [{ id: 'hermes' }, { id: 'openclaw' }],
    workloadRoutes: [{ workload: 'telegram.proactive-delivery', adapter: 'openclaw' }],
    capabilityTruth: [],
    conformanceFacts: { version: HARNESS_CONFORMANCE_VERSION, facts },
  };
}

test('ships the same four-tier claimed-unverified contract for Hermes and OpenClaw', () => {
  for (const harness of ['hermes', 'openclaw']) {
    const adapter = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', harness, 'adapter.json'), 'utf8'));
    const result = validateHarnessConformanceRegistry(adapter.harnessConformance);
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(adapter.harnessConformance.facts.map((fact) => fact.tier), HARNESS_CONFORMANCE_TIERS);
    assert.ok(adapter.harnessConformance.facts.every((fact) => fact.harness === harness && fact.state === 'claimed-unverified'));
  }
});

test('rejects proactive Telegram routing without verified exact installed-tuple evidence', () => {
  const noProof = validateRuntimeModeContract(proactiveRuntimeMode([
    { harness: 'openclaw', tier: 'proactive-authority', state: 'claimed-unverified', evidence: [{ kind: 'hook', detail: 'a hook exists' }] },
  ]));
  assert.equal(noProof.ok, false);
  assert.match(noProof.errors.join('\n'), /verified proactive-authority/);

  const missingTuple = validateRuntimeModeContract(proactiveRuntimeMode([
    { harness: 'openclaw', tier: 'proactive-authority', state: 'verified', evidence: [{ kind: 'hook', detail: 'a hook exists' }] },
  ]));
  assert.equal(missingTuple.ok, false);
  assert.match(missingTuple.errors.join('\n'), /installedTuple/);
});

test('admits a proactive route only when its verified fact binds the exact installed tuple', () => {
  const runtimeMode = proactiveRuntimeMode([
    {
      harness: 'openclaw', tier: 'proactive-authority', state: 'verified',
      evidence: [{ kind: 'owner-local-proof', detail: 'fixture only; no live probe was run' }],
      installedTuple: { harness: 'openclaw', runtimeVersion: '2026.9.0', assetDigest: digest },
    },
  ]);
  const result = validateRuntimeModeContract(runtimeMode);
  assert.equal(result.ok, true, result.errors.join('\n'));
  const schemaErrors = validateConfigShape({
    assistantName: 'Jarvis', userName: 'User', coachName: 'Coach',
    vaultPath: '/tmp/vault', workspacePath: '/tmp/workspace', runtime: 'multi', runtimeMode,
  });
  assert.deepEqual(schemaErrors, []);
});

test('rejects duplicate harness-tier registry facts', () => {
  const result = validateHarnessConformanceRegistry({
    version: HARNESS_CONFORMANCE_VERSION,
    facts: [
      { harness: 'hermes', tier: 'baseline-context', state: 'claimed-unverified', evidence: [{ kind: 'declaration', detail: 'first' }] },
      { harness: 'hermes', tier: 'baseline-context', state: 'claimed-unverified', evidence: [{ kind: 'declaration', detail: 'second' }] },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate harness\/tier/);
});
