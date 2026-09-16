'use strict';

const crypto = require('node:crypto');
const { autonomousRepairOperator, statusOperator, decisionStatePath } = require('./operator');
const decisionStore = require('./decision-store');
// The package import is the installed public contract. The relative fallback
// keeps the source distribution runnable before its sibling packages are packed.
let operatorNotification;
try {
  operatorNotification = require('@jarvos/runtime-kit');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes('@jarvos/runtime-kit')) throw error;
  operatorNotification = require('../../jarvos-runtime-kit');
}

const {
  NO_REPLY,
  OPERATOR_NOTIFICATION_SCHEMA_VERSION,
  SKILL_DECISION_BATCH_LIMIT,
  evaluateOperatorNotification,
} = operatorNotification;

// Whichever copy of the runtime kit Node actually resolved must carry the
// notification contract this module renders against. A stale or partial copy
// would otherwise silently fall back to older reminder semantics, so rendering
// fails closed instead; a copy that predates the digest rejects its
// pendingCount when the event is evaluated. The check is at the point of use,
// so an inconsistent install cannot break unrelated skills commands that never
// render a notification.
function requireNotificationContract() {
  for (const [name, value] of Object.entries({
    NO_REPLY, OPERATOR_NOTIFICATION_SCHEMA_VERSION, SKILL_DECISION_BATCH_LIMIT, evaluateOperatorNotification,
  })) {
    if (value === undefined) throw new Error(`the resolved @jarvos/runtime-kit does not provide ${name}`);
  }
}

function opaqueReference() {
  return crypto.randomBytes(24).toString('base64url');
}

function observedAt(result, now) {
  const value = result?.status?.observedAt;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : now;
}

// The scheduler caller owns occurrence identity. By default a run belongs to
// its UTC hour, so a retried run within the same hour cannot remind twice. A
// caller that already has its own run identity should name its series here
// rather than pass a run key stamped to the minute or the second: only a
// series plus a UTC hour is an ordered occurrence that a replay can never
// reclaim and that never fills the bounded custom-key history.
const OCCURRENCE_SERIES_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,44}$/;
function hourlyOccurrenceKey(now, series = 'hour') {
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) return null;
  const name = typeof series === 'string' && OCCURRENCE_SERIES_RE.test(series) ? series : 'hour';
  return `${name}-${at.toISOString().slice(0, 13)}`;
}

function occurrenceDedupeKey(base, occurrenceKey) {
  if (!occurrenceKey) return base;
  const suffix = `-${String(occurrenceKey).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`;
  return `${base.slice(0, 180 - suffix.length)}${suffix}`;
}

// Only allowlisted owner facts leave the decision record.
function decisionFacts(decision) {
  return {
    ...(Array.isArray(decision.affectedHarnesses) && decision.affectedHarnesses.length > 0
      ? { affectedHarnesses: decision.affectedHarnesses } : {}),
    ...(decision.preservedState ? { preservedState: decision.preservedState } : {}),
  };
}

// Maps a thrown failure to a reviewed, allowlisted cause using only its code
// and lease operation. The message, paths, and stack never leave; an unknown
// failure has no cause and renders the generic recovery.
function failureCauseFor(error) {
  if (error?.code === 'ELEASEGATE') return error.operation === 'decision-ledger' ? 'decision-lock-gate' : 'skill-sync-lock-gate';
  if (error?.code === 'ELEASEBUSY' && error.operation === 'decision-ledger') return 'decision-ledger-busy';
  if (error?.code === 'EDECISIONSTATE') return 'decision-ledger-unreadable';
  if (error?.code === 'EOCCURRENCE') return 'reminder-occurrence-rejected';
  return null;
}

