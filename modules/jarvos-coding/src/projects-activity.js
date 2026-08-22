'use strict';

const crypto = require('node:crypto');
const {
  validateExecutionReference,
} = require('../../jarvos-secondbrain/packages/jarvos-secondbrain-projects/src/provider-contracts');

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

async function resolveExecutionReference(input, executionLinks) {
  let reference;
  try {
    reference = validateExecutionReference(input.executionReference).reference;
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
  producerId = 'jarvos-coding',
  now = () => new Date().toISOString(),
  sensitivity = 'private',
} = {}) {
  const inference = inferenceDependencies({ inferenceAuthority, inferenceEvidenceStore });

  async function recordUnresolvedMilestone(input, stage, runId, reason) {
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
      const execution = await resolveExecutionReference(input, executionLinks);
      if (!execution.ok) {
        if (inference.configured && !inference.ready) {
          return { status: 'unavailable', reason: 'inference-admission-unavailable', stage };
        }
        if (inference.ready && UNRESOLVED_EXECUTION_REASONS.has(execution.reason)) {
          return recordUnresolvedMilestone(input, stage, runId, execution.reason);
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
