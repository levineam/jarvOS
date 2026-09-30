'use strict';

const crypto = require('node:crypto');

const DELIVERY_TRACE_SCHEMA_VERSION = 'jarvos-coding-delivery-trace/v1';

const SHA256 = /^[a-f0-9]{64}$/i;
const UNSAFE_PATH_CHARACTERS = /[\0-\x1f\\:]/;
const PLACEHOLDER_REASON = /^(?:n\/?a|none|no|nil|nothing|not applicable|tbd|todo|[-.\s]*)$/i;
const MIN_NO_DOC_REASON_LENGTH = 20;
const DOWNSTREAM_PROOF_LEVELS = Object.freeze(['installed', 'live']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameToken(left, right) {
  return hasText(left) && hasText(right) && left.trim().toLowerCase() === right.trim().toLowerCase();
}

// Repo-relative only. Also rejects a leading dash and `:` so the value is safe
// to place after `HEAD:` in a Git argument array.
function isSafeRepoPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  if (UNSAFE_PATH_CHARACTERS.test(value) || /^[-/]/.test(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function sameFileSet(declared, observed) {
  if (!Array.isArray(declared) || !Array.isArray(observed)) return false;
  const left = new Set(declared);
  const right = new Set(observed);
  return left.size === right.size && [...left].every((file) => right.has(file));
}

/**
 * Host-side observation of the plan file as it exists at the inspected commit.
 * Returns a digest and whether the text names the work, never the text itself.
 */
function observePlan(text, identifier) {
  const body = String(text ?? '');
  const escaped = String(identifier || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    digest: crypto.createHash('sha256').update(body).digest('hex'),
    mentionsWorkIdentifier: Boolean(escaped)
      && new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(body),
  };
}

function isBehavioralSourceProof(entry) {
  return entry.kind === 'behavioral'
    && entry.level === 'source'
    && entry.status === 'passed'
    && hasText(entry.criterion)
    && hasText(entry.claim)
    && hasText(entry.observation)
    && (hasText(entry.command) || hasText(entry.artifact));
}

function hasRuntimeEvidence(entry) {
  return isObject(entry.runtime)
    && hasText(entry.runtime.target)
    && hasText(entry.runtime.revision)
    && hasText(entry.observedAt)
    && hasText(entry.artifact);
}

/**
 * Pure comparison of an agent-declared delivery trace against a host-supplied
 * Git observation. It reads no files, runs no commands, and takes no tracker
 * input: only `identifier` and `observed` are consulted from the context.
 *
 * A passing result proves the source link only. Installed and live claims are
 * reported as `not-claimed` or `declared-unverified`; they are never promoted.
 */
function evaluateDeliveryTrace(trace, context = {}) {
  const reasons = [];
  const add = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const claims = { source: 'unproven', installed: 'not-claimed', live: 'not-claimed' };
  const finish = () => {
    if (reasons.length === 0) claims.source = 'proven';
    return {
      schemaVersion: DELIVERY_TRACE_SCHEMA_VERSION,
      ok: reasons.length === 0,
      reasons,
      claims,
    };
  };

  if (!isObject(trace) || trace.schemaVersion !== DELIVERY_TRACE_SCHEMA_VERSION) {
    add('delivery_trace_missing');
    return finish();
  }

  const identifier = hasText(context?.identifier) ? context.identifier : '';
  const observed = isObject(context?.observed)
    && hasText(context.observed.headCommit)
    && Array.isArray(context.observed.changedFiles)
    ? context.observed
    : null;
  if (!observed) add('observation_unavailable');

  // Owning plan: a Git path and digest. A tracker link is not a plan of record.
  const plan = isObject(trace.plan) ? trace.plan : {};
  const planDeclared = isSafeRepoPath(plan.path) && SHA256.test(plan.digest || '');
  if (!planDeclared) add('plan_missing');
  if (!sameToken(trace.workIdentifier, identifier)) add('plan_identity_mismatch');
  if (observed && planDeclared) {
    const observedPlan = isObject(observed.plan) && SHA256.test(observed.plan.digest || '')
      ? observed.plan
      : null;
    if (!observedPlan) {
      add('plan_missing');
    } else {
      if (observedPlan.mentionsWorkIdentifier !== true) add('plan_identity_mismatch');
      if (!sameToken(observedPlan.digest, plan.digest)) add('plan_stale');
    }
    const accepted = observed.acceptedPlanDigest;
    if (accepted !== undefined && accepted !== null && !sameToken(accepted, plan.digest)) add('plan_stale');
  }

  // Documentation decision: name the changed docs, or justify changing none.
  const docImpact = trace.docImpact;
  if (!isObject(docImpact) || !['affected', 'none'].includes(docImpact.decision)) {
    add('doc_impact_missing');
  } else if (docImpact.decision === 'none') {
    const reason = hasText(docImpact.reason) ? docImpact.reason.trim() : '';
    if (reason.length < MIN_NO_DOC_REASON_LENGTH || PLACEHOLDER_REASON.test(reason)) add('doc_impact_reason_missing');
  } else {
    const docs = Array.isArray(docImpact.docs) ? docImpact.docs : [];
    // The owning plan is not documentation of the change.
    const declared = docs.length > 0 && docs.every((doc) => isSafeRepoPath(doc) && doc !== plan.path);
    if (!declared || (observed && !docs.every((doc) => observed.changedFiles.includes(doc)))) add('doc_not_updated');
  }

  // Implementation: the declared revision and file set must be what Git shows.
  const implementation = isObject(trace.implementation) ? trace.implementation : {};
  if (observed) {
    if (!sameToken(implementation.headCommit, observed.headCommit)) add('implementation_stale');
    if (!sameFileSet(implementation.changedFiles, observed.changedFiles)) add('implementation_mismatch');
  }

  // Proof: tests, lint, build, and review entries are welcome but never count
  // as the behavioral observation.
  const proof = Array.isArray(trace.proof) ? trace.proof.filter(isObject) : [];
  const behavioral = proof.filter(isBehavioralSourceProof);
  if (behavioral.length === 0) {
    add('behavioral_proof_missing');
  } else if (observed && !behavioral.every((entry) => sameToken(entry.headCommit, observed.headCommit))) {
    add('proof_stale');
  }
  for (const entry of proof) {
    if (entry.level === undefined || entry.level === 'source') continue;
    if (!DOWNSTREAM_PROOF_LEVELS.includes(entry.level) || !hasRuntimeEvidence(entry)) {
      add('proof_level_unsupported');
    } else {
      claims[entry.level] = 'declared-unverified';
    }
  }

  return finish();
}

module.exports = {
  DELIVERY_TRACE_SCHEMA_VERSION,
  evaluateDeliveryTrace,
  isSafeRepoPath,
  observePlan,
};
