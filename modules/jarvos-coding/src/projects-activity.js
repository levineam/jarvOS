'use strict';

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

function createProjectsActivityEmitter({ authority, activityStore, executionLinks, producerId = 'jarvos-coding', now = () => new Date().toISOString(), sensitivity = 'private' } = {}) {
  return {
    schemaVersion: PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION,
    producerId,
    async recordMilestone(input = {}) {
      const stage = requiredString(input.stage, 'activity stage');
      if (!MILESTONE_STAGES.includes(stage)) return { status: 'skipped', reason: 'unsupported-stage', stage };
      if (input.result?.ok === false || NON_DURABLE_STAGE_STATUSES.has(String(input.result?.status || '').toLowerCase())) {
        return { status: 'skipped', reason: 'stage-not-durable', stage };
      }
      if (!authority || typeof authority.admitVerifiedReceipt !== 'function' || !activityStore || typeof activityStore.admit !== 'function') {
        return { status: 'unavailable', reason: 'activity-admission-unavailable', stage };
      }
      if (typeof input.runId !== 'string' || !input.runId.trim()) {
        return { status: 'unavailable', reason: 'activity-run-identity-required', stage };
      }
      const execution = await resolveExecutionReference(input, executionLinks);
      if (!execution.ok) return { status: 'unavailable', reason: execution.reason, stage };
      const runId = requiredString(input.runId, 'activity run identity');
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
