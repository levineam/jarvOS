'use strict';

const assert = require('assert');
const test = require('node:test');
const workspace = require('../src');

test('Control Plane registration remains observable and never claims mutation ownership', () => {
  const calls = [];
  const port = workspace.createWorkspaceControlPlanePort({ registry: { registerManager: (manifest) => { calls.push(manifest); return { status: 'observation_only', observationOnly: true }; } } });
  const registration = port.register({ capabilityState: 'cleanup-enabled' });
  assert.equal(registration.observationOnly, true);
  assert.deepEqual(calls[0].mutationClasses, []);
  assert.equal(calls[0].trust.level, 'data-only');
  const malformed = port.observe({ inventory: [{ candidateId: 'candidate-a' }] });
  assert.equal(malformed.kind, 'workspace-observation');
  assert.equal(malformed.status, 'deferred');
});

test('Control Plane observation port accepts only complete public observations', () => {
  const port = workspace.createWorkspaceControlPlanePort();
  const state = {
    clean: true, complete: true, dirty: false, conflicts: false, nestedRepository: false,
    detached: false, missing: false, unknownOwnership: false, duplicateIdentity: false,
    protected: false, divergedRefs: false, uniqueCommits: false, incomplete: false,
  };
  const result = port.observe({ inventory: [{
    version: 'jarvos-workspace-manager.v1', repositoryId: 'repo-a', checkoutId: 'checkout-a',
    worktreeId: 'worktree-a', branchId: 'branch-a', candidateId: 'candidate-a',
    subjectIdentity: 'subject-a', observedAt: '2026-08-12T12:00:00Z', freshUntil: '2026-08-12T13:00:00Z', state,
  }] });
  assert.equal(result.status, 'ok');
  assert.equal(result.inventory[0].candidateId, 'candidate-a');
});

test('disabled and mutation-incompatible adapters remain non-mutating', () => {
  for (const capabilityState of ['disabled', 'cleanup-enabled']) {
    const port = workspace.createWorkspaceControlPlanePort({ capabilityState, adapterCompatibility: { mutation: false } });
    assert.equal(port.manifest().mutationClasses.length, 0);
    assert.equal(port.register().observationOnly, true);
  }
});
