'use strict';

const FOLLOW_THROUGH_SUMMARY_VERSION = 'jarvos-coding-follow-through-summary/v1';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function opaqueId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function exactRoutingDecision(decision, binding) {
  return isObject(decision)
    && decision.type === 'jarvos.native-routing-decision/v1'
    && opaqueId(decision.decisionId)
    && decision.workRunId === binding.workRunId
    && decision.executorOwnerId === binding.executorOwnerId
    && decision.harnessWorkspaceId === binding.harnessWorkspaceId
    && decision.fence === binding.fence;
}

function exactNativeInvocationReceipt(receipt, binding) {
  return isObject(receipt)
    && receipt.type === 'jarvos.native-invocation-receipt/v1'
    && receipt.receiptType === 'native-invocation'
    && receipt.executionPath === 'native'
    && receipt.workRunId === binding.workRunId
    && receipt.executorOwnerId === binding.executorOwnerId
    && receipt.harnessWorkspaceId === binding.harnessWorkspaceId
    && receipt.fence === binding.fence
    && opaqueId(receipt.invocationId)
    && exactRoutingDecision(receipt.routingDecision, binding);
}

function acceptedUnsupportedDisposition(receipt, binding) {
  return isObject(receipt)
    && receipt.type === 'jarvos.managed-runtime-admission/v1'
    && opaqueId(receipt.admissionId)
    && receipt.workRunId === binding.workRunId
    && receipt.executorOwnerId === binding.executorOwnerId
    && receipt.harnessWorkspaceId === binding.harnessWorkspaceId
    && receipt.fence === binding.fence
    && receipt.disposition === 'unsupported'
    && receipt.accepted === true;
}

