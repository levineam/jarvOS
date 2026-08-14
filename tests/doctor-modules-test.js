'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HEALTH_MODULE_DIRECTORY,
  PUBLIC_MODULE_ID,
  loadHealthModules,
} = require('../lib/jarvos-doctor-modules');

const NOW = new Date('2026-08-13T12:00:00.000Z');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-doctor-module-'));
  fs.mkdirSync(path.join(root, HEALTH_MODULE_DIRECTORY), { recursive: true, mode: 0o700 });
  return root;
}

function writeSnapshot(root, snapshot, { mode = 0o600 } = {}) {
  const filePath = path.join(root, HEALTH_MODULE_DIRECTORY, `${PUBLIC_MODULE_ID}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  fs.chmodSync(filePath, mode);
  return filePath;
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
  writeSnapshot(root, snapshot({ moduleId: 'memory-stack-doctor' }));
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
