'use strict';

/**
 * OpenClaw runtime wiring metadata for the journal-maintenance job.
 *
 * The job defaults to 12:01 AM local time (`1 0 * * *`) and always includes
 * an explicit timezone so runtimes do not accidentally interpret the cron as UTC.
 */

const path = require('path');
const {
  getClawdDir,
  getJournalMaintenanceSchedule,
  getJournalMaintenanceTimeZone,
} = require('../../../bridge/config/jarvos-paths.js');

const JOB_NAME = 'journal-maintenance';
const RELATIVE_SCRIPT_PATH = path.join('scripts', 'journal-maintenance.js');

function buildJournalMaintenanceJobConfig(overrides = {}) {
  const schedule = overrides.schedule || getJournalMaintenanceSchedule();
  const timezone = overrides.timezone || overrides.timeZone || getJournalMaintenanceTimeZone();
  const clawdDir = overrides.clawdDir || getClawdDir();
  const scriptPath = overrides.scriptPath || path.join(clawdDir, RELATIVE_SCRIPT_PATH);

  return {
    name: JOB_NAME,
    schedule,
    timezone,
    command: `node "${scriptPath}"`,
  };
}

module.exports = {
  JOB_NAME,
  RELATIVE_SCRIPT_PATH,
  buildJournalMaintenanceJobConfig,
};
