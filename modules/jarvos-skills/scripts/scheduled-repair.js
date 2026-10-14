#!/usr/bin/env node
'use strict';

const {
  failureCauseFor,
  hourlyOccurrenceKey,
  scheduledRepairCliEnvelope,
  scheduledRepairCliOutput,
  scheduledRepairNotification,
  runScheduledRepair,
} = require('../src/scheduled-repair');

function parseArgs(argv) {
  const options = { configPath: undefined, announceConvergence: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      if (!argv[index + 1]) throw new Error('--config requires a path');
      options.configPath = argv[++index];
    } else if (arg === '--announce-convergence') {
      options.announceConvergence = true;
    } else if (arg === '--occurrence') {
      // The external scheduler names its occurrence so a catch-up or retry keeps
      // one reminder identity. Only the length is bounded here; the decision
      // store validates the key where it is claimed.
      const value = argv[index + 1];
      if (!value || value.startsWith('-') || value.length > 64) throw new Error('--occurrence requires a key');
      options.occurrenceKey = argv[++index];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

// A thrown failure keeps only its reviewed cause and its occurrence identity;
// the error message, paths, and stack never reach stdout. An unknown failure
// renders the generic recovery.
function failureOutput(error, { occurrenceKey, now = new Date().toISOString() } = {}) {
  const notification = scheduledRepairNotification({ ok: false, ran: false }, {
    now,
    failureCause: failureCauseFor(error),
    occurrenceKey: occurrenceKey || hourlyOccurrenceKey(now),
  });
  return scheduledRepairCliOutput(notification);
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write('Usage: scheduled-repair.js [--config PATH] [--announce-convergence] [--occurrence KEY]\n');
      return 0;
    }
    const { notifications, notification, result } = runScheduledRepair(options);
    process.stdout.write(`${scheduledRepairCliEnvelope(notifications)}\n`);
    return result?.ok && !notification?.event?.failureCause ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${failureOutput(error, { occurrenceKey: options?.occurrenceKey })}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, main, failureOutput };
