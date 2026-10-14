'use strict';

const {
  MUTATION_CLASSES,
  WORKSPACE_CONTRACT_VERSION,
  createWorkspaceObservation,
  validateLifecycleEvidenceBinding,
  createReleaseClearanceBinding,
  isOpaqueId,
  isSafelyRemovableObservation,
} = require('../contracts');

const WORKTREE_REMOVE_OPERATION = 'remove-worktree';

function canonicalTargetFenceKey(machineId, candidateId) {
  if (!isOpaqueId(machineId) || !isOpaqueId(candidateId)) throw new Error('target-fence identity must use opaque identifiers');
  return `target:${machineId}:${candidateId}`;
}

function requireApprovalBinding(input = {}) {
  const approval = input.approval;
  if (!approval || approval.status !== 'approved') return { ok: false, status: 'approval_required', reason: 'authenticated human approval is required' };
  if (typeof input.approvalVerifier !== 'function') return { ok: false, status: 'approval_required', reason: 'trusted approval verifier is required' };
  let verified;
  try { verified = input.approvalVerifier({ approval, expected: input.expected }); }
  catch (_) { return { ok: false, status: 'denied', reason: 'approval verification failed' }; }
  if (verified && typeof verified.then === 'function') return { ok: false, status: 'deferred', reason: 'approval verifier must complete synchronously' };
  if (verified !== true && (!verified || verified.ok !== true)) return { ok: false, status: 'denied', reason: 'approval verification failed' };
  if (!approval.principal || approval.principal.kind !== 'human' || typeof approval.principal.id !== 'string' || !approval.principal.id) return { ok: false, status: 'denied', reason: 'approval must bind an authenticated human principal' };
  const expected = input.expected || {};
  for (const [field, value] of Object.entries({
    candidateId: expected.candidateId,
    subjectIdentity: expected.subjectIdentity,
    evidenceDigest: expected.evidenceDigest,
    releaseClearanceDigest: expected.releaseClearanceDigest,
    releaseClearanceGeneration: expected.releaseClearanceGeneration,
    releaseClearanceReceiptId: expected.releaseClearanceReceiptId,
    releaseClearanceCurrentPointerId: expected.releaseClearanceCurrentPointerId,
    targetFenceKey: expected.targetFenceKey,
    targetFenceGeneration: expected.targetFenceGeneration,
    preconditionFingerprint: expected.preconditionFingerprint,
  })) {
    if (approval[field] !== value) return { ok: false, status: 'denied', reason: 'approval is not bound to this cleanup request' };
  }
  if (typeof approval.approvedAt !== 'string' || Number.isNaN(new Date(approval.approvedAt).getTime())) return { ok: false, status: 'denied', reason: 'approval timestamp is required' };
  if (typeof approval.expiresAt !== 'string' || Number.isNaN(new Date(approval.expiresAt).getTime())) return { ok: false, status: 'denied', reason: 'approval expiry is required' };
  const nowTime = new Date(input.now || new Date().toISOString()).getTime();
  if (Number.isNaN(nowTime) || new Date(approval.expiresAt).getTime() <= nowTime) return { ok: false, status: 'denied', reason: 'approval is expired' };
  if (approval.revoked === true) return { ok: false, status: 'denied', reason: 'approval is revoked' };
  return { ok: true };
}

async function revalidateReleaseClearance(command, releaseClearancePort) {
  if (!releaseClearancePort || typeof releaseClearancePort.resolve !== 'function') throw new Error('release clearance revalidation is required');
  const result = await releaseClearancePort.resolve({
    subjectIdentity: command.subjectIdentity,
    digest: command.releaseClearanceDigest,
    generation: command.releaseClearanceGeneration,
    currentPointerId: command.releaseClearanceCurrentPointerId,
    fresh: true,
  });
  if (result?.available === false || result?.status === 'blocked') throw new Error('release clearance is unavailable');
  const binding = result?.status === 'admissible' && result.binding ? result.binding : result;
  let normalized;
  try { normalized = createReleaseClearanceBinding(binding); }
  catch (_) { throw new Error('release clearance revalidation is malformed'); }
  if (normalized.subjectIdentity !== command.subjectIdentity
    || normalized.digest !== command.releaseClearanceDigest
    || normalized.generation !== command.releaseClearanceGeneration
    || normalized.currentPointerId !== command.releaseClearanceCurrentPointerId
    || !['satisfied', 'not-required'].includes(normalized.outcome)) {
    throw new Error('release clearance has changed');
  }
  return normalized;
}

