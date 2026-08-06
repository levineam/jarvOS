'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PENDING = 'mutation-owned-pending-migration';
const WRITER_INVENTORY = Object.freeze([
  ['secondbrain', 'adapters/obsidian/src/vault-storage-adapter.js', PENDING, 'U4'],
  ['secondbrain', 'adapters/obsidian/src/vault-mutation-ledger.js', 'operational-out-of-vault', 'U2', 'Writes the owner-only reconciliation ledger under the host state directory, never vault Markdown.'],
  ['secondbrain', 'adapters/obsidian/src/vault-mutation-reconciler.js', 'mutation-owned', 'U3', 'Performs the explicitly authorized offline fallback and bounded Obsidian reconciliation.'],
  ['secondbrain', 'bridge/config/src/shared-vault-onboarding.js', 'operational-out-of-vault', 'U1', 'Writes jarvos.config.json, never vault Markdown.'],
  ['secondbrain', 'bridge/provenance/src/journal-note-audit.js', PENDING, 'U4'],
  ['secondbrain', 'bridge/provenance/src/link-to-journal.js', PENDING, 'U4'],
  ['secondbrain', 'bridge/provenance/src/notes-section-normalizer.js', PENDING, 'U4'],
  ['secondbrain', 'bridge/synthesis/src/journal-spine-synthesis.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-journal/src/journal-lifecycle.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-journal/src/journal-maintenance.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/knowledge-optimizer.js', 'operational-out-of-vault', 'U1', 'Writes protected JSON sidecars, never vault Markdown.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/lint-frontmatter.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/manual-notes-maintenance.js', 'mixed-pending-migration', 'U4', 'Its protected JSON state remains out-of-vault while Markdown fixes migrate.'],
  ['secondbrain', 'packages/jarvos-secondbrain-notes/src/write-to-vault.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-projects/src/projects.js', PENDING, 'U4'],
  ['secondbrain', 'packages/jarvos-secondbrain-wiki/src/index.js', PENDING, 'U4'],
  ['agent-context', 'src/index.js', PENDING, 'U4'],
].map(([root, file, classification, migrationUnit, exceptionReason]) => Object.freeze({ root, file, classification, migrationUnit, exceptionReason })));

const PACKAGE_TEMPORARY_SHIMS = Object.freeze([
  ['packages/jarvos-secondbrain-notes/src/write-to-vault.js', '../../../bridge/provenance/src/link-to-journal', 'U4 moves backlink dispatch to the composition service.'],
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
module.exports = { PACKAGE_TEMPORARY_SHIMS, WRITER_INVENTORY, assertNoUnclassifiedVaultWrites, assertPackageImportBoundary, assertWriterInventory };
