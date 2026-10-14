'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const workspace = require('../src');

const observation = {
  version: 'jarvos-workspace-manager.v1',
  repositoryId: 'repo-1', checkoutId: 'checkout-1', worktreeId: 'worktree-1',
  branchId: 'branch-1', candidateId: 'candidate-1', subjectIdentity: 'subject-1',
  observedAt: '2026-08-12T12:00:00.000Z', freshUntil: '2026-08-12T13:00:00.000Z',
    state: { clean: true, complete: true, dirty: false, conflicts: false, nestedRepository: false, detached: false, missing: false, unknownOwnership: false, duplicateIdentity: false, protected: false, divergedRefs: false, uniqueCommits: false, incomplete: false },
};

test('human and agent operator projections expose equivalent bounded facts', () => {
  const result = workspace.projectOperatorSurface({
    inventory: [{ observation }],
    inspection: observation,
    disposition: { version: observation.version, candidateId: observation.candidateId, disposition: 'deferred', reason: 'evidence unavailable' },
    approval: { version: observation.version, requestId: 'request-1', candidateId: observation.candidateId, status: 'approval_required', operation: 'cleanup' },
    execution: { version: observation.version, requestId: 'request-1', candidateId: observation.candidateId, status: 'uncertain' },
    health: { version: observation.version, state: 'degraded', capabilityState: 'observe-only', reason: 'provider unavailable', observedAt: observation.observedAt },
    evidence: { version: observation.version, evidenceId: 'evidence-1', candidateId: observation.candidateId, sourceVersion: 'lifecycle.v1', subjectIdentity: observation.subjectIdentity, digest: 'a'.repeat(64), observedAt: observation.observedAt, freshUntil: observation.freshUntil, outcome: 'landed' },
  });
  assert.deepEqual(result.agent, result.human);
  assert.equal(result.agent.inventory[0].candidateId, 'candidate-1');
  assert.equal(Object.prototype.hasOwnProperty.call(result.agent.inventory[0], 'repositoryPath'), false);
});

test('private path and credential fields are rejected before projection', () => {
  assert.throws(() => workspace.projectInspection({ ...observation, repositoryPath: '/private/repo' }), /absolute path/);
  assert.throws(() => workspace.projectEvidence({ version: observation.version, candidateId: observation.candidateId, token: 'secret-value' }), /token|secret/i);
});

test('agent surface has no approval or execution escalation helper', () => {
  const agent = workspace.projectAgentSurface({ inventory: [{ observation }] });
  assert.equal(typeof agent.approve, 'undefined');
  assert.equal(typeof agent.execute, 'undefined');
});
