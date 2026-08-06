'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashUtf8 } = require('../adapters/obsidian/src/vault-mutation-contract');
const { createVaultMutationAdapter } = require('../adapters/obsidian/src/vault-mutation-adapter');
const { createVaultMutationReconciler } = require('../adapters/obsidian/src/vault-mutation-reconciler');
const { createJarvosVaultTransforms } = require('./vault-transform-registry');

const PENDING = 'mutation-owned-pending-migration';
const WRITER_INVENTORY = Object.freeze([
  ['secondbrain', 'adapters/obsidian/src/vault-storage-adapter.js', 'mutation-owned', 'U4', 'Composes only create and reviewed journal transform operations through the configured service.'],
  ['secondbrain', 'adapters/obsidian/src/vault-mutation-ledger.js', 'operational-out-of-vault', 'U2', 'Writes the owner-only reconciliation ledger under the host state directory, never vault Markdown.'],
  ['secondbrain', 'adapters/obsidian/src/vault-mutation-reconciler.js', 'mutation-owned', 'U3', 'Performs the explicitly authorized offline fallback and bounded Obsidian reconciliation.'],
  ['secondbrain', 'bridge/config/src/shared-vault-onboarding.js', 'operational-out-of-vault', 'U1', 'Writes jarvos.config.json, never vault Markdown.'],
  ['secondbrain', 'bridge/provenance/src/journal-note-audit.js', PENDING, 'U4'],
  ['secondbrain', 'bridge/provenance/src/link-to-journal.js', 'mutation-owned-with-operational-queue', 'U4', 'Journal Markdown dispatches through the configured service; only the deferred backlink JSON queue is written directly outside the vault.'],
  ['secondbrain', 'bridge/provenance/src/notes-section-normalizer.js', PENDING, 'U4'],
  ['secondbrain', 'bridge/synthesis/src/journal-spine-synthesis.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-journal/src/journal-lifecycle.js', 'mutation-owned-with-operational-receipts', 'U4', 'Journal Markdown creation is an injected canonical create operation; receipt JSON remains an operational out-of-vault record.'],
  ['secondbrain', 'packages/jarvos-secondbrain-journal/src/journal-maintenance.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/knowledge-optimizer.js', 'operational-out-of-vault', 'U1', 'Writes protected JSON sidecars, never vault Markdown.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/lint-frontmatter.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/manual-notes-maintenance.js', 'mixed-pending-migration', 'U4', 'Its protected JSON state remains out-of-vault while Markdown fixes migrate.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/write-to-vault.js', 'mutation-owned', 'U4', 'Builds only transport-neutral operations; bridge/top-level composition executes them.'],
  ['secondbrain', 'packages/jarvos-secondbrain-projects/src/projects.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-wiki/src/index.js', PENDING, 'U4'],
  ['agent-context', 'src/index.js', PENDING, 'U4'],
].map(([root, file, classification, migrationUnit, exceptionReason]) => Object.freeze({ root, file, classification, migrationUnit, exceptionReason })));

const PACKAGE_TEMPORARY_SHIMS = Object.freeze([
  ['packages/jarvos-secondbrain-notes/src/lib/notes-config.js', '../../../../bridge/config', 'U4 supplies package-owned configuration input.'],
  ['packages/jarvos-secondbrain-journal/src/journal-lifecycle.js', '../../../bridge/config', 'U4 supplies package-owned configuration input.'],
  ['packages/jarvos-secondbrain-journal/src/journal-maintenance.js', '../../../bridge/config', 'U4 supplies package-owned configuration input.'],
  ['packages/jarvos-secondbrain-journal/src/journal-maintenance.js', '../../../bridge/provenance/src/link-to-journal.js', 'U4 moves backlink dispatch to the composition service.'],
].map(([file, target, removalCriteria]) => Object.freeze({ file, target, removalCriteria })));