// Every event this occurrence should send, in order. All but the owner
// decision branches produce exactly one event.
function eventsFor(result, {
  now = new Date().toISOString(),
  deliveryClaims = [],
  reminderClaims = null,
  occurrenceKey = null,
  failureCause = null,
} = {}) {
  requireNotificationContract();
  const raised = Array.isArray(result?.attention?.raised) ? result.attention.raised : [];
  const resolved = Array.isArray(result?.attention?.resolved) ? result.attention.resolved : [];
  const createdDecisions = Array.isArray(result?.decisions?.items) ? result.decisions.items : [];
  const pendingDecisions = Array.isArray(result?.decisions?.pendingItems) ? result.decisions.pendingItems : [];
  // A scheduled run names exactly the decisions whose reminder it claimed for
  // this occurrence; paused, resolved, or already-reminded decisions are left
  // out. Rendering without claims keeps the original rule: a fresh decision
  // takes precedence over older pending ones. More than one item becomes one
  // bounded digest that carries no delivery attempt.
  const reminded = Array.isArray(reminderClaims) ? new Set(reminderClaims.map((claim) => claim?.decisionId)) : null;
  const decisionsForNotification = reminded
    ? pendingDecisions.filter((decision) => reminded.has(decision.id))
    : createdDecisions.length > 0 ? createdDecisions : pendingDecisions;
  const reminderOccurrence = reminded ? occurrenceKey : null;
  const migration = result?.decisions?.migration;
  const repaired = result?.reconciliation?.repaired === true
    && Array.isArray(result.reconciliation.applied)
    && result.reconciliation.applied.some((item) => item?.applied !== false);
  const common = {
    schemaVersion: OPERATOR_NOTIFICATION_SCHEMA_VERSION,
    audience: 'operator',
    observedAt: observedAt(result, now),
    freshness: 'current',
    privateDetailReference: opaqueReference(),
  };

  // A named failure gets its reviewed recovery. Its identity belongs to the
  // occurrence, so a failure that persists is reported again each occurrence
  // rather than deduped forever, and at most once per occurrence.
  const cause = typeof failureCause === 'string' && failureCause ? failureCause : null;
  if (!result?.ok || result?.ran === false || cause) {
    return [{
      ...common,
      code: 'recovery-failed',
      severity: 'error',
      automationOutcome: 'failed',
      actionRequired: true,
      action: cause ? 'follow-recovery' : 'choose-recovery',
      nextState: 'continue-monitoring',
      eventReference: opaqueReference(),
      ...(cause ? { failureCause: cause } : {}),
      dedupeKey: cause ? occurrenceDedupeKey(`scheduled-repair-failure-${cause}`, occurrenceKey) : 'scheduled-repair-recovery',
    }];
  }

  // Named owner decisions are rendered before the migration summary and the
  // generic safety hold: the hold stays durable local status, while every
  // decision this occurrence claimed needs the owner by name.
  if (decisionsForNotification.length === 1) {
    const decision = decisionsForNotification[0];
    const deliveryAttempt = deliveryClaims.find((claim) => claim.decisionId === decision.id) || null;
    return [{
      ...common,
      code: 'skill-owner-decision',
      severity: 'warning',
      automationOutcome: 'failed',
      actionRequired: true,
      action: 'choose-skill-option',
      nextState: 'await-owner-decision',
      eventReference: decision.decisionReference,
      decisionReference: decision.decisionReference,
      revision: decision.revision,
      optionSetVersion: 'v1',
      skillName: decision.skill,
      reasonCode: decision.reason,
      options: decision.options,
      ...decisionFacts(decision),
      ...(deliveryAttempt ? {
        deliveryAttemptId: deliveryAttempt.attemptId,
        deliveryAttemptKind: deliveryAttempt.kind,
      } : {}),
      dedupeKey: occurrenceDedupeKey(`skill-owner-decision-${decision.id.replace(/[^A-Za-z0-9-]/g, '-')}`, reminderOccurrence),
    }];
  }

  if (decisionsForNotification.length > 1) {
    // One occurrence is one digest message. It names a stable preview, the
    // first decisions in pending order up to the batch limit, each with its own
    // redacted facts and options, and declares how many this occurrence
    // reminded in total. Every claimed decision stays durable, pending, and
    // reminded; the ones outside the preview are listed in full through the
    // owner session. The message reference is fresh and never a decision
    // reference, so a reply that names no skill resolves nothing. A digest
    // carries no delivery attempt, so none is orphaned or acknowledged for
    // another.
    const named = decisionsForNotification.slice(0, SKILL_DECISION_BATCH_LIMIT);
    // A reminder digest is identified by its occurrence alone, so a changed
    // membership within one occurrence keeps its one delivery identity, the
    // same unsuffixed identity a single-message batch always had.
    const batchKey = crypto.createHash('sha256')
      .update(reminderOccurrence
        ? `occurrence\0${reminderOccurrence}`
        : decisionsForNotification.map((decision) => decision.id).sort().join('\0'))
      .digest('hex').slice(0, 32);
    return [{
      ...common,
      code: 'skill-owner-decision-batch',
      severity: 'warning',
      automationOutcome: 'failed',
      actionRequired: true,
      action: 'choose-skill-options',
      nextState: 'await-owner-decision',
      eventReference: opaqueReference(),
      optionSetVersion: 'v1',
      decisions: named.map((decision) => ({
        skillName: decision.skill,
        reasonCode: decision.reason,
        options: decision.options,
        decisionReference: decision.decisionReference,
        revision: decision.revision,
        ...decisionFacts(decision),
      })),
      pendingCount: decisionsForNotification.length,
      dedupeKey: occurrenceDedupeKey(`skill-owner-decision-batch-${batchKey}`, reminderOccurrence),
    }];
  }

  if (migration?.migrated === true && migration.pendingCount > 0) {
    const reference = opaqueReference();
    const migrationKey = migration.reference || reference;
    return [{
      ...common,
      code: 'skill-decision-summary',
      severity: 'warning',
      automationOutcome: 'failed',
      actionRequired: true,
      action: 'review-decisions',
      nextState: 'await-owner-decision',
      eventReference: reference,
      itemCount: migration.migratedCount || migration.pendingCount,
      resolvedCount: resolved.length,
      dedupeKey: `skill-decision-migration-${migrationKey.replace(/[^A-Za-z0-9-]/g, '').slice(-80)}`,
    }];
  }

  if (result.mutationDenied === true || raised.some((item) => item?.reasonCode === 'unsafe_source')) {
    return [{
      ...common,
      code: 'safety-hold',
      severity: 'warning',
      automationOutcome: 'safe-hold',
      actionRequired: false,
      action: 'none',
      nextState: 'continue-monitoring',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-safety-hold',
    }];
  }

  if (raised.length) {
    return [{
      ...common,
      code: 'recovery-failed',
      severity: 'warning',
      automationOutcome: 'failed',
      actionRequired: true,
      action: 'choose-recovery',
      nextState: 'continue-monitoring',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-owner-review',
    }];
  }

  if (resolved.length) {
    return [{
      ...common,
      code: 'resolution-complete',
      severity: 'info',
      automationOutcome: 'resolved',
      actionRequired: false,
      action: 'none',
      nextState: 'none',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-resolution',
    }];
  }

  if (repaired) {
    return [{
      ...common,
      code: 'repair-complete',
      severity: 'info',
      automationOutcome: 'repaired',
      actionRequired: false,
      action: 'none',
      nextState: 'none',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-repair',
    }];
  }

  return [];
}

