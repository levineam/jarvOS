#!/usr/bin/env node
'use strict';

// Public, CI-safe parity proof. This intentionally never invokes a model or
// reads a local overlay: those are maintainer-local operations with separate
// egress consent. It proves the projection/receipt contract for all adapters.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const skills = require('../src');

const args = new Set(process.argv.slice(2));
if (!args.has('--matrix') || !args.has('--isolated') || args.has('--live')) {
  process.stderr.write('Usage: dogfood-skills.js --matrix --isolated\n');
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
