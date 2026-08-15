'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CATALOG_SCHEMA_VERSION,
  OVERLAY_SCHEMA_VERSION,
  attestCatalogBundle,
  computeBundleTree,
  composeEffectiveCatalog,
} = require('../src/catalog');
const { resolveCollisionAlias, safeAliasCandidates, strictChoice } = require('../src/collision-alias');
const { planCatalogReconciliation, applyCatalogReconciliation, recoverJournal } = require('../src/reconciliation');
const { verifyHarnessBundle } = require('../src/harness-verification');
const { readReceipt, validateReceipt, removeReceipt } = require('../src/receipts');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'catalog');
const PUBLIC_FIXTURE = path.join(FIXTURE_ROOT, 'public-fixture');
const PRIVATE_FIXTURE = path.join(FIXTURE_ROOT, 'private-fixture');

function temp(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function copyFixture(from, to) {
  fs.cpSync(from, to, { recursive: true });
  const walk = (dir) => {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else fs.chmodSync(full, 0o600);
    }
  };
  walk(to);
}

function buildCatalog() {
  const publicTree = computeBundleTree(PUBLIC_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const privateTree = computeBundleTree(PRIVATE_FIXTURE, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  const effective = composeEffectiveCatalog({
    publicCatalog: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      entries: [{
        id: 'public-fixture',
        allowedHarnesses: ['codex', 'claude', 'openclaw', 'hermes'],
        bundle: {
          root: 'public-fixture',
          allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
          treeDigest: publicTree.treeDigest,
        },
      }],
    },
    localOverlay: {
      schemaVersion: OVERLAY_SCHEMA_VERSION,
      entries: [{
        id: 'private-fixture',
        allowedHarnesses: ['codex', 'hermes'],
        bundle: {
          root: 'private-fixture',
          allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
          treeDigest: privateTree.treeDigest,
        },
      }],
    },
  });
  assert.equal(effective.status, 'valid');
  return effective;
}

function buildPublicCatalogFrom(sourceRoot, allowedHarnesses = ['codex']) {
  const tree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
  });
  return composeEffectiveCatalog({
    publicCatalog: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      entries: [{
        id: 'public-fixture',
        allowedHarnesses,
        bundle: {
          root: 'public-fixture',
          allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
          treeDigest: tree.treeDigest,
        },
      }],
    },
    localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
  });
}

function harnesses(roots) {
  return Object.entries(roots).map(([id, root]) => ({ id, root }));
}

test('collision alias prefers canonical, then reviewer, then deterministic fallback', () => {
  assert.equal(resolveCollisionAlias({ canonicalId: 'transcribe' }).effectiveName, 'transcribe');
  const candidates = safeAliasCandidates('transcribe', { occupiedNames: ['transcribe'] });
  assert.ok(candidates.includes('jarvos-transcribe'));
  assert.equal(strictChoice(JSON.stringify({ name: candidates[1] }), candidates), candidates[1]);
  assert.equal(strictChoice(JSON.stringify({ name: 'evil' }), candidates), null);

  const reviewed = resolveCollisionAlias({
    canonicalId: 'transcribe',
    occupiedNames: ['transcribe'],
    reviewer: (request) => JSON.stringify({ name: request.candidates[1] }),
  });
  assert.equal(reviewed.source, 'reviewer');
  assert.equal(reviewed.effectiveName, candidates[1]);

  const fallback = resolveCollisionAlias({
    canonicalId: 'transcribe',
    occupiedNames: ['transcribe'],
    reviewer: () => 'not-json',
  });
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.effectiveName, candidates[0]);
});

