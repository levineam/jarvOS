'use strict';
const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const test = require('node:test'); const { spawnSync } = require('node:child_process'); const { computeBundleTree } = require('../src');
const CLI = path.join(__dirname, '..', 'scripts', 'dogfood-skills.js');
const PREFLIGHT = path.join(__dirname, '..', 'scripts', 'live-preflight-checklist.js');
function base(root) { const c = { schemaVersion: 'jarvos.shared-skill-config/v1', controlRoot: path.join(root, 'control'), publicCatalogPath: path.join(root, 'control', 'public.json'), publicSourceRoot: path.join(root, 'source'), localOverlayPath: path.join(root, 'control', 'local.json'), localSourceRoot: path.join(root, 'private'), harnesses: {}, scheduler: { enabled: false, intervalMinutes: 60, unitName: 'jarvos-shared-skills' }, liveDogfood: { authorized: false, receiptPath: path.join(root, 'receipt.json'), egress: {} } }; for (const id of ['codex', 'claude', 'openclaw', 'hermes']) c.harnesses[id] = { enabled: true, root: path.join(root, id) }; fs.mkdirSync(path.dirname(c.publicCatalogPath), { recursive: true, mode: 0o700 }); fs.writeFileSync(c.publicCatalogPath, JSON.stringify({ schemaVersion: 'jarvos.shared-skill-catalog/v1', entries: [] })); fs.writeFileSync(c.localOverlayPath, JSON.stringify({ schemaVersion: 'jarvos.shared-skill-local-overlay/v1', entries: [] })); return c; }
test('live dogfood refuses without authorization and writes redacted signed receipt when explicitly authorized', () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-live-')); try { const c = base(root); const cfg = path.join(root, 'config.json'); fs.writeFileSync(cfg, JSON.stringify(c)); let run = spawnSync(process.execPath, [CLI, '--matrix', '--live', `--config=${cfg}`], { encoding: 'utf8' }); assert.notEqual(run.status, 0); c.liveDogfood.authorized = true; fs.writeFileSync(cfg, JSON.stringify(c)); run = spawnSync(process.execPath, [CLI, '--matrix', '--live', `--config=${cfg}`, '--dry-run'], { encoding: 'utf8' }); assert.equal(run.status, 0, run.stderr); const receipt = JSON.parse(fs.readFileSync(c.liveDogfood.receiptPath, 'utf8')); assert.equal(receipt.schemaVersion, 'jarvos.shared-skill-live-matrix/v1'); assert.ok(receipt.signature); assert.equal(JSON.stringify(receipt).includes(root), false); } finally { fs.rmSync(root, { recursive: true, force: true }); } });

test('live dogfood requires explicit per-harness egress for a private overlay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-live-private-'));
  try {
    const c = base(root); const cfg = path.join(root, 'config.json');
    const bundle = path.join(c.localSourceRoot, 'private-fixture');
    fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bundle, 'SKILL.md'), '---\nname: private-fixture\n---\nprivate\n', { mode: 0o600 });
    const tree = computeBundleTree(bundle, { allowlist: ['SKILL.md'] });
    fs.writeFileSync(c.localOverlayPath, JSON.stringify({ schemaVersion: 'jarvos.shared-skill-local-overlay/v1', entries: [{ id: 'private-fixture', allowedHarnesses: ['hermes'], bundle: { root: 'private-fixture', allowlist: ['SKILL.md'], treeDigest: tree.treeDigest } }] }));
    c.liveDogfood.authorized = true; fs.writeFileSync(cfg, JSON.stringify(c));
    let run = spawnSync(process.execPath, [CLI, '--matrix', '--live', `--config=${cfg}`, '--dry-run'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0); assert.match(run.stderr, /explicit egress authorization/);
    c.liveDogfood.egress.hermes = true; fs.writeFileSync(cfg, JSON.stringify(c));
    run = spawnSync(process.execPath, [CLI, '--matrix', '--live', `--config=${cfg}`, '--dry-run'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(fs.readFileSync(c.liveDogfood.receiptPath, 'utf8'));
    assert.deepEqual(receipt.pairs, [{ id: 'private-fixture', harness: 'hermes', sourceKind: 'local-overlay', treeDigest: tree.treeDigest, status: 'preflight_only' }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live preflight stays non-activating with informational runtime-activation status', () => {
  const result = spawnSync(process.execPath, [PREFLIGHT, '--json'], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.activating, false);
  assert.equal(report.readOnly, true);
  const byId = Object.fromEntries(report.items.map((item) => [item.id, item]));
  assert.equal(byId['live-harness-gates'].status, 'off');
  assert.ok(byId['runtime-activation']);
  assert.notEqual(byId['runtime-activation'].status, 'fail');
  assert.ok(Array.isArray(byId['runtime-activation'].evidence?.statuses));
  assert.equal(byId['runtime-activation'].evidence.activating, false);
  assert.equal(byId['runtime-activation'].evidence.readOnly, true);
});
