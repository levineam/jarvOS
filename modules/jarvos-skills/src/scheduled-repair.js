'use strict';

const crypto = require('node:crypto');
const { autonomousRepairOperator, statusOperator } = require('./operator');
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
  evaluateOperatorNotification,
} = operatorNotification;

function opaqueReference() {
  return crypto.randomBytes(24).toString('base64url');
}

function observedAt(result, now) {
  const value = result?.status?.observedAt;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : now;
}

function eventFor(result, { now = new Date().toISOString() } = {}) {
  const raised = Array.isArray(result?.attention?.raised) ? result.attention.raised : [];
  const resolved = Array.isArray(result?.attention?.resolved) ? result.attention.resolved : [];
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

  if (!result?.ok || result?.ran === false) {
    return {
      ...common,
      code: 'recovery-failed',
      severity: 'error',
      automationOutcome: 'failed',
      actionRequired: true,
      action: 'choose-recovery',
      nextState: 'continue-monitoring',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-recovery',
    };
  }

  if (result.mutationDenied === true || raised.some((item) => item?.reasonCode === 'unsafe_source')) {
    return {
      ...common,
      code: 'safety-hold',
      severity: 'warning',
      automationOutcome: 'safe-hold',
      actionRequired: false,
      action: 'none',
      nextState: 'continue-monitoring',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-safety-hold',
    };
  }

  if (raised.length) {
    return {
      ...common,
      code: 'recovery-failed',
      severity: 'warning',
      automationOutcome: 'failed',
      actionRequired: true,
      action: 'choose-recovery',
      nextState: 'continue-monitoring',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-owner-review',
    };
  }

  if (resolved.length) {
    return {
      ...common,
      code: 'resolution-complete',
      severity: 'info',
      automationOutcome: 'resolved',
      actionRequired: false,
      action: 'none',
      nextState: 'none',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-resolution',
    };
  }

  if (repaired) {
    return {
      ...common,
      code: 'repair-complete',
      severity: 'info',
      automationOutcome: 'repaired',
      actionRequired: false,
      action: 'none',
      nextState: 'none',
      eventReference: opaqueReference(),
      dedupeKey: 'scheduled-repair-repair',
    };
  }

  return null;
}

const OPERATOR_NOTIFICATION_TRANSPORT_VERSION = 'jarvos-operator-notification-transport/v1';

function scheduledRepairCliOutput(notification) {
  if (!notification || notification.output === NO_REPLY) return NO_REPLY;
  const event = notification.event;
  return JSON.stringify({
    schema: OPERATOR_NOTIFICATION_TRANSPORT_VERSION,
    disposition: 'action-required',
    message: notification.output,
    event,
    dedupeIdentity: notification.dedupeIdentity,
  });
}

function scheduledRepairNotification(result, options = {}) {
  const event = eventFor(result, options);
  return event ? { event, ...evaluateOperatorNotification(event) } : {
    event: null,
    disposition: 'quiet',
    output: NO_REPLY,
    statusMessage: null,
    dedupeIdentity: null,
  };
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
      ? `${actionableCount} item${actionableCount === 1 ? '' : 's'} need review; future repeats stay quiet`
      : 'nothing needs your attention; future healthy runs stay quiet');
    return `${parts.join('; ')}.`;
  }

  return NO_REPLY;
}

function runScheduledRepair({
  configPath,
  announceConvergence = false,
  repair = autonomousRepairOperator,
  readStatus = statusOperator,
} = {}) {
  const result = repair({ configPath });
  const catalogStatus = announceConvergence && result?.ok && result?.ran !== false
    ? readStatus({ configPath })
    : null;
  const notification = scheduledRepairNotification(result);
  return {
    result,
    notification,
    message: scheduledRepairMessage(result, { announceConvergence, catalogStatus, notification }),
  };
}

module.exports = {
  OPERATOR_NOTIFICATION_TRANSPORT_VERSION,
  eventFor,
  scheduledRepairCliOutput,
  scheduledRepairMessage,
  scheduledRepairNotification,
  runScheduledRepair,
};
