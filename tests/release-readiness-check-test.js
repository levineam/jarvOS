#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const packageJson = require('../package.json');
const {
  checkFrontDoorReleaseProse,
  checkReleaseReadiness,
  findExistingReleaseTag,
  releaseTagNames,
} = require('../scripts/release-readiness-check');

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

const V011_OPTIONS = { target: '0.11.0', tag: 'v0.11.0' };
const RELEASE_URL = 'https://example.invalid/release';

function linkedLabel(version, { backtick = false } = {}) {
  const label = backtick ? `\`${version}\`` : version;
  return `[${label}](${RELEASE_URL})`;
}

function currentClaimFiles(readmeClaim, releaseProcessClaim) {
  return {
    'README.md': `## Release Status\n\n${readmeClaim}\n`,
    'docs/release-process.md': `${releaseProcessClaim}\n`,
  };
}

function resultFor(results, label) {
  return results.find((result) => result.label === label);
}

const README_LABEL = 'README current release prose';
const RELEASE_PROCESS_LABEL = 'release-process final-version prose';

// Label prefixes: plain, component-tag (as in the public README), and uppercase V (recognizers are case-insensitive).
const LABEL_PREFIXES = ['v', 'jarvos-bootstrap-v', 'V'];

test('front-door release prose accepts bare, backtick, and linked version labels for the target', () => {
  const forms = LABEL_PREFIXES.flatMap((prefix) => {
    const version = `${prefix}0.11.0`;
    return [version, `\`${version}\``, linkedLabel(version), linkedLabel(version, { backtick: true })];
  });

  for (const form of forms) {
    const claim = `${form} is the current public preview release.`;
    const results = runFrontDoorCheck(currentClaimFiles(claim, claim), V011_OPTIONS);
    assert.deepEqual(failedLabels(results), [], `form ${form}`);
  }

  const publicReadmeLine = '> **Release status:** [`jarvos-bootstrap-v0.11.0`](https://github.com/levineam/jarvOS/releases/tag/jarvos-bootstrap-v0.11.0) is the current public preview release.';
  const results = runFrontDoorCheck(currentClaimFiles(publicReadmeLine, publicReadmeLine), V011_OPTIONS);
  assert.deepEqual(failedLabels(results), []);
});

test('front-door release prose rejects a linked stale version label in README and release-process', () => {
  for (const prefix of LABEL_PREFIXES) {
    for (const backtick of [false, true]) {
      const claim = `${linkedLabel(`${prefix}0.10.0`, { backtick })} is the current public preview release.`;
      const results = runFrontDoorCheck(currentClaimFiles(claim, claim), V011_OPTIONS);

      const readmeResult = resultFor(results, README_LABEL);
      assert.equal(readmeResult.ok, false, claim);
      assert.match(readmeResult.detail, /README names v0\.10\.0; target is v0\.11\.0/i);

      const releaseProcessResult = resultFor(results, RELEASE_PROCESS_LABEL);
      assert.equal(releaseProcessResult.ok, false, claim);
      assert.match(releaseProcessResult.detail, /Release-process current claim names v0\.10\.0; target is v0\.11\.0/i);
    }
  }
});

test('front-door release prose rejects a linked candidate version label in README and release-process', () => {
  for (const prefix of LABEL_PREFIXES) {
    for (const backtick of [false, true]) {
      const claim = `${linkedLabel(`${prefix}0.11.0`, { backtick })} is the current public preview release candidate.`;
      const results = runFrontDoorCheck(currentClaimFiles(claim, claim), V011_OPTIONS);

      const readmeResult = resultFor(results, README_LABEL);
      assert.equal(readmeResult.ok, false, claim);
      assert.match(readmeResult.detail, /v0\.11\.0 is still described as a current candidate/i);

      const releaseProcessResult = resultFor(results, RELEASE_PROCESS_LABEL);
      assert.equal(releaseProcessResult.ok, false, claim);
      assert.match(releaseProcessResult.detail, /v0\.11\.0 is still described as a current candidate/i);
    }
  }
});

test('front-door release prose rejects a linked stale claim next to a valid unlinked current claim', () => {
  for (const validForm of ['v0.11.0', '`v0.11.0`', 'jarvos-bootstrap-v0.11.0', '`jarvos-bootstrap-v0.11.0`']) {
    for (const prefix of LABEL_PREFIXES) {
      for (const backtick of [false, true]) {
        const valid = `${validForm} is the current public preview release.`;
        const staleLinked = `Elsewhere, ${linkedLabel(`${prefix}0.10.0`, { backtick })} is the current public preview release.`;
        const claims = [valid, '', staleLinked].join('\n');
        const results = runFrontDoorCheck(currentClaimFiles(claims, claims), V011_OPTIONS);

        const readmeResult = resultFor(results, README_LABEL);
        assert.equal(readmeResult.ok, false, staleLinked);
        assert.match(readmeResult.detail, /README names v0\.10\.0; target is v0\.11\.0/i);

        const releaseProcessResult = resultFor(results, RELEASE_PROCESS_LABEL);
        assert.equal(releaseProcessResult.ok, false, staleLinked);
        assert.match(releaseProcessResult.detail, /Release-process current claim names v0\.10\.0; target is v0\.11\.0/i);
      }
    }
  }
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

test('tag preflight recognizes the published package-prefixed v0.11 tag', () => {
  const tags = 'v0.7.0\njarvos-bootstrap-v0.10.0\njarvos-bootstrap-v0.11.0\n';

  assert.equal(findExistingReleaseTag(tags, '0.11.0', 'jarvos-bootstrap'), 'jarvos-bootstrap-v0.11.0');
  assert.equal(findExistingReleaseTag(tags, '0.7.0', 'jarvos-bootstrap'), 'v0.7.0');
});

test('tag preflight never treats an unpublished candidate or foreign package tag as existing', () => {
  const tags = 'jarvos-bootstrap-v0.11.0\nother-package-v0.11.1\n';

  assert.equal(findExistingReleaseTag(tags, '0.11.1', 'jarvos-bootstrap'), null);
  assert.equal(findExistingReleaseTag('', '0.11.1', 'jarvos-bootstrap'), null);
  assert.deepEqual(releaseTagNames('0.11.1', 'jarvos-bootstrap'), ['v0.11.1', 'jarvos-bootstrap-v0.11.1']);
});

test('candidate release gate passes as unreleased work without authorizing a versioned release', () => {
  const report = checkReleaseReadiness({
    allowDirty: true,
    allowUnreleased: true,
    allowExistingTag: true,
    skipSmoke: true,
  });

  assert.equal(report.ok, true);
  assert.equal(report.version, `v${packageJson.version}`);
  assert.equal(report.results.find((result) => result.label === 'CHANGELOG.md version section').ok, true);
  assert.equal(report.results.find((result) => result.label === 'git tag preflight').ok, true);
});