function createWorktreeRemovalRequest({ observation, lifecycleEvidence, releaseClearance, approval, approvalVerifier, targetFence, preconditionFingerprint, actor = { kind: 'human' }, machineId = 'machine:default', desiredGeneration, now } = {}) {
  const normalized = createWorkspaceObservation(observation);
  if (actor.kind !== 'human') return { ok: false, status: 'denied', reason: 'only a human may request destructive cleanup' };
  if (!isSafelyRemovableObservation(normalized)) return { ok: false, status: 'preserve', reason: 'workspace observation is not safely removable' };
  const evidenceValidation = validateLifecycleEvidenceBinding(lifecycleEvidence || {});
  if (!evidenceValidation.ok || lifecycleEvidence.subjectIdentity !== normalized.subjectIdentity) {
    return { ok: false, status: 'deferred', reason: 'fresh matched lifecycle evidence is required' };
  }
  if (!releaseClearance || releaseClearance.available === false || releaseClearance.status === 'blocked') {
    return { ok: false, status: 'deferred', reason: 'fresh matched release clearance is required' };
  }
  let clearance;
  try { clearance = createReleaseClearanceBinding(releaseClearance); }
  catch (_) { return { ok: false, status: 'deferred', reason: 'release clearance is malformed' }; }
  if (clearance.subjectIdentity !== normalized.subjectIdentity) return { ok: false, status: 'needs_judgment', reason: 'release clearance identity does not match workspace' };
  if (!['satisfied', 'not-required'].includes(clearance.outcome)) return { ok: false, status: 'deferred', reason: 'terminal release clearance is required' };
  if (!targetFence || typeof targetFence.key !== 'string' || !Number.isInteger(targetFence.generation) || targetFence.generation < 0) {
    return { ok: false, status: 'deferred', reason: 'target-fence generation is required' };
  }
  if (typeof preconditionFingerprint !== 'string' || !preconditionFingerprint) return { ok: false, status: 'deferred', reason: 'precondition fingerprint is required' };
  const expectedTargetKey = canonicalTargetFenceKey(machineId, normalized.candidateId);
  if (targetFence.key !== expectedTargetKey) return { ok: false, status: 'deferred', reason: 'target-fence key is not bound to the candidate' };
  const effectiveNow = typeof now === 'function' ? now() : now || new Date().toISOString();
  const nowTime = new Date(effectiveNow).getTime();
  if (Number.isNaN(nowTime)) return { ok: false, status: 'deferred', reason: 'cleanup clock is invalid' };
  if (new Date(normalized.freshUntil).getTime() <= nowTime || new Date(lifecycleEvidence.freshUntil).getTime() <= nowTime || new Date(clearance.freshUntil).getTime() <= nowTime) {
    return { ok: false, status: 'deferred', reason: 'workspace, lifecycle, or release evidence is stale' };
  }
  const approvalResult = requireApprovalBinding({ approval, approvalVerifier, expected: {
    candidateId: normalized.candidateId,
    subjectIdentity: normalized.subjectIdentity,
    evidenceDigest: lifecycleEvidence.digest,
    releaseClearanceDigest: clearance.digest,
    releaseClearanceGeneration: clearance.generation,
    releaseClearanceReceiptId: clearance.receiptId,
    releaseClearanceCurrentPointerId: clearance.currentPointerId,
    targetFenceKey: expectedTargetKey,
    targetFenceGeneration: targetFence.generation,
    preconditionFingerprint,
  }, now: effectiveNow });
  if (!approvalResult.ok) return approvalResult;
  const generation = Number.isInteger(desiredGeneration) && desiredGeneration > 0 ? desiredGeneration : targetFence.generation + 1;
  const requestId = `workspace-remove:${normalized.candidateId}:${targetFence.generation}:${lifecycleEvidence.digest.slice(0, 16)}:${clearance.digest.slice(0, 16)}`;
  return {
    ok: true,
    request: {
      schemaVersion: 'jarvos-control-plane.record.v1',
      contractVersion: '1.0.0',
      type: 'request',
      id: requestId,
      sensitivity: { level: 'internal' },
      version: WORKSPACE_CONTRACT_VERSION,
      operation: WORKTREE_REMOVE_OPERATION,
      mutationClass: MUTATION_CLASSES.WORKTREE_REMOVE,
      resource: { machineId, type: 'workspace', id: normalized.candidateId },
      principal: { id: approval.principal.id },
      actor: { ...actor },
      desiredGeneration: generation,
      idempotencyKey: requestId,
      commandSpec: {
        operation: WORKTREE_REMOVE_OPERATION,
        arguments: { candidateId: normalized.candidateId },
        constraints: { preconditionFingerprint },
        lifecycle: { idempotent: true, recovery: 'verify-only' },
      },
      candidateId: normalized.candidateId,
      subjectIdentity: normalized.subjectIdentity,
      evidenceDigest: lifecycleEvidence.digest,
      releaseClearance: clearance,
      releaseClearanceDigest: clearance.digest,
      releaseClearanceGeneration: clearance.generation,
      releaseClearanceReceiptId: clearance.receiptId,
      releaseClearanceCurrentPointerId: clearance.currentPointerId,
      preconditionFingerprint,
      targetFence: { key: targetFence.key, generation: targetFence.generation, preconditionFingerprint, releaseClearanceDigest: clearance.digest, releaseClearanceGeneration: clearance.generation, releaseClearanceCurrentPointerId: clearance.currentPointerId },
      approval: {
        principal: { kind: 'human', id: approval.principal.id },
        decision: 'approved',
        approvedAt: approval.approvedAt,
        expiresAt: approval.expiresAt,
        candidateId: normalized.candidateId,
        subjectIdentity: normalized.subjectIdentity,
        targetFenceKey: expectedTargetKey,
        targetFenceGeneration: targetFence.generation,
        preconditionFingerprint,
        evidenceDigest: lifecycleEvidence.digest,
        releaseClearanceDigest: clearance.digest,
        releaseClearanceGeneration: clearance.generation,
        releaseClearanceReceiptId: clearance.receiptId,
        releaseClearanceCurrentPointerId: clearance.currentPointerId,
      },
    },
  };
}

