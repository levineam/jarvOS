'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const systemDoctor = require('../server/adapters/system-doctor');
const { MEMORY_COMPONENTS } = require('../server/vendor/jarvos-doctor-modules');
const { REPORT_SCHEMA, buildSystemDoctorReceipt } = require('../server/vendor/jarvos-system-doctor');

const MEMORY_ORDER = MEMORY_COMPONENTS.map(([id]) => id);

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-desktop-sd-'));
}

function writeSystemSnapshot(workspace, components, { profile = 'local-openclaw', generation = 3 } = {}) {
  const dir = path.join(workspace, '.jarvos', 'health-modules');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const snapshot = {
    schema: 'jarvos-health-module-snapshot/v1',
    moduleId: 'system',
    generation,
    observedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 60 * 60 * 1000).toISOString(),
    trust: 'trusted',
    factsVersion: 'jarvos-system-doctor-facts/v1',
    facts: {
      profile,
      components: components.map((component) => ({
        evidence: null,
        ...component,
      })),
    },
  };
  const filePath = path.join(dir, 'system.json');
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  fs.chmodSync(dir, 0o700);
  return snapshot;
}

function memoryComponents(state = 'healthy') {
  return MEMORY_ORDER.map((id) => ({
    id,
    state,
    reasonClass: state === 'healthy' ? 'none' : 'reported-condition',
    evidence: null,
  }));
}

function providerComponents() {
  return [
    { id: 'provider.gbrain', state: 'healthy', reasonClass: 'none', evidence: null },
    {
      id: 'provider.searxng',
      state: 'healthy',
      reasonClass: 'none',
      evidence: { httpReachable: true, searchResultCount: 2, runtimeToolAvailable: true },
    },
    { id: 'provider.paperclip', state: 'healthy', reasonClass: 'none', evidence: null },
  ];
}

test('validateReceipt accepts jarvos-system-doctor-report/v1 and keeps memory order', () => {
  const receipt = {
    schema: REPORT_SCHEMA,
    profile: { id: 'local-openclaw', title: 'Local OpenClaw' },
    workspace: '/tmp/ws',
    status: 'healthy',
    components: [
      { id: 'path.workspace', label: 'path.workspace', section: 'core', state: 'healthy', reasonClass: 'none', message: null },
      // deliberately reverse memory rows
      ...MEMORY_ORDER.slice().reverse().map((id) => ({
        id,
        label: id,
        section: 'memory',
        state: 'healthy',
        reasonClass: 'none',
        message: null,
      })),
    ],
  };
  const checked = systemDoctor.validateReceipt(receipt);
  assert.equal(checked.ok, true);
  assert.deepEqual(
    checked.receipt.sections.memory.map((row) => row.id),
    MEMORY_ORDER,
  );
});

test('loadReceipt composes public doctor checks with profile-selected optional components', () => {
  const workspace = tempRoot();
  writeSystemSnapshot(workspace, [...providerComponents(), ...memoryComponents('warning')]);

  const doctorReport = {
    ok: false,
    profile: { id: 'local-openclaw', title: 'Local OpenClaw' },
    workspace,
    checks: [
      { component: 'path.workspace', ok: true, status: 'ok', message: 'workspace ok' },
      { component: 'path.vault', ok: false, status: 'fail', message: 'vault missing' },
    ],
  };

  const loaded = systemDoctor.loadReceipt(
    {
      systemDoctor: {
        workspace,
        profile: 'local-openclaw',
        jarvosBin: 'jarvos',
      },
    },
    {
      doctorRunner: () => doctorReport,
    },
  );

  assert.equal(loaded.ok, true);
  assert.equal(loaded.receipt.schema, REPORT_SCHEMA);
  assert.equal(loaded.receipt.profile.id, 'local-openclaw');
  assert.equal(loaded.receipt.status, 'repair needed');

  const coreIds = loaded.receipt.sections.core.map((row) => row.id);
  assert.deepEqual(coreIds, ['path.workspace', 'path.vault']);
  assert.equal(loaded.receipt.sections.core[1].state, 'repair needed');

  const optionalIds = loaded.receipt.sections.optional.map((row) => row.id);
  assert.deepEqual(optionalIds, ['provider.gbrain', 'provider.searxng', 'provider.paperclip']);

  const memoryIds = loaded.receipt.sections.memory.map((row) => row.id);
  assert.deepEqual(memoryIds, MEMORY_ORDER);
  assert.equal(loaded.receipt.sections.memory.length, 10);
  assert.ok(loaded.receipt.sections.memory.every((row) => row.state === 'warning'));
});

test('loadReceipt prefers a published public receipt file and ignores private producer receipts', () => {
  const root = tempRoot();
  const publicPath = path.join(root, 'public-receipt.json');
  const privatePath = path.join(root, 'private-receipt.json');

  const publicReceipt = {
    schema: REPORT_SCHEMA,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: root,
    status: 'healthy',
    components: [
      { id: 'workspace.root', label: 'workspace.root', section: 'core', state: 'healthy', reasonClass: 'none', message: 'ok' },
    ],
  };
  fs.writeFileSync(publicPath, JSON.stringify(publicReceipt));
  fs.writeFileSync(privatePath, JSON.stringify({
    schema: 'jarvos-system-doctor-producer-receipt/v1',
    profile: 'local-openclaw',
    components: [],
  }));

  const fromPublic = systemDoctor.loadReceipt({
    systemDoctor: { receiptFile: publicPath, workspace: root },
  }, { doctorRunner: () => { throw new Error('should not run doctor'); } });
  assert.equal(fromPublic.ok, true);
  assert.equal(fromPublic.receipt.source, 'receipt-file');
  assert.equal(fromPublic.receipt.profile.id, 'minimal');

  const fromPrivate = systemDoctor.loadReceipt({
    systemDoctor: { receiptFile: privatePath, workspace: root },
  }, {
    doctorRunner: () => ({
      ok: true,
      profile: 'minimal',
      workspace: root,
      checks: [{ component: 'workspace.root', ok: true, status: 'ok', message: 'ok' }],
    }),
  });
  assert.equal(fromPrivate.ok, true);
  assert.equal(fromPrivate.receipt.source, 'composed-public');
  assert.equal(fromPrivate.receipt.sections.core[0].id, 'workspace.root');
});

test('buildSystemDoctorReceipt final status surfaces on the normalized Desktop receipt', () => {
  const receipt = buildSystemDoctorReceipt({
    ok: true,
    profile: { id: 'minimal', title: 'Minimal' },
    workspace: '/tmp/ws',
    results: [{ id: 'workspace.root', ok: true, message: 'ok' }],
    modules: [],
  });
  const checked = systemDoctor.validateReceipt(receipt);
  assert.equal(checked.ok, true);
  assert.equal(checked.receipt.status, 'healthy');
});

test('Services page helpers are present in static app bundle', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
  assert.match(app, /\/api\/system-doctor/);
  assert.match(app, /renderSystemDoctorReceipt/);
  assert.match(app, /fixed ten-row order/);
  assert.match(app, /data-section="memory"/);
  assert.match(app, /doctor-final/);
});
