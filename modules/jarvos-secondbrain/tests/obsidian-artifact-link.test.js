'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  OBSIDIAN_RESOLVER_ORIGIN,
  buildObsidianArtifactLink,
  buildObsidianArtifactUrl,
} = require('../src/obsidian-artifact-link');

test('builds the fixed HTTPS Obsidian resolver URL with one encoding pass', () => {
  const href = buildObsidianArtifactUrl({
    vaultName: 'Vault v3',
    vaultRelativePath: 'Notes/Über & Ideas.md',
  });
  assert.equal(href, `${OBSIDIAN_RESOLVER_ORIGIN}?vault=Vault%20v3&file=Notes%2F%C3%9Cber%20%26%20Ideas.md`);
  assert.equal(buildObsidianArtifactLink({
    vaultName: 'Vault v3',
    vaultRelativePath: 'Journal/2026-08-10.md',
    label: 'Open today\'s journal',
  }).label, "Open today's journal");
});

test('requires a safe caller-supplied vault identity and never accepts another origin', () => {
  for (const vaultName of ['', 'Vault/Other', 'Vault?leak', 'Vault%20v3', 'https://evil.example']) {
    assert.throws(() => buildObsidianArtifactUrl({ vaultName, vaultRelativePath: 'Notes/a.md' }), /vaultName/);
  }
  assert.throws(() => buildObsidianArtifactUrl({ vaultName: 'Vault v3', vaultRelativePath: 'Notes/a%2Fb.md' }), /canonical|path/);
  assert.ok(buildObsidianArtifactUrl({ vaultName: 'Vault v3', vaultRelativePath: 'Notes/a.md' }).startsWith(OBSIDIAN_RESOLVER_ORIGIN));
});
