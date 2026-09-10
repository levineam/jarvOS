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
    factsVersion: 'jarvos-system-doctor-facts/v2',
    facts: { profile: 'minimal', components: [] },
    ...overrides,
  };
}

function systemSnapshotV3(overrides = {}) {
  return systemSnapshot({ factsVersion: 'jarvos-system-doctor-facts/v3', ...overrides });
}

function systemComponentV3(id, state = 'healthy', dateOverrides = {}, overrides = {}) {
  const observedAt = Object.prototype.hasOwnProperty.call(dateOverrides, 'observedAt') ? dateOverrides.observedAt : NOW.toISOString();
  const validUntil = Object.prototype.hasOwnProperty.call(dateOverrides, 'validUntil') ? dateOverrides.validUntil : new Date(NOW.getTime() + 15 * 60 * 1000).toISOString();
  return { ...systemComponent(id, state, overrides), observedAt, validUntil };
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

test('the obsolete ten-row v1 System Doctor facts fail closed', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshot({
    factsVersion: 'jarvos-system-doctor-facts/v1',
    facts: {
      profile: 'minimal',
      components: MEMORY_COMPONENTS
        .filter(([id]) => id !== 'memory.gbrain-semantic-coverage')
        .map(([id]) => systemComponent(id)),
    },
  }));
  const report = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' });
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.equal(report.modules[0].reasonClass, 'module-invalid');
  assert.equal(report.modules[0].components, undefined);
  const text = renderSystemDoctor({
    ok: false,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: root,
    results: [{ id: 'node-version', ok: true, message: 'Node.js is supported' }],
    modules: report.modules,
  });
  assert.match(text, /⚠️ System health receipt — Receipt is invalid\. Republish it\./);
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

test('a valid v2 system component is readable with explicitly unknown check age', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshot({
    facts: { profile: 'minimal', components: [systemComponent('provider.paperclip', 'healthy')] },
  }));
  const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
  assert.equal(component.state, 'healthy');
  assert.equal(component.observedAt, null);
  assert.equal(component.validUntil, null);
});

test('a fresh v3 system component preserves its own observed and valid-until times', () => {
  const root = workspace();
  const observedAt = NOW.toISOString();
  const validUntil = new Date(NOW.getTime() + 15 * 60 * 1000).toISOString();
  writeSnapshot(root, systemSnapshotV3({
    facts: { profile: 'minimal', components: [systemComponentV3('provider.paperclip', 'healthy', { observedAt, validUntil })] },
  }));
  const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
  assert.equal(component.state, 'healthy');
  assert.equal(component.observedAt, observedAt);
  assert.equal(component.validUntil, validUntil);
});

test('a v3 component with null/null dates is accepted as unknown check age', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshotV3({
    facts: { profile: 'minimal', components: [systemComponentV3('provider.paperclip', 'healthy', { observedAt: null, validUntil: null })] },
  }));
  const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
  assert.equal(component.state, 'healthy');
  assert.equal(component.observedAt, null);
  assert.equal(component.validUntil, null);
});

test('an expired v3 component is stale even inside a fresh outer System snapshot', () => {
  const root = workspace();
  const observedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  const validUntil = new Date(NOW.getTime() - 1).toISOString();
  writeSnapshot(root, systemSnapshotV3({
    facts: { profile: 'minimal', components: [systemComponentV3('provider.paperclip', 'healthy', { observedAt, validUntil })] },
  }));
  const report = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' });
  const component = report.modules[0].components[0];
  assert.equal(component.state, 'warning');
  assert.equal(component.reasonClass, 'component-stale');
  assert.equal(component.observedAt, observedAt);
  assert.equal(component.validUntil, validUntil);
  assert.equal(report.modules[0].state, 'needs your attention');
});

test('a stale v3 component never asserts fresh healthy or service repair', () => {
  const observedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  const validUntil = new Date(NOW.getTime() - 1).toISOString();
  for (const state of ['healthy', 'repair needed']) {
    const root = workspace();
    writeSnapshot(root, systemSnapshotV3({
      facts: { profile: 'minimal', components: [systemComponentV3('provider.paperclip', state, { observedAt, validUntil })] },
    }));
    const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
    assert.equal(component.state, 'warning');
    assert.equal(component.reasonClass, 'component-stale');
  }
});