// The first event of the occurrence. Kept for callers that render one message.
function eventFor(result, options = {}) {
  return eventsFor(result, options)[0] || null;
}

function claimPendingDecisionAttempts(result, {
  configPath,
  now,
  occurrenceKey = hourlyOccurrenceKey(now),
  claimReminder,
  claimReminders = decisionStore.claimReminders,
  claimDelivery = decisionStore.claimDelivery,
} = {}) {
  const claims = { reminderClaims: [], deliveryClaims: [], failureCause: null };
  const pendingItems = Array.isArray(result?.decisions?.pendingItems) ? result.decisions.pendingItems : [];
  if (pendingItems.length === 0 || !occurrenceKey) return claims;
  let statePath;
  try {
    statePath = decisionStatePath({ configPath });
  } catch (error) {
    claims.failureCause = failureCauseFor(error) || 'decision-claim-failed';
    return claims;
  }
  // No claim is an ordinary quiet outcome. A reminder claim that fails (a
  // stuck lock gate, a busy or unreadable ledger, a rejected occurrence)
  // claims nothing and changes nothing, so it becomes a named failure instead
  // of silence. Once a reminder is claimed, it is sent; a later delivery claim
  // failure leaves that reminder visible and the next occurrence reports it.
  let failed = null;
  const attempt = (claim, input, { reportFailure = true } = {}) => {
    try {
      return claim(input) || null;
    } catch (error) {
      if (reportFailure && !failed) failed = failureCauseFor(error) || 'decision-claim-failed';
      return null;
    }
  };
  // One occurrence reminds every pending decision exactly once, because the
  // contract is that an unresolved decision repeats every hour. The ledger
  // claims them in one transition, least recently reminded first. A retry
  // within the current occurrence claims nothing new and changes nothing, but
  // replays that occurrence's own membership so the still-pending decisions
  // can be rendered again under the same identity; the sender suppresses what
  // it already accepted. Rendering then names a bounded preview of the claimed
  // set with its total; the batch limit bounds the preview, never how many
  // decisions are claimed or kept pending.
  if (typeof claimReminder === 'function') {
    for (const decision of pendingItems) {
      if (failed) break;
      const claim = attempt(claimReminder, { statePath, decisionId: decision.id, occurrenceKey, now });
      if (claim) claims.reminderClaims.push(claim);
    }
  } else if (typeof claimReminders === 'function') {
    const batch = attempt(claimReminders, {
      statePath, decisionIds: pendingItems.map((decision) => decision.id), occurrenceKey, now,
    });
    claims.reminderClaims = Array.isArray(batch) ? batch.filter(Boolean) : [];
  }
  // Claimed reminders are always sent; a failure is reported only when
  // nothing was claimed.
  if (claims.reminderClaims.length === 0) {
    claims.failureCause = failed;
    return claims;
  }
  // The bounded initial/fallback outbox attempt is attached only when exactly
  // one decision is sent; it stays the acknowledgeable attempt for uncertain
  // transports and never gates later reminders. A batch claims none, and so
  // does a replay of the current occurrence: the attempt the occurrence
  // already claimed is still the acknowledgeable one, so re-rendering the same
  // occurrence must not spend the one bounded fallback.
  const replayed = claims.reminderClaims.every((claim) => claim?.replay === true);
  if (!replayed && claims.reminderClaims.length === 1 && typeof claimDelivery === 'function') {
    const delivery = attempt(claimDelivery, { statePath, decisionId: claims.reminderClaims[0].decisionId, now }, { reportFailure: false });
    if (delivery) claims.deliveryClaims.push(delivery);
  }
  return claims;
}

