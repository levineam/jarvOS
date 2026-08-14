'use strict';

// Verifies the published npm tarball actually ships the files an install needs
// to run every advertised runtime and the runtime-kit verifier. Regression
// guard for the omitted `runtimes/` and `modules/jarvos-runtime-kit/` entries
// that left an npm install without adapters/setup/verifier assets.
const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function packedFiles() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // npm may print notices before the JSON payload; parse from the first bracket.
  const start = result.stdout.indexOf('[');
  const parsed = JSON.parse(result.stdout.slice(start));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return new Set((entry.files || []).map((file) => file.path.replace(/\\/g, '/')));
}

function advertisedRuntimeAssets() {
  const runtimesDir = path.join(ROOT, 'runtimes');
  const required = [
    'PUBLIC_BASELINE.md',
    'docs/journal-install-contract.md',
    'jarvos.config.schema.json',
    'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
    'modules/jarvos-agent-context/src/index.js',
    'modules/jarvos-secondbrain/scripts/journal-health.js',
    'modules/jarvos-secondbrain/scripts/journal-health-alarm.js',
    'modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/config/journal-module.json',
    'modules/jarvos-secondbrain/packages/jarvos-secondbrain-journal/src/journal-lifecycle.js',
    'modules/jarvos-runtime-kit/package.json',
    'modules/jarvos-runtime-kit/src/index.js',
    'modules/jarvos-runtime-kit/src/stewardship-bootstrap.js',
    'modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js',
    'modules/jarvos-runtime-kit/README.md',
    'modules/jarvos-coding/providers/compound-engineering.json',
    'docs/architecture/shared-skill-distribution.md',
    'docs/runbooks/shared-skill-distribution.md',
    'modules/jarvos-skills/schemas/catalog.schema.json',
    'modules/jarvos-skills/schemas/local-overlay.schema.json',
    'modules/jarvos-skills/src/reconciliation.js',
    'modules/jarvos-skills/scripts/dogfood-skills.js',
    'modules/jarvos-control-plane/scripts/jarvos-manager.js',
    'scripts/release-readiness-check.js',
    'scripts/release-status.js',
    'scripts/unreleased-drift-check.js',
    'scripts/lib/release-status.js',
    'modules/jarvos-secondbrain/adapters/obsidian/src/vault-mutation-adapter.js',
    'modules/jarvos-secondbrain/adapters/obsidian/src/vault-mutation-contract.js',
    'modules/jarvos-secondbrain/adapters/obsidian/src/vault-mutation-ledger.js',
    'modules/jarvos-secondbrain/adapters/obsidian/src/vault-mutation-reconciler.js',
    'profiles/minimal.json',
  ];
  for (const name of fs.readdirSync(runtimesDir)) {
    const adapter = path.join(runtimesDir, name, 'adapter.json');
    if (!fs.existsSync(adapter)) continue;
    required.push(`runtimes/${name}/adapter.json`);
    const setup = path.join(runtimesDir, name, 'setup.sh');
    if (fs.existsSync(setup)) required.push(`runtimes/${name}/setup.sh`);
    const readme = path.join(runtimesDir, name, 'README.md');
    if (fs.existsSync(readme)) required.push(`runtimes/${name}/README.md`);
    const bootstrapAssets = JSON.parse(fs.readFileSync(adapter, 'utf8')).stewardshipAdapter?.bootstrap?.selectedRuntimeAssets || [];
    required.push(...bootstrapAssets);
  }
  return required;
}

test('published tarball includes every advertised runtime and runtime-kit asset', () => {
  const files = packedFiles();
  const required = advertisedRuntimeAssets();
  const missing = required.filter((file) => !files.has(file));
  assert.deepEqual(missing, [], `published tarball is missing required files: ${missing.join(', ')}`);
});

test('managed provider package and public docs agree on pin, fallback, and admission truth', () => {
  const provider = JSON.parse(fs.readFileSync(path.join(ROOT, 'modules/jarvos-coding/providers/compound-engineering.json'), 'utf8'));
  const capability = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/codex/compound-engineering-capability.json'), 'utf8'));
  const conformance = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/codex/compound-engineering-conformance.json'), 'utf8'));
  assert.equal(provider.id, 'compound-engineering');
  assert.equal(provider.version, capability.provider.version);
  assert.equal(provider.source.revision, capability.provider.revision);
  assert.equal(provider.source.contentDigest.length, 64);
  assert.equal(provider.review.status, 'approved');
  assert.equal(capability.admission, 'supported');
  assert.equal(conformance.admission, 'supported');
  assert.equal(conformance.status, 'passed');

  const docs = [
    fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'modules/jarvos-coding/README.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'modules/jarvos-skills/README.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'modules/jarvos/README.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'modules/jarvos/docs/INSTALL.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'docs/architecture/packaging-and-install-profiles.md'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'docs/architecture/jarvos-architecture.md'), 'utf8'),
  ];
  assert.ok(docs.every((text) => /native jarvOS|same run|same worktree|fallback/i.test(text)), 'public docs must explain native fallback');
  assert.ok(docs.some((text) => /conformance-backed|healthy.*conformance|conformance.*healthy/i.test(text)), 'public docs must preserve conformance-backed health truth');
  assert.ok(docs.some((text) => /plan.*work.*complete/i.test(text)), 'public docs must lead with jarvOS verbs');
});
