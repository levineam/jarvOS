'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const workspace = require('../src');

test('recovery resolves an uncertain command from a fresh verifier without replaying execution', async () => {
  let verifyCalls = 0;
  const clearance = { version: workspace.RELEASE_CLEARANCE_CONTRACT_VERSION, sourceVersion: 'release.v1', subjectIdentity: 'subject-1', digest: 'b'.repeat(64), observedAt: '2026-08-12T12:00:00Z', freshUntil: '2099-08-12T13:00:00Z', outcome: 'satisfied', generation: 1, receiptId: 'receipt-1', currentPointerId: 'pointer-1' };
  const recovery = workspace.createWorkspaceRecoveryPort({ releaseClearancePort: { resolve: async () => clearance }, verifier: { verify: async ({ fresh, recovery }) => { verifyCalls += 1; return { outcome: fresh && recovery ? 'satisfied' : 'needs_judgment', verifier: 'independent-read', postcondition: { absent: true } }; } } });
  const result = await recovery.recover({ id: 'command-1', status: 'uncertain', subjectIdentity: clearance.subjectIdentity, releaseClearanceDigest: clearance.digest, releaseClearanceGeneration: clearance.generation, releaseClearanceCurrentPointerId: clearance.currentPointerId, resource: { id: 'candidate-1' } });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'satisfied');
  assert.equal(result.command.status, 'satisfied');
  assert.equal(verifyCalls, 1);
});

test('recovery retains uncertain state when the verifier cannot prove a terminal outcome', async () => {
  const recovery = workspace.createWorkspaceRecoveryPort({ verifier: { verify: async () => ({ outcome: 'unknown' }) } });
  const result = await recovery.recover({ id: 'command-1', status: 'uncertain', resource: { id: 'candidate-1' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'uncertain');
});

test('recovery never accepts a normal command as permission to execute', async () => {
  const recovery = workspace.createWorkspaceRecoveryPort({ verifier: { verify: async () => ({ outcome: 'satisfied' }) } });
  const result = await recovery.recover({ id: 'command-1', status: 'requested', resource: { id: 'candidate-1' } });
  assert.equal(result.status, 'needs_judgment');
  assert.equal(result.ok, false);
});