test('failed replacement journal restores the preserved backup before replanning', () => {
  const root = temp('jarvos-recovery-');
  const target = path.join(root, 'portable-skill');
  const backup = path.join(root, '.portable-skill.jarvos-bak-1234-abcd');
  const journalFile = path.join(root, 'shared-skill-reconcile.journal.json');
  fs.mkdirSync(backup, { mode: 0o700 });
  fs.writeFileSync(path.join(backup, 'SKILL.md'), '# preserved\n', { mode: 0o600 });
  fs.writeFileSync(journalFile, `${JSON.stringify({
    version: 1,
    phase: 'failed',
    recovery: { target, backup },
  })}\n`, { mode: 0o600 });

  const recovered = recoverJournal({ journalFile });
  assert.equal(recovered.recovered, true);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(backup), false);
  assert.equal(fs.existsSync(journalFile), false);
  assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), '# preserved\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('receipt failure persists replacement recovery when immediate backup restore also fails', () => {
  const control = temp('jarvos-receipt-rollback-control-');
  const sourceRoot = temp('jarvos-receipt-rollback-source-');
  const codex = temp('jarvos-receipt-rollback-codex-');
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const firstCatalog = buildPublicCatalogFrom(sourceRoot);
    applyCatalogReconciliation(planCatalogReconciliation({
      catalog: firstCatalog.catalog,
      catalogDigest: firstCatalog.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses({ codex }),
      controlRoot: control,
    }));
    const initialTarget = path.join(codex, 'public-fixture');
    const originalBody = fs.readFileSync(path.join(initialTarget, 'SKILL.md'), 'utf8');
    fs.appendFileSync(path.join(sourceRoot, 'public-fixture', 'SKILL.md'), '\nupdated\n');
    const updatedCatalog = buildPublicCatalogFrom(sourceRoot);
    const plan = planCatalogReconciliation({
      catalog: updatedCatalog.catalog,
      catalogDigest: updatedCatalog.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses({ codex }),
      controlRoot: control,
    });
    assert.equal(plan.pairs[0].status, 'outdated');
    const target = plan.pairs[0].target;

    assert.throws(() => applyCatalogReconciliation(plan, {
      io: {
        writeReceipt() { throw new Error('fixture receipt write failed'); },
        rollbackRenameSync() { throw new Error('fixture backup restore failed'); },
      },
    }), /receipt write failed/);

    const journal = JSON.parse(fs.readFileSync(plan.journalFile, 'utf8'));
    assert.equal(journal.phase, 'failed');
    assert.equal(journal.recovery.target, target);
    assert.equal(fs.existsSync(journal.recovery.backup), true);
    assert.equal(fs.existsSync(target), false);

    const heldBackup = `${journal.recovery.backup}.held`;
    fs.renameSync(journal.recovery.backup, heldBackup);
    assert.throws(
      () => recoverJournal({ journalFile: plan.journalFile }),
      /backup recovery is unavailable/,
    );
    assert.equal(fs.existsSync(plan.journalFile), true, 'failed recovery must preserve the journal');
    fs.renameSync(heldBackup, journal.recovery.backup);
    recoverJournal({ journalFile: plan.journalFile });
    assert.equal(fs.existsSync(plan.journalFile), false);
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), originalBody);
  } finally {
    for (const dir of [control, sourceRoot, codex]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-harness retirement rolls back every prior pair when a later receipt removal fails', () => {
  const control = temp('jarvos-retire-rollback-control-');
  const sourceRoot = temp('jarvos-retire-rollback-source-');
  const codex = temp('jarvos-retire-rollback-codex-');
  const hermes = temp('jarvos-retire-rollback-hermes-');
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const selected = buildPublicCatalogFrom(sourceRoot, ['codex', 'hermes']);
    applyCatalogReconciliation(planCatalogReconciliation({
      catalog: selected.catalog,
      catalogDigest: selected.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses({ codex, hermes }),
      controlRoot: control,
    }));
    const empty = composeEffectiveCatalog({
      publicCatalog: { schemaVersion: CATALOG_SCHEMA_VERSION, entries: [] },
      localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
    });
    const plan = planCatalogReconciliation({
      catalog: empty.catalog,
      catalogDigest: empty.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses({ codex, hermes }),
      controlRoot: control,
    });
    assert.equal(plan.pairs.filter((pair) => pair.action === 'retire').length, 2);
    let removals = 0;
    assert.throws(() => applyCatalogReconciliation(plan, {
      io: {
        removeReceipt(root, effectiveName) {
          removals += 1;
          if (removals === 2) throw new Error('fixture second retirement failed');
          return removeReceipt(root, effectiveName);
        },
      },
    }), /second retirement failed/);

    for (const root of [codex, hermes]) {
      assert.equal(fs.existsSync(path.join(root, 'public-fixture', 'SKILL.md')), true);
      assert.ok(validateReceipt(readReceipt(root, 'public-fixture')));
      assert.equal(fs.readdirSync(root).some((name) => name.includes('.jarvos-retire-')), false);
    }
    const journal = JSON.parse(fs.readFileSync(plan.journalFile, 'utf8'));
    assert.equal(journal.phase, 'failed');
    assert.equal(journal.retirements.length, 2);
    recoverJournal({ journalFile: plan.journalFile });
    assert.equal(fs.existsSync(plan.journalFile), false);
  } finally {
    for (const dir of [control, sourceRoot, codex, hermes]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('committed multi-harness retirement replays remaining backup cleanup without rollback', () => {
  const control = temp('jarvos-retire-cleanup-control-');
  const sourceRoot = temp('jarvos-retire-cleanup-source-');
  const codex = temp('jarvos-retire-cleanup-codex-');
  const hermes = temp('jarvos-retire-cleanup-hermes-');
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const selected = buildPublicCatalogFrom(sourceRoot, ['codex', 'hermes']);
    applyCatalogReconciliation(planCatalogReconciliation({
      catalog: selected.catalog,
      catalogDigest: selected.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses({ codex, hermes }),
      controlRoot: control,
    }));
    const empty = composeEffectiveCatalog({
      publicCatalog: { schemaVersion: CATALOG_SCHEMA_VERSION, entries: [] },
      localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
    });
    const plan = planCatalogReconciliation({
      catalog: empty.catalog,
      catalogDigest: empty.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses({ codex, hermes }),
      controlRoot: control,
    });
    let cleanups = 0;
    assert.throws(() => applyCatalogReconciliation(plan, {
      io: {
        cleanupRetirementBackup(backup) {
          cleanups += 1;
          if (cleanups === 2) throw new Error('fixture later cleanup failed');
          fs.rmSync(backup, { recursive: true, force: true });
        },
      },
    }), /later cleanup failed/);

    const journal = JSON.parse(fs.readFileSync(plan.journalFile, 'utf8'));
    assert.equal(journal.phase, 'retirements_committed');
    assert.equal(journal.retirements.length, 2);
    assert.equal(fs.existsSync(journal.retirements[0].backup), false);
    assert.equal(fs.existsSync(journal.retirements[1].backup), true);
    for (const root of [codex, hermes]) {
      assert.equal(fs.existsSync(path.join(root, 'public-fixture')), false);
      assert.equal(validateReceipt(readReceipt(root, 'public-fixture')), null);
    }

    recoverJournal({ journalFile: plan.journalFile });
    assert.equal(fs.existsSync(plan.journalFile), false);
    assert.equal(fs.existsSync(journal.retirements[1].backup), false);
    for (const root of [codex, hermes]) {
      assert.equal(fs.existsSync(path.join(root, 'public-fixture')), false);
      assert.equal(validateReceipt(readReceipt(root, 'public-fixture')), null);
    }
  } finally {
    for (const dir of [control, sourceRoot, codex, hermes]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multiple skills across four harnesses install once and stay clean on second reconcile', () => {
  const control = temp('jarvos-recon-control-');
  const sourceRoot = temp('jarvos-recon-source-');
  const roots = {
    codex: temp('jarvos-recon-codex-'),
    claude: temp('jarvos-recon-claude-'),
    openclaw: temp('jarvos-recon-openclaw-'),
    hermes: temp('jarvos-recon-hermes-'),
  };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    copyFixture(PRIVATE_FIXTURE, path.join(sourceRoot, 'private-fixture'));
    const effective = buildCatalog();

    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      localSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
    });
    assert.equal(plan.pairs.filter((pair) => pair.status === 'missing').length, 6);
    const applied = applyCatalogReconciliation(plan);
    assert.equal(applied.applied.filter((item) => item.applied).length, 6);

    for (const harness of ['codex', 'claude', 'openclaw', 'hermes']) {
      assert.equal(fs.existsSync(path.join(roots[harness], 'public-fixture', 'SKILL.md')), true);
      assert.equal(fs.existsSync(path.join(roots[harness], 'public-fixture', 'scripts', 'hello.js')), true);
    }
    assert.equal(fs.existsSync(path.join(roots.codex, 'private-fixture', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(roots.claude, 'private-fixture')), false);

    const second = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      localSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
    });
    assert.ok(second.pairs.every((pair) => pair.status === 'clean'));
    const secondApply = applyCatalogReconciliation(second);
    assert.ok(secondApply.applied.every((item) => item.applied === false));
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('planning attests one catalog source once across eligible harnesses', () => {
  const control = temp('jarvos-recon-attestation-control-');
  const sourceRoot = temp('jarvos-recon-attestation-source-');
  const roots = { codex: temp('jarvos-recon-attestation-codex-'), claude: temp('jarvos-recon-attestation-claude-'), hermes: temp('jarvos-recon-attestation-hermes-') };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const tree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), { allowlist: ['SKILL.md', 'scripts/**', 'assets/**'] });
    const catalog = { entries: [{ id: 'public-fixture', allowedHarnesses: ['codex', 'claude', 'hermes'], bundle: { root: 'public-fixture', allowlist: ['SKILL.md', 'scripts/**', 'assets/**'], treeDigest: tree.treeDigest } }] };
    let attestations = 0;
    const plan = planCatalogReconciliation({
      catalog,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
      attestCatalogBundle: (...args) => { attestations += 1; return attestCatalogBundle(...args); },
    });
    assert.equal(plan.pairs.length, 3);
    assert.equal(attestations, 1);
  } finally {
    fs.rmSync(control, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unmanaged same-name incumbent is preserved and portable skill gets one durable alias', () => {
  const control = temp('jarvos-recon-alias-control-');
  const sourceRoot = temp('jarvos-recon-alias-source-');
  const roots = {
    codex: temp('jarvos-recon-alias-codex-'),
    hermes: temp('jarvos-recon-alias-hermes-'),
  };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    // Incumbent only on codex under the canonical name.
    const incumbent = path.join(roots.codex, 'public-fixture');
    fs.mkdirSync(incumbent, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(incumbent, 'SKILL.md'), '---\nname: public-fixture\n---\nincumbent\n', { mode: 0o600 });

    const publicTree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const effective = composeEffectiveCatalog({
      publicCatalog: {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entries: [{
          id: 'public-fixture',
          allowedHarnesses: ['codex', 'hermes'],
          bundle: {
            root: 'public-fixture',
            allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
            treeDigest: publicTree.treeDigest,
          },
        }],
      },
    });

    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
      reviewer: (request) => JSON.stringify({ name: request.candidates[0] }),
    });
    assert.equal(plan.aliases['public-fixture'], 'jarvos-public-fixture');
    assert.ok(plan.notices.some((notice) => notice.effectiveName === 'jarvos-public-fixture'));
    applyCatalogReconciliation(plan);

    assert.equal(fs.readFileSync(path.join(roots.codex, 'public-fixture', 'SKILL.md'), 'utf8').includes('incumbent'), true);
    assert.equal(fs.existsSync(path.join(roots.codex, 'jarvos-public-fixture', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(roots.hermes, 'jarvos-public-fixture', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(roots.hermes, 'public-fixture')), false);

    const again = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
    });
    assert.equal(again.aliases['public-fixture'], 'jarvos-public-fixture');
    assert.ok(again.pairs.every((pair) => pair.effectiveName === 'jarvos-public-fixture'));
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('known higher-precedence skill roots reserve names before projection', () => {
  const control = temp('jarvos-recon-shadow-control-');
  const sourceRoot = temp('jarvos-recon-shadow-source-');
  const managedRoot = temp('jarvos-recon-shadow-managed-');
  const projectRoot = temp('jarvos-recon-shadow-project-');
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const tree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const catalog = { entries: [{
      id: 'public-fixture',
      allowedHarnesses: ['codex'],
      bundle: { root: 'public-fixture', allowlist: ['SKILL.md', 'scripts/**', 'assets/**'], treeDigest: tree.treeDigest },
    }] };
    copyFixture(PUBLIC_FIXTURE, path.join(projectRoot, 'public-fixture'));

    const plan = planCatalogReconciliation({
      catalog,
      publicSourceRoot: sourceRoot,
      controlRoot: control,
      harnesses: [{
        id: 'codex',
        root: managedRoot,
        adapter: { skillProjection: { orderedScopes: ['project', 'managed'] } },
        scopeRoots: { project: projectRoot },
        scopeRootsComplete: true,
      }],
      reviewer: (request) => JSON.stringify({ name: request.candidates[0] }),
    });

    assert.equal(plan.aliases['public-fixture'], 'jarvos-public-fixture');
    assert.equal(plan.pairs[0].effectiveName, 'jarvos-public-fixture');
    applyCatalogReconciliation(plan);
    assert.equal(fs.existsSync(path.join(managedRoot, 'public-fixture')), false);
    assert.equal(fs.existsSync(path.join(managedRoot, 'jarvos-public-fixture', 'SKILL.md')), true);
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('local modification is preserved while unrelated pairs still reconcile', () => {
  const control = temp('jarvos-recon-mod-control-');
  const sourceRoot = temp('jarvos-recon-mod-source-');
  const roots = {
    codex: temp('jarvos-recon-mod-codex-'),
    hermes: temp('jarvos-recon-mod-hermes-'),
  };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    copyFixture(PRIVATE_FIXTURE, path.join(sourceRoot, 'private-fixture'));
    const effective = buildCatalog();
    const first = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      localSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
    });
    applyCatalogReconciliation(first);

    fs.writeFileSync(path.join(roots.codex, 'public-fixture', 'SKILL.md'), 'edited locally\n', { mode: 0o600 });

    // Remove private from hermes to create an unrelated missing pair.
    fs.rmSync(path.join(roots.hermes, 'private-fixture'), { recursive: true, force: true });
    fs.rmSync(path.join(roots.hermes, '.jarvos-projections', 'private-fixture.json'), { force: true });

    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      localSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
    });
    const modified = plan.pairs.find((pair) => pair.id === 'public-fixture' && pair.harness === 'codex');
    assert.equal(modified.status, 'local_modified');
    const missingPrivate = plan.pairs.find((pair) => pair.id === 'private-fixture' && pair.harness === 'hermes');
    assert.equal(missingPrivate.status, 'missing');
    applyCatalogReconciliation(plan);
    assert.equal(fs.readFileSync(path.join(roots.codex, 'public-fixture', 'SKILL.md'), 'utf8'), 'edited locally\n');
    assert.equal(fs.existsSync(path.join(roots.hermes, 'private-fixture', 'SKILL.md')), true);
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale alias revision cannot apply and empty candidate intersection is a no-write conflict', () => {
  const control = temp('jarvos-recon-stale-control-');
  const sourceRoot = temp('jarvos-recon-stale-source-');
  const root = temp('jarvos-recon-stale-root-');
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const publicTree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const effective = composeEffectiveCatalog({
      publicCatalog: {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entries: [{
          id: 'public-fixture',
          allowedHarnesses: ['codex'],
          bundle: {
            root: 'public-fixture',
            allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
            treeDigest: publicTree.treeDigest,
          },
        }],
      },
    });
    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      harnesses: [{ id: 'codex', root }],
      controlRoot: control,
    });
    // Mutate alias revision behind the plan.
    fs.writeFileSync(plan.aliasFile, `${JSON.stringify({
      version: 1,
      revision: plan.aliasRevision + 1,
      aliases: {},
      notices: {},
    }, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => applyCatalogReconciliation(plan), /aliases changed since planning/);

    // Exhaust the finite candidate generator by repeatedly occupying every
    // name it still offers until no safe alias remains.
    const occupied = new Set(['public-fixture']);
    for (let round = 0; round < 50; round += 1) {
      const remaining = safeAliasCandidates('public-fixture', { occupiedNames: [...occupied] });
      if (remaining.length === 0) break;
      for (const candidate of remaining) occupied.add(candidate);
    }
    assert.equal(safeAliasCandidates('public-fixture', { occupiedNames: [...occupied] }).length, 0);
    const conflict = resolveCollisionAlias({
      canonicalId: 'public-fixture',
      occupiedNames: [...occupied],
    });
    assert.equal(conflict.source, 'conflict');
    assert.equal(conflict.effectiveName, null);
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deselection retires only unchanged receipt-owned bundles', () => {
  const control = temp('jarvos-recon-retire-control-');
  const sourceRoot = temp('jarvos-recon-retire-source-');
  const codex = temp('jarvos-recon-retire-codex-');
  const hermes = temp('jarvos-recon-retire-hermes-');
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    copyFixture(PRIVATE_FIXTURE, path.join(sourceRoot, 'private-fixture'));
    const effective = buildCatalog();
    applyCatalogReconciliation(planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      localSourceRoot: sourceRoot,
      harnesses: harnesses({ codex, hermes }),
      controlRoot: control,
    }));

    // Locally modify private on codex, keep public clean.
    fs.writeFileSync(path.join(codex, 'private-fixture', 'SKILL.md'), 'keep me\n', { mode: 0o600 });

    const publicOnly = composeEffectiveCatalog({
      publicCatalog: {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entries: [effective.catalog.entries.find((entry) => entry.id === 'public-fixture')],
      },
    });
    const plan = planCatalogReconciliation({
      catalog: publicOnly.catalog,
      catalogDigest: publicOnly.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses({ codex, hermes }),
      controlRoot: control,
    });
    assert.ok(plan.pairs.some((pair) => pair.deselected));
    applyCatalogReconciliation(plan);
    assert.equal(fs.readFileSync(path.join(codex, 'private-fixture', 'SKILL.md'), 'utf8'), 'keep me\n');
    assert.equal(fs.existsSync(path.join(hermes, 'private-fixture')), false);
    assert.equal(fs.existsSync(path.join(codex, 'public-fixture', 'SKILL.md')), true);
  } finally {
    for (const dir of [control, sourceRoot, codex, hermes]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('exact-path harness verification binds digest and never invents model-visible smoke success', () => {
  const root = temp('jarvos-verify-');
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(root, 'public-fixture'));
    const tree = computeBundleTree(path.join(root, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const ok = verifyHarnessBundle({
      adapter: { skillProjection: { verificationTier: 'exact-path' } },
      targetPath: path.join(root, 'public-fixture'),
      expectedName: 'public-fixture',
      expectedTreeDigest: tree.treeDigest,
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    assert.equal(ok.status, 'model_visible');
    const pending = verifyHarnessBundle({
      adapter: { skillProjection: { verificationTier: 'interactive-smoke' } },
      targetPath: path.join(root, 'public-fixture'),
      expectedName: 'public-fixture',
      expectedTreeDigest: tree.treeDigest,
      remoteModelProbe: false,
    });
    assert.equal(pending.status, 'verification_pending');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exact-digest unmanaged copy is adopted without rewriting bytes', () => {
  const control = temp('jarvos-recon-adopt-control-');
  const sourceRoot = temp('jarvos-recon-adopt-source-');
  const roots = {
    codex: temp('jarvos-recon-adopt-codex-'),
  };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    // Pre-place an unmanaged exact copy in the harness root.
    copyFixture(PUBLIC_FIXTURE, path.join(roots.codex, 'public-fixture'));
    const before = computeBundleTree(path.join(roots.codex, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const mtimeBefore = fs.statSync(path.join(roots.codex, 'public-fixture', 'SKILL.md')).mtimeMs;

    const publicTree = before;
    const effective = composeEffectiveCatalog({
      publicCatalog: {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entries: [{
          id: 'public-fixture',
          allowedHarnesses: ['codex'],
          bundle: {
            root: 'public-fixture',
            allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
            treeDigest: publicTree.treeDigest,
          },
        }],
      },
      localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
    });
    assert.equal(effective.status, 'valid');

    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      localSourceRoot: null,
      harnesses: harnesses(roots),
      controlRoot: control,
      inventoryGenerationId: 'gen-adopt0001',
    });
    const pair = plan.pairs.find((item) => item.id === 'public-fixture' && item.harness === 'codex');
    assert.equal(pair.status, 'unmanaged_exact');
    assert.equal(pair.action, 'adopt');

    const applied = applyCatalogReconciliation(plan);
    assert.equal(applied.ok, true);
    const row = applied.applied.find((item) => item.id === 'public-fixture' && item.harness === 'codex');
    assert.equal(row.status, 'adopted');
    assert.equal(row.applied, true);

    const after = computeBundleTree(path.join(roots.codex, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    assert.equal(after.treeDigest, before.treeDigest);
    const mtimeAfter = fs.statSync(path.join(roots.codex, 'public-fixture', 'SKILL.md')).mtimeMs;
    assert.equal(mtimeAfter, mtimeBefore);

    const { readReceipt, validateReceipt } = require('../src/receipts');
    const receipt = validateReceipt(readReceipt(roots.codex, 'public-fixture'));
    assert.ok(receipt);
    assert.equal(receipt.treeDigest, before.treeDigest);
    assert.equal(receipt.inventoryGenerationId, 'gen-adopt0001');

    // Second reconcile is zero-write clean.
    const plan2 = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
      inventoryGenerationId: 'gen-adopt0001',
    });
    assert.equal(plan2.pairs[0].status, 'clean');
    assert.equal(plan2.pairs[0].action, 'preserve');
    const applied2 = applyCatalogReconciliation(plan2);
    assert.equal(applied2.noop, true);
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('divergent unmanaged copy stays preserved', () => {
  const control = temp('jarvos-recon-div-control-');
  const sourceRoot = temp('jarvos-recon-div-source-');
  const roots = { codex: temp('jarvos-recon-div-codex-') };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    copyFixture(PUBLIC_FIXTURE, path.join(roots.codex, 'public-fixture'));
    fs.writeFileSync(path.join(roots.codex, 'public-fixture', 'SKILL.md'), '---\nname: public-fixture\n---\ndivergent\n', { mode: 0o600 });
    const publicTree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const effective = composeEffectiveCatalog({
      publicCatalog: {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entries: [{
          id: 'public-fixture',
          allowedHarnesses: ['codex'],
          bundle: {
            root: 'public-fixture',
            allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
            treeDigest: publicTree.treeDigest,
          },
        }],
      },
      localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
    });
    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
    });
    // Divergent unmanaged occupant forces an alias; the original name stays put.
    assert.ok(plan.pairs[0].effectiveName);
    assert.notEqual(plan.pairs[0].effectiveName, 'public-fixture');
    assert.equal(plan.pairs[0].status, 'missing');
    assert.equal(plan.pairs[0].action, 'install');
    const applied = applyCatalogReconciliation(plan);
    assert.equal(applied.ok, true);
    // Original divergent body is preserved at the canonical name.
    assert.match(fs.readFileSync(path.join(roots.codex, 'public-fixture', 'SKILL.md'), 'utf8'), /divergent/);
    // Portable copy lands under the alias, not by overwriting the occupant.
    assert.equal(fs.existsSync(path.join(roots.codex, plan.pairs[0].effectiveName, 'SKILL.md')), true);
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incomplete inventory generation refuses mutations', () => {
  const control = temp('jarvos-recon-inc-control-');
  const sourceRoot = temp('jarvos-recon-inc-source-');
  const roots = { codex: temp('jarvos-recon-inc-codex-') };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const publicTree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const effective = composeEffectiveCatalog({
      publicCatalog: {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entries: [{
          id: 'public-fixture',
          allowedHarnesses: ['codex'],
          bundle: {
            root: 'public-fixture',
            allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
            treeDigest: publicTree.treeDigest,
          },
        }],
      },
      localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
    });
    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
      incompleteGeneration: true,
      inventoryGenerationId: 'gen-incomplete01',
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.incompleteGeneration, true);
    assert.equal(plan.pairs.length, 0);
    assert.equal(plan.mutate, false);
    const applied = applyCatalogReconciliation(plan);
    assert.equal(applied.ok, false);
    assert.equal(applied.reason, 'incomplete_generation');
    assert.equal(fs.existsSync(path.join(roots.codex, 'public-fixture')), false);
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install receipts carry inventory generation identity', () => {
  const control = temp('jarvos-recon-igen-control-');
  const sourceRoot = temp('jarvos-recon-igen-source-');
  const roots = { codex: temp('jarvos-recon-igen-codex-') };
  try {
    copyFixture(PUBLIC_FIXTURE, path.join(sourceRoot, 'public-fixture'));
    const publicTree = computeBundleTree(path.join(sourceRoot, 'public-fixture'), {
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
    });
    const effective = composeEffectiveCatalog({
      publicCatalog: {
        schemaVersion: CATALOG_SCHEMA_VERSION,
        entries: [{
          id: 'public-fixture',
          allowedHarnesses: ['codex'],
          bundle: {
            root: 'public-fixture',
            allowlist: ['SKILL.md', 'scripts/**', 'assets/**'],
            treeDigest: publicTree.treeDigest,
          },
        }],
      },
      localOverlay: { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] },
    });
    const plan = planCatalogReconciliation({
      catalog: effective.catalog,
      catalogDigest: effective.digest,
      publicSourceRoot: sourceRoot,
      harnesses: harnesses(roots),
      controlRoot: control,
      inventoryGenerationId: 'gen-install0001',
      sourceIdentities: {
        'public-fixture': {
          logicalId: 'public-fixture',
          sourceKind: 'public-catalog',
          profileDigest: 'a'.repeat(64),
        },
      },
    });
    const applied = applyCatalogReconciliation(plan);
    assert.equal(applied.ok, true);
    const { readReceipt, validateReceipt } = require('../src/receipts');
    const receipt = validateReceipt(readReceipt(roots.codex, 'public-fixture'));
    assert.equal(receipt.inventoryGenerationId, 'gen-install0001');
    assert.equal(receipt.sourceIdentity.logicalId, 'public-fixture');
    assert.equal(receipt.sourceIdentity.profileDigest, 'a'.repeat(64));
  } finally {
    fs.rmSync(control, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    for (const root of Object.values(roots)) fs.rmSync(root, { recursive: true, force: true });
  }
});
