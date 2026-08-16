'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashUtf8, validateVaultRelativeMarkdownPath } = require('../adapters/obsidian/src/vault-mutation-contract');
const { createVaultMutationAdapter } = require('../adapters/obsidian/src/vault-mutation-adapter');
const { createJarvosVaultTransforms } = require('./vault-transform-registry');

const WRITER_INVENTORY = Object.freeze([
  ['secondbrain', 'adapters/obsidian/src/vault-storage-adapter.js', 'mutation-owned', 'U4', 'Composes only create and reviewed journal transform operations through the configured service.'],
  ['secondbrain', 'adapters/obsidian/src/vault-mutation-ledger.js', 'operational-out-of-vault', 'U2', 'Writes the owner-only reconciliation ledger under the host state directory, never vault Markdown.'],
  ['secondbrain', 'adapters/obsidian/src/vault-mutation-reconciler.js', 'mutation-owned', 'U3', 'Performs the explicitly authorized offline fallback and bounded Obsidian reconciliation.'],
  ['secondbrain', 'bridge/config/src/shared-vault-onboarding.js', 'operational-out-of-vault', 'U1', 'Writes jarvos.config.json, never vault Markdown.'],
  ['secondbrain', 'bridge/provenance/src/journal-note-audit.js', 'mutation-owned', 'U4', 'Audit repairs use one exact-content guarded replacement through the configured mutation service.'],
  ['secondbrain', 'bridge/provenance/src/link-to-journal.js', 'mutation-owned-with-operational-queue', 'U4', 'Journal Markdown dispatches through the configured service; only the deferred backlink JSON queue is written directly outside the vault.'],
  ['secondbrain', 'bridge/provenance/src/notes-section-normalizer.js', 'mutation-owned', 'U4', 'Normalizes notes through canonical note operations and applies the journal rewrite through one exact-content guarded replacement.'],
  ['secondbrain', 'bridge/synthesis/src/journal-spine-synthesis.js', 'operational-hidden-sidecar', 'U4', 'Writes owner-only JSON and Markdown reports under the hidden knowledge sidecar directory; these are rebuildable operational evidence, not authored vault pages.'],
  ['secondbrain', 'packages/jarvos-secondbrain-journal/src/journal-lifecycle.js', 'mutation-owned-with-operational-receipts', 'U4', 'Journal Markdown creation is an injected canonical create operation; receipt JSON remains an operational out-of-vault record.'],
  ['secondbrain', 'packages/jarvos-secondbrain-journal/src/journal-maintenance.js', 'mutation-owned-with-operational-state', 'U4', 'Journal Markdown uses injected create or exact-content replacement operations; audit backups and known-good state remain hidden operational recovery records.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/knowledge-optimizer.js', 'operational-out-of-vault', 'U1', 'Writes protected JSON sidecars, never vault Markdown.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/lint-frontmatter.js', 'mutation-owned', 'U4', 'Frontmatter fixes require an injected Obsidian-owned exact-hash replacement executor.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/manual-notes-maintenance.js', 'mutation-owned-with-operational-sidecars', 'U4', 'Frontmatter fixes require an injected Obsidian-owned exact-hash replacement executor; protected JSON state and knowledge sidecars remain out-of-vault.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/write-to-vault.js', 'mutation-owned', 'U4', 'Builds only transport-neutral operations; bridge/top-level composition executes them.'],
  ['secondbrain', 'packages/jarvos-secondbrain-projects/src/projects.js', 'mutation-owned', 'U4', 'Project pages and their visible index require injected create or exact-content replacement operations.'],
  ['secondbrain', 'packages/jarvos-secondbrain-projects/src/migrate.js', 'operational-out-of-vault', 'U1', 'Writes only an owner-supplied migration ledger; project Markdown remains delegated to the mutation-owned project writer.'],
  ['secondbrain', 'packages/jarvos-secondbrain-projects/src/registry.js', 'operational-out-of-vault', 'U1', 'Writes only the owner-supplied project registry state store; visible project Markdown remains mutation-owned.'],
  ['secondbrain', 'packages/jarvos-secondbrain-projects/src/activity-store.js', 'operational-out-of-vault', 'U10', 'Writes only the owner-private Project Activity generation and quarantine records; it never writes vault Markdown.'],
  ['secondbrain', 'packages/jarvos-secondbrain-projects/src/execution-link-store.js', 'operational-out-of-vault', 'U2', 'Writes only the protected Projects-to-Beads execution-link state store; it never writes vault Markdown or mirrors Beads lifecycle state.'],
  ['secondbrain', 'packages/jarvos-secondbrain-wiki/src/index.js', 'rebuildable-external-output', 'U4', 'Generated wiki output is explicitly rejected inside a configured vault until an Obsidian-owned deletion lifecycle is available; external derived output remains rebuildable.'],
  ['secondbrain', 'scripts/obsidian-live-smoke.js', 'mutation-owned-with-operational-attestation', 'U7', 'Creates and exact-identity deletes only a disposable vault fixture through the configured service; the owner-only rollout attestation is written outside the vault.'],
  ['agent-context', 'src/index.js', 'mutation-owned-with-operational-locks', 'U5', 'Note and session-thread Markdown use configured create/transform operations; session locks live in the owner-only host state directory outside the vault.'],
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
  allowDeleteOperation,
} = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) throw new Error('vaultRoot must be absolute');
  if (typeof source !== 'string' || !source) throw new Error('mutation source is required');
  const adapter = suppliedAdapter || createVaultMutationAdapter({ vaultRoot, vaultId, transforms, ...adapterOptions, allowDeleteOperation });
  if (typeof adapter.submit !== 'function') throw new Error('vault mutation adapter must support atomic operation planning');
  // Only an explicit stopped-app signal is a default absence proof. A missing
  // CLI, timeout, busy app, or generic transport failure cannot establish that
  // Obsidian is not concurrently mutating the vault.
  const absenceProof = proveObsidianAbsent || (() => adapter.capability().state === 'app_stopped');
  const offlineWriteCapability = Object.freeze({});
  const reconciler = suppliedReconciler || adapter.createReconciler({
    // Offline fallback remains closed unless this composition host supplies a
    // proof that Obsidian is absent. A caller cannot smuggle this authority in
    // operation data.
    proveObsidianAbsent: absenceProof,
    exclusiveWriterCapability,
    offlineSourceAllowlist,
    offlineWriteCapability,
  });

  function boundSource(requestedSource) {
    if (requestedSource !== undefined && requestedSource !== source) throw new Error('Caller cannot override the configured mutation source');
    return source;
  }

  function submitAuthorized(input, operationSource) {
    const operation = { ...input, source: operationSource };
    const receipt = adapter.submit(operation);
    if (receipt.status !== 'unavailable') return receipt;
    const planned = receipt.operation || adapter.ledger.get(operation.operationId)?.operation || operation;
    return reconciler.safeOfflineSave(planned, offlineWriteCapability);
  }

  function execute(input) {
    boundSource(input?.source);
    return submitAuthorized(input, source);
  }

  function createWriteContext({ vaultRelativePath, operationId, intentId, operationSource = source } = {}) {
    if (typeof vaultRelativePath !== 'string' || !vaultRelativePath) throw new Error('vaultRelativePath is required');
    const contextSource = boundSource(operationSource);
    const id = operationId || intentId || `note-${crypto.randomUUID()}`;
    return Object.freeze({
      mutationExecutor: (operation) => submitAuthorized(operation, contextSource),
      operationId: id,
      // Package operation factories require a positive sequence field. The
      // adapter replaces this placeholder while atomically persisting the full
      // operation, so no durable FIFO slot exists without its payload.
      sequence: 1,
      source: contextSource,
      vaultId,
      vaultRoot,
    });
  }

  function createMarkdownFile({ filePath, vaultRelativePath, nextContent, content, source: operationSource = source, operationId, intentId } = {}) {
    const markdown = nextContent ?? content;
    if (typeof markdown !== 'string') throw new Error('nextContent is required for a Markdown create');
    const relativePath = vaultRelativePath || (() => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('filePath or vaultRelativePath is required');
      return path.relative(vaultRoot, path.resolve(filePath)).split(path.sep).join('/');
    })();
    validateVaultRelativeMarkdownPath(relativePath);
    if (filePath && path.resolve(vaultRoot, relativePath) !== path.resolve(filePath)) throw new Error('filePath is outside the configured vault');
    const context = createWriteContext({
      vaultRelativePath: relativePath,
      operationId,
      intentId,
      operationSource,
    });
    return submitAuthorized({
      schemaVersion: 1,
      operationId: context.operationId,
      vaultId: context.vaultId,
      vaultRelativePath: relativePath,
      sequence: 1,
      operationKind: 'create',
      content: markdown,
    }, context.source);
  }

  // Whole-file replacement is deliberately a composition concern: packages can
  // ask for it without knowing about Obsidian, while this boundary supplies the
  // durable identity, per-path sequence, and exact-content conflict guard.
  function applyMarkdownMutation({ filePath, vaultRelativePath, expectedContent, nextContent, source: operationSource = source, operationId, intentId } = {}) {
    if (typeof expectedContent !== 'string' || typeof nextContent !== 'string') throw new Error('expectedContent and nextContent are required for an exact Markdown replacement');
    boundSource(operationSource);
    const relativePath = vaultRelativePath || (() => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('filePath or vaultRelativePath is required');
      return path.relative(vaultRoot, path.resolve(filePath)).split(path.sep).join('/');
    })();
    validateVaultRelativeMarkdownPath(relativePath);
    if (filePath && path.resolve(vaultRoot, relativePath) !== path.resolve(filePath)) throw new Error('filePath is outside the configured vault');
    const expectedHash = hashUtf8(expectedContent);
    const intendedHash = hashUtf8(nextContent);
    // A caller-provided intent stays stable for retries. A fresh submission
    // needs a fresh identity even when the same before/after bytes recur later;
    // otherwise an old acknowledged ledger entry could mask a newly reverted
    // file as already satisfied.
    const stableIntentId = operationId || intentId || `replace-${crypto.randomUUID()}`;
    const receipt = submitAuthorized({
      schemaVersion: 1,
      operationId: stableIntentId,
      vaultId,
      vaultRelativePath: relativePath,
      sequence: 1,
      operationKind: 'replace',
      expectedContent,
      expectedHash,
      content: nextContent,
      intendedHash,
    }, source);
    // The transport records a rejected guarded write as a conflict lifecycle.
    // Present that distinction to replacement callers without changing the
    // generic adapter outcome for unrelated mutation kinds.
    return receipt.status === 'failed' && receipt.lifecycleState === 'conflict'
      ? { ...receipt, status: 'conflict' }
      : receipt;
  }

  function deleteMarkdownFile({ filePath, vaultRelativePath, expectedContent, source: operationSource = source, operationId, intentId } = {}) {
    if (typeof allowDeleteOperation !== 'function') throw new Error('Guarded Markdown deletion is not configured for this mutation service');
    if (typeof expectedContent !== 'string') throw new Error('expectedContent is required for a guarded Markdown deletion');
    const relativePath = vaultRelativePath || (() => {
      if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('filePath or vaultRelativePath is required');
      return path.relative(vaultRoot, path.resolve(filePath)).split(path.sep).join('/');
    })();
    validateVaultRelativeMarkdownPath(relativePath);
    if (filePath && path.resolve(vaultRoot, relativePath) !== path.resolve(filePath)) throw new Error('filePath is outside the configured vault');
    const id = operationId || intentId || `delete-${crypto.randomUUID()}`;
    boundSource(operationSource);
    const operation = {
      schemaVersion: 1,
      operationId: id,
      vaultId,
      vaultRelativePath: relativePath,
      sequence: 1,
      operationKind: 'delete',
      expectedContent,
      expectedHash: hashUtf8(expectedContent),
      source,
    };
    if (allowDeleteOperation(operation) !== true) throw new Error('Guarded Markdown deletion is outside this service authority');
    const receipt = submitAuthorized(operation, source);
    return receipt.status === 'failed' && receipt.lifecycleState === 'conflict'
      ? { ...receipt, status: 'conflict' }
      : receipt;
  }

  return Object.freeze({ adapter, applyMarkdownMutation, createMarkdownFile, createWriteContext, deleteMarkdownFile, execute, reconciler, source, transforms, vaultId, vaultRoot });
}

module.exports = { PACKAGE_TEMPORARY_SHIMS, WRITER_INVENTORY, assertNoUnclassifiedVaultWrites, assertPackageImportBoundary, assertWriterInventory, configuredVaultId, createConfiguredVaultMutationService };