function createWorktreeCleanupPort({ executor, verifier, releaseClearancePort } = {}) {
  if (!executor || typeof executor.execute !== 'function') throw new Error('worktree executor is required');
  if (!verifier || typeof verifier.verify !== 'function') throw new Error('independent worktree verifier is required');
  return {
    async executeFenced(command, context = {}) {
      if (command.mutationClass !== MUTATION_CLASSES.WORKTREE_REMOVE || command.commandSpec?.operation !== WORKTREE_REMOVE_OPERATION) {
        throw new Error('unsupported workspace mutation');
      }
      if (!command.targetFence || command.targetFence.preconditionFingerprint !== command.commandSpec?.constraints?.preconditionFingerprint) {
        throw new Error('target-fence precondition binding is invalid');
      }
      await revalidateReleaseClearance(command, context.releaseClearancePort || releaseClearancePort);
      if (typeof context.assertCurrentFence === 'function') context.assertCurrentFence();
      return executor.execute({
        candidateId: command.resource.id,
        targetFence: command.targetFence,
        fence: context.fence,
        assertCurrentFence: context.assertCurrentFence,
      });
    },
    async verify(command, context = {}) {
      // Verification gets a fresh read request and never consumes executor
      // output as proof. Recovery uses this same method with recovery: true.
      return verifier.verify({
        candidateId: command.resource.id,
        targetFence: command.targetFence,
        request: context.request || null,
        fresh: true,
        recovery: context.recovery === true,
      });
    },
  };
}

module.exports = { WORKTREE_REMOVE_OPERATION, canonicalTargetFenceKey, createWorktreeCleanupPort, createWorktreeRemovalRequest, requireApprovalBinding, revalidateReleaseClearance };
