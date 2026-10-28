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
test('v2 published observations preserve eleven Memory rows but leave component age unknown with zero Doctor calls', (t) => {
  const f = fixture(t);
  const result = doctor.loadReceipt(f.cfg, { now, doctorRunner() { assert.fail('page read must never probe'); } });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.sections.core.length, 0);
  assert.deepEqual(result.receipt.sections.memory.map((r) => r.id), MEMORY_COMPONENTS.map(([id]) => id));
  assert.equal(result.receipt.sections.optional[0].label, 'SearXNG');
  assert.equal(result.receipt.sections.optional[0].observedAt, null);
  assert.equal(result.receipt.sections.optional[0].freshness, 'unavailable');
  assert.equal(result.receipt.observations[0].freshness, 'current');
  assert.equal(result.receipt.source, 'published-modules');
});
test('v3 preserves a component date pair and warns only for stale component evidence', (t) => {
  const componentDates = { observedAt: '2026-09-10T10:00:00.000Z', validUntil: '2026-09-10T11:00:00.000Z' };
  const f = fixture(t, {
    factsVersion: 'jarvos-system-doctor-facts/v3',
    facts: { profile: 'local-openclaw', components: [
      { id: 'provider.searxng', state: 'healthy', reasonClass: 'none', evidence: { httpReachable: true, searchResultCount: 2, runtimeToolAvailable: true }, ...componentDates },
      ...MEMORY_COMPONENTS.map(([id]) => ({ id, state: 'healthy', reasonClass: 'none', evidence: null, observedAt: null, validUntil: null })),
    ] },
  });
  const result = doctor.loadReceipt(f.cfg, { now });
  const row = result.receipt.sections.optional[0];
  assert.equal(result.ok, true);
  assert.equal(result.receipt.factsVersion, 'jarvos-system-doctor-facts/v3');
  assert.equal(row.observedAt, componentDates.observedAt);
  assert.equal(row.validUntil, componentDates.validUntil);
  assert.equal(row.freshness, 'stale');
  assert.equal(row.state, 'warning');
  assert.equal(row.reasonClass, 'component-stale');
  assert.match(row.guidance, /published evidence is stale/i);
});
function v4Facts() {
  const at = { observedAt: '2026-09-10T11:00:00.000Z', validUntil: '2026-09-10T13:00:00.000Z' };
  const check = (id, extra = {}) => ({ id, label: `Check ${id}`, state: 'healthy', reasonClass: 'none', ...at, ...extra });
  const row = (checks, extra = {}) => ({ state: 'healthy', reasonClass: 'none', ...at, ...extra, checks });
  return { profile: 'local-openclaw',
    products: [{ id: 'capture', label: 'Capture', maker: 'jarvOS', order: 1, version: null, ...row([check('capture-ideas', { evidence: null })]) }],
    doctor: { label: 'jarvOS Doctor', ...row(['last-run', 'reviewed-release', 'repairs', 'alerts'].map((part) => {
      const { evidence, ...rest } = check(`doctor-${part}`); return { ...rest, part };
    })) } };
}
test('v4 published rollups load with dates, products and Doctor passed through', (t) => {
  const f = fixture(t, { factsVersion: 'jarvos-system-doctor-facts/v4', facts: v4Facts() });
  const result = doctor.loadReceipt(f.cfg, { now });
  assert.equal(result.ok, true, result.error);
  const { receipt } = result;
  assert.equal(receipt.factsVersion, 'jarvos-system-doctor-facts/v4');
  assert.deepEqual(receipt.sections.optional.map((r) => [r.id, r.label, r.rollup]),
    [['capture', 'Capture', 'product'], ['doctor', 'jarvOS Doctor', 'doctor']]);
  assert.equal(receipt.sections.optional[1].observedAt, '2026-09-10T11:00:00.000Z');
  assert.equal(receipt.sections.optional[1].freshness, 'current');
  assert.equal(receipt.products[0].checks[0].id, 'capture-ideas');
  assert.equal(receipt.doctor.checks.length, 4);
  assert.equal(receipt.status, 'healthy');
});
test('v4 receipt file loads, a malformed products block is refused, and v3 still loads', (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, 'receipt.json');
  const at = { observedAt: '2026-09-10T11:00:00.000Z', validUntil: '2026-09-10T13:00:00.000Z' };
  const facts = v4Facts();
  const receipt = { schema: doctor.REPORT_SCHEMA, profile: { id: 'local-openclaw', title: 'Local' }, workspace: f.workspace,
    status: 'healthy', factsVersion: 'jarvos-system-doctor-facts/v4', ...at,
    components: [
      { id: 'capture', label: 'Capture', section: 'optional', state: 'healthy', rollup: 'product', ...at },
      { id: 'doctor', label: 'jarvOS Doctor', section: 'optional', state: 'healthy', rollup: 'doctor', ...at },
    ], products: facts.products, doctor: facts.doctor };
  f.cfg.systemDoctor.receiptFile = file;
  const write = () => fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  write();
  const v4 = doctor.loadReceipt(f.cfg, { now });
  assert.equal(v4.ok, true);
  assert.equal(v4.receipt.products.length, 1);
  assert.equal(v4.receipt.doctor.label, 'jarvOS Doctor');
  assert.deepEqual(v4.receipt.components.map((c) => c.rollup), ['product', 'doctor']);
  receipt.products = [{ id: 42, label: 'Capture', state: 'healthy', checks: [] }];
  write();
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, false);
  receipt.products = facts.products;
  delete receipt.doctor;
  write();
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, false);
  const v3 = { ...receipt, factsVersion: 'jarvos-system-doctor-facts/v3', components: [receipt.components[0]] };
  delete v3.products;
  fs.writeFileSync(file, JSON.stringify(v3), { mode: 0o600 });
  const loaded = doctor.loadReceipt(f.cfg, { now });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.receipt.products, undefined);
  assert.equal(loaded.receipt.doctor, undefined);
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
    status: 'healthy', factsVersion: 'jarvos-system-doctor-facts/v3', observedAt: '2026-09-10T11:00:00Z', validUntil: '2026-09-10T13:00:00Z',
    components: [{ id: 'core', label: 'Core', section: 'core', state: 'healthy', observedAt: '2026-09-10T11:00:00.000Z', validUntil: '2026-09-10T13:00:00.000Z' }] };
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
  assert.equal(staleRow.receipt.components[0].reasonClass, 'component-stale');
  fs.chmodSync(file, 0o666);
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, false);
  fs.chmodSync(file, 0o600);
  assert.equal(doctor.loadReceipt(f.cfg, { now: new Date('2026-09-10T14:00:00Z') }).ok, false);
  f.cfg.systemDoctor.profile = 'other';
  assert.equal(doctor.loadReceipt(f.cfg, { now }).ok, false);
});
test('configured receipts reject unsupported facts and never inherit report dates into a component', (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, 'receipt.json');
  const receipt = {
    schema: doctor.REPORT_SCHEMA,
    profile: { id: 'local-openclaw', title: 'Local' },
    workspace: f.workspace,
    status: 'healthy',
    factsVersion: SYSTEM_FACTS_VERSION,
    observedAt: '2026-09-10T11:00:00.000Z', validUntil: '2026-09-10T13:00:00.000Z',
    components: [{ id: 'core', label: 'Core', section: 'core', state: 'healthy' }],
  };
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  f.cfg.systemDoctor.receiptFile = file;
  const noInheritance = doctor.loadReceipt(f.cfg, { now });
  assert.equal(noInheritance.ok, true);
  assert.equal(noInheritance.receipt.components[0].observedAt, null);
  assert.equal(noInheritance.receipt.components[0].freshness, 'unavailable');
  receipt.factsVersion = 'jarvos-system-doctor-facts/v999';
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  const unsupported = doctor.loadReceipt(f.cfg, { now });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.receipt.source, 'unavailable');
});
test('configured legacy receipts keep component age unknown and future v3 evidence fails closed', (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, 'receipt.json');
  const receipt = {
    schema: doctor.REPORT_SCHEMA,
    profile: { id: 'local-openclaw', title: 'Local' },
    workspace: f.workspace,
    status: 'healthy',
    observedAt: '2026-09-10T11:00:00.000Z', validUntil: '2026-09-10T13:00:00.000Z',
    components: [{ id: 'core', label: 'Core', section: 'core', state: 'healthy' }],
  };
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  f.cfg.systemDoctor.receiptFile = file;
  const legacy = doctor.loadReceipt(f.cfg, { now });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.receipt.factsVersion, SYSTEM_FACTS_VERSION);
  assert.equal(legacy.receipt.components[0].observedAt, null);
  receipt.factsVersion = 'jarvos-system-doctor-facts/v3';
  receipt.components[0].observedAt = '2026-09-10T12:30:00.000Z';
  receipt.components[0].validUntil = '2026-09-10T13:30:00.000Z';
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  const future = doctor.loadReceipt(f.cfg, { now });
  assert.equal(future.ok, false);
  assert.equal(future.receipt.source, 'unavailable');
});
test('System navigation and visible refresh are wired without subprocess execution', () => {
  const app = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');
  const nav = fs.readFileSync(path.join(__dirname, '../static/index.html'), 'utf8');
  assert.match(nav, /href="#\/system"/);
  assert.match(app, /startVisibleRefresh\('system'/);
  assert.match(app, /document.hidden/);
  assert.match(app, /generation === renderGeneration/);
  assert.match(app, /Overall/);
  assert.match(app, /Source profile/);
  assert.match(app, /Last checked unavailable/);
  assert.doesNotMatch(app, /all systems calm/);
  assert.doesNotMatch(app, /Published Doctor observations\. Refreshes every 30 seconds/);
  const reader = fs.readFileSync(path.join(__dirname, '../server/adapters/system-doctor.js'), 'utf8');
  assert.doesNotMatch(reader, /spawnSync|child_process|runPublicDoctor/);
});
