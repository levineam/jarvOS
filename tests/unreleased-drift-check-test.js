#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { unreleasedSection, changelogVersionSection } = require('../scripts/unreleased-drift-check');

test('unreleasedSection treats a literal "Nothing yet." placeholder as empty', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n- Nothing yet.\n\n## v0.6.3 — 2026-07-16\n\n- Something shipped.\n';
  const result = unreleasedSection(changelog);
  assert.equal(result.present, true);
  assert.equal(result.nonEmpty, false, 'a placeholder-only bullet must not count as tracked work');
});

test('unreleasedSection treats other known placeholders (None., N/A, TBD) as empty', () => {
  for (const placeholder of ['None.', 'N/A', 'TBD', 'tbd.']) {
    const changelog = `## [Unreleased]\n\n- ${placeholder}\n\n## v0.6.3\n`;
    assert.equal(unreleasedSection(changelog).nonEmpty, false, `"${placeholder}" should be treated as empty`);
  }
});

test('unreleasedSection recognizes real recorded work as non-empty', () => {
  const changelog = '## [Unreleased]\n\n- Add protected-resource mutation policy.\n\n## v0.6.3\n';
  const result = unreleasedSection(changelog);
  assert.equal(result.present, true);
  assert.equal(result.nonEmpty, true);
});

test('unreleasedSection reports absent when there is no [Unreleased] heading', () => {
  const result = unreleasedSection('## v0.6.3\n\n- Something shipped.\n');
  assert.equal(result.present, false);
  assert.equal(result.nonEmpty, false);
});

test('unreleasedSection does not bleed content from the next section', () => {
  const changelog = '## [Unreleased]\n\n- Nothing yet.\n\n## v0.6.3\n\n- Real shipped change.\n';
  const result = unreleasedSection(changelog);
  assert.equal(result.nonEmpty, false);
});

test('changelogVersionSection still detects a dated version heading', () => {
  const changelog = '## v0.6.3 — 2026-07-16\n\nPatch release.\n';
  const result = changelogVersionSection(changelog, '0.6.3');
  assert.equal(result.present, true);
  assert.equal(result.dated, true);
});

test('changelogVersionSection reports undated when still marked Unreleased', () => {
  const changelog = '## v0.7.0 (Unreleased)\n\nPending.\n';
  const result = changelogVersionSection(changelog, '0.7.0');
  assert.equal(result.present, true);
  assert.equal(result.dated, false);
});

test('public journal landing stays unreleased without a package version bump', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const unreleased = unreleasedSection(changelog);

  assert.equal(pkg.version, '0.7.0');
  assert.equal(unreleased.present, true);
  assert.equal(unreleased.nonEmpty, true);
  assert.match(changelog, /daily journal creation/i);
  assert.doesNotMatch(changelog, /^##\s+v0\.7\.1\b/m);
});
