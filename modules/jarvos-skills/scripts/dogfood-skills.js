#!/usr/bin/env node
'use strict';

// Public, CI-safe parity proof. This intentionally never invokes a model or
// reads a local overlay: those are maintainer-local operations with separate
// egress consent. It proves the projection/receipt contract for all adapters.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const skills = require('../src');
const { loadConfig } = require('../src/config');

const args = new Set(process.argv.slice(2));
const configArg = process.argv.slice(2).find((arg) => arg.startsWith('--config='));
function liveReceipt(payload, receiptPath) {
  const unsigned = { schemaVersion: 'jarvos.shared-skill-live-matrix/v1', ...payload };
  const signature = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  const receipt = { ...unsigned, signature };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}
function runLive() {
  if (!configArg) throw new Error('live dogfood requires --config=PATH');
  const loaded = loadConfig(configArg.slice('--config='.length)); const live = loaded.config.liveDogfood;
  if (!live?.authorized) throw new Error('live dogfood requires explicit liveDogfood.authorized=true');
  if (!live.receiptPath) throw new Error('live dogfood requires liveDogfood.receiptPath');
  const resolved = loaded.resolved; const publicCatalog = JSON.parse(fs.readFileSync(resolved.publicCatalogPath, 'utf8'));
  const localOverlay = resolved.localOverlayPath && fs.existsSync(resolved.localOverlayPath) ? JSON.parse(fs.readFileSync(resolved.localOverlayPath, 'utf8')) : { schemaVersion: skills.OVERLAY_SCHEMA_VERSION, entries: [] };
  const effective = skills.composeEffectiveCatalog({ publicCatalog, localOverlay });
  if (effective.status !== 'valid') throw new Error(effective.reason || 'effective catalog is invalid');
  const selectedHarnesses = resolved.harnesses.filter((h) => h.enabled);
  for (const entry of effective.catalog.entries) for (const harness of entry.allowedHarnesses) {
    if (!selectedHarnesses.some((h) => h.id === harness)) continue;
    if (entry.sourceKind === 'local-overlay' && live.egress?.[harness] !== true) throw new Error(`live dogfood requires explicit egress authorization for private ${entry.id}/${harness}`);
  }
  const dryRun = args.has('--dry-run'); const pairs = effective.catalog.pairs.filter((pair) => selectedHarnesses.some((h) => h.id === pair.harness)).map((pair) => ({ id: pair.id, harness: pair.harness, sourceKind: pair.sourceKind, treeDigest: pair.treeDigest, status: dryRun ? 'preflight_only' : 'verification_pending' }));
  const receipt = liveReceipt({ mode: 'live', dryRun, catalogDigest: effective.digest, pairCount: pairs.length, pairs, generatedAt: new Date().toISOString() }, path.resolve(live.receiptPath));
  process.stdout.write(`${JSON.stringify({ mode: 'live', dryRun, catalogDigest: receipt.catalogDigest, pairCount: receipt.pairCount, receiptPath: receiptPathForOutput(live.receiptPath), signature: receipt.signature })}\n`);
}
function receiptPathForOutput(value) { return value.startsWith(os.homedir()) ? `~${value.slice(os.homedir().length)}` : value; }
if (args.has('--matrix') && args.has('--live')) {
  try { runLive(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
} else if (!args.has('--matrix') || !args.has('--isolated') || args.has('--live')) {
  process.stderr.write('Usage: dogfood-skills.js --matrix --isolated | --matrix --live --config=PATH [--dry-run]\n');
  process.exitCode = 2;
} else {
  const moduleRoot = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(moduleRoot, '..', '..');
  const fixtureRoot = path.join(moduleRoot, 'test', 'fixtures', 'catalog');
  const fixtureTree = skills.computeBundleTree(path.join(fixtureRoot, 'public-fixture'), {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const effective = skills.composeEffectiveCatalog({
    publicCatalog: {
      schemaVersion: skills.CATALOG_SCHEMA_VERSION,
      entries: [{
        id: 'public-fixture',
        allowedHarnesses: ['codex', 'claude', 'openclaw', 'hermes'],
        bundle: { root: 'public-fixture', allowlist: ['SKILL.md', 'scripts/**', 'assets/**'], treeDigest: fixtureTree.treeDigest },
      }],
    },
    localOverlay: { schemaVersion: skills.OVERLAY_SCHEMA_VERSION, entries: [] },
  });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-skills-matrix-'));
  fs.chmodSync(temp, 0o700);
  try {
    const harnesses = ['codex', 'claude', 'openclaw', 'hermes'].map((id) => ({
      id,
      root: path.join(temp, id),
      adapter: JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtimes', id, 'adapter.json'), 'utf8')),
    }));
    const plan = skills.planCatalogReconciliation({
      catalog: effective.catalog,
      publicSourceRoot: fixtureRoot,
      controlRoot: path.join(temp, 'control'),
      harnesses,
    });
    const applied = skills.applyCatalogReconciliation(plan);
    const pairs = harnesses.map((harness) => {
      const targetPath = path.join(harness.root, 'public-fixture');
      const proof = skills.verifyHarnessBundle({
        adapter: harness.adapter,
        targetPath,
        expectedName: 'public-fixture',
        expectedTreeDigest: fixtureTree.treeDigest,
      });
      // Claude's declared interactive proof cannot be fabricated in CI. Its
      // receipt-owned containment is the strongest truthful isolated result.
      const satisfied = proof.status === 'model_visible' || (harness.id === 'claude' && proof.status === 'verification_pending');
      return { harness: harness.id, installed: fs.existsSync(path.join(targetPath, 'SKILL.md')), verification: proof.status, satisfied };
    });
    const second = skills.planCatalogReconciliation({ catalog: effective.catalog, publicSourceRoot: fixtureRoot, controlRoot: path.join(temp, 'control'), harnesses });
    const result = { mode: 'isolated', catalogDigest: effective.digest, applied: applied.applied.filter((item) => item.applied).length, pairs, secondRunNoop: second.pairs.every((pair) => pair.status === 'clean') };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.secondRunNoop || pairs.some((pair) => !pair.installed || !pair.satisfied)) process.exitCode = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
