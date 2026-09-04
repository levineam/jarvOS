'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const systemDoctor = require('../server/adapters/system-doctor');
const { MEMORY_COMPONENTS, SYSTEM_FACTS_VERSION } = require('../server/vendor/jarvos-doctor-modules');
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
    factsVersion: SYSTEM_FACTS_VERSION,
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
      state: 'warning',
      reasonClass: 'search-empty',
      evidence: { httpReachable: true, searchResultCount: 0, runtimeToolAvailable: true },
    },
    { id: 'provider.paperclip', state: 'healthy', reasonClass: 'none', evidence: null },
  ];
}

test('vendored Memory order is the exact eleven-row facts/v2 roster', () => {
  assert.equal(SYSTEM_FACTS_VERSION, 'jarvos-system-doctor-facts/v2');
  assert.deepEqual(MEMORY_ORDER, [
    'memory.gbrain',
    'memory.gbrain-semantic-coverage',
    'memory.lossless-claw',
    'memory.qmd-search',
    'memory.memory-wiki',
    'memory.notes-provenance',
    'memory.recall-evaluation',
    'memory.scheduled-maintenance',
    'memory.runtime-checkout',
    'memory.automatic-repair',
    'memory.notification-follow-up',
  ]);
  assert.equal(MEMORY_ORDER.length, 11);
  assert.equal(systemDoctor.MEMORY_LABELS['memory.gbrain'], 'GBrain core');
  assert.equal(systemDoctor.MEMORY_LABELS['memory.gbrain-semantic-coverage'], 'GBrain semantic coverage');
});

test('validateReceipt keeps eleven-row Memory order and attaches degraded guidance', () => {
  const receipt = {
    schema: REPORT_SCHEMA,
    profile: { id: 'local-openclaw', title: 'Local OpenClaw' },
    workspace: '/tmp/ws',
    status: 'healthy',
    components: [
      { id: 'path.workspace', label: 'path.workspace', section: 'core', state: 'healthy', reasonClass: 'none', message: null },
      {
        id: 'provider.searxng',
        label: 'SearXNG',
        section: 'optional',
        state: 'warning',
        reasonClass: 'search-empty',
        message: null,
      },
      ...MEMORY_ORDER.slice().reverse().map((id) => ({
        id,
        label: systemDoctor.MEMORY_LABELS[id] || id,
        section: 'memory',
        state: 'healthy',
        reasonClass: 'none',
        message: null,
      })),
    ],
  };
  const checked = systemDoctor.validateReceipt(receipt);
  assert.equal(checked.ok, true);
  assert.equal(checked.receipt.presentation, 'compact-scoreboard');
  assert.equal(checked.receipt.factsVersion, SYSTEM_FACTS_VERSION);
  assert.deepEqual(
    checked.receipt.sections.memory.map((row) => row.id),
    MEMORY_ORDER,
  );
  assert.equal(checked.receipt.sections.memory.length, 11);
  const searx = checked.receipt.sections.optional.find((row) => row.id === 'provider.searxng');
  assert.equal(searx.label, 'SearXNG');
  assert.match(searx.guidance, /No search results/);
});

test('loadReceipt composes public doctor checks with equal Services visibility for SearXNG', () => {
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
  assert.match(loaded.receipt.sections.core[1].guidance, /Fix it, then rerun Doctor/);

  const optionalIds = loaded.receipt.sections.optional.map((row) => row.id);
  assert.deepEqual(optionalIds, ['provider.gbrain', 'provider.searxng', 'provider.paperclip']);
  // SearXNG is a peer Services row — same section, same compact row shape.
  const searx = loaded.receipt.sections.optional.find((row) => row.id === 'provider.searxng');
  assert.equal(searx.section, 'optional');
  assert.equal(searx.state, 'warning');
  assert.match(searx.guidance, /No search results/);

  const memoryIds = loaded.receipt.sections.memory.map((row) => row.id);
  assert.deepEqual(memoryIds, MEMORY_ORDER);
  assert.equal(loaded.receipt.sections.memory.length, 11);
  assert.equal(loaded.receipt.sections.memory[0].label, 'GBrain core');
  assert.equal(loaded.receipt.sections.memory[1].label, 'GBrain semantic coverage');
});

