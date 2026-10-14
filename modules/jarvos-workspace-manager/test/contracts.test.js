'use strict';

const assert = require('assert');
const test = require('node:test');
const workspace = require('../src');

const observation = {
  version: workspace.WORKSPACE_CONTRACT_VERSION,
  repositoryId: 'repo-a',
  checkoutId: 'checkout-a',
  worktreeId: 'worktree-a',
  branchId: 'branch-a',
  candidateId: 'candidate-a',
  subjectIdentity: 'subject-a',
  observedAt: '2026-08-12T12:00:00.000Z',
  freshUntil: '2026-08-12T13:00:00.000Z',
  state: {
    clean: true, complete: true, dirty: false, conflicts: false, nestedRepository: false,
    detached: false, missing: false, unknownOwnership: false, duplicateIdentity: false,
    protected: false, divergedRefs: false, uniqueCommits: false, incomplete: false,
  },
};
const evidence = {
  version: workspace.WORKSPACE_CONTRACT_VERSION,
  sourceVersion: 'jarvos-stewardship.v2',
  subjectIdentity: 'subject-a',
  digest: 'a'.repeat(64),
  observedAt: '2026-08-12T12:05:00.000Z',
  freshUntil: '2026-08-12T13:00:00.000Z',
  outcome: 'landed',
};
const releaseClearance = {
  version: workspace.RELEASE_CLEARANCE_CONTRACT_VERSION,
  sourceVersion: 'release-clearance.v1',
  subjectIdentity: 'subject-a',
  digest: 'b'.repeat(64),
  observedAt: '2026-08-12T12:06:00.000Z',
  freshUntil: '2026-08-12T13:00:00.000Z',
  outcome: 'satisfied',
  generation: 2,
  receiptId: 'receipt-a',
  currentPointerId: 'pointer-a',
};

test('opaque workspace observations and lifecycle evidence round trip deterministically', () => {
  const normalizedObservation = workspace.createWorkspaceObservation(observation);
  const normalizedEvidence = workspace.createLifecycleEvidenceBinding(evidence);
  assert.deepEqual(normalizedObservation, workspace.createWorkspaceObservation(observation));
  assert.deepEqual(normalizedEvidence, workspace.createLifecycleEvidenceBinding(evidence));
  assert.equal(workspace.validateWorkspaceObservation(normalizedObservation).ok, true);
  assert.equal(workspace.validateLifecycleEvidenceBinding(normalizedEvidence).ok, true);
});

test('public contracts reject paths, credentials, tracker authority, and transcripts', () => {
  for (const input of [
    { ...observation, repositoryId: '/private/repo' },
    { ...observation, transcript: 'private conversation' },
    { ...observation, adapterExtensions: { token: 'Bearer private-token' } },
    { ...evidence, trackerAuthority: 'paperclip' },
    { ...evidence, detail: 'C:\\Users\\private' },
  ]) assert.equal(workspace.validatePublicWorkspaceRecord(input).ok, false);
});

test('release clearance is versioned, opaque, and strict about authority-shaped fields', () => {
  assert.deepEqual(workspace.createReleaseClearanceBinding(releaseClearance), releaseClearance);
  assert.equal(workspace.validateReleaseClearanceBinding(releaseClearance).ok, true);
  for (const input of [
    { ...releaseClearance, outcome: 'unknown' },
    { ...releaseClearance, version: 'unknown' },
    { ...releaseClearance, sourcePath: '/private/release' },
    { ...releaseClearance, trackerAuthority: 'paperclip' },
    { ...releaseClearance, token: 'Bearer private-token' },
    { ...releaseClearance, notes: 'free-form private release context' },
  ]) assert.equal(workspace.validateReleaseClearanceBinding(input).ok, false);
});

test('subject identity derivation is deterministic across adapters', () => {
  const input = { repositoryId: 'repo-a', checkoutId: 'checkout-a', worktreeId: 'worktree-a', branchId: 'branch-a', candidateId: 'candidate-a' };
  assert.equal(workspace.deriveSubjectIdentity(input), workspace.deriveSubjectIdentity({ ...input }));
  assert.match(workspace.deriveSubjectIdentity(input), /^subject:[a-f0-9]{64}$/);
  assert.notEqual(workspace.deriveSubjectIdentity(input), workspace.deriveSubjectIdentity({ ...input, candidateId: 'candidate-b' }));
});