test('a stale v3 SearXNG component cannot assert a fresh healthy search result', () => {
  const root = workspace();
  const observedAt = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  const validUntil = new Date(NOW.getTime() - 1).toISOString();
  writeSnapshot(root, systemSnapshotV3({
    facts: { profile: 'minimal', components: [systemComponentV3('provider.searxng', 'healthy', { observedAt, validUntil })] },
  }));
  const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
  assert.equal(component.state, 'warning');
  assert.equal(component.reasonClass, 'component-stale');
});

test('a v3 system snapshot with a legacy four-field component fails closed', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshotV3({
    facts: { profile: 'minimal', components: [systemComponent('provider.paperclip', 'healthy')] },
  }));
  const report = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' });
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.equal(report.modules[0].reasonClass, 'module-invalid');
  assert.equal(report.modules[0].components, undefined);
});

test('missing, half-present, malformed, future, and reversed v3 component dates fail closed', () => {
  const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
  const past = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  const cases = [
    { observedAt: NOW.toISOString(), validUntil: null },
    { observedAt: null, validUntil: past },
    { observedAt: 'not-a-date', validUntil: future },
    { observedAt: NOW.toISOString(), validUntil: 'not-a-date' },
    { observedAt: '2026-02-30T00:00:00.000Z', validUntil: future },
    { observedAt: future, validUntil: new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString() },
    { observedAt: NOW.toISOString(), validUntil: NOW.toISOString() },
    { observedAt: NOW.toISOString(), validUntil: past },
  ];
  for (const dates of cases) {
    const root = workspace();
    writeSnapshot(root, systemSnapshotV3({
      facts: { profile: 'minimal', components: [{ ...systemComponent('provider.paperclip', 'healthy'), ...dates }] },
    }));
    const report = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' });
    assert.equal(report.modules[0].state, 'needs your attention');
    assert.equal(report.modules[0].reasonClass, 'module-invalid');
    assert.equal(report.modules[0].components, undefined);
  }

  const missingObservedAt = systemComponentV3('provider.paperclip');
  delete missingObservedAt.observedAt;
  const missingRoot = workspace();
  writeSnapshot(missingRoot, systemSnapshotV3({
    facts: { profile: 'minimal', components: [missingObservedAt] },
  }));
  assert.equal(loadHealthModules({ workspace: missingRoot, now: NOW, profile: 'minimal' }).modules[0].reasonClass, 'module-invalid');
});

test('a v3 component is stale exactly at its validity deadline', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshotV3({
    facts: {
      profile: 'minimal',
      components: [systemComponentV3('provider.paperclip', 'healthy', {
        observedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
        validUntil: NOW.toISOString(),
      })],
    },
  }));
  const component = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0].components[0];
  assert.equal(component.reasonClass, 'component-stale');
});

test('a v3 Memory roster remains accepted in its fixed order', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshotV3({
    facts: { profile: 'minimal', components: MEMORY_COMPONENTS.map(([id]) => systemComponentV3(id)) },
  }));
  const module = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules[0];
  assert.equal(module.state, 'healthy');
  assert.deepEqual(module.components.map((component) => component.id), MEMORY_COMPONENTS.map(([id]) => id));
});

test('an unrecognized field on a v3 component fails closed without leaking it', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshotV3({
    facts: { profile: 'minimal', components: [{ ...systemComponentV3('provider.paperclip'), privateNote: 'do-not-leak' }] },
  }));
  const report = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' });
  assert.equal(report.modules[0].state, 'needs your attention');
  assert.equal(report.modules[0].reasonClass, 'module-invalid');
  assert.doesNotMatch(JSON.stringify(report), /do-not-leak/);
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
  assert.match(text, /Core\n✅ node-version/);
  assert.match(text, /Memory\n✅ GBrain core\n✅ GBrain semantic coverage/);
  for (const [, label] of MEMORY_COMPONENTS) assert.match(text, new RegExp(label.replace(/[&]/g, '\\&')));
  assert.doesNotMatch(text, /PASS|FAIL|WARN|SKIP|Selected optional components|System Doctor:|READY/);
  assert.equal((text.match(/✅|❌|⚠️/g) || []).length, receipt.components.length);
});