test('compactRows is one icon per component without PASS/FAIL/final-status copy', () => {
  const workspace = tempRoot();
  writeSystemSnapshot(workspace, [...providerComponents(), ...memoryComponents()]);
  const loaded = systemDoctor.loadReceipt(
    { systemDoctor: { workspace, profile: 'local-openclaw' } },
    {
      doctorRunner: () => ({
        ok: true,
        profile: { id: 'local-openclaw', title: 'Local OpenClaw' },
        workspace,
        checks: [{ component: 'workspace.root', ok: true, status: 'ok', message: 'ok' }],
      }),
    },
  );
  const rows = systemDoctor.compactRows(loaded.receipt);
  assert.ok(rows.length >= 1 + 3 + 11);
  assert.ok(rows.every((row) => row.icon === 'ok' || row.icon === 'warn' || row.icon === 'bad'));
  assert.ok(rows.every((row) => !/PASS|FAIL|READY|NOT READY/.test(JSON.stringify(row))));
  const searx = rows.find((row) => row.id === 'provider.searxng');
  assert.equal(searx.sectionLabel, 'Services');
  assert.equal(searx.icon, 'warn');
  assert.match(searx.guidance, /No search results/);
  const memory = rows.filter((row) => row.section === 'memory');
  assert.equal(memory.length, 11);
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

test('Services page renders compact scoreboard without PASS/FAIL/READY wording', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'static', 'app.js'), 'utf8');
  assert.match(app, /\/api\/system-doctor/);
  assert.match(app, /renderSystemDoctorReceipt/);
  assert.match(app, /fixed eleven-row order/);
  assert.match(app, /compact-scoreboard/);
  assert.match(app, /doctor-icon/);
  assert.match(app, /data-section="\$\{key === 'optional' \? 'services' : key\}"/);
  assert.doesNotMatch(app, /PASS|FAIL|NOT READY|doctor-final|ten-row/);
});

test('live workspace snapshot composes an eleven-row Desktop receipt (rendered behavior proof)', () => {
  const workspace = '/Users/andrew/clawd';
  if (!fs.existsSync(path.join(workspace, '.jarvos', 'health-modules', 'system.json'))) {
    return; // skip when host snapshot is absent
  }
  const loaded = systemDoctor.loadReceipt(
    {
      systemDoctor: {
        workspace,
        profile: 'local-openclaw',
        jarvosBin: 'jarvos',
      },
    },
    {
      // Avoid long live doctor; core empty is fine for Memory/Services proof.
      doctorRunner: () => ({
        ok: true,
        profile: { id: 'local-openclaw', title: 'Local OpenClaw' },
        workspace,
        checks: [{ component: 'workspace.root', ok: true, status: 'ok', message: 'ok' }],
      }),
    },
  );
  assert.equal(loaded.ok, true);
  assert.equal(loaded.receipt.sections.memory.length, 11);
  assert.deepEqual(
    loaded.receipt.sections.memory.map((row) => row.id),
    MEMORY_ORDER,
  );
  const rows = systemDoctor.compactRows(loaded.receipt);
  const searx = rows.find((row) => row.id === 'provider.searxng');
  assert.ok(searx, 'SearXNG must be visible as a Services peer when selected');
  assert.equal(searx.sectionLabel, 'Services');
  assert.ok(rows.every((row) => !/PASS|FAIL|READY/.test(`${row.label}${row.guidance || ''}`)));
  // Proof artifact for the issue thread
  const proofPath = path.join(__dirname, '..', 'test', 'fixtures', 'system-doctor-rendered-proof.json');
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, `${JSON.stringify({
    schema: loaded.receipt.schema,
    factsVersion: loaded.receipt.factsVersion,
    presentation: loaded.receipt.presentation,
    status: loaded.receipt.status,
    memoryIds: loaded.receipt.sections.memory.map((row) => row.id),
    memoryLabels: loaded.receipt.sections.memory.map((row) => row.label),
    services: loaded.receipt.sections.optional.map((row) => ({
      id: row.id,
      label: row.label,
      state: row.state,
      guidance: row.guidance,
    })),
    compactRows: rows,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
});
