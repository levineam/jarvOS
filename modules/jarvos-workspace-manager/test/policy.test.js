'use strict';

const assert = require('assert');
const test = require('node:test');
const workspace = require('../src');

test('capability states cannot escalate through a request', () => {
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'human', action: 'archive', capabilityState: 'observe-only' }).outcome, 'deny');
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'human', action: 'cleanup', capabilityState: 'archive-enabled' }).outcome, 'deny');
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'human', action: 'archive', capabilityState: 'archive-enabled' }).outcome, 'allow');
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'human', action: 'cleanup', capabilityState: 'cleanup-enabled' }).outcome, 'require_approval');
});

test('policy validation rejects unknown capability states and unsupported mutation classes', () => {
  assert.throws(() => workspace.createWorkspacePolicy({ capabilityState: 'unbounded', mutationClasses: [] }), /capabilityState/);
  assert.throws(() => workspace.createWorkspacePolicy({ capabilityState: 'cleanup-enabled', mutationClasses: ['workspace.branch-delete'] }), /not enabled/);
  assert.equal(workspace.createWorkspacePolicy({ capabilityState: 'archive-enabled', mutationClasses: [workspace.MUTATION_CLASSES.ARCHIVE_METADATA] }).capabilityState, 'archive-enabled');
});

test('human and agent projections share bounded facts while agents cannot approve or execute', () => {
  const record = {
    version: workspace.WORKSPACE_CONTRACT_VERSION,
    repositoryId: 'repo-a', checkoutId: 'checkout-a', worktreeId: 'worktree-a', branchId: 'branch-a',
    candidateId: 'candidate-a', subjectIdentity: 'subject-a', disposition: 'preserve',
    evidenceId: 'evidence-a', privateDetail: 'not allowed',
  };
  const safe = { ...record };
  delete safe.privateDetail;
  assert.deepEqual(workspace.projectHumanWorkspaceRecord(safe), workspace.projectAgentWorkspaceRecord(safe));
  assert.deepEqual(workspace.projectAgentWorkspaceRecord({ ...safe, state: { clean: true } }).state, { clean: true });
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'agent', action: 'approve', capabilityState: 'cleanup-enabled' }).outcome, 'deny');
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'agent', action: 'execute', capabilityState: 'cleanup-enabled' }).outcome, 'deny');
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'agent', action: 'request_disposition', capabilityState: 'observe-only' }).outcome, 'allow');
  assert.equal(workspace.authorizeWorkspaceAction({ actorKind: 'agent', action: 'archive', capabilityState: 'archive-enabled' }).outcome, 'allow');
});
