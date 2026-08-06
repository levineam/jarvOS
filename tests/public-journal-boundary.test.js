'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const service = require('../modules/jarvos-secondbrain/src/vault-mutation-service');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_JOURNAL_SURFACE = [
  'PUBLIC_BASELINE.md',
  'jarvos.config.schema.json',
  'docs/journal-install-contract.md',
  'docs/architecture/secondbrain-external-integrations.md',
  'modules/jarvos-agent-context/README.md',
  'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
  'modules/jarvos-agent-context/src/index.js',
  'modules/jarvos-secondbrain/scripts/journal-health-alarm.js',
  'modules/jarvos-secondbrain/README.md',
  'modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/README.md',
  'modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/config/journal-module.json',
  'modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-lifecycle.js',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('packaged public journal surface contains no machine-specific runtime or vault defaults', () => {
  const forbidden = [
    ['/Users', 'andrew'].join('/'),
    ['~', 'Vaults', 'Vault v3'].join('/'),
    ['America', 'New_York'].join('/'),
    'source-live-attestation',
    'private scheduler manifest',
    'rollout record',
  ];

  for (const relativePath of PUBLIC_JOURNAL_SURFACE) {
    const contents = read(relativePath);
    for (const marker of forbidden) {
      assert.equal(contents.includes(marker), false, `${relativePath} contains forbidden public marker ${marker}`);
    }
  }
});

test('public journal documentation states the explicit configuration and ownership contract', () => {
  const install = read('docs/journal-install-contract.md');
  const packageReadme = read('modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/README.md');
  const agentReadme = read('modules/jarvos-agent-context/README.md');
  const combined = `${install}\n${packageReadme}\n${agentReadme}`.toLowerCase();
  for (const claim of [
    'JARVOS_JOURNAL_DIR',
    'JARVOS_TIMEZONE',
    'fail closed',
    'creation-only',
    'Journaling.md',
    'single-writer',
    'jarvos_journal_health',
    'jarvos_ensure_today_journal',
  ]) {
    assert.ok(combined.includes(claim.toLowerCase()), `missing public journal contract claim: ${claim}`);
  }
});

test('writer inventory covers each user-visible vault writer with a migration or narrow exception', () => {
  const inventory = service.WRITER_INVENTORY;
  const roots = {
    secondbrain: path.join(__dirname, '..', 'modules', 'jarvos-secondbrain'),
    'agent-context': path.join(__dirname, '..', 'modules', 'jarvos-agent-context'),
  };
  assert.doesNotThrow(() => service.assertWriterInventory(inventory, { roots }));
  assert.doesNotThrow(() => service.assertNoUnclassifiedVaultWrites({ roots, inventory, excludeTestFixtures: true }));
  assert.throws(() => service.assertWriterInventory(inventory, { roots, strictMigrated: true }), /not migrated/i);
  assert.equal(inventory.some((entry) => entry.root === 'agent-context' && entry.file === 'src/index.js'), true);
  assert.equal(inventory.some((entry) => entry.file.endsWith('lint-frontmatter.js')), true);
  assert.equal(inventory.some((entry) => entry.file.endsWith('vault-storage-adapter.js')), true);
});

test('raw in-scope Markdown write without a classification fails the source guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-guard-'));
  try {
    const offender = path.join(root, 'packages', 'writer.js');
    fs.mkdirSync(path.dirname(offender), { recursive: true });
    fs.writeFileSync(offender, "require('fs').writeFileSync(target, content, 'utf8');\n");
    assert.throws(() => service.assertNoUnclassifiedVaultWrites({ roots: { fixture: root }, inventory: [] }), /unclassified raw vault mutation/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packages cannot import adapters or bridge except named temporary shims with removal criteria', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-guard-'));
  try {
    const pkg = path.join(root, 'packages', 'notes', 'src');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'bad.js'), "require('../../../adapters/obsidian/src/vault-mutation-contract');\n");
    assert.throws(() => service.assertPackageImportBoundary({ root, shims: [] }), /forbidden package import/i);
    assert.doesNotThrow(() => service.assertPackageImportBoundary({ root, shims: [{ file: 'packages/notes/src/bad.js', target: '../../../adapters/obsidian/src/vault-mutation-contract', removalCriteria: 'U4 migration' }] }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
