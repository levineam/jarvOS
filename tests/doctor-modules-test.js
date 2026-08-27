'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HEALTH_MODULE_DIRECTORY,
  CONTINUITY_MODULE_ID,
  PUBLIC_MODULE_ID,
  loadHealthModules,
  modulePath,
} = require('../lib/jarvos-doctor-modules');

const NOW = new Date('2026-08-13T12:00:00.000Z');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-doctor-module-'));
  fs.mkdirSync(path.join(root, HEALTH_MODULE_DIRECTORY), { recursive: true, mode: 0o700 });
  return root;
}

function writeSnapshot(root, snapshot, { mode = 0o600, moduleId = snapshot.moduleId } = {}) {
  const filePath = path.join(root, HEALTH_MODULE_DIRECTORY, `${moduleId}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  fs.chmodSync(filePath, mode);
  return filePath;
}

function digest(seed) {
  return `sha256:${seed.charCodeAt(0).toString(16).repeat(64).slice(0, 64)}`;
}

function liveTurn(target, overrides = {}) {
  return {
    producer: 'jarvos-gbrain',
    target,
    challengeDigest: digest('c'),
    jarvosRuntimeDigest: digest('j'),
    gbrainRuntimeDigest: digest('g'),
    logicalBrainDigest: digest('l'),
    storeDigest: digest('s'),
    fixtureDigest: digest('f'),
    probeGeneration: 9,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
    consumed: true,
    ...overrides,
  };
}

function continuityTarget(target, overrides = {}) {
  return {
    target,
    binaryPresent: true,
    runtimeVerified: true,
    runtimeFresh: true,
    nativeRegistered: true,
    serviceReachable: true,
    sameBrain: true,
    capabilityProven: true,
    skillifyProven: target === 'codex',
    maintenanceBlocked: false,
    backupFresh: true,
    machineProven: true,
    probeGeneration: 9,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
    challengeDigest: digest('c'),
    jarvosRuntimeDigest: digest('j'),
    gbrainRuntimeDigest: digest('g'),
    logicalBrainDigest: digest('l'),
    storeDigest: digest('s'),
    fixtureDigest: digest('f'),
    liveTurn: liveTurn(target),
    ...overrides,
  };
}

function continuitySnapshot(overrides = {}) {
  return {
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: CONTINUITY_MODULE_ID,
    generation: 9,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    trust: 'trusted',
    factsVersion: 'jarvos-gbrain-continuity-facts/v1',
    facts: {
      producer: 'jarvos-gbrain',
      targets: [
        continuityTarget('codex'),
        continuityTarget('hermes'),
        continuityTarget('openclaw'),
      ],
    },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: PUBLIC_MODULE_ID,
    generation: 7,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    trust: 'trusted',
    repairable: false,
    updateAvailable: false,
    ...overrides,
  };
}

test('a missing optional Memory module is absent rather than a failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-doctor-module-'));
  const report = loadHealthModules({ workspace: root, now: NOW });
  assert.deepEqual(report.modules, []);
  assert.deepEqual(report.issues, []);
});

test('missing continuity evidence is visible only when the private profile requires it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-doctor-module-'));
  const optional = loadHealthModules({ workspace: root, now: NOW });
  assert.deepEqual(optional.modules, []);

  const required = loadHealthModules({ workspace: root, now: NOW, expectedContinuity: true });
  assert.deepEqual(required.issues, ['continuity-evidence-missing']);
  assert.equal(required.modules[0].id, CONTINUITY_MODULE_ID);
  assert.equal(required.modules[0].state, 'needs your attention');
  assert.equal(required.modules[0].reasonClass, 'continuity-evidence-missing');
  assert.deepEqual(required.modules[0].targets.map((target) => target.target), ['codex', 'hermes', 'openclaw']);
  assert.ok(required.modules[0].targets.every((target) => target.evidenceState === 'stale-probe'));
  assert.doesNotMatch(JSON.stringify(required), /Users\/|jarvos-doctor-module-/);
});

test('a required continuity snapshot remains visible when another optional module is present', () => {
  const root = workspace();
  writeSnapshot(root, snapshot());
  const report = loadHealthModules({ workspace: root, now: NOW, expectedContinuity: true });
  assert.deepEqual(report.modules.map((module) => module.id), ['memory', 'gbrain-continuity']);
  assert.equal(report.modules[1].reasonClass, 'continuity-evidence-missing');
});

test('the reducer exposes healthy, update available, repair needed, and needs your attention', () => {
  const cases = [
    [{}, 'healthy'],
    [{ updateAvailable: true }, 'update available'],
    [{ repairable: true }, 'repair needed'],
    [{ trust: 'untrusted' }, 'needs your attention'],
  ];

  for (const [overrides, expected] of cases) {
    const root = workspace();
    writeSnapshot(root, snapshot(overrides));
    const report = loadHealthModules({ workspace: root, now: NOW });
    assert.equal(report.modules[0].id, PUBLIC_MODULE_ID);
    assert.equal(report.modules[0].state, expected);
  }
});

test('repair needed has precedence over update available', () => {
  const root = workspace();
  writeSnapshot(root, snapshot({ repairable: true, updateAvailable: true }));
  const report = loadHealthModules({ workspace: root, now: NOW });
  assert.equal(report.modules[0].state, 'repair needed');
});

test('stale, malformed, symlinked, and disallowed snapshots fail closed without exposing paths', () => {
  const staleRoot = workspace();
  writeSnapshot(staleRoot, snapshot({ validUntil: new Date(NOW.getTime() - 1).toISOString() }));
  assert.equal(loadHealthModules({ workspace: staleRoot, now: NOW }).modules[0].state, 'needs your attention');

  const malformedRoot = workspace();
  const malformedPath = path.join(malformedRoot, HEALTH_MODULE_DIRECTORY, `${PUBLIC_MODULE_ID}.json`);
  fs.writeFileSync(malformedPath, '{not-json\n', 'utf8');
  fs.chmodSync(malformedPath, 0o600);
  const malformed = loadHealthModules({ workspace: malformedRoot, now: NOW });
  assert.equal(malformed.modules[0].state, 'needs your attention');
  assert.doesNotMatch(JSON.stringify(malformed), /malformedPath|jarvos-doctor-module-/);

  const symlinkRoot = workspace();
  const target = path.join(symlinkRoot, 'outside.json');
  fs.writeFileSync(target, `${JSON.stringify(snapshot())}\n`, 'utf8');
  fs.chmodSync(target, 0o600);
  fs.symlinkSync(target, path.join(symlinkRoot, HEALTH_MODULE_DIRECTORY, `${PUBLIC_MODULE_ID}.json`));
  assert.equal(loadHealthModules({ workspace: symlinkRoot, now: NOW }).modules[0].state, 'needs your attention');

  const extraFieldRoot = workspace();
  writeSnapshot(extraFieldRoot, snapshot({ stagePath: '/private/stage' }));
  const extraField = loadHealthModules({ workspace: extraFieldRoot, now: NOW });
  assert.equal(extraField.modules[0].state, 'needs your attention');
  assert.doesNotMatch(JSON.stringify(extraField), /\/private\/stage/);
});

test('the public module ID is fixed and cannot inherit a legacy durable identifier', () => {
  const root = workspace();
  writeSnapshot(root, snapshot({ moduleId: 'memory-stack-doctor' }), { moduleId: PUBLIC_MODULE_ID });
  const report = loadHealthModules({ workspace: root, now: NOW });
  assert.equal(PUBLIC_MODULE_ID, 'memory');
  assert.equal(report.modules[0].id, 'memory');
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.doesNotMatch(JSON.stringify(report), /memory-stack-doctor/);
});

test('two readers receive the same public result for one accepted generation', () => {
  const root = workspace();
  writeSnapshot(root, snapshot());
  const first = loadHealthModules({ workspace: root, now: NOW });
  const second = loadHealthModules({ workspace: root, now: NOW });
  assert.deepEqual(first.modules, second.modules);
  assert.deepEqual(first.modules[0], {
    id: 'memory',
    state: 'healthy',
    generation: 7,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    reasonClass: 'none',
  });
});

test('the closed allowlist loads Memory and continuity in stable order and ignores unknown files', () => {
  const root = workspace();
  writeSnapshot(root, continuitySnapshot());
  writeSnapshot(root, snapshot());
  const unknown = path.join(root, HEALTH_MODULE_DIRECTORY, 'not-a-module.json');
  fs.writeFileSync(unknown, `${JSON.stringify({ privatePath: '/do/not/show' })}\n`, 'utf8');
  fs.chmodSync(unknown, 0o600);

  const report = loadHealthModules({ workspace: root, now: NOW });
  assert.deepEqual(report.modules.map((module) => module.id), ['memory', 'gbrain-continuity']);
  assert.equal(report.modules[1].targets.length, 3);
  assert.doesNotMatch(JSON.stringify(report), /do\/not\/show/);
});

test('modulePath rejects unknown and traversal module IDs', () => {
  const root = workspace();
  assert.throws(() => modulePath(root, 'unknown'), /unsupported health module/);
  assert.throws(() => modulePath(root, '../gbrain-continuity'), /unsupported health module/);
  assert.match(modulePath(root, CONTINUITY_MODULE_ID), /gbrain-continuity\.json$/);
});

test('continuity reduction reports independent ordered evidence per expected harness', () => {
  const root = workspace();
  writeSnapshot(root, continuitySnapshot({
    facts: {
      producer: 'jarvos-gbrain',
      targets: [
        continuityTarget('codex', { binaryPresent: false }),
        continuityTarget('hermes', { serviceReachable: false }),
        continuityTarget('openclaw', { sameBrain: false }),
      ],
    },
  }));

  const report = loadHealthModules({ workspace: root, now: NOW });
  assert.deepEqual(report.modules[0], {
    id: 'gbrain-continuity',
    state: 'needs your attention',
    generation: 9,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    reasonClass: 'continuity-incomplete',
    targets: [
      { target: 'codex', evidenceState: 'absent', generation: 9, observedAt: NOW.toISOString(), validUntil: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(), reasonClass: 'binary-absent', jarvosRuntimeDigest: digest('j'), gbrainRuntimeDigest: digest('g'), logicalBrainDigest: digest('l'), storeDigest: digest('s'), fixtureDigest: digest('f') },
      { target: 'hermes', evidenceState: 'unreachable', generation: 9, observedAt: NOW.toISOString(), validUntil: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(), reasonClass: 'service-unreachable', jarvosRuntimeDigest: digest('j'), gbrainRuntimeDigest: digest('g'), logicalBrainDigest: digest('l'), storeDigest: digest('s'), fixtureDigest: digest('f') },
      { target: 'openclaw', evidenceState: 'wrong-brain', generation: 9, observedAt: NOW.toISOString(), validUntil: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(), reasonClass: 'brain-mismatch', jarvosRuntimeDigest: digest('j'), gbrainRuntimeDigest: digest('g'), logicalBrainDigest: digest('l'), storeDigest: digest('s'), fixtureDigest: digest('f') },
    ],
  });
});

test('different cross-harness identity tuples cannot report shared continuity', () => {
  const root = workspace();
  writeSnapshot(root, continuitySnapshot({
    facts: {
      producer: 'jarvos-gbrain',
      targets: [
        continuityTarget('codex'),
        continuityTarget('hermes', {
          storeDigest: digest('x'),
          liveTurn: liveTurn('hermes', { storeDigest: digest('x') }),
        }),
        continuityTarget('openclaw'),
      ],
    },
  }));
  const report = loadHealthModules({ workspace: root, now: NOW });
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.ok(report.modules[0].targets.every((target) => target.evidenceState === 'wrong-brain'));
  assert.ok(report.modules[0].targets.every((target) => target.reasonClass === 'cross-harness-tuple-mismatch'));
});

test('lower continuity evidence accepts null tuple fields but cannot become machine or live proven', () => {
  const root = workspace();
  const noEvidence = {
    challengeDigest: null,
    jarvosRuntimeDigest: null,
    gbrainRuntimeDigest: null,
    logicalBrainDigest: null,
    storeDigest: null,
    fixtureDigest: null,
    liveTurn: null,
  };
  writeSnapshot(root, continuitySnapshot({
    facts: {
      producer: 'jarvos-gbrain',
      targets: [
        continuityTarget('codex', { binaryPresent: false, ...noEvidence }),
        continuityTarget('hermes'),
        continuityTarget('openclaw'),
      ],
    },
  }));
  const target = loadHealthModules({ workspace: root, now: NOW }).modules[0].targets[0];
  assert.equal(target.evidenceState, 'absent');
  assert.equal(target.jarvosRuntimeDigest, null);
  assert.equal(target.fixtureDigest, null);
});

test('installed binary cannot imply continuity health and maintenance or backup gates precede machine proof', () => {
  const cases = [
    [{ runtimeVerified: false }, 'unsafe-runtime'],
    [{ nativeRegistered: false }, 'unregistered'],
    [{ capabilityProven: false }, 'missing-capability'],
    [{ skillifyProven: false }, 'missing-capability'],
    [{ observedAt: new Date(NOW.getTime() - 31 * 60 * 1000).toISOString(), validUntil: new Date(NOW.getTime() - 1).toISOString() }, 'stale-probe'],
    [{ maintenanceBlocked: true }, 'maintenance-blocked'],
    [{ backupFresh: false }, 'backup-stale'],
    [{ machineProven: false }, 'stale-probe'],
    [{ liveTurn: null }, 'machine-proven'],
  ];

  for (const [overrides, state] of cases) {
    const root = workspace();
    writeSnapshot(root, continuitySnapshot({
      facts: {
        producer: 'jarvos-gbrain',
        targets: [continuityTarget('codex', overrides), continuityTarget('hermes'), continuityTarget('openclaw')],
      },
    }));
    const report = loadHealthModules({ workspace: root, now: NOW });
    assert.equal(report.modules[0].targets[0].evidenceState, state);
  }
});

test('continuity live-turn proof is tuple-bound, fresh, single-use, and producer-trusted', () => {
  const cases = [
    [{ producer: 'unknown' }, 'machine-proven'],
    [{ target: 'hermes' }, 'machine-proven'],
    [{ observedAt: new Date(NOW.getTime() - 31 * 60 * 1000).toISOString() }, 'machine-proven'],
    [{ observedAt: new Date(NOW.getTime() + 1).toISOString() }, 'machine-proven'],
    [{ consumed: false }, 'machine-proven'],
    [{ jarvosRuntimeDigest: digest('x') }, 'machine-proven'],
    [{ logicalBrainDigest: digest('x') }, 'machine-proven'],
    [{ fixtureDigest: digest('x') }, 'machine-proven'],
    [{ probeGeneration: 8 }, 'machine-proven'],
    [{}, 'machine-proven', { probeGeneration: 8, liveTurn: liveTurn('codex', { probeGeneration: 8 }) }],
  ];

  for (const [receiptOverrides, expected, targetOverrides = {}] of cases) {
    const root = workspace();
    writeSnapshot(root, continuitySnapshot({
      facts: {
        producer: 'jarvos-gbrain',
        targets: [continuityTarget('codex', { liveTurn: liveTurn('codex', receiptOverrides), ...targetOverrides }), continuityTarget('hermes'), continuityTarget('openclaw')],
      },
    }));
    const report = loadHealthModules({ workspace: root, now: NOW });
    assert.equal(report.modules[0].targets[0].evidenceState, expected);
  }
});

test('continuity is exact-schema, owner-only, and private fact data cannot leak', () => {
  const invalidCases = [
    continuitySnapshot({ repairable: false }),
    continuitySnapshot({ facts: { producer: 'jarvos-gbrain', targets: [continuityTarget('codex'), continuityTarget('hermes'), continuityTarget('openclaw')], privateUrl: 'postgres://private.example/brain' } }),
    continuitySnapshot({ facts: { producer: 'jarvos-gbrain', targets: [continuityTarget('codex', { command: 'gbrain --secret password' }), continuityTarget('hermes'), continuityTarget('openclaw')] } }),
  ];
  for (const invalid of invalidCases) {
    const root = workspace();
    writeSnapshot(root, invalid);
    const report = loadHealthModules({ workspace: root, now: NOW });
    assert.equal(report.modules[0].state, 'needs your attention');
    assert.doesNotMatch(JSON.stringify(report), /postgres:|password|private\.example/);
  }

  const modeRoot = workspace();
  writeSnapshot(modeRoot, continuitySnapshot(), { mode: 0o644 });
  assert.equal(loadHealthModules({ workspace: modeRoot, now: NOW }).modules[0].state, 'needs your attention');

  const symlinkRoot = workspace();
  const target = path.join(symlinkRoot, 'continuity-private.json');
  fs.writeFileSync(target, `${JSON.stringify(continuitySnapshot())}\n`, 'utf8');
  fs.chmodSync(target, 0o600);
  fs.symlinkSync(target, path.join(symlinkRoot, HEALTH_MODULE_DIRECTORY, 'gbrain-continuity.json'));
  assert.equal(loadHealthModules({ workspace: symlinkRoot, now: NOW }).modules[0].state, 'needs your attention');
});

test('a present untrusted or stale continuity snapshot fails closed as that module', () => {
  const untrustedRoot = workspace();
  writeSnapshot(untrustedRoot, continuitySnapshot({ trust: 'untrusted' }));
  const untrusted = loadHealthModules({ workspace: untrustedRoot, now: NOW }).modules[0];
  assert.deepEqual(untrusted, {
    id: 'gbrain-continuity',
    state: 'needs your attention',
    generation: 9,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    reasonClass: 'module-untrusted',
  });

  const staleRoot = workspace();
  writeSnapshot(staleRoot, continuitySnapshot({
    observedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    validUntil: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
  }));
  assert.equal(loadHealthModules({ workspace: staleRoot, now: NOW }).modules[0].reasonClass, 'module-stale');
});
