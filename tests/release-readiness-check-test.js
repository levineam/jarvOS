#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { checkCodexRoutingClaims, checkFrontDoorReleaseProse, checkReleaseReadiness, resolveReceiptRevisions } = require('../scripts/release-readiness-check');

function runFrontDoorCheck(files, options = {}) {
  return checkFrontDoorReleaseProse({
    target: options.target || '0.6.2',
    tag: options.tag || 'v0.6.2',
    allowUnreleased: Boolean(options.allowUnreleased),
    exists: (filePath) => Object.prototype.hasOwnProperty.call(files, filePath),
    readText: (filePath) => {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
        throw new Error(`${filePath} missing`);
      }
      return files[filePath];
    },
  });
}

function failedLabels(results) {
  return results.filter((result) => !result.ok).map((result) => result.label);
}

test('receipt revisions use the PR head parent when CI checks out a merge commit', () => {
  const revisions = {
    HEAD: 'merge',
    'HEAD^2': 'pr-head',
    'HEAD^2^': 'receipt-parent',
    'HEAD^': 'base',
  };
  const result = resolveReceiptRevisions((_command, args) => ({ status: 0, stdout: `${revisions[args[1]] || ''}\n` }));
  assert.deepEqual(result, { revision: 'merge', sourceParentRevision: 'receipt-parent' });
});

test('front-door release prose passes when README and release-process match the finalized target', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': 'Issues should carry the current active release label, such as `release-v0.6.2`.\n',
  });

  assert.deepEqual(failedLabels(results), []);
});

test('front-door release prose fails when finalized release-process has no current version claim', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': 'Future patches use the active Paperclip release parent.\n',
  });

  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, false);
  assert.match(releaseProcessResult.detail, /Missing a current release-process version or active release label claim/);
});

test('front-door release prose fails when README names an older current public preview', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.1` is the current public preview release.\n',
    'docs/release-process.md': 'Issues should carry the current active release label, such as `release-v0.6.2`.\n',
  });

  const readmeResult = results.find((result) => result.label === 'README current release prose');
  assert.equal(readmeResult.ok, false);
  assert.match(readmeResult.detail, /README names v0\.6\.1; target is v0\.6\.2/);
});

test('front-door release prose checks every README current public preview claim', () => {
  const results = runFrontDoorCheck({
    'README.md': [
      '## Release Status',
      '',
      '`v0.6.2` is the current public preview release.',
      '',
      'Elsewhere, `v0.6.1` is the current public preview release.',
    ].join('\n'),
    'docs/release-process.md': 'Issues should carry the current active release label, such as `release-v0.6.2`.\n',
  });

  const readmeResult = results.find((result) => result.label === 'README current release prose');
  assert.equal(readmeResult.ok, false);
  assert.match(readmeResult.detail, /README names v0\.6\.1; target is v0\.6\.2/);
});

test('front-door release prose fails when finalized README still calls target a candidate', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release candidate.\n',
    'docs/release-process.md': 'Issues should carry the current active release label, such as `release-v0.6.2`.\n',
  });

  const readmeResult = results.find((result) => result.label === 'README current release prose');
  assert.equal(readmeResult.ok, false);
  assert.match(readmeResult.detail, /v0\.6\.2 is still described as a current candidate/);
});

test('front-door release prose fails when finalized release-process still calls target a candidate', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': '`v0.6.2` is the current patch-candidate lane for capture determinism.\n',
  });

  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, false);
  assert.match(releaseProcessResult.detail, /v0\.6\.2 is still described as a current candidate/);
});

test('front-door release prose fails when finalized release-process still calls target a release candidate', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': '`v0.6.2` is the current release candidate for capture determinism.\n',
  });

  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, false);
  assert.match(releaseProcessResult.detail, /v0\.6\.2 is still described as a current candidate/);
});

test('front-door release prose fails when finalized release-process still calls an older version a candidate', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': '`v0.6.1` is the current patch-candidate lane for capture determinism.\n',
  });

  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, false);
  assert.match(releaseProcessResult.detail, /v0\.6\.1 is still described as a current candidate/);
});

test('front-door release prose fails when finalized release-process names an older current lane', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': '`v0.6.1` is the current secondbrain hardening lane after the capitalization patch.\n',
  });

  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, false);
  assert.match(releaseProcessResult.detail, /Release-process current claim names v0\.6\.1; target is v0\.6\.2/);
});

test('front-door release prose fails when finalized release-process names an older active release label', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': 'Issues should carry the current active release label, such as `release-v0.6.1`.\n',
  });

  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, false);
  assert.match(releaseProcessResult.detail, /Release-process current claim names v0\.6\.1; target is v0\.6\.2/);
});

test('front-door release prose checks every active release label claim', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.2` is the current public preview release.\n',
    'docs/release-process.md': [
      'Public issues should carry the current active release label, such as `release-v0.6.2`.',
      'Internal ops should carry the current active release label, such as `release-v0.6.1`.',
    ].join('\n'),
  });

  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, false);
  assert.match(releaseProcessResult.detail, /Release-process current claim names v0\.6\.1; target is v0\.6\.2/);
});

