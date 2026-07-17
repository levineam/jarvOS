'use strict';

const APPROVED_STATUSES = new Set(['reviewing']);
const CLOSED_STATUSES = new Set(['promoted', 'dismissed', 'resolved', 'stale']);

function hasSourceEvidence(record = {}) {
  return Boolean(record.source && typeof record.source === 'object' && record.source.type && record.source.ref);
}

function canPromoteCandidate(candidate = {}) {
  const errors = [];
  if (candidate.type !== 'ontology-candidate') errors.push('record must have type ontology-candidate');
  if (!APPROVED_STATUSES.has(candidate.status)) errors.push('candidate status must be reviewing before promotion');
  if (CLOSED_STATUSES.has(candidate.status)) errors.push(`candidate status is already closed: ${candidate.status}`);
  if (!hasSourceEvidence(candidate)) errors.push('candidate requires source.type and source.ref');
  if (!candidate.proposed_target) errors.push('candidate requires proposed_target');
  if (!candidate.proposal) errors.push('candidate requires proposal');
  if (!candidate.reviewer) errors.push('candidate requires reviewer before promotion');
  if (!candidate.reviewed_at) errors.push('candidate requires reviewed_at before promotion');
  return { ok: errors.length === 0, errors };
}

function promoteReviewedCandidate(candidate = {}, options = {}) {
  const check = canPromoteCandidate(candidate);
  if (!check.ok) {
    return { ok: false, promoted: false, errors: check.errors };
  }

  const promotedAt = options.promotedAt || new Date().toISOString();
  const targetAnchor = options.targetAnchor || `${candidate.proposed_target}:${candidate.id}`;
  const result = {
    ok: true,
    promoted: options.dryRun !== true,
    dryRun: options.dryRun === true,
    target: candidate.proposed_target,
    entry: {
      target: candidate.proposed_target,
      content: candidate.proposal,
      source: candidate.source,
      promotedAt,
      reviewer: candidate.reviewer,
    },
    outcome: {
      ontology_anchor: targetAnchor,
      reason: options.reason || 'Reviewed ontology candidate promoted.',
    },
    nextRecord: {
      ...candidate,
      status: 'promoted',
      updated_at: promotedAt,
      outcome: {
        ...(candidate.outcome || {}),
        ontology_anchor: targetAnchor,
        reason: options.reason || 'Reviewed ontology candidate promoted.',
      },
    },
  };

  if (typeof options.apply === 'function' && options.dryRun !== true) {
    result.applyResult = options.apply(result.entry);
  }

  return result;
}

function resolveInquiry(inquiry = {}, options = {}) {
  const errors = [];
  if (inquiry.type !== 'ontology-inquiry') errors.push('record must have type ontology-inquiry');
  if (!hasSourceEvidence(inquiry)) errors.push('inquiry requires source.type and source.ref');
  if (!inquiry.question) errors.push('inquiry requires question');
  if (!options.resolution) errors.push('resolution is required');
  if (errors.length) return { ok: false, resolved: false, errors };
  const resolvedAt = options.resolvedAt || new Date().toISOString();
  return {
    ok: true,
    resolved: true,
    nextRecord: {
      ...inquiry,
      status: 'resolved',
      resolution: options.resolution,
      resolved_at: resolvedAt,
      updated_at: resolvedAt,
    },
  };
}

module.exports = {
  canPromoteCandidate,
  promoteReviewedCandidate,
  resolveInquiry,
};
