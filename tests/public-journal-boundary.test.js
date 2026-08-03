'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_JOURNAL_SURFACE = [
  'PUBLIC_BASELINE.md',
  'jarvos.config.schema.json',
  'docs/journal-install-contract.md',
  'docs/architecture/secondbrain-external-integrations.md',
  'modules/jarvos-agent-context/README.md',
  'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
  'modules/jarvos-agent-context/src/index.js',
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
