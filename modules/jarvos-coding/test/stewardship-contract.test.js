'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  STEWARDSHIP_CONTRACT_VERSION,
  buildLifecycleOutcome,
  buildReleaseClassificationInput,
  classifyReleaseFromGitEvidence,
  createLandingPolicy,
  createReconcilePolicy,
  evaluateLandingPolicy,
  evaluateReconcilePolicy,
  normalizeGitEvidence,
  validateLifecycleSessions,
  validatePublicRecord,
} = require('../src');

const git = { baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), changedFiles: ['src/a.js'], commits: ['b'.repeat(40)], clean: true };

test('release classification authority is normalized Git evidence, not harness provenance', () => {
  const inputs = ['Claude Code', 'Codex', 'OpenClaw', 'Hermes'].map((harness) => buildReleaseClassificationInput({ git, harness }));
  assert.deepEqual(inputs.map((input) => input.authoritative), Array(4).fill(inputs[0].authoritative));
  assert.deepEqual(inputs.map(classifyReleaseFromGitEvidence), Array(4).fill(classifyReleaseFromGitEvidence(inputs[0])));
  assert.equal(inputs[0].provenance.harness, 'Claude Code');
});

test('active sessions safely share an opaque project identity', () => {
  const first = buildLifecycleOutcome({ projectId: 'project-9', sessionId: 'session-a', worktreeId: 'worktree-a', causalRunId: 'run-a', provenance: { harness: 'Codex' } });
  const second = buildLifecycleOutcome({ projectId: 'project-9', sessionId: 'session-b', worktreeId: 'worktree-b', causalRunId: 'run-b' });
  assert.equal(first.version, STEWARDSHIP_CONTRACT_VERSION);
  assert.equal(first.projectId, second.projectId);
  assert.notEqual(first.sessionId, second.sessionId);
  assert.deepEqual(first.provenance, { harness: 'Codex' });
  assert.equal(validateLifecycleSessions([first, second]).ok, true);
});

test('public record validation rejects local paths, transcript content, credentials, and tracker authority', () => {
  for (const record of [
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: '/repo', sessionId: 'session-a' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', provenance: 'opened /Users/example/private.txt' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', provenance: 'opened C:\\Users\\example\\private.txt' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', provenance: 'opened \\\\server\\share' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', transcript: 'hello' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', apiKey: 'secret' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', provenance: 'Bearer top-secret-token' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', paperclipAuthority: 'issue-edit' },
    { version: STEWARDSHIP_CONTRACT_VERSION, projectId: 'project-a', sessionId: 'session-a', beadsAuthority: 'claim' },
  ]) assert.equal(validatePublicRecord(record).ok, false);
});

test('Git evidence is deterministic and accepts only safe normalized values', () => {
  assert.deepEqual(normalizeGitEvidence(git).changedFiles, ['src/a.js']);
  for (const evidence of [
    { ...git, changedFiles: 'src/a.js' },
    { ...git, commits: ['not-a-commit'] },
    { ...git, baseCommit: 'abc' },
    { ...git, changedFiles: ['../secret'] },
    { ...git, changedFiles: ['/home/example/secret'] },
    { ...git, changedFiles: ['src\\a.js'] },
    { ...git, changedFiles: ['src/\0a.js'] },
  ]) assert.throws(() => normalizeGitEvidence(evidence), /git\./);
});

test('harness provenance is bounded and never changes Git authority', () => {
  assert.throws(() => buildReleaseClassificationInput({ git, harness: '/Users/example' }), /harness provenance/);
  assert.throws(() => buildReleaseClassificationInput({ git, harness: 'Bearer secret-token' }), /harness provenance|credentials/);
  assert.throws(() => buildReleaseClassificationInput({ git, harness: 'Paperclip' }), /tracker authority/);
  assert.throws(() => buildReleaseClassificationInput({ git: null, harness: 'Codex' }), /git evidence/);
});

test('lifecycle outcomes accept only public contract states', () => {
  assert.throws(() => buildLifecycleOutcome({ projectId: 'project-a', sessionId: 'session-a', lifecycle: 'running' }), /record.lifecycle/);
  assert.equal(buildLifecycleOutcome({ projectId: 'project-a', sessionId: 'session-a', lifecycle: 'checkpointed' }).lifecycle, 'checkpointed');
  assert.throws(() => buildLifecycleOutcome({ projectId: 'project-a', sessionId: 'session-a', provenance: { harness: '/Users/example' } }), /harness provenance/);
  assert.throws(() => buildLifecycleOutcome({ projectId: 'project-a', sessionId: 'session-a', checkpointAuthority: 'custom-authority' }), /checkpointAuthority/);
});

test('landing and reconcile policies preserve private, public, and third-party boundaries', () => {
  assert.equal(evaluateLandingPolicy(createLandingPolicy({ repositoryKind: 'private' }), { action: 'merge' }).decision, 'candidate');
  assert.equal(evaluateLandingPolicy(createLandingPolicy({ repositoryKind: 'private', privateAutoLandAuthorized: true }), { action: 'merge' }).decision, 'auto-land');
  assert.equal(evaluateLandingPolicy(createLandingPolicy({ repositoryKind: 'private', privateAutoLandAuthorized: true }), { action: 'tag' }).decision, 'candidate');
  const publicPolicy = createLandingPolicy({ repositoryKind: 'public' });
  assert.equal(evaluateLandingPolicy(publicPolicy, { action: 'merge' }).decision, 'candidate');
  assert.equal(evaluateLandingPolicy(publicPolicy, { action: 'merge', humanApproval: { action: 'merge', approved: true } }).decision, 'approved');
  assert.equal(evaluateLandingPolicy(publicPolicy, { action: 'patch', humanApproval: { action: 'patch', approved: true } }).decision, 'candidate');
  assert.equal(evaluateLandingPolicy(createLandingPolicy({ repositoryKind: 'third-party' }), { action: 'patch' }).decision, 'internal-only');
  const thirdParty = createLandingPolicy({ repositoryKind: 'third-party', thirdPartyPatchAllowed: true });
  assert.equal(evaluateLandingPolicy(thirdParty, { action: 'patch', humanApproval: { action: 'patch', approved: true } }).decision, 'approved');
  assert.equal(evaluateLandingPolicy(thirdParty, { action: 'unknown', humanApproval: { action: 'unknown', approved: true } }).decision, 'internal-only');
  assert.equal(evaluateReconcilePolicy(createReconcilePolicy({ repositoryKind: 'private', privateAutoLandAuthorized: true }), { action: 'merge', ownershipOnly: true }).decision, 'candidate');
});
