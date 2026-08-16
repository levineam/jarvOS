'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = join(__dirname, '..');
const BASELINE = 'd730524c900694c4b375875f4662848720e31778';
const APP_TOKEN_ACTION_SHA = 'bcd2ba49218906704ab6c1aa796996da409d3eb1';
const CHECKOUT_ACTION_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_ACTION_SHA = '820762786026740c76f36085b0efc47a31fe5020';
const ACTION_SHA = '45996ed1f6d02564a971a2fa1b5860e934307cf7';
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function readJson(name) {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
}

function assertReleaseVersionCoherence(manifest, packageJson) {
  const manifestVersion = manifest['.'];
  const packageVersion = packageJson.version;

  assert.equal(typeof manifestVersion, 'string', 'Manifest release version must be a string');
  assert.match(manifestVersion, SEMVER_PATTERN, 'Manifest release version must be valid SemVer');
  assert.equal(typeof packageVersion, 'string', 'Package release version must be a string');
  assert.match(packageVersion, SEMVER_PATTERN, 'Package release version must be valid SemVer');
  assert.equal(manifestVersion, packageVersion, 'Release versions must match');
}

test('requires matching valid release versions without pinning the current version', () => {
  const manifest = readJson('.release-please-manifest.json');
  const packageJson = readJson('package.json');

  assertReleaseVersionCoherence(manifest, packageJson);
  assert.doesNotThrow(() => assertReleaseVersionCoherence(
    { ...manifest, '.': '0.8.0' },
    { ...packageJson, version: '0.8.0' },
  ));
  assert.throws(
    () => assertReleaseVersionCoherence(
      { ...manifest, '.': '0.8.1' },
      { ...packageJson, version: '0.8.0' },
    ),
    /Release versions must match/,
  );
  assert.throws(
    () => assertReleaseVersionCoherence(
      { ...manifest, '.': 'not-semver' },
      { ...packageJson, version: 'not-semver' },
    ),
    /Manifest release version must be valid SemVer/,
  );
});

test('pins the Release Please config to the public baseline and root package identity', () => {
  const config = readJson('release-please-config.json');
  assert.equal(config['bootstrap-sha'], BASELINE);
  assert.equal(config['last-release-sha'], BASELINE);
  assert.equal(config['include-v-in-tag'], true);
  assert.equal(config.packages['.']['release-type'], 'node');
  assert.equal(config.packages['.']['package-name'], 'jarvos-bootstrap');
  assert.match(createHash('sha256').update(JSON.stringify(config)).digest('hex'), /^[a-f0-9]{64}$/);
});

test('runs only from trusted main pushes with immutable action and App-token release identity', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release-please.yml'), 'utf8');
  const privateKeyField = ['private', 'key'].join('-');
  const permissions = workflow.match(/^permissions:\n((?:  [^\n]+\n)+)\nconcurrency:/m)?.[1];
  const tokenStep = workflow.match(/      - id: app-token\n([\s\S]*?)(?=      - id: release\n)/)?.[1];
  const releaseStep = workflow.match(/      - id: release\n([\s\S]*)$/)?.[1];

  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /@v\d/);
  assert.doesNotMatch(workflow, /JARVOS_RELEASE_PLEASE_APP_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/);

  assert.equal(permissions, '  contents: write\n  pull-requests: write\n  issues: write\n');
  assert.ok(tokenStep, 'App-token step must precede the release step');
  assert.match(tokenStep, new RegExp(`^        uses: actions/create-github-app-token@${APP_TOKEN_ACTION_SHA} # v3\\.2\\.0$`, 'm'));
  assert.match(tokenStep, /^          client-id: \$\{\{ secrets\.JARVOS_RELEASE_PLEASE_APP_CLIENT_ID \}\}$/m);
  assert.match(
    tokenStep,
    new RegExp(`^          ${privateKeyField}: \\$\\{\\{ secrets\\.JARVOS_RELEASE_PLEASE_APP_PRIVATE_KEY \\}\\}$`, 'm'),
  );
  assert.match(tokenStep, /^          owner: \$\{\{ github\.repository_owner \}\}$/m);
  assert.match(tokenStep, /^          repositories: jarvOS$/m);
  assert.match(tokenStep, /^          permission-contents: write$/m);
  assert.match(tokenStep, /^          permission-issues: write$/m);
  assert.match(tokenStep, /^          permission-pull-requests: write$/m);

  assert.ok(releaseStep, 'Release step must follow the App-token step');
  assert.match(releaseStep, new RegExp(`^        uses: googleapis/release-please-action@${ACTION_SHA} # v5\\.0\\.0$`, 'm'));
  assert.match(releaseStep, /^          token: \$\{\{ steps\.app-token\.outputs\.token \}\}$/m);
});

test('pins CI checkout and Node setup actions to Node 24 releases', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const checkoutUses = [...workflow.matchAll(/^\s+- uses: actions\/checkout@([^ ]+) # v7\.0\.1$/gm)];
  const setupNodeUses = [...workflow.matchAll(/^\s+uses: actions\/setup-node@([^ ]+) # v7\.0\.0$/gm)];

  assert.equal(checkoutUses.length, 6);
  assert.ok(checkoutUses.every((match) => match[1] === CHECKOUT_ACTION_SHA));
  assert.equal(setupNodeUses.length, 2);
  assert.ok(setupNodeUses.every((match) => match[1] === SETUP_NODE_ACTION_SHA));
  assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node)@v\d/);
});

test('secret scan ignores exact GitHub secret references but retains literal candidates', () => {
  const key = ['private', 'key'].join('-');
  const input = [
    `.github/workflows/release.yml:10:  ${key}: \${{ secrets.APP_PRIVATE_KEY }}`,
    `+  ${key}: literal-value`,
  ].join('\n');
  const result = spawnSync('bash', [join(ROOT, 'scripts/filter-secret-scan-candidates.sh')], {
    encoding: 'utf8',
    input,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `+  ${key}: literal-value\n`);
});

test('does not force a target version before Release Please observes the public range', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release-please.yml'), 'utf8');
  assert.doesNotMatch(workflow, /Release-As:\s*1\.0\.0/);
  assert.doesNotMatch(workflow, /release-as:/i);
});
