#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    version: '',
    allowDirty: false,
    allowUnreleased: false,
    allowExistingTag: false,
    skipSmoke: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) opts.version = argv[++i];
    else if (arg === '--allow-dirty') opts.allowDirty = true;
    else if (arg === '--allow-unreleased') opts.allowUnreleased = true;
    else if (arg === '--allow-existing-tag') opts.allowExistingTag = true;
    else if (arg === '--skip-smoke') opts.skipSmoke = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }

  return opts;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

function readText(filePath) {
  return fs.readFileSync(path.join(ROOT, filePath), 'utf8');
}

function exists(filePath) {
  return fs.existsSync(path.join(ROOT, filePath));
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function printHelp() {
  console.log(`Usage: node scripts/release-readiness-check.js [--version v0.1.0]

Checks:
  - package.json version matches target
  - CHANGELOG.md has target version section
  - release docs/template exist and contain required sections
  - release notes draft exists for the target version
  - git tag does not already exist
  - git working tree is clean
  - tracked files do not include common local artifacts
  - npm test passes

Development flags:
  --allow-dirty          Allow an in-progress working tree
  --allow-unreleased     Allow the changelog section to say Unreleased
  --allow-existing-tag   Allow the target tag to already exist
  --skip-smoke           Skip npm test
`);
}

function checkReleaseReadiness(opts = {}) {
  const pkg = JSON.parse(readText('package.json'));
  const target = normalizeVersion(opts.version || pkg.version);
  const tag = `v${target}`;
  const results = [];

  function pass(label, detail = '') {
    results.push({ ok: true, label, detail });
  }

  function fail(label, detail = '') {
    results.push({ ok: false, label, detail });
  }

  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    fail('target version format', `Expected semver like v0.1.0; got ${opts.version || pkg.version}`);
  } else {
    pass('target version format', tag);
  }

  if (pkg.version === target) pass('package.json version', pkg.version);
  else fail('package.json version', `package.json has ${pkg.version}; target is ${target}`);

  try {
    const changelog = readText('CHANGELOG.md');
    const changelogHeading = changelog.match(new RegExp(`^##\\s+${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b([^\\n]*)`, 'm'));
    if (!changelogHeading) {
      fail('CHANGELOG.md version section', `Missing heading for ${tag}`);
    } else if (/unreleased/i.test(changelogHeading[1] || '') && !opts.allowUnreleased) {
      fail('CHANGELOG.md release date', `${tag} is still marked Unreleased`);
    } else {
      pass('CHANGELOG.md version section', changelogHeading[0]);
    }
  } catch (error) {
    fail('CHANGELOG.md missing or unreadable', `Could not read CHANGELOG.md: ${error.message}`);
  }

  if (exists('docs/release-process.md')) pass('release process doc', 'docs/release-process.md');
  else fail('release process doc', 'docs/release-process.md missing');

  if (exists('.github/release-template.md')) {
    const template = readText('.github/release-template.md');
    const required = ['## Summary', "## What's Included", '## Known Limitations', '## Install / Update', '## Verification'];
    const missing = required.filter((section) => !template.includes(section));
    if (missing.length) fail('GitHub release template', `Missing sections: ${missing.join(', ')}`);
    else pass('GitHub release template', '.github/release-template.md');
  } else {
    fail('GitHub release template', '.github/release-template.md missing');
  }

  const releaseNotesPath = `docs/releases/${tag}.md`;
  if (exists(releaseNotesPath)) {
    const notes = readText(releaseNotesPath);
    const required = ['## Summary', "## What's Included", '## Known Limitations', '## Install / Update', '## Verification'];
    const missing = required.filter((section) => !notes.includes(section));
    if (missing.length) fail('release notes draft', `Missing sections in ${releaseNotesPath}: ${missing.join(', ')}`);
    else if (/ISSUE\b|VERSION\b/.test(notes)) fail('release notes draft', `${releaseNotesPath} still contains placeholders`);
    else pass('release notes draft', releaseNotesPath);
  } else {
    fail('release notes draft', `${releaseNotesPath} missing`);
  }

  const gbrainNarrativeFiles = [
    'README.md',
    'docs/architecture/jarvos-architecture.md',
    releaseNotesPath,
    'modules/README.md',
    'modules/jarvos-gbrain/README.md',
    'runtimes/openclaw/README.md',
  ];
  const gbrainRequired = [
    [/GBrain-first/i, 'GBrain-first resolver language'],
    [/first structured recall authority|first-pass structured recall|first structured recall/i, 'GBrain as first structured recall authority'],
    [/QMD[^.\n]*(fallback|support|source)/i, 'QMD framed as fallback/support, not peer authority'],
  ];
  const gbrainForbidden = [
    /Structured knowledge bridge for GBrain/i,
    /Structured knowledge bridge for jarvOS/i,
    /curated bridge from an Obsidian-compatible vault into GBrain pages/i,
    /jarvOS GBrain bridge\s*-/i,
  ];
  const gbrainCorpus = gbrainNarrativeFiles
    .filter((file) => exists(file))
    .map((file) => `${file}\n${readText(file)}`)
    .join('\n\n');
  const missingGbrainFiles = gbrainNarrativeFiles.filter((file) => !exists(file));
  if (missingGbrainFiles.length) {
    fail('GBrain-first release narrative files', `Missing files: ${missingGbrainFiles.join(', ')}`);
  } else {
    const missingRequired = gbrainRequired
      .filter(([pattern]) => !pattern.test(gbrainCorpus))
      .map(([, label]) => label);
    const foundForbidden = gbrainForbidden
      .filter((pattern) => pattern.test(gbrainCorpus))
      .map((pattern) => pattern.source);
    if (missingRequired.length || foundForbidden.length) {
      fail(
        'GBrain-first release narrative',
        [
          missingRequired.length ? `missing: ${missingRequired.join(', ')}` : '',
          foundForbidden.length ? `forbidden: ${foundForbidden.join(', ')}` : '',
        ].filter(Boolean).join('; '),
      );
    } else {
      pass('GBrain-first release narrative', 'public docs frame GBrain as first structured resolver with QMD fallback/support');
    }
  }

  const tagCheck = run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
  if (tagCheck.error) {
    fail('git tag preflight', `git failed: ${tagCheck.error.message}`);
  } else if (tagCheck.status === 0 && !opts.allowExistingTag) {
    fail('git tag preflight', `${tag} already exists`);
  } else if (tagCheck.status === 0) {
    pass('git tag preflight', `${tag} exists and was allowed`);
  } else {
    pass('git tag preflight', `${tag} does not exist yet`);
  }

  const status = run('git', ['status', '--porcelain']);
  if (status.error) {
    fail('working tree cleanliness', `git failed: ${status.error.message}`);
  } else {
    const dirty = String(status.stdout || '').trim();
    if (dirty && !opts.allowDirty) fail('working tree cleanliness', dirty.split('\n').slice(0, 10).join('; '));
    else if (dirty) pass('working tree cleanliness', 'dirty tree allowed for development check');
    else pass('working tree cleanliness', 'clean');
  }

  const tracked = run('git', ['ls-files']);
  if (tracked.error) {
    fail('tracked local artifacts', `git failed: ${tracked.error.message}`);
  } else {
    const localArtifacts = String(tracked.stdout || '')
      .split(/\r?\n/)
      .filter((file) => /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(file));
    if (localArtifacts.length) fail('tracked local artifacts', localArtifacts.join(', '));
    else pass('tracked local artifacts', 'none');
  }

  if (opts.skipSmoke) {
    pass('smoke test', 'skipped by --skip-smoke');
  } else {
    const smoke = run('npm', ['test']);
    if (smoke.status === 0) pass('smoke test', 'npm test passed');
    else fail('smoke test', String(smoke.stdout || smoke.stderr || '').split('\n').slice(-20).join('\n'));
  }

  return {
    ok: results.every((result) => result.ok),
    version: tag,
    results,
  };
}

function main() {
  const opts = parseArgs();
  if (opts.help) {
    printHelp();
    return;
  }

  const report = checkReleaseReadiness(opts);
  for (const result of report.results) {
    const marker = result.ok ? 'PASS' : 'FAIL';
    console.log(`${marker} ${result.label}${result.detail ? ` — ${result.detail}` : ''}`);
  }
  console.log('');
  console.log(report.ok ? `READY ${report.version}` : `NOT READY ${report.version}`);
  process.exit(report.ok ? 0 : 1);
}

module.exports = {
  checkReleaseReadiness,
  normalizeVersion,
  parseArgs,
};

if (require.main === module) {
  main();
}
