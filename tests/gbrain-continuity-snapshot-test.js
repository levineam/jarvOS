'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CONTINUITY_MODULE_ID,
  loadHealthModules,
  modulePath,
} = require('../lib/jarvos-doctor-modules');
const { writeContinuitySnapshot } = require('../scripts/jarvos-gbrain-continuity-snapshot');

const NOW = new Date('2026-08-27T12:00:00.000Z');

function digest(seed) {
  return `sha256:${seed.charCodeAt(0).toString(16).repeat(64).slice(0, 64)}`;
}

function target(name) {
  const receipt = {
    producer: 'jarvos-gbrain', target: name, challengeDigest: digest('c'),
    jarvosRuntimeDigest: digest('j'), gbrainRuntimeDigest: digest('g'),
    logicalBrainDigest: digest('l'), storeDigest: digest('s'), fixtureDigest: digest('f'),
    probeGeneration: 11, observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(), consumed: true,
  };
  return {
    target: name, binaryPresent: true, runtimeVerified: true, runtimeFresh: true,
    nativeRegistered: true, serviceReachable: true, sameBrain: true,
    capabilityProven: true, skillifyProven: name === 'codex', maintenanceBlocked: false,
    backupFresh: true, machineProven: true, probeGeneration: 11,
    observedAt: NOW.toISOString(), validUntil: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
    challengeDigest: digest('c'), jarvosRuntimeDigest: digest('j'), gbrainRuntimeDigest: digest('g'),
    logicalBrainDigest: digest('l'), storeDigest: digest('s'), fixtureDigest: digest('f'), liveTurn: receipt,
  };
}

function snapshot(generation = 11) {
  const value = {
    schema: 'jarvos-health-module-snapshot/v1', moduleId: CONTINUITY_MODULE_ID, generation,
    observedAt: NOW.toISOString(), validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    trust: 'trusted', factsVersion: 'jarvos-gbrain-continuity-facts/v1',
    facts: { producer: 'jarvos-gbrain', targets: ['codex', 'hermes', 'openclaw'].map(target) },
  };
  value.facts.targets.forEach((item) => {
    item.probeGeneration = generation;
    item.liveTurn.probeGeneration = generation;
  });
  return value;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-gbrain-snapshot-'));
  fs.chmodSync(root, 0o700);
  return root;
}

function writeInput(root, value, mode = 0o600) {
  const input = path.join(root, `input-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(input, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(input, mode);
  return input;
}

test('the producer atomically writes a validated snapshot consumed by the existing reducer', () => {
  const workspace = fixture();
  const input = writeInput(workspace, snapshot());
  const result = writeContinuitySnapshot({ workspace, input, now: NOW });
  assert.deepEqual(result, { ok: true, moduleId: CONTINUITY_MODULE_ID, generation: 11 });
  assert.equal(fs.statSync(path.join(workspace, '.jarvos')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(modulePath(workspace, CONTINUITY_MODULE_ID))).mode & 0o777, 0o700);
  assert.equal(fs.statSync(modulePath(workspace, CONTINUITY_MODULE_ID)).mode & 0o777, 0o600);
  const report = loadHealthModules({ workspace, now: NOW, expectedContinuity: true });
  assert.equal(report.modules[0].state, 'healthy');
  assert.ok(report.modules[0].targets.every((item) => item.evidenceState === 'live-turn-proven'));
});

test('the producer rejects unsafe input, invalid fields, and non-monotonic generations', () => {
  const workspace = fixture();
  const unsafe = writeInput(workspace, snapshot(), 0o644);
  assert.throws(() => writeContinuitySnapshot({ workspace, input: unsafe, now: NOW }), /file-unsafe/);

  const invalid = writeInput(workspace, { ...snapshot(), privatePath: '/secret' });
  assert.throws(() => writeContinuitySnapshot({ workspace, input: invalid, now: NOW }), /snapshot-invalid/);

  const first = writeInput(workspace, snapshot(11));
  writeContinuitySnapshot({ workspace, input: first, now: NOW });
  const same = writeInput(workspace, snapshot(11));
  assert.throws(() => writeContinuitySnapshot({ workspace, input: same, now: NOW }), /generation-not-newer/);
});

test('the producer rejects symlinked input and unsafe state directories', () => {
  const workspace = fixture();
  const source = writeInput(workspace, snapshot());
  const link = path.join(workspace, 'input-link.json');
  fs.symlinkSync(source, link);
  assert.throws(() => writeContinuitySnapshot({ workspace, input: link, now: NOW }), /file-unsafe/);

  const unsafeWorkspace = fixture();
  fs.mkdirSync(path.join(unsafeWorkspace, '.jarvos'), { mode: 0o755 });
  fs.chmodSync(path.join(unsafeWorkspace, '.jarvos'), 0o755);
  const input = writeInput(unsafeWorkspace, snapshot());
  assert.throws(() => writeContinuitySnapshot({ workspace: unsafeWorkspace, input, now: NOW }), /directory-unsafe/);
});