function assertWriterInventory(inventory, { roots = {}, strictMigrated = false } = {}) {
  const seen = new Set();
  for (const entry of inventory || []) {
    if (!entry?.root || !entry.file || !entry.classification || !entry.migrationUnit) throw new Error('Writer inventory has missing classification');
    const key = `${entry.root}/${entry.file}`;
    if (seen.has(key) || !roots[entry.root] || !fs.existsSync(path.join(roots[entry.root], entry.file))) throw new Error(`Writer inventory has missing or duplicate production path: ${key}`);
    if (!entry.classification.includes('mutation-owned') && !entry.exceptionReason) throw new Error(`Writer inventory exception requires a reason: ${key}`);
    if (strictMigrated && entry.classification.includes('pending-migration')) throw new Error(`Writer is not migrated: ${key}`);
    seen.add(key);
  }
}
function filesUnder(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target); else if (entry.isFile() && entry.name.endsWith('.js')) found.push(target);
    }
  };
  walk(root); return found;
}
function assertNoUnclassifiedVaultWrites({ roots, inventory = WRITER_INVENTORY, strictMigrated = false, exclude = [], excludeTestFixtures = false } = {}) {
  assertWriterInventory(inventory, { roots, strictMigrated });
  const classified = new Set(inventory.map((entry) => `${entry.root}/${entry.file}`));
  for (const [rootName, root] of Object.entries(roots || {})) {
    for (const filename of filesUnder(root)) {
      const relative = path.relative(root, filename);
      const key = `${rootName}/${relative}`;
      if (excludeTestFixtures && /(?:^|\/)(?:tests|test)\//.test(relative)) continue;
      if (/\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(/.test(fs.readFileSync(filename, 'utf8')) && !classified.has(key) && !exclude.includes(key)) throw new Error(`Unclassified raw vault mutation: ${key}`);
    }
  }
}
function assertPackageImportBoundary({ root, shims = [] } = {}) {
  const allowed = new Map(shims.map((shim) => [`${shim.file}\0${shim.target}`, shim]));
  for (const filename of filesUnder(path.join(root, 'packages'))) {
    const relative = path.relative(root, filename);
    const source = fs.readFileSync(filename, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const target = match[1];
      if (!/(?:\.\.\/)+(?:adapters|bridge)(?:\/|$)/.test(target)) continue;
      if (!allowed.get(`${relative}\0${target}`)?.removalCriteria) throw new Error(`Forbidden package import: ${relative} -> ${target}`);
    }
  }
}

function configuredVaultId(vaultRoot) {
  return `vault:${hashUtf8(path.resolve(vaultRoot)).slice(0, 24)}`;
}

// This is the sole production composition point for authored vault content.
// Package code receives only the small context returned by createWriteContext;
// it cannot import this service, an adapter, or the reconciliation ledger.
function createConfiguredVaultMutationService({
  vaultRoot,
  vaultId = configuredVaultId(vaultRoot),
  source = 'bridge.vault-mutation-service',
  transforms = createJarvosVaultTransforms(),
  adapter: suppliedAdapter,
  reconciler: suppliedReconciler,
  adapterOptions = {},
  proveObsidianAbsent,
  exclusiveWriterCapability,
  offlineSourceAllowlist,
} = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be absolute');
  if (typeof source !== 'string' || !source) throw new Error('mutation source is required');
  const adapter = suppliedAdapter || createVaultMutationAdapter({ vaultRoot, vaultId, transforms, ...adapterOptions });
  const absenceProof = proveObsidianAbsent || (() => ['app_stopped', 'cli_missing'].includes(adapter.capability().state));
  const reconciler = suppliedReconciler || createVaultMutationReconciler({
    adapter,
    ledger: adapter.ledger,
    vaultRoot,
    transforms,
    // Offline fallback remains closed unless this composition host supplies a
    // proof that Obsidian is absent. A caller cannot smuggle this authority in
    // operation data.
    proveObsidianAbsent: absenceProof,
    exclusiveWriterCapability,
    offlineSourceAllowlist: offlineSourceAllowlist || [source],
  });

  function execute(input) {
    const operation = { ...input, source: input.source || source };
    const receipt = adapter.execute(operation);
    if (receipt.status !== 'unavailable') return receipt;
    return reconciler.safeOfflineSave(operation);
  }

  function createWriteContext({ vaultRelativePath, operationId, intentId, operationSource = source } = {}) {
    if (typeof vaultRelativePath !== 'string' || !vaultRelativePath) throw new Error('vaultRelativePath is required');
    const id = operationId || intentId || `note-${crypto.randomUUID()}`;
    const existing = adapter.ledger.get(id);
    if (existing && existing.operation.vaultRelativePath !== vaultRelativePath) throw new Error('operationId belongs to a different vault path');
    const sequence = existing?.operation.sequence || adapter.ledger.nextSequence(vaultId, vaultRelativePath);
    return Object.freeze({
      mutationExecutor: execute,
      operationId: id,
      sequence,
      source: operationSource,
      vaultId,
      vaultRoot,
    });
  }

  return Object.freeze({ adapter, createWriteContext, execute, reconciler, source, transforms, vaultId, vaultRoot });
}

module.exports = { PACKAGE_TEMPORARY_SHIMS, WRITER_INVENTORY, assertNoUnclassifiedVaultWrites, assertPackageImportBoundary, assertWriterInventory, configuredVaultId, createConfiguredVaultMutationService };