test('the validated System module preserves its declared version and component age into the receipt', () => {
  const root = workspace();
  const observedAt = '2026-08-13T11:45:00.000Z';
  const validUntil = '2026-08-13T12:15:00.000Z';
  writeSnapshot(root, systemSnapshotV3({
    facts: {
      profile: 'minimal',
      components: [
        systemComponentV3('provider.paperclip', 'healthy', { observedAt, validUntil }),
        systemComponentV3('provider.searxng', 'healthy', { observedAt: null, validUntil: null }),
      ],
    },
  }));
  const modules = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules;
  const receipt = buildSystemDoctorReceipt({
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: root,
    results: [],
    modules,
  });
  const paperclip = receipt.components.find((component) => component.id === 'provider.paperclip');
  const searxng = receipt.components.find((component) => component.id === 'provider.searxng');
  assert.equal(receipt.factsVersion, 'jarvos-system-doctor-facts/v3');
  assert.deepEqual({ observedAt: paperclip.observedAt, validUntil: paperclip.validUntil }, { observedAt, validUntil });
  assert.deepEqual({ observedAt: searxng.observedAt, validUntil: searxng.validUntil }, { observedAt: null, validUntil: null });
});

test('the validated v2 System module retains unknown component age without inferring outer receipt dates', () => {
  const root = workspace();
  writeSnapshot(root, systemSnapshot({
    facts: { profile: 'minimal', components: [systemComponent('provider.paperclip')] },
  }));
  const modules = loadHealthModules({ workspace: root, now: NOW, profile: 'minimal' }).modules;
  const receipt = buildSystemDoctorReceipt({
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: root,
    results: [],
    modules,
  });
  const paperclip = receipt.components.find((component) => component.id === 'provider.paperclip');
  assert.equal(receipt.factsVersion, 'jarvos-system-doctor-facts/v2');
  assert.deepEqual({ observedAt: paperclip.observedAt, validUntil: paperclip.validUntil }, { observedAt: null, validUntil: null });
});

test('the System Doctor receipt preserves each selected system component observed and valid-until age', () => {
  const observedAt = '2026-09-03T18:00:00.000Z';
  const validUntil = '2026-09-03T18:15:00.000Z';
  const report = {
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [],
    modules: [{
      id: 'system',
      state: 'healthy',
      reasonClass: 'none',
      factsVersion: 'jarvos-system-doctor-facts/v3',
      components: [
        {
          id: 'provider.paperclip', label: 'Paperclip', state: 'healthy', reasonClass: 'none', evidence: null, observedAt, validUntil,
        },
        {
          id: 'provider.searxng', label: 'SearXNG', state: 'healthy', reasonClass: 'none', evidence: null, observedAt: null, validUntil: null,
        },
      ],
    }],
  };
  const receipt = buildSystemDoctorReceipt(report);
  const v3Component = receipt.components.find((component) => component.id === 'provider.paperclip');
  assert.equal(v3Component.observedAt, observedAt);
  assert.equal(v3Component.validUntil, validUntil);
  const v2Component = receipt.components.find((component) => component.id === 'provider.searxng');
  assert.equal(v2Component.observedAt, null);
  assert.equal(v2Component.validUntil, null);
});

test('the System Doctor receipt preserves the validated module\'s declared facts version without stamping one', () => {
  const withVersion = buildSystemDoctorReceipt({
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [],
    modules: [{
      id: 'system', state: 'healthy', reasonClass: 'none', factsVersion: 'jarvos-system-doctor-facts/v3', components: [],
    }],
  });
  assert.equal(withVersion.factsVersion, 'jarvos-system-doctor-facts/v3');

  const withoutVersion = buildSystemDoctorReceipt({
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [],
    modules: [{ id: 'system', state: 'healthy', reasonClass: 'none', components: [] }],
  });
  assert.equal(withoutVersion.factsVersion, null);

  const noSystemModule = buildSystemDoctorReceipt({
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [],
    modules: [],
  });
  assert.equal(noSystemModule.factsVersion, null);

  const invalidSystemModule = buildSystemDoctorReceipt({
    ok: false,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [],
    modules: [{
      id: 'system', state: 'needs your attention', reasonClass: 'module-invalid', factsVersion: 'jarvos-system-doctor-facts/v3',
    }],
  });
  assert.equal(invalidSystemModule.factsVersion, null);
});

