'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyManagedProviderReconciliation,
  computeProviderTreeDigest,
  discoverManagedProviderCandidate,
  disableManagedProvider,
  getManifest,
  managedProviderHealth,
  planManagedProviderReconciliation,
  stageManagedProvider,
} = require('../src');

const providerManifest = require('../../jarvos-coding/providers/compound-engineering.json');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

function supportedManifest() {
  return {
    ...providerManifest,
    harnesses: {
      ...providerManifest.harnesses,
      codex: { ...providerManifest.harnesses.codex, status: 'supported' },
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-provider-reconcile-'));
  const sourceRoot = path.join(root, 'source');
  const stagingRoot = path.join(root, 'staging');
  const profileRoot = path.join(root, 'profile');
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sourceRoot, 'plugin.json'), '{"name":"compound-engineering"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(sourceRoot, 'skills.md'), '# bounded fixture\n', { mode: 0o600 });
  const entries = [
    { path: 'plugin.json', digest: digest(fs.readFileSync(path.join(sourceRoot, 'plugin.json'))) },
    { path: 'skills.md', digest: digest(fs.readFileSync(path.join(sourceRoot, 'skills.md'))) },
  ];
  const targetPath = path.join(profileRoot, 'codex-profile.json');
  const statePath = path.join(profileRoot, 'compound-engineering.state.json');
  return { root, sourceRoot, stagingRoot, entries, targetPath, statePath };
}

test('approved provider stages only allowlisted inert regular files and binds both digests', () => {
  const input = fixture();
  const manifest = supportedManifest();
  const expectedTreeDigest = computeProviderTreeDigest(input.sourceRoot, input.entries);
  const staged = stageManagedProvider({
    manifest,
    sourceRoot: input.sourceRoot,
    stagingRoot: input.stagingRoot,
    entries: input.entries,
    expectedTreeDigest,
    artifactDigest: manifest.source.contentDigest,
  });
  assert.equal(staged.treeDigest, expectedTreeDigest);
  assert.equal(fs.readFileSync(path.join(staged.stagePath, 'plugin.json'), 'utf8'), '{"name":"compound-engineering"}\n');
  assert.equal(fs.statSync(staged.stagePath).mode & 0o077, 0);
});

test('staging rejects symlinks, executable files, and digest mismatches before activation', () => {
  const input = fixture();
  const manifest = supportedManifest();
  fs.symlinkSync(path.join(input.sourceRoot, 'plugin.json'), path.join(input.sourceRoot, 'link.json'));
  assert.throws(() => stageManagedProvider({ manifest, sourceRoot: input.sourceRoot, stagingRoot: input.stagingRoot, entries: [{ path: 'link.json', digest: digest(fs.readFileSync(path.join(input.sourceRoot, 'plugin.json'))) }], artifactDigest: manifest.source.contentDigest }), /symbolic link/);
  fs.rmSync(path.join(input.sourceRoot, 'link.json'));
  fs.writeFileSync(path.join(input.sourceRoot, 'run.sh'), '#!/bin/sh\n', { mode: 0o700 });
  assert.throws(() => stageManagedProvider({ manifest, sourceRoot: input.sourceRoot, stagingRoot: input.stagingRoot, entries: [{ path: 'run.sh', digest: digest(fs.readFileSync(path.join(input.sourceRoot, 'run.sh'))) }], artifactDigest: manifest.source.contentDigest }), /executable/);
  assert.throws(() => stageManagedProvider({ manifest, sourceRoot: input.sourceRoot, stagingRoot: input.stagingRoot, entries: [{ path: 'plugin.json', digest: 'f'.repeat(64) }], artifactDigest: manifest.source.contentDigest }), /digest mismatch/);
});

test('plan/apply is generation-bound and preserves unrelated harness entries', () => {
  const input = fixture();
  const manifest = supportedManifest();
  const config = { plugins: { entries: { unrelated: { enabled: true, owner: 'user' } } } };
  const plan = planManagedProviderReconciliation({ manifest, harness: 'codex', harnessConfig: config, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(plan.status, 'not-installed');
  assert.equal(managedProviderHealth(plan).doctor, 'warn');
  const applied = applyManagedProviderReconciliation(plan, { manifest, harnessConfig: config, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(applied.status, 'installed');
  const installed = JSON.parse(fs.readFileSync(input.targetPath, 'utf8'));
  assert.deepEqual(installed.plugins.entries.unrelated, config.plugins.entries.unrelated);
  assert.equal(installed.plugins.entries['compound-engineering'].jarvosManaged, true);
  const currentConfig = installed;
  const clean = planManagedProviderReconciliation({ manifest, harness: 'codex', harnessConfig: currentConfig, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(clean.status, 'installed');
  assert.equal(applyManagedProviderReconciliation(clean, { manifest, harnessConfig: currentConfig, targetPath: input.targetPath, statePath: input.statePath }).applied, false);
  const changedManifest = { ...manifest, version: '3.21.5', source: { ...manifest.source, revision: 'a'.repeat(40), contentDigest: 'c'.repeat(64) } };
  assert.throws(() => applyManagedProviderReconciliation(plan, { manifest: changedManifest, harnessConfig: config, targetPath: input.targetPath, statePath: input.statePath }), /changed since planning/);
});

test('unknown and locally modified targets are preserved, while disable removes only owned state', () => {
  const input = fixture();
  const manifest = supportedManifest();
  const unknown = { plugins: { entries: { 'compound-engineering': { enabled: true, source: 'user-installed' } } } };
  const unknownPlan = planManagedProviderReconciliation({ manifest, harness: 'codex', harnessConfig: unknown, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(unknownPlan.status, 'unknown');
  assert.equal(applyManagedProviderReconciliation(unknownPlan, { manifest, harnessConfig: unknown, targetPath: input.targetPath, statePath: input.statePath }).applied, false);

  const config = { plugins: { entries: {} } };
  const applied = applyManagedProviderReconciliation(planManagedProviderReconciliation({ manifest, harness: 'codex', harnessConfig: config, targetPath: input.targetPath, statePath: input.statePath }), { manifest, harnessConfig: config, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(applied.applied, true);
  const ownedConfig = JSON.parse(fs.readFileSync(input.targetPath, 'utf8'));
  const modifiedConfig = { ...ownedConfig, plugins: { ...ownedConfig.plugins, entries: { ...ownedConfig.plugins.entries, 'compound-engineering': { ...ownedConfig.plugins.entries['compound-engineering'], enabled: false } } } };
  fs.writeFileSync(input.targetPath, `${JSON.stringify(modifiedConfig)}\n`);
  const modified = JSON.parse(fs.readFileSync(input.targetPath, 'utf8'));
  const modifiedPlan = planManagedProviderReconciliation({ manifest, harness: 'codex', harnessConfig: modified, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(modifiedPlan.status, 'local-modified');
  assert.equal(applyManagedProviderReconciliation(modifiedPlan, { manifest, harnessConfig: modified, targetPath: input.targetPath, statePath: input.statePath }).applied, false);

  fs.writeFileSync(input.targetPath, `${JSON.stringify(ownedConfig, null, 2)}\n`);
  const disabled = disableManagedProvider({ manifest, harnessConfig: ownedConfig, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(disabled.applied, true);
});

test('candidate discovery is separate, age-bearing, and idempotent by provider key', () => {
  const manifest = supportedManifest();
  const candidate = { ...manifest, version: '3.22.0', source: { ...manifest.source, revision: 'b'.repeat(40), contentDigest: 'd'.repeat(64) } };
  const reviews = new Map();
  const reviewStore = { upsert: (key, value) => { reviews.set(key, value); return value; } };
  const first = discoverManagedProviderCandidate({ approvedManifest: manifest, candidateManifest: candidate, reviewStore, now: '2026-08-12T00:00:00.000Z' });
  const second = discoverManagedProviderCandidate({ approvedManifest: manifest, candidateManifest: candidate, reviewStore, now: '2026-08-12T00:01:00.000Z' });
  assert.equal(first.status, 'candidate');
  assert.equal(second.review.reviewKey, first.review.reviewKey);
  assert.equal(reviews.size, 1);
  assert.equal(discoverManagedProviderCandidate({ approvedManifest: manifest, candidateManifest: manifest }).status, 'no-candidate');
});

test('an unsupported harness remains explicitly skipped', () => {
  const input = fixture();
  const manifest = {
    ...providerManifest,
    harnesses: {
      ...providerManifest.harnesses,
      codex: { ...providerManifest.harnesses.codex, status: 'unsupported' },
    },
  };
  const plan = planManagedProviderReconciliation({ manifest, harness: 'codex', harnessConfig: {}, targetPath: input.targetPath, statePath: input.statePath });
  assert.equal(plan.status, 'unsupported');
  assert.equal(managedProviderHealth(plan).doctor, 'skipped');
});

test('skills manifest declares Compound Engineering as a managed external provider', () => {
  const manifest = getManifest();
  assert.equal(manifest.managedProviders[0].id, 'compound-engineering');
  assert.equal(manifest.managedProviders[0].updatePolicy, 'managed-release');
});