test('front-door release prose allows candidate wording in candidate mode', () => {
  const results = runFrontDoorCheck({
    'README.md': '## Release Status\n\n`v0.6.1` is the current public preview release.\n',
    'docs/release-process.md': '`v0.6.2` is the current patch-candidate lane for capture determinism.\n',
  }, { allowUnreleased: true });

  assert.deepEqual(failedLabels(results), []);
  const releaseProcessResult = results.find((result) => result.label === 'release-process final-version prose');
  assert.equal(releaseProcessResult.ok, true);
});

test('candidate release gate passes as unreleased work without authorizing a versioned release', () => {
  const report = checkReleaseReadiness({
    allowDirty: true,
    allowUnreleased: true,
    allowExistingTag: true,
    skipSmoke: true,
  });

  assert.equal(report.ok, true);
  assert.equal(report.version, 'v0.7.0');
  assert.equal(report.results.find((result) => result.label === 'CHANGELOG.md version section').ok, true);
  assert.equal(report.results.find((result) => result.label === 'git tag preflight').ok, true);
});

test('Codex direct routing evidence fails when the referenced lifecycle receipt is stale or incomplete', () => {
  const root = path.resolve(__dirname, '..');
  const corpus = fs.readFileSync(path.join(root, 'runtimes/codex/coding-conformance-prompts.json'), 'utf8');
  const routing = JSON.parse(fs.readFileSync(path.join(root, 'runtimes/codex/coding-routing-conformance.json'), 'utf8'));
  const lifecycle = JSON.parse(fs.readFileSync(path.join(root, 'runtimes/codex/coding-lifecycle-conformance.json'), 'utf8'));
  const files = {
    'runtimes/codex/coding-conformance-prompts.json': corpus,
    'runtimes/codex/coding-routing-conformance.json': JSON.stringify(routing),
    'runtimes/codex/coding-lifecycle-conformance.json': JSON.stringify(lifecycle),
    'README.md': 'Natural routing is currently unavailable until direct evidence is current.\n',
  };
  const run = (lifecycleOverride) => checkCodexRoutingClaims({
    readText: (file) => lifecycleOverride && file.endsWith('coding-lifecycle-conformance.json') ? JSON.stringify(lifecycleOverride) : files[file],
    exists: (file) => Object.prototype.hasOwnProperty.call(files, file),
    revision: 'release-revision',
    sourceParentRevision: lifecycle.jarvosRevision,
  });
  assert.equal(run(lifecycle).find((entry) => entry.label === 'Codex direct invocation evidence').ok, true);
  const failed = run({ ...lifecycle, status: 'failed' }).find((entry) => entry.label === 'Codex direct invocation evidence');
  assert.equal(failed.ok, false);
});
