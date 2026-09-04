'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HEALTH_MODULE_DIRECTORY,
  CONTINUITY_MODULE_ID,
  MEMORY_COMPONENTS,
  PUBLIC_MODULE_ID,
  SYSTEM_MODULE_ID,
  loadHealthModules,
  modulePath,
} = require('../lib/jarvos-doctor-modules');
const { buildSystemDoctorReceipt, renderSystemDoctor } = require('../lib/jarvos-system-doctor');

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

function systemComponent(id, state = 'healthy', overrides = {}) {
  return {
    id,
    state,
    reasonClass: state === 'healthy' ? 'none' : 'reported-condition',
    evidence: id === 'provider.searxng'
      ? { httpReachable: true, searchResultCount: 3, runtimeToolAvailable: true }
      : null,
    ...overrides,
  };
}

function systemSnapshot(overrides = {}) {
  return {
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: SYSTEM_MODULE_ID,
    generation: 11,
    observedAt: NOW.toISOString(),
    validUntil: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    trust: 'trusted',
    factsVersion: 'jarvos-system-doctor-facts/v1',
    facts: { profile: 'minimal', components: [] },
    ...overrides,
  };
}

test('a missing optional Memory module is absent rather than a failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-doctor-module-'));
  const report = loadHealthModules({ workspace: root, now: NOW });
  assert.deepEqual(report.modules, []);
  assert.deepEqual(report.issues, []);
});

test('a profile-bound system snapshot exposes only its selected optional components', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshot({
    facts: {
      profile: 'minimal',
      components: [systemComponent('provider.paperclip', 'not configured')],
    },
  }));
  const report = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' });
  assert.deepEqual(report.modules.map((module) => module.id), [SYSTEM_MODULE_ID]);
  assert.equal(report.modules[0].components.length, 1);
  assert.equal(report.modules[0].components[0].label, 'Paperclip');
  assert.equal(report.modules[0].components[0].state, 'not configured');
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.doesNotMatch(JSON.stringify(report), /telegram|openclaw|gbrain/i);
});

test('a system snapshot for another profile fails closed', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshot());
  const report = loadHealthModules({ workspace: root, now: NOW, profile: 'local-openclaw' });
  assert.equal(report.modules[0].id, SYSTEM_MODULE_ID);
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.equal(report.modules[0].reasonClass, 'profile-mismatch');
  assert.equal(report.modules[0].components, undefined);
});

test('Memory keeps its fixed eleven-component roster and rejects partial or reordered projections', () => {
  const components = MEMORY_COMPONENTS.map(([id]) => systemComponent(id));
  const root = workspace();
  writeSnapshot(root, systemSnapshot({ facts: { profile: 'minimal', components } }));
  const accepted = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0];
  assert.deepEqual(accepted.components.map(({ id, label }) => [id, label]), MEMORY_COMPONENTS);

  for (const invalid of [components.slice(0, -1), [components[1], components[0], ...components.slice(2)]]) {
    const invalidRoot = workspace();
    writeSnapshot(invalidRoot, systemSnapshot({ facts: { profile: 'minimal', components: invalid } }));
    const rejected = loadHealthModules({ workspace: invalidRoot, now: NOW, profile: 'minimal' }).modules[0];
    assert.equal(rejected.state, 'needs your attention');
    assert.equal(rejected.reasonClass, 'module-invalid');
  }
});

test('SearXNG cannot be healthy when HTTP responds but search and runtime-tool proof fail', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshot({
    facts: {
      profile: 'minimal',
      components: [systemComponent('provider.searxng', 'healthy', {
        evidence: { httpReachable: true, searchResultCount: 0, runtimeToolAvailable: false },
      })],
    },
  }));
  const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
  assert.equal(component.state, 'warning');
  assert.equal(component.reasonClass, 'search-empty');
});

test('SearXNG reports the first failed acceptance layer', () => {
  const cases = [
    [{ httpReachable: false, searchResultCount: 3, runtimeToolAvailable: true }, 'http-unreachable'],
    [{ httpReachable: true, searchResultCount: 3, runtimeToolAvailable: false }, 'runtime-tool-missing'],
  ];
  for (const [evidence, reasonClass] of cases) {
    const root = workspace();
    writeSnapshot(root, systemSnapshot({
      facts: {
        profile: 'minimal',
        components: [systemComponent('provider.searxng', 'healthy', { evidence })],
      },
    }));
    const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
    assert.equal(component.state, 'warning');
    assert.equal(component.reasonClass, reasonClass);
  }
});