function acceptedTerminalFor(run, binding) {
  return run.state === 'completed'
    && run.terminalEvidence
    && run.terminalEvidence.status === 'accepted'
    && run.terminalEvidence.fence === binding.fence;
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function summary({ status, binding = null, reason = null, terminalEvidence = null }) {
  return {
    version: FOLLOW_THROUGH_SUMMARY_VERSION,
    status,
    disposition: status,
    success: status === 'accepted',
    reason,
    execution: binding ? clone(binding) : null,
    terminalEvidence: terminalEvidence ? {
      reference: terminalEvidence.reference,
      digest: terminalEvidence.digest || null,
      status: terminalEvidence.status || null,
    } : null,
  };
}

function createWorkFollowThrough({ workRunStore, hostReceiptResolver = null, admissionResolver = null } = {}) {
  if (!workRunStore || typeof workRunStore.getFollowThrough !== 'function' || typeof workRunStore.getWorkRun !== 'function') {
    throw new Error('workRunStore with follow-through bindings is required');
  }

  async function resolve(resolver, binding) {
    if (typeof resolver !== 'function') return { available: false, receipt: null };
    try {
      return { available: true, receipt: await resolver({ workRunId: binding.workRunId, binding: clone(binding) }) };
    } catch (_) {
      return { available: false, receipt: null };
    }
  }

  function snapshotStillCurrent(outcomeId, binding, run) {
    try {
      const currentBinding = workRunStore.getFollowThrough(outcomeId);
      const currentRun = currentBinding && workRunStore.getWorkRun(currentBinding.workRunId, { public: false });
      return sameSnapshot(binding, currentBinding) && sameSnapshot(run, currentRun);
    } catch (_) {
      return false;
    }
  }

  async function summarize({ outcomeId } = {}) {
    const binding = workRunStore.getFollowThrough(outcomeId);
    if (!binding) return summary({ status: 'unavailable', reason: 'follow_through_not_bound' });
    const run = workRunStore.getWorkRun(binding.workRunId, { public: false });
    if (!run) return summary({ status: 'unavailable', binding, reason: 'bound_work_run_unavailable' });
    const acceptedTerminal = acceptedTerminalFor(run, binding);
    const releasedCompleted = run.ownerId === null && acceptedTerminal && run.fence === binding.fence;
    if ((run.ownerId !== binding.executorOwnerId && !releasedCompleted) || run.fence !== binding.fence) {
      return summary({ status: 'unavailable', binding, reason: 'binding_owner_fence_conflict' });
    }
    if (run.state === 'failed') return summary({ status: 'failed', binding, reason: 'work_run_failed', terminalEvidence: run.terminalEvidence });
    if (run.state === 'blocked' || run.recovery?.state === 'blocked') {
      return summary({ status: 'resumption-pending', binding, reason: run.recovery?.reasonCode || 'recovery_pending' });
    }

    const admission = await resolve(admissionResolver, binding);
    if (!snapshotStillCurrent(outcomeId, binding, run)) {
      return summary({ status: 'unavailable', binding, reason: 'follow_through_state_changed' });
    }
    if (acceptedUnsupportedDisposition(admission.receipt, binding)) {
      return summary({ status: 'unsupported', binding, reason: 'managed_runtime_unsupported' });
    }
    if (admission.available && admission.receipt && admission.receipt.disposition === 'unsupported') {
      return summary({ status: 'unavailable', binding, reason: 'unsupported_disposition_unaccepted' });
    }
    const native = await resolve(hostReceiptResolver, binding);
    if (!snapshotStillCurrent(outcomeId, binding, run)) {
      return summary({ status: 'unavailable', binding, reason: 'follow_through_state_changed' });
    }
    const hasNativeInvocation = exactNativeInvocationReceipt(native.receipt, binding);
    if (acceptedTerminal && hasNativeInvocation) {
      return summary({ status: 'accepted', binding, terminalEvidence: run.terminalEvidence });
    }
    if (run.state === 'completed' || acceptedTerminal) {
      return summary({ status: 'unavailable', binding, reason: hasNativeInvocation ? 'accepted_terminal_evidence_required' : 'exact_native_invocation_required', terminalEvidence: run.terminalEvidence });
    }
    if (hasNativeInvocation) return summary({ status: 'running', binding });
    if (native.available && native.receipt?.type === 'jarvos.native-invocation-receipt/v1') {
      return summary({ status: 'unavailable', binding, reason: 'native_receipt_correlation_unavailable' });
    }
    return summary({ status: 'not-dispatched', binding, reason: native.available ? 'exact_native_invocation_not_found' : 'native_receipt_resolver_unavailable' });
  }

  async function toProjectsSummary({ outcomeId, canonicalId, observedAt, canonicalAtAdmission = null } = {}) {
    const derived = await summarize({ outcomeId });
    if (!derived.execution) return null;
    if (typeof canonicalId !== 'string' || !/^out_[0-9]{6,}$/.test(canonicalId)) throw new Error('canonicalId must be a Projects outcome identifier');
    if (canonicalId !== outcomeId) throw new Error('canonicalId must match outcomeId');
    if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) throw new Error('observedAt must be an ISO timestamp');
    const blocked = ['failed', 'resumption-pending', 'unsupported', 'unavailable'].includes(derived.status);
    return {
      id: `follow-through:${outcomeId}`,
      canonicalId,
      category: blocked ? 'attention' : 'execution',
      status: derived.status === 'accepted' ? 'completed' : derived.status,
      title: `Follow-through ${derived.disposition}; next action ${derived.execution.todoId}`,
      occurredAt: derived.execution.boundAt,
      observedAt,
      evidenceRefs: [
        derived.execution.executorOwnerId,
        derived.execution.harnessWorkspaceId,
        derived.execution.workRunId,
        derived.execution.todoId,
        derived.execution.triggerId,
      ],
      canonicalAtAdmission,
    };
  }

  return { summarize, toProjectsSummary };
}

module.exports = {
  FOLLOW_THROUGH_SUMMARY_VERSION,
  createWorkFollowThrough,
  exactNativeInvocationReceipt,
};
