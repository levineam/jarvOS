'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const doctor = require('../server/adapters/system-doctor');
const { MEMORY_COMPONENTS, SYSTEM_FACTS_VERSION } = require('../server/vendor/jarvos-doctor-modules');
const now = new Date('2026-09-10T12:00:00Z');
function fixture(t, overrides = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-system-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const dir = path.join(workspace, '.jarvos', 'health-modules');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const snapshot = {
    schema: 'jarvos-health-module-snapshot/v1', moduleId: 'system', generation: 3,
    observedAt: '2026-09-10T11:00:00.000Z', validUntil: '2026-09-10T13:00:00.000Z', trust: 'trusted',
    factsVersion: SYSTEM_FACTS_VERSION,
    facts: { profile: 'local-openclaw', components: [
      { id: 'provider.searxng', state: 'healthy', reasonClass: 'none', evidence: { httpReachable: true, searchResultCount: 2, runtimeToolAvailable: true } },
      ...MEMORY_COMPONENTS.map(([id]) => ({ id, state: 'healthy', reasonClass: 'none', evidence: null })),
    ] }, ...overrides,
  };
  const file = path.join(dir, 'system.json');
  const write = () => fs.writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 });
  write();
  return { workspace, cfg: { systemDoctor: { workspace, profile: 'local-openclaw' } }, file, snapshot, write };
}
test('published observations preserve eleven Memory rows and timestamps with zero Doctor calls', (t) => {
  const f = fixture(t);
  const result = doctor.loadReceipt(f.cfg, { now, doctorRunner() { assert.fail('page read must never probe'); } });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.sections.core.length, 0);
  assert.deepEqual(result.receipt.sections.memory.map((r) => r.id), MEMORY_COMPONENTS.map(([id]) => id));
  assert.equal(result.receipt.sections.optional[0].label, 'SearXNG');
  assert.equal(result.receipt.sections.optional[0].observedAt, '2026-09-10T11:00:00.000Z');
  assert.equal(result.receipt.observations[0].freshness, 'current');
  assert.equal(result.receipt.source, 'published-modules');
});
test('expiry removes healthy claims and a newer publication is picked up without restart', (t) => {
  const f = fixture(t);
  let result = doctor.loadReceipt(f.cfg, { now: new Date('2026-09-10T14:00:00Z') });
  assert.notEqual(result.receipt.status, 'healthy');
  assert.equal(result.receipt.observations[0].freshness, 'stale');
  assert.equal(result.receipt.sections.memory.length, 0);
  Object.assign(f.snapshot, { observedAt: '2026-09-10T13:30:00.000Z', validUntil: '2026-09-10T15:00:00.000Z', generation: 4 });
  f.write();
  result = doctor.loadReceipt(f.cfg, { now: new Date('2026-09-10T14:00:00Z') });
  assert.equal(result.receipt.observations[0].generation, 4);
  assert.equal(result.receipt.sections.memory.length, 11);
});
for (const [name, overrides] of Object.entries({ untrusted: { trust: 'untrusted' }, future: { observedAt: '2026-09-11T00:00:00Z' }, invalid: { validUntil: null } })) {
  test(`${name} snapshot never renders healthy rows`, (t) => {
    const f = fixture(t, overrides);
    const result = doctor.loadReceipt(f.cfg, { now });
    assert.notEqual(result.receipt.status, 'healthy');
    assert.ok(result.receipt.components.every((c) => c.state !== 'healthy'));
  });
}
test('missing observations and configured invalid receipt fail closed', (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.file);
  assert.notEqual(doctor.loadReceipt(f.cfg, { now }).receipt.status, 'healthy');
  f.cfg.systemDoctor.receiptFile = f.file;
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, false);
});
test('public receipt requires matching profile/workspace and valid observation dates', (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, 'receipt.json');
  const receipt = { schema: doctor.REPORT_SCHEMA, profile: { id: 'local-openclaw', title: 'Local' }, workspace: f.workspace,
    status: 'healthy', observedAt: '2026-09-10T11:00:00Z', validUntil: '2026-09-10T13:00:00Z',
    components: [{ id: 'core', label: 'Core', section: 'core', state: 'healthy' }] };
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  f.cfg.systemDoctor.receiptFile = file;
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, true);
  receipt.components[0].observedAt = '2026-09-10T08:00:00.000Z';
  receipt.components[0].validUntil = '2026-09-10T09:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(receipt));
  const staleRow = doctor.loadReceipt(f.cfg, { now });
  assert.equal(staleRow.receipt.status, 'needs your attention');
  assert.equal(staleRow.receipt.components[0].observedAt, '2026-09-10T08:00:00.000Z');
  assert.equal(staleRow.receipt.components[0].freshness, 'stale');
  assert.equal(staleRow.receipt.components[0].reasonClass, 'module-stale');
  fs.chmodSync(file, 0o666);
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, false);
  fs.chmodSync(file, 0o600);
  assert.equal(doctor.loadReceipt(f.cfg, { now: new Date('2026-09-10T14:00:00Z') }).ok, false);
  f.cfg.systemDoctor.profile = 'other';
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, false);
});
test('System navigation and visible refresh are wired without subprocess execution', () => {
  const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  const nav = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  assert.match(nav, /href="#\/system"/);
  assert.match(app, /startVisibleRefresh\('system'/);
  assert.match(app, /document.hidden/);
  assert.match(app, /generation === renderGeneration/);
  assert.doesNotMatch(app, /all systems calm/);
  assert.doesNotMatch(app, /Published Doctor observations\. Refreshes every 30 seconds/);
  const reader = fs.readFileSync(path.join(__dirname, '../server/adapters/system-doctor.js'), 'utf8');
  assert.doesNotMatch(reader, /spawnSync|child_process|runPublicDoctor/);
});