test('legacy module snapshots cannot select System Doctor components', () => {
  const root = workspace();
  writeSnapshot(root, snapshot());
  const modules = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules;
  const receipt = buildSystemDoctorReceipt({
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: root,
    results: [],
    modules,
  });
  assert.deepEqual(receipt.components, []);
});

test('the shared System Doctor receipt and text list core plus every selected component', () => {
  const memory = MEMORY_COMPONENTS.map(([id, label]) => ({
    id, label, state: 'healthy', reasonClass: 'none', evidence: null,
  }));
  const report = {
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [{ id: 'node-version', ok: true, message: 'Node.js is supported' }],
    modules: [{ id: 'system', state: 'healthy', reasonClass: 'none', components: memory }],
  };
  const receipt = buildSystemDoctorReceipt(report);
  assert.equal(receipt.schema, 'jarvos-system-doctor-report/v1');
  assert.equal(receipt.components.filter((component) => component.section === 'memory').length, 11);
  const text = renderSystemDoctor({ ...report, systemDoctor: receipt });
  assert.match(text, /^✅ node-version — Node\.js is supported$/m);
  assert.doesNotMatch(text, /\bPASS\b|\bFAIL\b|\bWARN\b|\bSKIP\b/);
  assert.doesNotMatch(text, /Selected optional components/);
  assert.doesNotMatch(text, /READY|NOT READY/);
  assert.doesNotMatch(text, /— healthy\b|— warning\b|— repair needed\b|— not configured\b/);
  const memoryLines = text.split('\n').filter((line) => line.startsWith('✅ ') && !line.includes('node-version'));
  assert.equal(memoryLines.length, 11);
  for (const [, label] of MEMORY_COMPONENTS) {
    assert.ok(text.split('\n').includes(`✅ ${label}`), label);
  }
  // Exactly one status icon per rendered component line.
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('jarvOS') || line.startsWith('Workspace:')) continue;
    const icons = (line.match(/[✅⚠️❌◻️]/gu) || []);
    assert.equal(icons.length, 1, line);
  }
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


test('System Doctor text distinguishes broken from unverified without status vocabulary', () => {
  const report = {
    ok: false,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [
      { id: 'node-version', ok: true, message: 'Node.js is supported' },
      { id: 'workspace-files', ok: false, message: 'Missing MEMORY.md' },
    ],
    modules: [{
      id: 'system',
      state: 'needs your attention',
      reasonClass: 'component-degraded',
      components: [
        ...MEMORY_COMPONENTS.map(([id, label]) => ({ id, label, state: 'healthy', reasonClass: 'none', evidence: null })),
        {
          id: 'provider.searxng',
          label: 'SearXNG',
          state: 'warning',
          reasonClass: 'search-empty',
          evidence: { httpReachable: true, searchResultCount: 0, runtimeToolAvailable: true },
        },
        {
          id: 'provider.paperclip',
          label: 'Paperclip',
          state: 'not configured',
          reasonClass: 'not-configured',
          evidence: null,
        },
      ],
    }],
  };
  const receipt = buildSystemDoctorReceipt(report);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.status, 'repair needed');
  assert.equal(receipt.components.filter((component) => component.section === 'memory').length, 11);
  assert.ok(receipt.components.some((component) => component.id === 'provider.searxng'));

  const text = renderSystemDoctor({ ...report, systemDoctor: receipt });
  const before = [
    '❌ workspace-files — Missing MEMORY.md',
    '⚠️ SearXNG — reachable, but search returned no results',
    '◻️ Paperclip — not configured yet',
  ];
  for (const line of before) assert.ok(text.split('\n').includes(line), line);
  assert.ok(text.split('\n').includes('✅ GBrain core'));
  assert.ok(text.split('\n').includes('✅ GBrain semantic coverage'));
  assert.doesNotMatch(text, /\bPASS\b|\bFAIL\b|Selected optional components|READY/);
});
