'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { autonomousRepairOperator, statusOperator } = require('./operator');

/**
 * Load the public operator-notification contract with the monorepo source-tree
 * fallback used by other jarvOS modules when the package is not installed.
 */
function loadOperatorNotification() {
  try {
    return require(require.resolve('@jarvos/runtime-kit', {
      paths: [path.join(__dirname, '..'), process.cwd()],
    }));
  } catch {
    const fallback = path.join(__dirname, '..', '..', 'jarvos-runtime-kit', 'src', 'index.js');
    if (fs.existsSync(fallback)) return require(fallback);
    throw new Error('operator notification contract is unavailable');
  }
}

const {
  NO_REPLY,
  OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  evaluateOperatorNotification,
} = loadOperatorNotification();

/** Reasons that stay quiet as durable safety holds (AE1). */
const SAFE_HOLD_REASONS = new Set([
  'unsafe_source',
  'privacy_restricted',
  'owner_excluded',
  'harness_native',
  'vendor_managed',
  'trust_class_insufficient',
  'capability_unsupported',
  'local_modification_preserved',
  'source_absent',
  'source_retired',
  'already_managed_receipt',
  'rule_proven_portable',
  'rule_proven_update',
]);

/** Reasons that require a concrete owner decision (AE2). */
const OWNER_DECISION_REASONS = new Set([
  'needs_owner_input',
  'semantic_collision',
  'ambiguous_identity',
  'incomplete_observation',
  'review_required',
]);

function normalizeReasonCode(value) {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value)
    ? value
    : 'needs_owner_input';
}

function countByReason(items = []) {
  const counts = new Map();
  for (const item of items) {
    const reason = normalizeReasonCode(item?.reasonCode);
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');
}

/**
 * Mint a stable opaque reference from private transition material.
 * The token is base64url and never embeds the reason code or skill identity.
 */
function mintEventReference(seed) {
  return crypto.createHash('sha256')
    .update(String(seed || 'jarvos-skill-sync'))
    .digest('base64url')
    .slice(0, 32);
}

function mintDedupeKey(parts) {
  const raw = parts.filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const compact = raw.slice(0, 120) || 'skill-sync';
  if (/^[a-z][a-z0-9-]*$/.test(compact)) return compact;
  return `skill-sync-${crypto.createHash('sha256').update(compact).digest('hex').slice(0, 16)}`;
}

function baseEvent(overrides = {}) {
  const observedAt = overrides.observedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    audience: 'operator',
    observedAt,
    freshness: 'current',
    ...overrides,
  };
}

function evaluate(event) {
  return evaluateOperatorNotification(event);
}

function repairedCount(result) {
  if (result?.reconciliation?.repaired !== true) return 0;
  if (!Array.isArray(result.reconciliation.applied)) return 0;
  return result.reconciliation.applied.filter((item) => item?.applied !== false).length;
}

function classifyRaised(raised = []) {
  const owner = [];
  const holds = [];
  for (const item of raised) {
    const reason = normalizeReasonCode(item?.reasonCode);
    if (OWNER_DECISION_REASONS.has(reason) || !SAFE_HOLD_REASONS.has(reason)) {
      // Unknown reason codes fail closed as owner decisions (never raw in output).
      owner.push({ ...item, reasonCode: reason });
    } else {
      holds.push({ ...item, reasonCode: reason });
    }
  }
  return { owner, holds };
}

/**
 * Build durable-status material for quiet holds/resolutions/repairs.
 * Reason codes stay here for the shared-skills status surface only.
 */
function buildDurableStatusSummary({ holds = [], resolved = [], repaired = 0, observedAt } = {}) {
  const parts = [];
  if (holds.length) {
    parts.push({
      kind: 'safe-hold',
      count: holds.length,
      reasons: countByReason(holds),
      firstSeenAt: observedAt || null,
      occurrenceCount: holds.length,
    });
  }
  if (resolved.length) {
    parts.push({
      kind: 'resolved',
      count: resolved.length,
      reasons: countByReason(resolved),
    });
  }
  if (repaired > 0) {
    parts.push({ kind: 'repaired', count: repaired });
  }
  return parts;
}