const OPERATOR_NOTIFICATION_TRANSPORT_VERSION = 'jarvos-operator-notification-transport/v1';

// One transport entry: the complete, self-describing shape a sender delivers.
// It is exactly what the single-message envelope has always been, so an entry
// taken out of `messages` is independently valid rather than a fragment that
// only means something next to its envelope.
function transportEntry(notification) {
  return {
    schema: OPERATOR_NOTIFICATION_TRANSPORT_VERSION,
    disposition: 'action-required',
    message: notification.output,
    event: notification.event,
    dedupeIdentity: notification.dedupeIdentity,
  };
}

// A digest occurrence is one message and declares no chunk positions. Legacy
// chunked batches handed to the envelope must still form a complete sequence:
// one occurrence's bounded messages must form a complete, consistent sequence.
// An individual message can only declare its own position, so the count being
// the same in every message and every position from 1 to that count appearing
// exactly once is a property the transport layer checks as it assembles the
// occurrence. A producer that cannot satisfy it fails closed rather than
// handing a sender a set that silently omits or repeats a message.
function assertChunkSequence(entries) {
  const positions = entries
    .filter((entry) => entry.event?.code === 'skill-owner-decision-batch' && entry.event.chunkCount !== undefined);
  if (positions.length === 0) return;
  const counts = new Set(positions.map((entry) => entry.event.chunkCount));
  const indexes = new Set(positions.map((entry) => entry.event.chunkIndex));
  const [count] = [...counts];
  if (counts.size !== 1 || indexes.size !== positions.length || positions.length !== count
    || [...indexes].some((index) => !Number.isSafeInteger(index) || index < 1 || index > count)) {
    throw new Error('scheduled repair chunk sequence is inconsistent');
  }
}

// One occurrence may need several bounded messages. The envelope keeps the
// original single-message fields, which always mirror the first message, so an
// older sender still delivers something safe and correlatable; `messages`
// carries every bounded message of this occurrence, each a complete transport
// entry with its own reviewed disposition, event, and dedupe identity, for a
// sender that ledgers and acknowledges per message.
function scheduledRepairCliEnvelope(notifications) {
  const list = (Array.isArray(notifications) ? notifications : [notifications])
    .filter((notification) => notification && notification.output !== NO_REPLY);
  if (list.length === 0) return NO_REPLY;
  const messages = list.map(transportEntry);
  assertChunkSequence(messages);
  return JSON.stringify({
    ...messages[0],
    messages,
  });
}

