'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { computeBundleTree, verifyHarnessBundle, deriveShadowPaths, resolveShadowPaths } = require('../src');
const { defaultConfig, normalizeConfig } = require('../src/config');

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
    const explicit = resolveShadowPaths({ harness: { scopeRoots: { project: '~/.codex/project-skills' } }, adapter: { skillProjection: { orderedScopes: ['project', 'managed'] } }, effectiveName: 'fixture' });
    assert.equal(explicit.complete, true);
    assert.equal(deriveShadowPaths({ harness: { scopeRoots: { project: '~/.codex/project-skills' } }, adapter: { skillProjection: { orderedScopes: ['project', 'managed'] } }, effectiveName: 'fixture' })[0], path.join(os.homedir(), '.codex/project-skills', 'fixture'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('default adapter scope roots detect project and workspace shadows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-default-scopes-'));
  const previousCwd = process.cwd();
  fs.chmodSync(root, 0o700);
  try {
    const realRoot = fs.realpathSync(root);
    process.chdir(realRoot);
    const config = normalizeConfig(defaultConfig());
    const cases = [
      { id: 'codex', scope: 'project', directory: '.codex/skills' },
      { id: 'openclaw', scope: 'workspace', directory: 'skills' },
    ];
    for (const item of cases) {
      const adapter = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'runtimes', item.id, 'adapter.json'), 'utf8'));
      const target = path.join(realRoot, `${item.id}-managed`, 'fixture'); fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: fixture\n---\n', { mode: 0o600 });
      const shadow = path.join(realRoot, item.directory, 'fixture'); fs.mkdirSync(shadow, { recursive: true, mode: 0o700 });
      const tree = computeBundleTree(target);
      const shadows = resolveShadowPaths({ harness: { root: path.dirname(target), scopeRoots: config.harnesses[item.id].scopeRoots, scopeRootsComplete: config.harnesses[item.id].scopeRootsComplete }, adapter, effectiveName: 'fixture' });
      assert.equal(shadows.complete, false, `${item.id} current-directory defaults must not claim complete coverage`);
      assert.ok(shadows.paths.includes(shadow));
      assert.equal(verifyHarnessBundle({ adapter, targetPath: target, expectedName: 'fixture', expectedTreeDigest: tree.treeDigest, shadowPaths: shadows.paths, shadowPathsComplete: shadows.complete }).reason, 'higher_precedence_scope_unknown');
    }
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
