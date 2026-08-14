'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCodexRuntime, REPOSITORY_REGISTRY_SCHEMA_VERSION } = require('../src');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-runtime-'));
  const root = path.join(base, 'repo'); const stateRoot = path.join(base, 'state'); const worktreeRoot = path.join(base, 'worktrees');
  for (const dir of [root, stateRoot, worktreeRoot]) fs.mkdirSync(dir);
  const registryPath = path.join(base, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: REPOSITORY_REGISTRY_SCHEMA_VERSION, generation: 1, repositories: [{ repositoryId: 'repo_fixture', publicLabel: 'Fixture', agentSelectable: true, root, stateRoot, worktreePolicy: { root: worktreeRoot }, acceptancePolicy: { mode: 'human-evidence-required' }, providerEgressPolicy: {}, credentialReferences: {} }] }));
  fs.chmodSync(registryPath, 0o600); return { root, stateRoot, worktreeRoot, registryPath };
}
test('only owner-provisioned opaque repositories are publicly listed and resolved', () => {
  const f = fixture(); const runtime = createCodexRuntime({ registryPath: f.registryPath });
  assert.deepEqual(runtime.listRepositories(), [{ repositoryId: 'repo_fixture', label: 'Fixture', agentSelectable: true }]);
  const context = runtime.resolveRequest({ repositoryId: 'repo_fixture', subjectKey: 'ORG-1' });
  assert.equal(context.subjectKey, 'repo_fixture:ORG-1'); assert.equal(context.canonicalWorktree, fs.realpathSync(f.root));
  assert.doesNotMatch(JSON.stringify(context.public), /state|worktrees|\/(?:private|var)/);
  assert.doesNotMatch(JSON.stringify(runtime.health()), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test('runtime fails closed for unknown ids, model paths, and cross-repository run reuse', () => {
  const f = fixture(); const runtime = createCodexRuntime({ registryPath: f.registryPath });
  assert.throws(() => runtime.resolveRequest({ repositoryId: 'missing', subjectKey: 'ORG-1' }), /unknown repository/);
  assert.throws(() => runtime.resolveRequest({ repositoryId: 'repo_fixture', subjectKey: 'ORG-1', worktree: f.root }), /model-supplied worktree/);
  assert.throws(() => runtime.resolveRequest({ repositoryId: 'repo_fixture', subjectKey: 'ORG-1', root: f.root }), /model-supplied root/);
  const context = runtime.resolveRequest({ repositoryId: 'repo_fixture', subjectKey: 'ORG-1', workRunId: 'run_fixed' });
  context.store.resolveWorkRun({ workRunId: context.workRunId, subjectKey: context.subjectKey, canonicalWorktree: context.canonicalWorktree });
  assert.throws(() => runtime.resolveRequest({ repositoryId: 'repo_fixture', subjectKey: 'ORG-2', workRunId: 'run_fixed' }), /different repository-qualified subject/);
});
test('insecure registry files and overlapping authority roots are rejected before service', () => {
  const f = fixture(); fs.chmodSync(f.registryPath, 0o644);
  assert.throws(() => createCodexRuntime({ registryPath: f.registryPath }), /permissions/);
  fs.chmodSync(f.registryPath, 0o600);
  const registry = JSON.parse(fs.readFileSync(f.registryPath)); registry.repositories[0].stateRoot = f.root; fs.writeFileSync(f.registryPath, JSON.stringify(registry));
  assert.throws(() => createCodexRuntime({ registryPath: f.registryPath }), /must not overlap/);
});