test('the System Doctor receipt treats module-invalid, module-stale, and module-untrusted system evidence as a warning, never repair needed', () => {
  for (const reasonClass of ['module-invalid', 'module-stale', 'module-untrusted']) {
    const report = {
      ok: false,
      profile: { id: 'minimal', title: 'Minimal' },
      workspace: '/portable/workspace',
      results: [],
      modules: [{ id: 'system', state: 'needs your attention', reasonClass }],
    };
    const receipt = buildSystemDoctorReceipt(report);
    const component = receipt.components.find((item) => item.id === 'module.system');
    assert.equal(component.state, 'warning');
    assert.equal(component.reasonClass, reasonClass);
  }
});

test('the System Doctor receipt still reports repair needed for a genuinely failed selected service', () => {
  const report = {
    ok: false,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [],
    modules: [{
      id: 'system',
      state: 'repair needed',
      reasonClass: 'component-failed',
      components: [{
        id: 'provider.paperclip', label: 'Paperclip', state: 'repair needed', reasonClass: 'reported-condition', evidence: null, observedAt: null, validUntil: null,
      }],
    }],
  };
  const receipt = buildSystemDoctorReceipt(report);
  const component = receipt.components.find((item) => item.id === 'provider.paperclip');
  assert.equal(component.state, 'repair needed');
  assert.equal(receipt.status, 'repair needed');
});

test('operator text distinguishes a failure from an unverified component and gives each a next action', () => {
  const report = {
    ok: false,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [
      { id: 'workspace-files', ok: false, message: 'Required workspace file is missing' },
      {
        id: 'optional-runtime', status: 'skipped', message: 'Runtime adapter is not installed', detail: 'Install it only when needed',
      },
    ],
    modules: [{
      id: 'system',
      state: 'needs your attention',
      reasonClass: 'component-degraded',
      components: [
        {
          id: 'provider.searxng', label: 'SearXNG', state: 'warning', reasonClass: 'search-empty', evidence: null,
        },
        {
          id: 'provider.paperclip', label: 'Paperclip', state: 'not configured', reasonClass: 'not-configured', evidence: null,
        },
        {
          id: 'memory.qmd', label: 'QMD search', state: 'warning', reasonClass: 'unavailable', evidence: null,
        },
      ],
    }],
  };
  const text = renderSystemDoctor(report);
  assert.match(text, /❌ workspace-files — Required workspace file is missing\. Fix it, then rerun Doctor\./);
  assert.match(text, /⚠️ optional-runtime — Runtime adapter is not installed — Install it only when needed\. Configure it when needed\./);
  assert.match(text, /⚠️ SearXNG — No search results\. Run a real search, then rerun Doctor\./);
  assert.match(text, /⚠️ Paperclip — Not configured\. Configure it when needed\./);
  assert.match(text, /⚠️ QMD search — unavailable\. Verify it, then rerun Doctor\./);
  assert.equal((text.match(/✅|❌|⚠️/g) || []).length, 5);
});

test('blocking modules remain visible without duplicating a projected Memory roster', () => {
  const base = {
    ok: false,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/portable/workspace',
    results: [{ id: 'node-version', ok: true, message: 'Node.js is supported' }],
  };
  const legacyOnly = renderSystemDoctor({
    ...base,
    modules: [{ id: 'memory', state: 'repair needed', reasonClass: 'reported-condition' }],
  });
  assert.match(legacyOnly, /❌ Memory receipt — reported condition\. Fix it, then rerun Doctor\./);

  const memory = MEMORY_COMPONENTS.map(([id, label]) => ({
    id, label, state: 'healthy', reasonClass: 'none', evidence: null,
  }));
  const projected = renderSystemDoctor({
    ...base,
    modules: [
      { id: 'memory', state: 'repair needed', reasonClass: 'reported-condition' },
      { id: 'system', state: 'healthy', reasonClass: 'none', components: memory },
    ],
  });
  assert.doesNotMatch(projected, /Memory receipt/);
  assert.equal((projected.match(/✅ GBrain core/g) || []).length, 1);
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