function scheduledRepairCliOutput(notification) {
  if (!notification || notification.output === NO_REPLY) return NO_REPLY;
  return JSON.stringify(transportEntry(notification));
}

const QUIET_NOTIFICATION = Object.freeze({
  event: null,
  disposition: 'quiet',
  output: NO_REPLY,
  statusMessage: null,
  dedupeIdentity: null,
});

function scheduledRepairNotifications(result, options = {}) {
  const events = eventsFor(result, options);
  if (events.length === 0) return [{ ...QUIET_NOTIFICATION }];
  return events.map((event) => ({ event, ...evaluateOperatorNotification(event) }));
}

function scheduledRepairNotification(result, options = {}) {
  return scheduledRepairNotifications(result, options)[0];
}

function scheduledRepairMessage(result, {
  announceConvergence = false,
  catalogStatus = null,
  now,
  notification = scheduledRepairNotification(result, { now }),
} = {}) {
  if (notification.output !== NO_REPLY) return notification.output;
  if (notification.statusMessage) return NO_REPLY;

  if (announceConvergence && result?.ok && result?.ran !== false) {
    const inventoryCount = Number(result.status?.counts?.skills || 0);
    const actionableCount = Number(result.status?.counts?.actionable || 0);
    const pairs = Array.isArray(catalogStatus?.pairs) ? catalogStatus.pairs : [];
    const cleanPairs = pairs.filter((pair) => pair?.status === 'clean').length;
    const parts = [
      `jarvOS skill sync is active: ${inventoryCount} skill${inventoryCount === 1 ? '' : 's'} inventoried`,
      `${cleanPairs}/${pairs.length} managed harness projection${pairs.length === 1 ? '' : 's'} clean`,
    ];
    parts.push(actionableCount
      ? `${actionableCount} item${actionableCount === 1 ? '' : 's'} need review; pending skill decisions are reminded hourly until you decide or pause them`
      : 'nothing needs your attention; future healthy runs stay quiet');
    return `${parts.join('; ')}.`;
  }

  return NO_REPLY;
}

// Every message this occurrence sends, in order. A quiet occurrence sends none;
// a convergence announcement is a single message.
function scheduledRepairMessages(result, {
  announceConvergence = false,
  catalogStatus = null,
  now,
  notifications = scheduledRepairNotifications(result, { now }),
} = {}) {
  const direct = notifications.filter((notification) => notification.output !== NO_REPLY);
  if (direct.length > 0) return direct.map((notification) => notification.output);
  const single = scheduledRepairMessage(result, { announceConvergence, catalogStatus, notification: notifications[0] });
  return single === NO_REPLY ? [] : [single];
}

function runScheduledRepair({
  configPath,
  announceConvergence = false,
  repair = autonomousRepairOperator,
  readStatus = statusOperator,
  claimReminder,
  claimReminders = decisionStore.claimReminders,
  claimDelivery = decisionStore.claimDelivery,
  now = new Date().toISOString(),
  occurrenceKey = hourlyOccurrenceKey(now),
} = {}) {
  const result = repair({ configPath });
  // A failed run renders recovery instead, so it must not consume a reminder
  // or a delivery attempt that no message would carry.
  const claims = result?.ok && result?.ran !== false
    ? claimPendingDecisionAttempts(result, { configPath, now, occurrenceKey, claimReminder, claimReminders, claimDelivery })
    : { reminderClaims: [], deliveryClaims: [], failureCause: null };
  const catalogStatus = announceConvergence && result?.ok && result?.ran !== false
    ? readStatus({ configPath })
    : null;
  const notifications = scheduledRepairNotifications(result, { now, occurrenceKey, ...claims });
  const messages = scheduledRepairMessages(result, { announceConvergence, catalogStatus, notifications });
  return {
    result,
    notifications,
    messages,
    // The first message keeps the original single-message shape.
    notification: notifications[0],
    message: messages[0] || NO_REPLY,
  };
}

module.exports = {
  OPERATOR_NOTIFICATION_TRANSPORT_VERSION,
  eventFor,
  eventsFor,
  failureCauseFor,
  hourlyOccurrenceKey,
  claimPendingDecisionAttempts,
  scheduledRepairCliEnvelope,
  scheduledRepairCliOutput,
  scheduledRepairMessage,
  scheduledRepairMessages,
  scheduledRepairNotification,
  scheduledRepairNotifications,
  runScheduledRepair,
};
