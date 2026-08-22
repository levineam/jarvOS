'use strict';

const crypto = require('node:crypto');
const {
  validateExecutionReference,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/provider-contracts');
const {
  validateInferenceDecision,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/project-inference-contracts');

const PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION = 'jarvos-coding-projects-activity/v1';
const MILESTONE_STAGES = Object.freeze([
  'claim', 'branch', 'sliceReview', 'holisticReview', 'fixRerun', 'pullRequest', 'postMergeSweep', 'verifyClose',
]);
const NON_DURABLE_STAGE_STATUSES = new Set([
  'failed', 'error', 'not_found', 'skipped', 'deferred', 'blocked', 'pending', 'incomplete', 'indeterminate', 'unavailable',
]);
const UNRESOLVED_EXECUTION_REASONS = new Set([
  'exact-beads-execution-link-required',
  'execution-link-admission-unavailable',
  'execution-link-not-found',
  'beads-execution-link-required',
  'canonical-execution-link-resolver-unavailable',
  'canonical-execution-link-not-found',
  'canonical-execution-link-invalid',
  'canonical-execution-link-resolver-failed',
  'inference-canonical-link-mismatch',
  'inference-decision-not-actionable',
  'inference-canonical-reference-required',
  'inference-decision-invalid',
]);
const ACTIONABLE_INFERENCE_DISPOSITIONS = new Set(['established', 'associated', 'corrected']);
const NON_ACTIONABLE_INFERENCE_DISPOSITIONS = new Set([
  'provisional', 'quarantined', 'unresolved', 'rejected', 'superseded', 'not-evaluable', 'unchanged',
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function sameExecutionTuple(left, right) {
  return left.authority === right.authority
    && left.provider === right.provider
    && left.workspaceId === right.workspaceId
    && left.itemId === right.itemId
    && left.itemRevision === right.itemRevision
    && left.status === right.status
    && left.sourceRevision === right.sourceRevision
    && left.canonical.id === right.canonical.id
    && left.canonical.revision === right.canonical.revision;
}

function inferenceDecisionFrom(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'inferenceDecision')) return input.inferenceDecision;
  if (Object.prototype.hasOwnProperty.call(input, 'projectInferenceDecision')) return input.projectInferenceDecision;
  if (input.inference && typeof input.inference === 'object' && Object.prototype.hasOwnProperty.call(input.inference, 'decision')) {
    return input.inference.decision;
  }
  return null;
}

function normalizeInferenceDecision(decision) {
  if (decision === null || decision === undefined) return { present: false, decision: null, actionable: false };
  const validated = validateInferenceDecision(decision);
  if (!validated.ok) {
    return { present: true, decision, actionable: false, reason: 'inference-decision-invalid' };
  }
  const normalized = validated.decision;
  const { disposition } = normalized;
  if (NON_ACTIONABLE_INFERENCE_DISPOSITIONS.has(disposition)) {
    return { present: true, decision: normalized, actionable: false, reason: 'inference-decision-not-actionable' };
  }
  if (!ACTIONABLE_INFERENCE_DISPOSITIONS.has(disposition)) {
    return { present: true, decision: normalized, actionable: false, reason: 'inference-decision-invalid' };
  }
  const { canonical } = normalized;
  if (!canonical) {
    return { present: true, decision: normalized, actionable: false, reason: 'inference-canonical-reference-required' };
  }
  return {
    present: true,
    decision: normalized,
    actionable: true,
    canonical: {
      recordId: canonical.recordId,
      kind: canonical.kind,
      revision: canonical.revision,
      parentId: canonical.parentId === undefined ? null : canonical.parentId,
      refDigest: canonical.refDigest === undefined ? null : canonical.refDigest,
    },
  };
}

function inferenceDecisionRefs(decision) {
  if (!decision || typeof decision !== 'object') return { candidateId: null, decisionId: null };
  const candidateId = typeof decision.candidateId === 'string' && decision.candidateId.trim()
    ? decision.candidateId.trim()
    : null;
  const decisionId = typeof decision.decisionId === 'string' && decision.decisionId.trim()
    ? decision.decisionId.trim()
    : null;
  return { candidateId, decisionId };
}

function canonicalMatchesDecision(reference, decisionInfo) {
  return Boolean(
    decisionInfo?.actionable
      && reference
      && reference.canonical
      && reference.canonical.id === decisionInfo.canonical.recordId
      && reference.canonical.kind === decisionInfo.canonical.kind
      && reference.canonical.revision === decisionInfo.canonical.revision,
  );
}

function safeWorkReference(input = {}) {
  const value = input.workReference || input.workRef;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  for (const field of ['authority', 'provider', 'workspaceId', 'itemId', 'itemRevision']) {
    if (typeof value[field] === 'string' && value[field].trim()) safe[field] = value[field].trim();
  }
  return Object.keys(safe).length ? safe : null;
}

function executionLinkResolverFrom({ executionLinkResolver, resolveExecutionLink, resolveCanonicalExecutionLink } = {}) {
  const supplied = [executionLinkResolver, resolveExecutionLink, resolveCanonicalExecutionLink].filter((value) => value !== undefined);
  if (supplied.length === 0) return { configured: false, resolver: null };
  const resolver = supplied.find((value) => typeof value === 'function') || null;
  return { configured: true, resolver, valid: supplied.every((value) => typeof value === 'function') };
}

async function resolveExecutionReference(input, executionLinks, { decisionInfo = null, executionLinkResolver = null } = {}) {
  let suppliedReference = input.executionReference;
  if (!suppliedReference && decisionInfo?.actionable) {
    if (typeof executionLinkResolver !== 'function') {
      return { ok: false, reason: 'canonical-execution-link-resolver-unavailable' };
    }
    let resolved;
    try {
      resolved = await executionLinkResolver({
        decision: decisionInfo.decision,
        canonical: decisionInfo.canonical,
        workReference: safeWorkReference(input),
      });
    } catch (_) {
      return { ok: false, reason: 'canonical-execution-link-resolver-failed' };
    }
    suppliedReference = resolved && typeof resolved === 'object'
      ? (resolved.executionReference || resolved.reference || resolved)
      : null;
    if (!suppliedReference) return { ok: false, reason: 'canonical-execution-link-not-found' };
    let candidate;
    try {
      candidate = validateExecutionReference(suppliedReference).reference;
    } catch (_) {
      return { ok: false, reason: 'canonical-execution-link-invalid' };
    }
    if (!canonicalMatchesDecision(candidate, decisionInfo)) {
      return { ok: false, reason: 'inference-canonical-link-mismatch' };
    }
    suppliedReference = candidate;
  }
  let reference;
  try {
    reference = validateExecutionReference(suppliedReference).reference;
  } catch (_) {
    return { ok: false, reason: 'exact-beads-execution-link-required' };
  }
  if (reference.authority !== 'beads' || reference.provider !== 'beads') {
    return { ok: false, reason: 'beads-execution-link-required' };
  }
  if (!executionLinks || typeof executionLinks.read !== 'function') {
    return { ok: false, reason: 'execution-link-admission-unavailable' };
  }
  let current;
  try {
    current = await executionLinks.read(reference.workspaceId, reference.itemId);
  } catch (_) {
    return { ok: false, reason: 'execution-link-admission-unavailable' };
  }
  if (!current) return { ok: false, reason: 'execution-link-not-found' };
  try {
    current = validateExecutionReference(current).reference;
  } catch (_) {
    return { ok: false, reason: 'execution-link-invalid' };
  }
  if (!sameExecutionTuple(reference, current)) return { ok: false, reason: 'stale-or-mismatched-execution-link' };
  const workReference = safeWorkReference(input);
  if (workReference?.authority && workReference.authority !== reference.authority) {
    return { ok: false, reason: 'work-reference-mismatch' };
  }
  if (workReference?.provider && workReference.provider !== reference.provider) {
    return { ok: false, reason: 'work-reference-mismatch' };
  }
  if (workReference?.workspaceId && workReference.workspaceId !== reference.workspaceId) {
    return { ok: false, reason: 'work-reference-mismatch' };
  }
  if (workReference?.itemId && workReference.itemId !== reference.itemId) {
    return { ok: false, reason: 'work-reference-mismatch' };
  }
  if (workReference?.itemRevision && workReference.itemRevision !== reference.itemRevision) {
    return { ok: false, reason: 'work-reference-mismatch' };
  }
  if (decisionInfo?.present && decisionInfo.actionable && !canonicalMatchesDecision(reference, decisionInfo)) {
    return { ok: false, reason: 'inference-canonical-link-mismatch' };
  }
  return { ok: true, reference };
}

function metadataDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function inferenceDependencies({ inferenceAuthority, inferenceEvidenceStore } = {}) {
  const configured = inferenceAuthority !== undefined || inferenceEvidenceStore !== undefined;
  const ready = Boolean(
    inferenceAuthority
      && typeof inferenceAuthority.admitEvidenceUnit === 'function'
      && inferenceEvidenceStore
      && typeof inferenceEvidenceStore.admitUnresolvedEvidence === 'function',
  );
  return { configured, ready };
}

function stableEventTimestamps(input) {
  const occurredAt = input.occurredAt || input.result?.occurredAt || input.result?.timestamp;
  const observedAt = input.observedAt || input.result?.observedAt || occurredAt;
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) return null;
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) return null;
  return {
    // Evidence contracts normalize timestamps to UTC. Normalize before
    // deriving the identity so equivalent timestamp spellings replay safely.
    occurredAt: new Date(occurredAt).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
  };
}