function ownerDecisionMessage(result, raisedOwner, { observedAt } = {}) {
  const seed = raisedOwner.map((item) => item.fingerprint || item.logicalId || item.reasonCode).join('|')
    || `owner-${observedAt || 'now'}`;
  const event = baseEvent({
    code: 'recovery-failed',
    severity: 'error',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'choose-recovery',
    nextState: 'continue-monitoring',
    eventReference: mintEventReference(seed),
    dedupeKey: mintDedupeKey(['skill-sync-owner', seed.slice(0, 48)]),
    privateDetailReference: mintEventReference(`private:${seed}`),
    observedAt,
  });
  // Prefer recovery-failed wording when the run itself failed closed; otherwise
  // a raised owner decision is still an action-required recovery choice.
  if (result?.ok === false) {
    return evaluate(event);
  }
  // Concrete owner input without a failed automation still needs choose-recovery.
  return evaluate(event);
}

function incompleteInventoryMessage(result, { observedAt } = {}) {
  const count = Number(result?.status?.counts?.actionable || 0);
  const seed = `incomplete:${count}:${observedAt || ''}`;
  return evaluate(baseEvent({
    code: 'recovery-failed',
    severity: 'warning',
    automationOutcome: 'safe-hold',
    actionRequired: true,
    action: 'choose-recovery',
    nextState: 'continue-monitoring',
    eventReference: mintEventReference(seed),
    dedupeKey: mintDedupeKey(['skill-sync-incomplete', String(count)]),
    privateDetailReference: mintEventReference(`private:${seed}`),
    observedAt,
  }));
}

function failureMessage(result, { observedAt } = {}) {
  const seed = `failed:${result?.reason || 'scheduled-repair'}:${observedAt || ''}`;
  return evaluate(baseEvent({
    code: 'recovery-failed',
    severity: 'error',
    automationOutcome: 'failed',
    actionRequired: true,
    action: 'choose-recovery',
    nextState: 'continue-monitoring',
    eventReference: mintEventReference(seed),
    dedupeKey: mintDedupeKey(['skill-sync-failed', result?.reason || 'unknown']),
    privateDetailReference: mintEventReference(`private:${seed}`),
    observedAt,
  }));
}

function quietHoldEvaluation({ observedAt } = {}) {
  return evaluate(baseEvent({
    code: 'safety-hold',
    severity: 'warning',
    automationOutcome: 'safe-hold',
    actionRequired: false,
    action: 'none',
    nextState: 'continue-monitoring',
    eventReference: mintEventReference(`hold:${observedAt || 'now'}`),
    dedupeKey: mintDedupeKey(['skill-sync-safe-hold']),
    observedAt,
  }));
}

function quietRepairEvaluation({ observedAt } = {}) {
  return evaluate(baseEvent({
    code: 'repair-complete',
    severity: 'info',
    automationOutcome: 'repaired',
    actionRequired: false,
    action: 'none',
    nextState: 'none',
    eventReference: mintEventReference(`repair:${observedAt || 'now'}`),
    dedupeKey: mintDedupeKey(['skill-sync-repair']),
    observedAt,
  }));
}

function quietResolutionEvaluation({ observedAt } = {}) {
  return evaluate(baseEvent({
    code: 'resolution-complete',
    severity: 'info',
    automationOutcome: 'resolved',
    actionRequired: false,
    action: 'none',
    nextState: 'none',
    eventReference: mintEventReference(`resolved:${observedAt || 'now'}`),
    dedupeKey: mintDedupeKey(['skill-sync-resolved']),
    observedAt,
  }));
}

/**
 * One-shot activation announcement. Still avoids raw codes and private ids.
 * Uses plain English only; not a recurring interrupt path.
 */
function convergenceMessage(result, catalogStatus) {
  const inventoryCount = Number(result?.status?.counts?.skills || 0);
  const actionableCount = Number(result?.status?.counts?.actionable || 0);
  const pairs = Array.isArray(catalogStatus?.pairs) ? catalogStatus.pairs : [];
  const cleanPairs = pairs.filter((pair) => pair?.status === 'clean').length;
  const parts = [
    `jarvOS skill sync is active: ${inventoryCount} skill${inventoryCount === 1 ? '' : 's'} inventoried`,
    `${cleanPairs}/${pairs.length} managed harness projection${pairs.length === 1 ? '' : 's'} clean`,
  ];
  parts.push(actionableCount
    ? `${actionableCount} item${actionableCount === 1 ? '' : 's'} need review; future repeats stay quiet`
    : 'nothing needs your attention; future healthy runs stay quiet');
  return `${parts.join('; ')}.`;
}

