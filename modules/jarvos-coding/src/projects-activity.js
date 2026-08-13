'use strict';

const PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION = 'jarvos-coding-projects-activity/v1';
const MILESTONE_STAGES = Object.freeze([
  'claim', 'branch', 'sliceReview', 'holisticReview', 'fixRerun', 'pullRequest', 'postMergeSweep', 'verifyClose',
]);

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function canonicalIdOf(input = {}) {
  const value = input.canonicalId || input.projectId || input.outcomeId || input.canonical?.id || input.projectRef?.id || input.outcomeRef?.id;
  if (typeof value !== 'string' || !/^(?:prj|out)_[0-9]{6,}$/.test(value)) return null;
  return value;
}

function createProjectsActivityEmitter({ authority, activityStore, producerId = 'jarvos-coding', now = () => new Date().toISOString(), sensitivity = 'private' } = {}) {
  return {
    schemaVersion: PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION,
    producerId,
    async recordMilestone(input = {}) {
      const stage = requiredString(input.stage, 'activity stage');
      if (!MILESTONE_STAGES.includes(stage)) return { status: 'skipped', reason: 'unsupported-stage', stage };
      if (input.result?.ok === false || ['failed', 'error', 'not_found'].includes(String(input.result?.status || '').toLowerCase())) {
        return { status: 'skipped', reason: 'stage-not-durable', stage };
      }
      const canonicalId = canonicalIdOf(input);
      if (!canonicalId) return { status: 'unavailable', reason: 'canonical-project-link-required', stage };
      if (!authority || typeof authority.admitVerifiedReceipt !== 'function' || !activityStore || typeof activityStore.admit !== 'function') {
        return { status: 'unavailable', reason: 'activity-admission-unavailable', stage };
      }
      const runId = requiredString(
        input.runId || input.operationId || input.workReference?.operationId || input.workReference?.itemId || input.issueIdentifier,
        'activity run identity',
      );
      const eventId = `coding:${runId}:${stage}`;
      const receipt = authority.admitVerifiedReceipt({
        contract: 'jarvos.verified-activity/v1',
        eventId,
        canonicalId,
        producerId,
        kind: 'coding-milestone',
        occurredAt: input.occurredAt || now(),
        observedAt: now(),
        evidenceRefs: [
          `coding:${eventId}`,
          ...(input.workReference?.itemId ? [`beads:${input.workReference.itemId}`] : []),
        ],
        sourceRevision: `${runId}:${stage}`,
        sensitivity,
        dedupeKey: eventId,
      });
      const stored = activityStore.admit(receipt, { admission: authority });
      return {
        schemaVersion: PROJECTS_ACTIVITY_EMITTER_SCHEMA_VERSION,
        status: stored.status,
        stage,
        eventId,
        canonicalId,
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