function unresolvedEvidenceInput(input, { runId, stage, sensitivity }) {
  const timestamps = stableEventTimestamps(input);
  if (!timestamps) throw new Error('stable inference event time required');
  const workReference = input.workReference || input.workRef || null;
  const itemId = workReference && typeof workReference.itemId === 'string' && workReference.itemId.trim()
    ? workReference.itemId.trim()
    : null;
  const authority = workReference && typeof workReference.authority === 'string' && workReference.authority.trim()
    ? workReference.authority.trim()
    : null;
  const executionReference = input.executionReference && typeof input.executionReference === 'object'
    ? input.executionReference
    : null;
  const metadata = {
    runId,
    stage,
    occurredAt: timestamps.occurredAt,
    observedAt: timestamps.observedAt,
    itemId,
    authority,
    workspaceId: typeof executionReference?.workspaceId === 'string' ? executionReference.workspaceId : null,
    itemRevision: typeof executionReference?.itemRevision === 'string' ? executionReference.itemRevision : null,
    sourceRevision: typeof executionReference?.sourceRevision === 'string' ? executionReference.sourceRevision : null,
    resultStatus: typeof input.result?.status === 'string' ? input.result.status : null,
  };
  const contentDigest = metadataDigest(metadata);
  const sourceRevision = `coding_${contentDigest}`;
  const admittedSensitivity = sensitivity === 'private' ? 'owner-private' : sensitivity;
  return {
    sourceClass: 'execution',
    observationId: `obs_coding_${contentDigest.slice(0, 32)}`,
    evidenceId: `ev_coding_${contentDigest.slice(0, 32)}`,
    occurredAt: timestamps.occurredAt,
    observedAt: timestamps.observedAt,
    sourceRevision,
    sensitivity: admittedSensitivity,
    coverageState: 'partial',
    contentDigest,
  };
}

