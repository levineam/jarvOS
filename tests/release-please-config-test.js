'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const ROOT = join(__dirname, '..');
const BASELINE = 'd730524c900694c4b375875f4662848720e31778';
const ACTION_SHA = '16a9c90856f42705d54a6fda1823352bdc62cf38';

function readJson(name) {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8'));
}

test('pins the root Node Release Please manifest to v0.7.0 and the public baseline', () => {
  const config = readJson('release-please-config.json');
  const manifest = readJson('.release-please-manifest.json');
  assert.equal(manifest['.'], '0.7.0');
  assert.equal(config['bootstrap-sha'], BASELINE);
  assert.equal(config['last-release-sha'], BASELINE);
  assert.equal(config['include-v-in-tag'], true);
  assert.equal(config.packages['.']['release-type'], 'node');
  assert.equal(config.packages['.']['package-name'], 'jarvos-bootstrap');
  assert.match(createHash('sha256').update(JSON.stringify(config)).digest('hex'), /^[a-f0-9]{64}$/);
});

test('runs only from trusted main pushes with immutable action and App-token release identity', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/release-please.yml'), 'utf8');
  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- main/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(workflow, new RegExp(`googleapis/release-please-action@${ACTION_SHA}`));
  assert.doesNotMatch(workflow, /@v\d/);
  assert.match(workflow, /secrets\.JARVOS_RELEASE_PLEASE_APP_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /issues: write/);
});

test('documents the deliberate Release-As v1.0.0 promotion without changing package version early', () => {
  const packageJson = readJson('package.json');
  const workflow = readFileSync(join(ROOT, '.github/workflows/release-please.yml'), 'utf8');
  assert.equal(packageJson.version, '0.7.0');
  assert.match(workflow, /Release-As: 1\.0\.0/);
});
