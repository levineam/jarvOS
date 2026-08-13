'use strict';

const assert = require('assert');
const test = require('node:test');
const workspace = require('../src');

const observation = { repositoryId: 'repo-a', checkoutId: 'checkout-a', worktreeId: 'worktree-a', branchId: 'branch-a', candidateId: 'candidate-a', subjectIdentity: 'subject-a', observedAt: '2026-08-12T12:00:00Z', freshUntil: '2026-08-12T13:00:00Z', state: { clean: true, complete: true, dirty: false, conflicts: false, nestedRepository: false, detached: false, missing: false, unknownOwnership: false, duplicateIdentity: false, protected: false, divergedRefs: false, uniqueCommits: false, incomplete: false } };

test('normalization projects only deterministic public-safe observation facts', () => {
  const normalized = workspace.normalizeGitObservation({ ...observation, privatePath: '/private/repo', commandOutput: 'secret', state: observation.state });
  assert.deepEqual(normalized.state, observation.state);
  assert.equal('privatePath' in normalized, false);
  assert.equal('commandOutput' in normalized, false);
  assert.deepEqual(normalized, workspace.normalizeGitObservation({ ...observation, state: observation.state }));
});

test('malformed lifecycle producer output fails closed instead of synthesizing authority', () => {
  const outcome = workspace.resolveDisposition({ observation, lifecycleResult: { outcome: 'landed' }, now: '2026-08-12T12:10:00Z' });
  assert.equal(outcome.disposition, 'deferred');
  assert.match(outcome.reason, /malformed/i);
});
