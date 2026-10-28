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
// ── facts/v4 per-check aging ──
const V4_NAME = 'jarvos-system-doctor-facts/v4';
const FRESH = { observedAt: '2026-09-10T11:00:00.000Z', validUntil: '2026-09-10T13:00:00.000Z' };
const EXPIRED = { observedAt: '2026-09-10T08:00:00.000Z', validUntil: '2026-09-10T10:00:00.000Z' };
const v4Check = (id, dates, state = 'healthy', reasonClass = 'none', extra = {}) => ({ id, label: `Check ${id}`, state, reasonClass, ...dates, ...extra });
const v4Row = (checks, extra = {}) => ({ ...extra, checks, state: 'healthy', reasonClass: 'none', ...FRESH });
function v4DoctorRow(overrides = {}) {
  const parts = ['last-run', 'reviewed-release', 'repairs', 'alerts'];
  return v4Row(parts.map((part) => ({ ...v4Check(`doctor-${part}`, overrides[part] || FRESH, ...(overrides[`${part}State`] || [])), part })), { label: 'jarvOS Doctor' });
}
function v4ReceiptFile(t, { products, doctor: doctorRow, envelope = FRESH }) {
  const f = fixture(t);
  const file = path.join(f.workspace, 'receipt.json');
  const receipt = { schema: doctor.REPORT_SCHEMA, profile: { id: 'local-openclaw', title: 'Local' }, workspace: f.workspace,
    status: 'healthy', factsVersion: V4_NAME, ...envelope,
    components: [], products, doctor: doctorRow };
  f.cfg.systemDoctor.receiptFile = file;
  fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
  return { f, receipt, load: (at = now) => doctor.loadReceipt(f.cfg, { now: at }) };
}
test('v4 an expired memory check beside a fresh gateway failure still shows the failure, not stale', (t) => {
  const product = { id: 'openclaw', label: 'OpenClaw', maker: 'x', order: 1, version: null, ...v4Row([
    v4Check('memory', EXPIRED),
    v4Check('gateway', FRESH, 'repair needed', 'http-unreachable'),
  ]) };
  const { load } = v4ReceiptFile(t, { products: [product], doctor: v4DoctorRow() });
  const result = load();
  assert.equal(result.ok, true, result.error);
  const row = result.receipt.products[0];
  assert.equal(row.checks[0].state, 'warning');
  assert.equal(row.checks[0].reasonClass, 'component-stale');
  assert.equal(row.checks[1].state, 'repair needed');
  assert.equal(row.state, 'repair needed');
  assert.equal(row.reasonClass, 'http-unreachable');
  assert.equal(row.observedAt, EXPIRED.observedAt);
  assert.equal(row.validUntil, EXPIRED.validUntil);
  const rollup = result.receipt.components.find((c) => c.id === 'openclaw');
  assert.equal(rollup.state, 'repair needed');
  assert.equal(rollup.reasonClass, 'http-unreachable');
  assert.equal(result.receipt.status, 'repair needed');
});
test('v4 an undated healthy check never reads as healthy or rescues an expired row', (t) => {
  const undated = { observedAt: null, validUntil: null };
  const product = { id: 'openclaw', label: 'OpenClaw', maker: 'x', order: 1, version: null, ...v4Row([
    v4Check('memory', EXPIRED),
    v4Check('gateway', undated),
  ]) };
  const { load } = v4ReceiptFile(t, { products: [product], doctor: v4DoctorRow() });
  const result = load();
  assert.equal(result.ok, true, result.error);
  const row = result.receipt.products[0];
  assert.equal(row.checks[1].state, 'warning');
  assert.equal(row.checks[1].reasonClass, 'evidence-time-missing');
  assert.equal(row.state, 'warning');
  assert.equal(result.receipt.components.find((c) => c.id === 'openclaw').state, 'warning');
});
test('v4 an expired failure keeps its state and reason, and a row of one stale healthy check warns', (t) => {
  const products = [
    { id: 'a', label: 'A', maker: 'x', order: 1, version: null, ...v4Row([v4Check('a1', EXPIRED, 'repair needed', 'search-empty')]) },
    { id: 'b', label: 'B', maker: 'x', order: 2, version: null, ...v4Row([v4Check('b1', EXPIRED)]) },
  ];
  const result = v4ReceiptFile(t, { products, doctor: v4DoctorRow() }).load();
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.receipt.products.map((p) => [p.state, p.reasonClass]), [['repair needed', 'search-empty'], ['warning', 'component-stale']]);
  assert.equal(result.receipt.components.find((c) => c.id === 'a').freshness, 'stale');
});
test('v4 doctor block ages each check on its own', (t) => {
  const product = { id: 'a', label: 'A', maker: 'x', order: 1, version: null, ...v4Row([v4Check('a1', FRESH)]) };
  const doctorRow = v4DoctorRow({ 'last-run': EXPIRED, 'alerts': FRESH, alertsState: ['warning', 'alerts-open'] });
  const result = v4ReceiptFile(t, { products: [product], doctor: doctorRow }).load();
  assert.equal(result.ok, true, result.error);
  const block = result.receipt.doctor;
  assert.deepEqual(block.checks.map((c) => [c.part, c.state, c.reasonClass]), [
    ['last-run', 'warning', 'component-stale'], ['reviewed-release', 'healthy', 'none'],
    ['repairs', 'healthy', 'none'], ['alerts', 'warning', 'alerts-open']]);
  assert.equal(block.state, 'warning');
  assert.equal(block.reasonClass, 'component-stale');
  assert.equal(block.observedAt, EXPIRED.observedAt);
  assert.equal(block.validUntil, EXPIRED.validUntil);
  const rollup = result.receipt.components.find((c) => c.rollup === 'doctor');
  assert.equal(rollup.state, 'warning');
  assert.equal(rollup.validUntil, EXPIRED.validUntil);
  assert.equal(result.receipt.products[0].state, 'healthy');
});
test('v4 an expired envelope turns healthy checks module-stale but keeps failures', (t) => {
  const product = { id: 'a', label: 'A', maker: 'x', order: 1, version: null, ...v4Row([
    v4Check('a1', FRESH), v4Check('a2', FRESH, 'repair needed', 'http-unreachable')]) };
  const healthy = { id: 'b', label: 'B', maker: 'x', order: 2, version: null, ...v4Row([v4Check('b1', FRESH)]) };
  const envelope = { observedAt: '2026-09-10T10:00:00.000Z', validUntil: '2026-09-10T11:55:00.000Z' };
  const result = v4ReceiptFile(t, { products: [product, healthy], doctor: v4DoctorRow(), envelope }).load();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.receipt.observations[0].freshness, 'stale');
  const [a, b] = result.receipt.products;
  assert.deepEqual(a.checks.map((c) => [c.state, c.reasonClass]), [['warning', 'module-stale'], ['repair needed', 'http-unreachable']]);
  assert.equal(a.state, 'repair needed');
  assert.deepEqual([b.state, b.reasonClass], ['warning', 'module-stale']);
  assert.ok(result.receipt.doctor.checks.every((c) => c.state === 'warning' && c.reasonClass === 'module-stale'));
  assert.notEqual(result.receipt.status, 'healthy');
});
test('v2 and v3 receipts still reject an expired envelope and age whole components', (t) => {
  const f = fixture(t);
  const file = path.join(f.workspace, 'receipt.json');
  f.cfg.systemDoctor.receiptFile = file;
  for (const factsVersion of [SYSTEM_FACTS_VERSION, 'jarvos-system-doctor-facts/v3']) {
    const dated = factsVersion === SYSTEM_FACTS_VERSION ? {} : EXPIRED;
    const receipt = { schema: doctor.REPORT_SCHEMA, profile: { id: 'local-openclaw', title: 'Local' }, workspace: f.workspace,
      status: 'healthy', factsVersion, ...FRESH,
      components: [{ id: 'core', label: 'Core', section: 'core', state: 'healthy', ...dated }] };
    fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
    const loaded = doctor.loadReceipt(f.cfg, { now });
    assert.equal(loaded.ok, true, factsVersion);
    assert.equal(loaded.receipt.products, undefined);
    assert.equal(loaded.receipt.components[0].state, dated.observedAt ? 'warning' : 'healthy');
    assert.equal(loaded.receipt.components[0].reasonClass, dated.observedAt ? 'component-stale' : 'none');
    assert.equal(doctor.loadReceipt(f.cfg, { now: new Date('2026-09-10T14:00:00Z') }).ok, false, factsVersion);
  }
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
