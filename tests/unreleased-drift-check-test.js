#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { unreleasedSection, changelogVersionSection, evaluateUnreleasedDrift } = require('../scripts/unreleased-drift-check');

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

test('changelogVersionSection recognizes Release Please bracketed headings', () => {
  const changelog = '## [0.9.0](https://github.com/levineam/jarvOS/compare/jarvos-bootstrap-v0.8.0...jarvos-bootstrap-v0.9.0) (2026-08-26)\n\nRelease notes.\n';
  const result = changelogVersionSection(changelog, '0.9.0');
  assert.equal(result.present, true);
  assert.equal(result.dated, true);
});

test('evaluateUnreleasedDrift treats the canonical package-prefixed tag as the current release', () => {
  const result = evaluateUnreleasedDrift({
    version: '0.9.0',
    tags: ['v0.7.0', 'jarvos-bootstrap-v0.9.0'],
    commitsSinceTag: 0,
    changelog: '## [0.9.0](https://example.test/compare/jarvos-bootstrap-v0.8.0...jarvos-bootstrap-v0.9.0) (2026-08-26)\n',
  });

  assert.equal(result.latestTag, 'jarvos-bootstrap-v0.9.0');
  assert.equal(result.drift, false);
  assert.equal(result.state, 'ok');
});

test('evaluateUnreleasedDrift still rejects a genuinely untagged finalized release', () => {
  const result = evaluateUnreleasedDrift({
    version: '0.9.0',
    tags: ['v0.7.0'],
    commitsSinceTag: 0,
    changelog: '## [0.8.0](https://example.test/compare/jarvos-bootstrap-v0.7.0...jarvos-bootstrap-v0.8.0) (2026-08-16)\n',
  });

  assert.equal(result.drift, true);
  assert.equal(result.state, 'untagged-release');
});

test('evaluateUnreleasedDrift reports the v0.11 prefixed tag as baseline with no candidate', () => {
  const result = evaluateUnreleasedDrift({
    version: '0.11.0',
    tags: ['v0.7.0', 'jarvos-bootstrap-v0.10.0', 'jarvos-bootstrap-v0.11.0'],
    commitsSinceTag: 0,
    changelog: '## [0.11.0](https://example.test/compare/jarvos-bootstrap-v0.10.0...jarvos-bootstrap-v0.11.0) (2026-09-19)\n',
  });

  assert.equal(result.baselineTag, 'jarvos-bootstrap-v0.11.0');
  assert.equal(result.baselineVersion, '0.11.0');
  assert.equal(result.candidateVersion, null);
  assert.equal(result.drift, false);
});

test('evaluateUnreleasedDrift does not infer a candidate from a package-prefixed tag alone', () => {
  const result = evaluateUnreleasedDrift({
    version: '0.11.0',
    tags: ['jarvos-bootstrap-v0.11.0'],
    commitsSinceTag: 3,
    changelog: '## [0.11.0](https://example.test/compare/a...b) (2026-09-19)\n',
  });

  assert.equal(result.baselineTag, 'jarvos-bootstrap-v0.11.0');
  assert.equal(result.drift, true);
  assert.equal(result.state, 'unlogged-work');
  assert.equal(result.candidateVersion, null);
  assert.doesNotMatch(result.messages.join(' '), /Release Please candidate/);
});

test('evaluateUnreleasedDrift accepts post-tag work tracked under [Unreleased] after a package-prefixed tag', () => {
  const result = evaluateUnreleasedDrift({
    version: '0.11.0',
    tags: ['jarvos-bootstrap-v0.11.0'],
    commitsSinceTag: 3,
    changelog: '## [Unreleased]\n\n- Track the release monitor card.\n\n## [0.11.0](https://example.test/compare/a...b) (2026-09-19)\n',
  });

  assert.equal(result.drift, false);
  assert.equal(result.state, 'ok');
  assert.match(result.messages.join(' '), /tracked under \[Unreleased\]/);
});

test('evaluateUnreleasedDrift honors only an explicit present candidate observation for post-tag work', () => {
  const input = {
    version: '0.11.0',
    tags: ['jarvos-bootstrap-v0.11.0'],
    commitsSinceTag: 3,
    changelog: '## [0.11.0](https://example.test/compare/a...b) (2026-09-19)\n',
  };

  const present = evaluateUnreleasedDrift({ ...input, candidate: { status: 'present', version: '0.11.1', source: 'release-please-pr' } });
  assert.equal(present.drift, false);
  assert.equal(present.state, 'ok');
  assert.match(present.messages.join(' '), /explicitly observed Release Please candidate/);

  for (const candidate of [{ status: 'none' }, { status: 'unavailable' }, undefined]) {
    const result = evaluateUnreleasedDrift({ ...input, candidate });
    assert.equal(result.drift, true, `candidate ${JSON.stringify(candidate)} must not suppress unlogged work`);
    assert.equal(result.state, 'unlogged-work');
  }
});

test('evaluateUnreleasedDrift still flags unlogged work after a legacy plain tag', () => {
  const result = evaluateUnreleasedDrift({
    version: '0.7.0',
    tags: ['v0.7.0'],
    commitsSinceTag: 3,
    changelog: '## v0.7.0 — 2026-07-19\n',
  });

  assert.equal(result.drift, true);
  assert.equal(result.state, 'unlogged-work');
});

test('evaluateUnreleasedDrift names a finalized candidate without synthesizing its tag', () => {
  const result = evaluateUnreleasedDrift({
    version: '0.11.1',
    tags: ['jarvos-bootstrap-v0.11.0'],
    commitsSinceTag: 2,
    changelog: '## [0.11.1](https://example.test/compare/a...b) (2026-09-20)\n\n## [0.11.0](https://example.test/compare/a...b) (2026-09-19)\n',
  });

  assert.equal(result.state, 'ready-to-tag');
  assert.equal(result.candidateVersion, '0.11.1');
  assert.equal(result.baselineTag, 'jarvos-bootstrap-v0.11.0');
  assert.doesNotMatch(result.messages.join(' '), /git tag/);
});

test('public journal landing remains tracked as unreleased work', () => {
  const changelog = fs.readFileSync(path.resolve(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const unreleased = unreleasedSection(changelog);

  assert.equal(unreleased.present, true);
  assert.equal(unreleased.nonEmpty, true);
  assert.match(changelog, /daily journal creation/i);
  assert.doesNotMatch(changelog, /^##\s+v0\.7\.1\b/m);
});
