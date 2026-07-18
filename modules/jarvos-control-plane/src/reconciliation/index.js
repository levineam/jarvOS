'use strict';

const {
  canonicalMutationKey,
  createCommand,
  createEvidence,
  lifecycleTransition,
} = require('../contracts');

function createReconciler(options = {}) {
  if (!options.registry) throw new Error('registry is required');
  if (!options.policy) throw new Error('policy is required');
  if (!options.store) throw new Error('store is required');
  const registry = options.registry;
  const policy = options.policy;
  const store = options.store;
  const managers = options.managers || {};
  const leaseTtlMs = options.leaseTtlMs || 60000;
  if (typeof store.putCommandIfAbsent !== 'function') throw new Error('store.putCommandIfAbsent is required');

  async function reconcileRequest(request, context = {}) {
    const policyDecision = policy.decide(request, context.policy || {});
    store.putRecord(request);
    store.putRecord(policyDecision);

    if (policyDecision.outcome !== 'allow') {
      return {
        ok: false,
        status: policyDecision.outcome === 'require_approval' ? 'approval_required' : policyDecision.outcome,
        request,
        policyDecision,
      };
    }

    const selected = registry.selectManager(request.resource, request.mutationClass);
    if (!selected.ok) {
      return {
        ok: false,
        status: 'deferred',
        reason: selected.reason,
        request,
        policyDecision,
      };
    }

    // Reattachment hints (branch/PR/session) may ride on the request or
    // commandSpec.arguments. They are pointers only — never proof of progress.
    const reattachmentCheckpoint = request.checkpoint
      || request.commandSpec?.arguments?.resumeFrom
      || request.commandSpec?.arguments?.checkpoint
      || null;

    let command = createCommand({
      requestId: request.id,
      policyDecisionId: policyDecision.id,
      managerId: selected.managerId,
      resource: request.resource,
      mutationClass: request.mutationClass,
      desiredGeneration: request.desiredGeneration,
      commandSpec: request.commandSpec,
      authority: policyDecision.authority,
      provenance: request.provenance,
      checkpoint: reattachmentCheckpoint,
    });

    const reservation = store.putCommandIfAbsent(command);
    if (!reservation.inserted) {
      return {
        ok: true,
        status: 'deduped',
        request,
        policyDecision,
        command: reservation.command,
      };
    }
    command = reservation.command;

    const leaseKey = canonicalMutationKey({ resource: request.resource, mutationClass: request.mutationClass });
    const leaseResult = store.acquireLease({
      key: leaseKey,
      holder: command.id,
      ttlMs: leaseTtlMs,
      metadata: { actionKey: command.actionKey, requestId: request.id },
    });

    if (!leaseResult.ok) {
      const conflict = lifecycleTransition(command, 'conflict', { reason: leaseResult.reason });
      store.putRecord(conflict);
      return {
        ok: false,
        status: 'conflict',
        conflict: leaseResult,
        request,
        policyDecision,
        command: conflict,
      };
    }

    command = lifecycleTransition(command, 'lease_acquired', {
      leaseId: leaseResult.lease.id,
      fence: leaseResult.lease.fence,
      checkpoint: { phase: 'pre-dispatch' },
    });
    store.putRecord(command);

    const port = managers[selected.managerId];
    if (!port || typeof port.executeFenced !== 'function') {
      command = lifecycleTransition(command, 'deferred', { reason: 'manager fenced execution port unavailable' });
      store.putRecord(command);
      if (store.releaseLease) store.releaseLease(leaseResult.lease);
      return { ok: false, status: 'deferred', request, policyDecision, command };
    }

    command = lifecycleTransition(command, 'dispatching', { checkpoint: { phase: 'dispatching' } });
    store.putRecord(command);

    let execution;
    try {
      const assertCurrentFence = () => {
        if (!store.assertLeaseCurrent || !store.assertLeaseCurrent(leaseResult.lease)) throw new Error('stale_fence');
        return true;
      };
      assertCurrentFence();
      execution = await port.executeFenced(command, {
        fence: leaseResult.lease.fence,
        lease: leaseResult.lease,
        request,
        assertCurrentFence,
      });
      assertCurrentFence();
    } catch (error) {
      command = lifecycleTransition(command, 'failed', { reason: error.message, checkpoint: { phase: 'execute-error' } });
      store.putRecord(command);
      if (store.releaseLease) store.releaseLease(leaseResult.lease);
      return { ok: false, status: 'failed', error, request, policyDecision, command };
    }

    command = lifecycleTransition(command, 'executed', { checkpoint: { phase: 'post-side-effect', execution } });
    store.putRecord(command);

    const verifier = port.verify || (() => ({ outcome: 'unverifiable', reason: 'verifier unavailable' }));
    command = lifecycleTransition(command, 'verifying', { checkpoint: { phase: 'verifying' } });
    store.putRecord(command);
    let verification;
    try {
      verification = await verifier(command, { execution, request });
      if (!verification || typeof verification !== 'object' || typeof verification.outcome !== 'string') {
        throw new Error('invalid verifier result');
      }
    } catch (error) {
      command = lifecycleTransition(command, 'unverifiable', {
        reason: `verifier_error: ${error.message}`,
        checkpoint: { phase: 'verify-error' },
      });
      store.putRecord(command);
      if (store.releaseLease) store.releaseLease(leaseResult.lease);
      return { ok: false, status: 'unverifiable', error, request, policyDecision, command };
    }
    const evidence = createEvidence({
      commandId: command.id,
      managerId: command.managerId,
      verifier: verification.verifier || `${command.managerId}.verify`,
      outcome: verification.outcome,
      postcondition: verification.postcondition || null,
      data: verification,
      authority: verification.authority || null,
    });
    const evidenceCommit = store.commitEvidence(leaseResult.lease, evidence);
    if (!evidenceCommit.ok) {
      command = lifecycleTransition(command, 'unverifiable', { reason: evidenceCommit.reason, checkpoint: { phase: 'evidence-rejected' } });
      store.putRecord(command);
      if (store.releaseLease) store.releaseLease(leaseResult.lease);
      return { ok: false, status: 'unverifiable', request, policyDecision, command, evidenceCommit };
    }

    const terminal = verification.outcome === 'satisfied' ? 'satisfied' : 'unverifiable';
    command = lifecycleTransition(command, terminal, { checkpoint: { phase: 'terminal', evidenceId: evidence.id } });
    store.putRecord(command);
    if (store.releaseLease) store.releaseLease(leaseResult.lease);
    return {
      ok: terminal === 'satisfied',
      status: terminal,
      request,
      policyDecision,
      command,
      evidence,
    };
  }

  return { reconcileRequest };
}

module.exports = {
  createReconciler,
};