/**
 * Project a scheduled-repair result through the public notification contract.
 * Direct human output never includes raw reason codes, skill ids, or paths.
 */
function scheduledRepairNotification(result, {
  announceConvergence = false,
  catalogStatus = null,
  observedAt = null,
} = {}) {
  const at = observedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const empty = {
    message: NO_REPLY,
    disposition: 'quiet',
    statusMessage: null,
    durableStatus: [],
    evaluation: null,
  };

  if (!result?.ok) {
    const evaluation = failureMessage(result, { observedAt: at });
    return {
      message: evaluation.output,
      disposition: evaluation.disposition,
      statusMessage: evaluation.statusMessage,
      durableStatus: [],
      evaluation,
    };
  }

  if (result.ran === false) {
    const evaluation = failureMessage({
      ...result,
      reason: result.reason || 'did_not_run',
    }, { observedAt: at });
    return {
      message: evaluation.output,
      disposition: evaluation.disposition,
      statusMessage: evaluation.statusMessage,
      durableStatus: [],
      evaluation,
    };
  }

  if (result.mutationDenied === true) {
    const evaluation = incompleteInventoryMessage(result, { observedAt: at });
    return {
      message: evaluation.output,
      disposition: evaluation.disposition,
      statusMessage: evaluation.statusMessage,
      durableStatus: buildDurableStatusSummary({
        holds: [{ reasonCode: 'incomplete_observation' }],
        observedAt: at,
      }),
      evaluation,
    };
  }

  if (announceConvergence) {
    return {
      message: convergenceMessage(result, catalogStatus),
      disposition: 'direct-notification',
      statusMessage: null,
      durableStatus: [],
      evaluation: null,
    };
  }

  const raised = Array.isArray(result.attention?.raised) ? result.attention.raised : [];
  const resolved = Array.isArray(result.attention?.resolved) ? result.attention.resolved : [];
  const repaired = repairedCount(result);
  const { owner, holds } = classifyRaised(raised);
  const durableStatus = buildDurableStatusSummary({
    holds,
    resolved,
    repaired,
    observedAt: at,
  });

  // AE2: concrete owner decisions interrupt once with a complete message.
  if (owner.length) {
    const evaluation = ownerDecisionMessage(result, owner, { observedAt: at });
    return {
      message: evaluation.output,
      disposition: evaluation.disposition,
      statusMessage: evaluation.statusMessage,
      durableStatus,
      evaluation,
    };
  }

  // AE1 + R6: safe holds, automatic repairs, and resolutions stay quiet.
  if (holds.length || resolved.length || repaired) {
    let evaluation;
    if (holds.length) evaluation = quietHoldEvaluation({ observedAt: at });
    else if (repaired) evaluation = quietRepairEvaluation({ observedAt: at });
    else evaluation = quietResolutionEvaluation({ observedAt: at });
    return {
      message: evaluation.output,
      disposition: evaluation.disposition,
      statusMessage: evaluation.statusMessage,
      durableStatus,
      evaluation,
    };
  }

  return empty;
}

function scheduledRepairMessage(result, options = {}) {
  return scheduledRepairNotification(result, options).message;
}

function runScheduledRepair({
  configPath,
  announceConvergence = false,
  repair = autonomousRepairOperator,
  readStatus = statusOperator,
  observedAt = null,
} = {}) {
  const result = repair({ configPath });
  const catalogStatus = announceConvergence && result?.ok && result?.ran !== false
    ? readStatus({ configPath })
    : null;
  const notification = scheduledRepairNotification(result, {
    announceConvergence,
    catalogStatus,
    observedAt,
  });
  return {
    result,
    message: notification.message,
    disposition: notification.disposition,
    statusMessage: notification.statusMessage,
    durableStatus: notification.durableStatus,
    evaluation: notification.evaluation,
  };
}

module.exports = {
  OWNER_DECISION_REASONS,
  SAFE_HOLD_REASONS,
  countByReason,
  mintEventReference,
  scheduledRepairMessage,
  scheduledRepairNotification,
  runScheduledRepair,
};
