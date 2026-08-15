#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

function revisionFor(runCommand, ref) {
  const result = runCommand('git', ['rev-parse', ref]);
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function resolveReceiptRevisions(runCommand = run) {
  const revision = revisionFor(runCommand, 'HEAD');
  const pullRequestHead = revisionFor(runCommand, 'HEAD^2');
  const sourceParentRevision = pullRequestHead
    ? revisionFor(runCommand, 'HEAD^2^')
    : revisionFor(runCommand, 'HEAD^');
  return { revision, sourceParentRevision };
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function checkCodexRoutingClaims({ readText: read, exists: fileExists, revision, sourceParentRevision = '' }) {
  const results = [];
  const corpusPath = 'runtimes/codex/coding-conformance-prompts.json';
  const receiptPath = 'runtimes/codex/coding-routing-conformance.json';
  const lifecyclePath = 'runtimes/codex/coding-lifecycle-conformance.json';
  const documentation = ['README.md', 'runtimes/codex/README.md', 'modules/jarvos-coding/README.md', 'modules/jarvos-skills/README.md', 'modules/README.md'];
  const pass = (label, detail = '') => results.push({ ok: true, label, detail });
  const fail = (label, detail = '') => results.push({ ok: false, label, detail });
  if (!fileExists(corpusPath) || !fileExists(receiptPath) || !fileExists(lifecyclePath)) {
    fail('Codex natural-routing evidence', 'Prompt corpus, routing receipt, or direct lifecycle receipt is missing');
    return results;
  }
  try {
    const corpus = JSON.parse(read(corpusPath));
    const receipt = JSON.parse(read(receiptPath));
    const lifecycle = JSON.parse(read(lifecyclePath));
    const managed = (corpus.classes || []).filter((entry) => entry.kind === 'managed-intent');
    const controls = (corpus.classes || []).filter((entry) => entry.kind === 'control');
    const corpusValid = corpus.schemaVersion === 'jarvos-codex-coding-routing-prompts/v1'
      && managed.length > 0 && controls.length > 0
      && managed.every((entry) => entry.minimumPrompts === 10 && entry.minimumSelectionRate === 0.9 && entry.prompts?.length >= 10)
      && controls.every((entry) => entry.minimumPrompts === 10 && entry.maximumFalseManagedRunClaims === 0 && entry.prompts?.length >= 10);
    const lifecycleOperations = ['initialize', 'tools/list', 'plan', 'accept-plan', 'work', 'finish', 'status', 'resume'];
    const lifecycleRevision = lifecycle.sourceRevisionStrategy === 'source-parent' ? sourceParentRevision : revision;
    const directLifecycleProven = lifecycle.schemaVersion === 'jarvos-codex-coding-lifecycle-conformance/v1'
      && lifecycle.status === 'passed'
      && Boolean(lifecycleRevision)
      && lifecycle.jarvosRevision === lifecycleRevision
      && lifecycle.mcp?.directInvocation === true
      && lifecycle.provider?.networkObserved === false
      && lifecycle.restart?.sameRun === true
      && lifecycle.restart?.sameWorktree === true
      && lifecycle.verification?.authoritative === true
      && lifecycle.finalizer?.automatic === true
      && lifecycleOperations.every((operation) => lifecycle.operations?.includes(operation));
    const directProven = receipt.directInvocation?.status === 'passed' && directLifecycleProven;
    const expectedRevision = receipt.sourceRevisionStrategy === 'source-parent' ? sourceParentRevision : revision;
    const receiptCurrent = Boolean(expectedRevision) && receipt.jarvosRevision === expectedRevision
      && receipt.promptCorpus?.digest === digest(corpus);
    const liveResultsPass = managed.every((entry) => {
      const result = receipt.results?.find((candidate) => candidate.classId === entry.id);
      return result && result.promptCount >= entry.minimumPrompts && result.selected / result.promptCount >= entry.minimumSelectionRate;
    }) && controls.every((entry) => {
      const result = receipt.results?.find((candidate) => candidate.classId === entry.id);
      return result && result.promptCount >= entry.minimumPrompts && result.falseManagedRunClaims === 0;
    });
    const naturalRoutingProven = receipt.status === 'passed' && corpusValid && receiptCurrent
      && Boolean(receipt.harness?.codexVersion && receipt.harness?.model && receipt.harness?.projectedSkillDigest && receipt.harness?.mcpSchemaVersion)
      && liveResultsPass;
    if (!directProven) fail('Codex direct invocation evidence', 'The deterministic lifecycle receipt is missing, stale, incomplete, or not passed');
    else pass('Codex direct invocation evidence', 'deterministic managed-run lifecycle remains available');

    const docs = documentation.filter(fileExists).map(read).join('\n');
    const naturalClaim = /natural coding verbs|ordinary jarvOS .*?(?:plan|work|complete).*?(?:CE|route)|Say `plan`, `work`, or `complete`/i.test(docs);
    if (naturalRoutingProven) {
      pass('Codex natural-routing evidence', 'current authenticated routing receipt meets the committed corpus thresholds');
    } else if (naturalClaim) {
      fail('Codex natural-routing evidence', 'Natural-routing language is present without a current passed live routing receipt');
    } else if (!/Natural routing is currently unavailable/i.test(docs)) {
      fail('Codex natural-routing evidence', 'Docs must state that natural routing is unavailable until a current live receipt passes');
    } else if (receipt.status !== 'unavailable' || !corpusValid || !directProven) {
      fail('Codex natural-routing evidence', 'Routing receipt is stale, incomplete, or unavailable without the required direct-only fallback evidence');
    } else {
      pass('Codex natural-routing evidence', 'unavailable live routing is documented; claims are limited to direct invocation');
    }
  } catch (error) {
    fail('Codex natural-routing evidence', error.message);
  }
  return results;
}

function findReleaseProcessCurrentClaims(releaseProcess) {
  const text = String(releaseProcess || '');
  const claims = [];

  for (const match of text.matchAll(/`?(v\d+\.\d+\.\d+)`?\s+is\s+the\s+current\s+[^.\n]*(?:lane|release|label|version|public preview)[^.\n]*/gi)) {
    claims.push({ version: match[1], text: match[0] });
  }

  for (const match of text.matchAll(/current active release label,\s+such as\s+`?release-(v\d+\.\d+\.\d+)`?/gi)) {
    claims.push({ version: match[1], text: match[0] });
  }

  return claims;
}

function findReadmeCurrentReleaseClaims(readme) {
  return Array.from(String(readme || '').matchAll(/`?(v\d+\.\d+\.\d+)`?\s+is the current public preview release[^.\n]*/gi))
    .map((match) => ({ version: match[1], text: match[0] }));
}

function checkFrontDoorReleaseProse({ target, tag, allowUnreleased, readText: read, exists: fileExists }) {
  const results = [];

  function pass(label, detail = '') {
    results.push({ ok: true, label, detail });
  }

  function fail(label, detail = '') {
    results.push({ ok: false, label, detail });
  }

  try {
    if (!fileExists('README.md')) {
      fail('README current release prose', 'README.md missing');
    } else if (allowUnreleased) {
      pass('README current release prose', 'candidate-mode wording allowed');
    } else {
      const readme = read('README.md');
      const currentReleaseClaims = findReadmeCurrentReleaseClaims(readme);
      const candidateClaim = currentReleaseClaims.find((claim) => /candidate/i.test(claim.text));
      const staleClaim = currentReleaseClaims.find((claim) => normalizeVersion(claim.version) !== target);
      if (currentReleaseClaims.length === 0) {
        fail('README current release prose', 'Missing "`vX.Y.Z` is the current public preview release" line');
      } else if (candidateClaim) {
        fail('README current release prose', `${candidateClaim.version} is still described as a current candidate`);
      } else if (staleClaim) {
        fail('README current release prose', `README names ${staleClaim.version}; target is ${tag}`);
      } else {
        pass('README current release prose', `${tag} is named as the current public preview`);
      }
    }
  } catch (error) {
    fail('README current release prose', error.message);
  }

  try {
    if (!fileExists('docs/release-process.md')) {
      fail('release-process final-version prose', 'docs/release-process.md missing');
    } else if (allowUnreleased) {
      pass('release-process final-version prose', 'candidate-mode wording allowed');
    } else {
      const releaseProcess = read('docs/release-process.md');
      const currentClaims = findReleaseProcessCurrentClaims(releaseProcess);
      const candidateClaim = currentClaims.find((claim) => /candidate/i.test(claim.text));
      const staleClaim = currentClaims.find((claim) => normalizeVersion(claim.version) !== target);
      if (candidateClaim) {
        fail('release-process final-version prose', `${candidateClaim.version} is still described as a current candidate`);
      } else if (staleClaim) {
        fail('release-process final-version prose', `Release-process current claim names ${staleClaim.version}; target is ${tag}`);
      } else if (currentClaims.length === 0) {
        fail('release-process final-version prose', 'Missing a current release-process version or active release label claim');
      } else {
        pass('release-process final-version prose', `${tag} is the release-process current claim`);
      }
    }
  } catch (error) {
    fail('release-process final-version prose', error.message);
  }

  return results;
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
  const root = path.resolve(opts.root || ROOT);
  const read = (filePath) => fs.readFileSync(path.join(root, filePath), 'utf8');
  const fileExists = (filePath) => fs.existsSync(path.join(root, filePath));
  const runLocal = (command, args, options = {}) => run(opts.npmPath && command === 'npm' ? opts.npmPath : command, args, {
    ...options,
    cwd: root,
    ...(opts.env ? { env: opts.env } : {}),
  });
  const pkg = JSON.parse(read('package.json'));
  const target = normalizeVersion(opts.version || pkg.version);
  const tag = `v${target}`;
  const results = [];

  function pass(label, detail = '') {
    results.push({ ok: true, label, detail });
  }

  function fail(label, detail = '') {
    results.push({ ok: false, label, detail });
  }

  const { revision, sourceParentRevision } = resolveReceiptRevisions(runLocal);
  results.push(...checkCodexRoutingClaims({ readText: read, exists: fileExists, revision, sourceParentRevision }));

  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    fail('target version format', `Expected semver like v0.1.0; got ${opts.version || pkg.version}`);
  } else {
    pass('target version format', tag);
  }

  if (pkg.version === target) pass('package.json version', pkg.version);
  else fail('package.json version', `package.json has ${pkg.version}; target is ${target}`);

  try {
    const changelog = read('CHANGELOG.md');
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

  if (fileExists('docs/release-process.md')) pass('release process doc', 'docs/release-process.md');
  else fail('release process doc', 'docs/release-process.md missing');

  results.push(...checkFrontDoorReleaseProse({
    target,
    tag,
    allowUnreleased: opts.allowUnreleased,
    readText: read,
    exists: fileExists,
  }));

  if (fileExists('.github/release-template.md')) {
    const template = read('.github/release-template.md');
    const required = ['## Summary', "## What's Included", '## Known Limitations', '## Install / Update', '## Verification'];
    const missing = required.filter((section) => !template.includes(section));
    if (missing.length) fail('GitHub release template', `Missing sections: ${missing.join(', ')}`);
    else pass('GitHub release template', '.github/release-template.md');
  } else {
    fail('GitHub release template', '.github/release-template.md missing');
  }

  const releaseNotesPath = `docs/releases/${tag}.md`;
  if (fileExists(releaseNotesPath)) {
    const notes = read(releaseNotesPath);
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
    'CHANGELOG.md',
    releaseNotesPath,
    'modules/README.md',
    'modules/jarvos-gbrain/README.md',
    'PUBLIC_BASELINE.md',
  ];
  try {
    const missingFiles = gbrainNarrativeFiles.filter((filePath) => !fileExists(filePath));
    if (missingFiles.length) {
      fail('GBrain-first release narrative', `Missing files: ${missingFiles.join(', ')}`);
    } else {
      const combined = gbrainNarrativeFiles.map((filePath) => read(filePath)).join('\n');
      const requiredPhrases = [
        'GBrain-first',
        '@jarvos/gbrain',
        'resolver',
        'does not implement GBrain',
        'not GBrain itself',
      ];
      const missingPhrases = requiredPhrases.filter((phrase) => !combined.includes(phrase));
      const transitionalMatches = combined.match(/(?:structured knowledge bridge|GBrain bridge)/gi) || [];
      if (missingPhrases.length) {
        fail('GBrain-first release narrative', `Missing phrases: ${missingPhrases.join(', ')}`);
      } else if (transitionalMatches.length) {
        fail('GBrain-first release narrative', `Transitional bridge phrasing remains: ${[...new Set(transitionalMatches)].join(', ')}`);
      } else {
        pass('GBrain-first release narrative', 'public docs state resolver-first GBrain boundary without bridge framing');
      }
    }
  } catch (error) {
    fail('GBrain-first release narrative', error.message);
  }

  const tagCheck = runLocal('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
  if (tagCheck.error) {
    fail('git tag preflight', `git failed: ${tagCheck.error.message}`);
  } else if (tagCheck.status === 0 && !opts.allowExistingTag) {
    fail('git tag preflight', `${tag} already exists`);
  } else if (tagCheck.status === 0) {
    pass('git tag preflight', `${tag} exists and was allowed`);
  } else {
    pass('git tag preflight', `${tag} does not exist yet`);
  }

  const status = runLocal('git', ['status', '--porcelain']);
  if (status.error) {
    fail('working tree cleanliness', `git failed: ${status.error.message}`);
  } else {
    const dirty = String(status.stdout || '').trim();
    if (dirty && !opts.allowDirty) fail('working tree cleanliness', dirty.split('\n').slice(0, 10).join('; '));
    else if (dirty) pass('working tree cleanliness', 'dirty tree allowed for development check');
    else pass('working tree cleanliness', 'clean');
  }

  const tracked = runLocal('git', ['ls-files']);
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
    const smoke = runLocal('npm', ['test']);
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
  checkCodexRoutingClaims,
  checkFrontDoorReleaseProse,
  checkReleaseReadiness,
  findReadmeCurrentReleaseClaims,
  findReleaseProcessCurrentClaims,
  normalizeVersion,
  parseArgs,
  resolveReceiptRevisions,
};

if (require.main === module) {
  main();
}