test('missing, stale, or mismatched lifecycle evidence fails closed', () => {
  assert.equal(workspace.classifyWorkspaceDisposition({ observation, now: '2026-08-12T12:10:00.000Z' }).disposition, 'deferred');
  assert.equal(workspace.classifyWorkspaceDisposition({ observation, lifecycleEvidence: { ...evidence, freshUntil: '2026-08-12T12:06:00.000Z' }, now: '2026-08-12T12:10:00.000Z' }).disposition, 'deferred');
  assert.equal(workspace.classifyWorkspaceDisposition({ observation, lifecycleEvidence: { ...evidence, subjectIdentity: 'other-subject' }, now: '2026-08-12T12:10:00.000Z' }).disposition, 'needs_judgment');
  assert.equal(workspace.classifyWorkspaceDisposition({ observation, lifecycleEvidence: evidence, releaseClearance, now: '2026-08-12T12:10:00.000Z' }).disposition, 'cleanup_candidate');
  for (const outcome of ['pending', 'blocked', 'uncertain', 'incompatible']) {
    assert.notEqual(workspace.classifyWorkspaceDisposition({ observation, lifecycleEvidence: evidence, releaseClearance: { ...releaseClearance, outcome }, now: '2026-08-12T12:10:00.000Z' }).disposition, 'cleanup_candidate');
  }
  assert.equal(workspace.classifyWorkspaceDisposition({ observation, lifecycleEvidence: evidence, releaseClearance: { ...releaseClearance, freshUntil: '2026-08-12T12:06:00.000Z' }, now: '2026-08-12T12:10:00.000Z' }).disposition, 'deferred');
  assert.equal(workspace.classifyWorkspaceDisposition({ observation, lifecycleEvidence: evidence, releaseClearance: { ...releaseClearance, subjectIdentity: 'other-subject' }, now: '2026-08-12T12:10:00.000Z' }).disposition, 'needs_judgment');
});

test('archive and cleanup remain distinct metadata and physical mutation classes', () => {
  assert.equal(workspace.MUTATION_CLASSES.ARCHIVE_METADATA, 'workspace.archive-metadata');
  assert.equal(workspace.MUTATION_CLASSES.WORKTREE_REMOVE, 'workspace.worktree-remove');
  assert.equal(workspace.MUTATION_CLASSES.BRANCH_DELETE, 'workspace.branch-delete');
  assert.notEqual(workspace.MUTATION_CLASSES.ARCHIVE_METADATA, workspace.MUTATION_CLASSES.WORKTREE_REMOVE);
  assert.equal(workspace.createDispositionDecision({ observation, disposition: 'archived', lifecycleEvidence: evidence }).mutationClass, null);
  assert.throws(() => workspace.createDispositionDecision({ observation, disposition: 'cleanup_candidate', lifecycleEvidence: evidence }), /release clearance/);
  assert.equal(workspace.createDispositionDecision({ observation, disposition: 'cleanup_candidate', lifecycleEvidence: evidence, releaseClearance }).mutationClass, workspace.MUTATION_CLASSES.WORKTREE_REMOVE);
});

test('health and capability contracts remain versioned and bounded', () => {
  assert.deepEqual(workspace.createWorkspaceHealth({ state: 'degraded', capabilityState: 'observe-only', observedAt: '2026-08-12T12:00:00Z' }), {
    version: workspace.WORKSPACE_CONTRACT_VERSION,
    state: 'degraded', capabilityState: 'observe-only', observedAt: '2026-08-12T12:00:00.000Z',
  });
  assert.equal(workspace.validateWorkspaceHealth({ version: 'unknown', state: 'healthy', capabilityState: 'observe-only', observedAt: '2026-08-12T12:00:00Z' }).ok, false);
});
