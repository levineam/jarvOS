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
const { atomicWriteJson, collapseHome, expandHome, loadConfig } = require('../src/config');

const args = new Set(process.argv.slice(2));
const configArg = process.argv.slice(2).find((arg) => arg.startsWith('--config='));
function liveReceipt(payload, receiptPath) {
  const unsigned = { schemaVersion: 'jarvos.shared-skill-live-matrix/v1', ...payload };
  const signature = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  const receipt = { ...unsigned, signature };
  atomicWriteJson(receiptPath, receipt);
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
  const receiptPath = path.resolve(expandHome(live.receiptPath));
  const receipt = liveReceipt({ mode: 'live', dryRun, catalogDigest: effective.digest, pairCount: pairs.length, pairs, generatedAt: new Date().toISOString() }, receiptPath);
  process.stdout.write(`${JSON.stringify({ mode: 'live', dryRun, catalogDigest: receipt.catalogDigest, pairCount: receipt.pairCount, receiptPath: receiptPathForOutput(receiptPath), signature: receipt.signature })}\n`);
}
function receiptPathForOutput(value) { return collapseHome(expandHome(value)); }
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
      scopeRoots: id === 'codex' ? { project: path.join(temp, 'codex-project'), user: path.join(temp, 'codex-user') }
        : id === 'openclaw' ? { workspace: path.join(temp, 'openclaw-workspace'), user: path.join(temp, 'openclaw-user') }
          : id === 'hermes' ? { workspace: path.join(temp, 'hermes-workspace'), user: path.join(temp, 'hermes-user') }
            : { project: path.join(temp, 'claude-project'), user: path.join(temp, 'claude-user') },
      scopeRootsComplete: true,
      adapter: JSON.parse(fs.readFileSync(path.join(repoRoot, 'runtimes', id, 'adapter.json'), 'utf8')),
    }));
    const plan = skills.planCatalogReconciliation({
      catalog: effective.catalog,
      publicSourceRoot: fixtureRoot,
      controlRoot: path.join(temp, 'control'),
      harnesses,
    });
    const freshDiscovery = ({ harness }) => ({
      fresh: true,
      source: 'isolated-native-discovery-fixture',
      tuples: plan.pairs.filter((pair) => pair.harness === harness.id).map((pair) => ({
        id: pair.id,
        catalogRelease: pair.catalogRelease,
        treeDigest: pair.treeDigest,
      })),
    });
    const applied = skills.applyCatalogReconciliation(plan, { freshDiscovery });
    const shadowChecks = harnesses.filter((harness) => harness.adapter.skillProjection.verificationTier === 'exact-path').map((harness) => {
      const shadowPaths = skills.resolveShadowPaths({ harness, adapter: harness.adapter, effectiveName: 'public-fixture' });
      const shadowRoot = shadowPaths.paths[0];
      if (!shadowRoot) throw new Error(`missing declared higher-precedence scope for ${harness.id}`);
      fs.mkdirSync(shadowRoot, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(shadowRoot, 'SKILL.md'), 'unmanaged shadow\n', { mode: 0o600 });
      const proof = skills.verifyHarnessBundle({ adapter: harness.adapter, targetPath: path.join(harness.root, 'public-fixture'), expectedName: 'public-fixture', expectedTreeDigest: fixtureTree.treeDigest, shadowPaths: shadowPaths.paths, shadowPathsComplete: shadowPaths.complete });
      fs.rmSync(path.dirname(shadowRoot), { recursive: true, force: true }); return { harness: harness.id, status: proof.status, reason: proof.reason };
    });
    const pairs = harnesses.map((harness) => {
      const targetPath = path.join(harness.root, 'public-fixture');
      const shadowPaths = skills.resolveShadowPaths({ harness, adapter: harness.adapter, effectiveName: 'public-fixture' });
      const proof = skills.verifyHarnessBundle({
        adapter: harness.adapter,
        targetPath,
        expectedName: 'public-fixture',
        expectedTreeDigest: fixtureTree.treeDigest,
        shadowPaths: shadowPaths.paths,
        shadowPathsComplete: shadowPaths.complete,
      });
      // Claude's declared interactive proof cannot be fabricated in CI. Its
      // receipt-owned containment is the strongest truthful isolated result.
      const satisfied = proof.status === 'model_visible' || (harness.id === 'claude' && proof.status === 'verification_pending');
      const receipts = plan.pairs.filter((pair) => pair.harness === harness.id).map((pair) => skills.readReceipt(harness.root, pair.effectiveName));
      const observedEqualDesired = receipts.every((receipt) => receipt?.status !== 'model_visible'
        || receipt.desiredSetDigest === receipt.observedSetDigest);
      return { harness: harness.id, installed: fs.existsSync(path.join(targetPath, 'SKILL.md')), verification: proof.status, observedEqualDesired, satisfied: satisfied && observedEqualDesired };
    });
    const second = skills.planCatalogReconciliation({ catalog: effective.catalog, publicSourceRoot: fixtureRoot, controlRoot: path.join(temp, 'control'), harnesses });
    const result = { mode: 'isolated', catalogDigest: effective.digest, applied: applied.applied.filter((item) => item.applied).length, pairs, shadowChecks, secondRunNoop: second.pairs.every((pair) => pair.status === 'clean') };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.secondRunNoop || pairs.some((pair) => !pair.installed || !pair.satisfied) || shadowChecks.some((check) => check.reason !== 'higher_precedence_shadow')) process.exitCode = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
