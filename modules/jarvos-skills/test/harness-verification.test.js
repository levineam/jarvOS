'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { computeBundleTree, verifyHarnessBundle, deriveShadowPaths } = require('../src');

test('exact-path proof binds name and bundle digest while interactive proof remains pending', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-verify-'));
  fs.chmodSync(root, 0o700);
  try {
    const bundle = path.join(root, 'fixture');
    fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(bundle, 'SKILL.md'), '---\nname: fixture\n---\n', { mode: 0o600 });
    const tree = computeBundleTree(bundle);
    const exact = verifyHarnessBundle({ adapter: { skillProjection: { verificationTier: 'exact-path' } }, targetPath: bundle, expectedName: 'fixture', expectedTreeDigest: tree.treeDigest });
    assert.equal(exact.status, 'model_visible');
    const shadow = path.join(root, 'higher-precedence-fixture'); fs.mkdirSync(shadow, { mode: 0o700 });
    assert.equal(verifyHarnessBundle({ adapter: { skillProjection: { verificationTier: 'exact-path' } }, targetPath: bundle, expectedName: 'fixture', expectedTreeDigest: tree.treeDigest, shadowPaths: [shadow] }).reason, 'higher_precedence_shadow');
    assert.equal(verifyHarnessBundle({ adapter: { skillProjection: { verificationTier: 'interactive-smoke' } }, targetPath: bundle, expectedName: 'fixture', expectedTreeDigest: tree.treeDigest }).reason, 'remote_probe_not_authorized');
    assert.equal(verifyHarnessBundle({ adapter: { skillProjection: { verificationTier: 'interactive-smoke' } }, remoteModelProbe: true }).reason, 'interactive_probe_required');
    assert.equal(deriveShadowPaths({ harness: { scopeRoots: { project: '~/.codex/project-skills' } }, adapter: { skillProjection: { orderedScopes: ['project', 'managed'] } }, effectiveName: 'fixture' })[0], path.join(os.homedir(), '.codex/project-skills', 'fixture'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