function createProjectsActivityEmitter({
  authority,
  activityStore,
  executionLinks,
  inferenceAuthority,
  inferenceEvidenceStore,
  executionLinkResolver,
  resolveExecutionLink,
  resolveCanonicalExecutionLink,
  producerId = 'jarvos-coding',
  now = () => new Date().toISOString(),
  sensitivity = 'private',
} = {}) {
  const inference = inferenceDependencies({ inferenceAuthority, inferenceEvidenceStore });
  const linkResolver = executionLinkResolverFrom({ executionLinkResolver, resolveExecutionLink, resolveCanonicalExecutionLink });

  async function recordUnresolvedMilestone(input, stage, runId, reason, decision = null) {
    if (!inference.ready) {
      return {
        status: 'unavailable',
        reason: inference.configured ? 'inference-admission-unavailable' : reason,
        stage,
      };
    }
    let envelope;
    try {
      envelope = inferenceAuthority.admitEvidenceUnit(unresolvedEvidenceInput(input, { runId, stage, sensitivity }));
    } catch (_) {
      if (!stableEventTimestamps(input)) {
        return { status: 'unavailable', reason: 'inference-event-time-required', stage };
      }
      return { status: 'unavailable', reason: 'inference-evidence-admission-failed', stage };
    }
    let stored;
    try {
      stored = inferenceEvidenceStore.admitUnresolvedEvidence(envelope, {
        verifier: inferenceAuthority,
        reason: 'canonical_mapping_unavailable',
        ...inferenceDecisionRefs(decision),
      });
    } catch (_) {
      return { status: 'unavailable', reason: 'inference-evidence-store-failed', stage };
    }
    return {
      schemaVersion: PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION,
      status: stored.status,
      stage,
      eventId: `coding-inference:${envelope.evidence.evidenceId}`,
      evidenceId: envelope.evidence.evidenceId,
      canonicalId: null,
      reason,
      generation: stored.generation || null,
    };
  }

  return {
    schemaVersion: PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION,
    producerId,
    async recordMilestone(input = {}) {
      const stage = requiredString(input.stage, 'activity stage');
      if (!MILESTONE_STAGES.includes(stage)) return { status: 'skipped', reason: 'unsupported-stage', stage };
      if (input.result?.ok === false || NON_DURABLE_STAGE_STATUSES.has(String(input.result?.status || '').toLowerCase())) {
        return { status: 'skipped', reason: 'stage-not-durable', stage };
      }
      if (typeof input.runId !== 'string' || !input.runId.trim()) {
        return { status: 'unavailable', reason: 'activity-run-identity-required', stage };
      }
      const hasActivityAdmission = Boolean(
        authority
          && typeof authority.admitVerifiedReceipt === 'function'
          && activityStore
          && typeof activityStore.admit === 'function',
      );
      if (!hasActivityAdmission && !inference.ready) {
        return {
          status: 'unavailable',
          reason: inference.configured ? 'inference-admission-unavailable' : 'activity-admission-unavailable',
          stage,
        };
      }
      const runId = requiredString(input.runId, 'activity run identity');
      const decisionInfo = normalizeInferenceDecision(inferenceDecisionFrom(input));
      if (decisionInfo.present && !decisionInfo.actionable) {
        const reason = decisionInfo.reason;
        if (inference.configured && !inference.ready) {
          return { status: 'unavailable', reason: 'inference-admission-unavailable', stage };
        }
        if (inference.ready && UNRESOLVED_EXECUTION_REASONS.has(reason)) {
          return recordUnresolvedMilestone(input, stage, runId, reason, decisionInfo.decision);
        }
        return { status: 'unavailable', reason, stage };
      }
      if (decisionInfo.present && linkResolver.configured && !linkResolver.valid) {
        return { status: 'unavailable', reason: 'canonical-execution-link-resolver-invalid', stage };
      }
      const execution = await resolveExecutionReference(input, executionLinks, {
        decisionInfo,
        executionLinkResolver: linkResolver.resolver,
      });
      if (!execution.ok) {
        if (inference.configured && !inference.ready) {
          return { status: 'unavailable', reason: 'inference-admission-unavailable', stage };
        }
        if (inference.ready && UNRESOLVED_EXECUTION_REASONS.has(execution.reason)) {
          return recordUnresolvedMilestone(input, stage, runId, execution.reason, decisionInfo.decision);
        }
        return { status: 'unavailable', reason: execution.reason, stage };
      }
      if (!hasActivityAdmission) return { status: 'unavailable', reason: 'activity-admission-unavailable', stage };
      const { workspaceId, itemId, itemRevision, canonical } = execution.reference;
      const eventId = `coding:${runId}:${workspaceId}:${itemId}:${stage}`;
      let receipt;
      try {
        receipt = authority.admitVerifiedReceipt({
          contract: 'jarvos.verified-activity/v1',
          eventId,
          canonicalId: canonical.id,
          producerId,
          kind: 'coding-milestone',
          occurredAt: input.occurredAt || now(),
          observedAt: now(),
          evidenceRefs: [`beads:${workspaceId}:${itemId}:${itemRevision}`, `coding:${eventId}`],
          sourceRevision: `${runId}:${workspaceId}:${itemId}:${itemRevision}:${stage}`,
          sensitivity,
          dedupeKey: eventId,
        });
      } catch (_) {
        return { status: 'unavailable', reason: 'activity-producer-not-admitted', stage };
      }
      let stored;
      try {
        stored = activityStore.admit(receipt, { admission: authority });
      } catch (_) {
        return { status: 'unavailable', reason: 'activity-admission-failed', stage };
      }
      return {
        schemaVersion: PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION,
        status: stored.status,
        stage,
        eventId,
        canonicalId: canonical.id,
        generation: stored.generation || null,
      };
    },
  };
}

module.exports = {
  MILESTONE_STAGES,
  PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION,
  createProjectsActivityEmitter,
};
