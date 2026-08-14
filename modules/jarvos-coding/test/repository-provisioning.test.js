'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  provisionRepository,
  inspectProvisionedRepositories,
  updateProvisionedRepository,
  revokeProvisionedRepository,
  recordOwnerAction,
  loadRepositoryRegistry,
} = require('../src');

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-provisioning-'));
  const root = path.join(base, 'repository');
  fs.mkdirSync(root, 0o700);
  return {
    base,
    registryPath: path.join(base, 'coding-registry.json'),
    entry: {
      publicLabel: 'Fixture repository', agentSelectable: true, root,
      stateRoot: path.join(base, 'state'),
      worktreePolicy: { root: path.join(base, 'worktrees') },
      tracker: { kind: 'fixture' }, acceptancePolicy: { mode: 'human-evidence-required' },
      providerEgressPolicy: { classes: ['plan'] }, credentialReferences: { tracker: 'keychain:fixture' },
      learning: { enabled: true }, learningPublicationTarget: 'vault:fixture',
    },
  };
}

test('owner provisioning atomically adds, inspects, updates, and revokes a repository', () => {
  const f = fixture();
  const added = provisionRepository({ registryPath: f.registryPath, repository: f.entry });
  assert.equal(added.generation, 1);
  assert.equal(added.repository.label, 'Fixture repository');
  assert.equal(fs.statSync(f.registryPath).mode & 0o077, 0);
  assert.equal(fs.statSync(f.entry.stateRoot).mode & 0o077, 0);
  assert.equal(fs.statSync(f.entry.worktreePolicy.root).mode & 0o077, 0);
  assert.ok(fs.existsSync(`${f.registryPath}.receipt.json`));
  assert.doesNotMatch(JSON.stringify(added), new RegExp(f.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const inspected = inspectProvisionedRepositories({ registryPath: f.registryPath });
  assert.deepEqual(inspected.repositories, [{ repositoryId: added.repository.repositoryId, label: 'Fixture repository', agentSelectable: true }]);

  const updated = updateProvisionedRepository({ registryPath: f.registryPath, repositoryId: added.repository.repositoryId, repository: { ...f.entry, publicLabel: 'Renamed fixture', learning: { enabled: false } } });
  assert.equal(updated.generation, 2);
  assert.equal(updated.repository.label, 'Renamed fixture');
  assert.equal(loadRepositoryRegistry(f.registryPath).generation, 2);

  const revoked = revokeProvisionedRepository({ registryPath: f.registryPath, repositoryId: added.repository.repositoryId });
  assert.equal(revoked.generation, 3);
  assert.deepEqual(inspectProvisionedRepositories({ registryPath: f.registryPath }).repositories, []);
  assert.throws(() => loadRepositoryRegistry(f.registryPath).resolve(added.repository.repositoryId), /unknown repository/);
});

test('owner actions are scoped to one provisioned repository and plan revision', () => {
  const f = fixture();
  const added = provisionRepository({ registryPath: f.registryPath, repository: f.entry });
  const accepted = recordOwnerAction({ registryPath: f.registryPath, repositoryId: added.repository.repositoryId, action: 'accept-plan', runId: 'run_1', revision: 'sha256:current' });
  assert.equal(accepted.action, 'accept-plan');
  assert.equal(accepted.revision, 'sha256:current');
  const declined = recordOwnerAction({ registryPath: f.registryPath, repositoryId: added.repository.repositoryId, action: 'decline-learning', runId: 'run_1' });
  assert.equal(declined.action, 'decline-learning');
  const reset = recordOwnerAction({ registryPath: f.registryPath, repositoryId: added.repository.repositoryId, action: 'reset-learning-retry', runId: 'run_1' });
  assert.equal(reset.action, 'reset-learning-retry');
  assert.throws(() => recordOwnerAction({ registryPath: f.registryPath, repositoryId: 'missing', action: 'decline-learning', runId: 'run_1' }), /unknown repository/);
});

test('provisioning fails closed for missing explicit authority and unsafe roots', () => {
  const f = fixture();
  assert.throws(() => provisionRepository({ registryPath: f.registryPath, repository: { ...f.entry, acceptancePolicy: undefined } }), /acceptancePolicy is required/);
  assert.throws(() => provisionRepository({ registryPath: f.registryPath, repository: { ...f.entry, learningPublicationTarget: undefined } }), /learningPublicationTarget is required/);
  assert.throws(() => provisionRepository({ registryPath: f.registryPath, repository: { ...f.entry, stateRoot: f.entry.root } }), /must not overlap/);
  const link = path.join(f.base, 'repository-link'); fs.symlinkSync(f.entry.root, link);
  assert.throws(() => provisionRepository({ registryPath: f.registryPath, repository: { ...f.entry, root: link } }), /must not be a symbolic link/);
  assert.throws(() => provisionRepository({ registryPath: undefined, repository: f.entry }), /registryPath is required/);
});
