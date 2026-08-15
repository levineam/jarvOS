'use strict';

const { autonomousRepairOperator, statusOperator } = require('./operator');

function countByReason(items = []) {
  const counts = new Map();
  for (const item of items) {
    const reason = typeof item?.reasonCode === 'string' && /^[a-z0-9_]{1,64}$/.test(item.reasonCode)
      ? item.reasonCode
      : 'needs_owner_input';
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');
}

function scheduledRepairMessage(result, { announceConvergence = false, catalogStatus = null } = {}) {
  if (!result?.ok) return 'jarvOS skill sync needs attention: scheduled repair did not complete.';
  if (result.ran === false) {
    return result.reason === 'inventory_disabled'
      ? 'jarvOS skill sync needs attention: machine-wide inventory is disabled.'
      : 'jarvOS skill sync needs attention: the scheduled repair did not run.';
  }
  if (result.mutationDenied === true) {
    const count = Number(result.status?.counts?.actionable || 0);
    return `jarvOS skill sync needs attention: the inventory was incomplete, so no files were changed${count ? `; ${count} item${count === 1 ? '' : 's'} require review` : ''}.`;
  }

  const raised = Array.isArray(result.attention?.raised) ? result.attention.raised : [];
  const resolved = Array.isArray(result.attention?.resolved) ? result.attention.resolved : [];
  const repaired = result.reconciliation?.repaired === true
    ? (Array.isArray(result.reconciliation.applied)
      ? result.reconciliation.applied.filter((item) => item?.applied !== false).length
      : 0)
    : 0;

  if (announceConvergence) {
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

  if (raised.length || resolved.length || repaired) {
    const parts = [];
    if (raised.length) {
      const reasons = countByReason(raised);
      parts.push(`${raised.length} new item${raised.length === 1 ? '' : 's'} need review${reasons ? `: ${reasons}` : ''}`);
    }
    if (resolved.length) parts.push(`${resolved.length} prior item${resolved.length === 1 ? '' : 's'} resolved`);
    if (repaired) parts.push(`${repaired} managed projection${repaired === 1 ? '' : 's'} repaired`);
    return `jarvOS skill sync: ${parts.join('; ')}.`;
  }

  return 'NO_REPLY';
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
  return {
    result,
    message: scheduledRepairMessage(result, { announceConvergence, catalogStatus }),
  };
}

module.exports = { countByReason, scheduledRepairMessage, runScheduledRepair };
