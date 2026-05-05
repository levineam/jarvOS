'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PATHS_MODULE = path.resolve(__dirname, '../bridge/config/jarvos-paths.js');
const JOB_MODULE = path.resolve(__dirname, '../adapters/openclaw/src/journal-maintenance-job.js');

const ENV_KEYS = [
  'JARVOS_CLAWD_DIR',
  'CLAWD_DIR',
  'JARVOS_TIMEZONE',
  'TZ',
  'JARVOS_JOURNAL_MAINTENANCE_SCHEDULE',
  'JARVOS_JOURNAL_MAINTENANCE_TIMEZONE',
];

function withEnv(vars, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const { resetConfigCache } = require(PATHS_MODULE);
  resetConfigCache();

  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigCache();
  }
}

function makeClawdConfig(config = {}, userMd = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-schedule-'));
  fs.writeFileSync(path.join(tmpDir, 'jarvos.config.json'), JSON.stringify(config));
  if (userMd !== null) fs.writeFileSync(path.join(tmpDir, 'USER.md'), userMd);
  return tmpDir;
}

test('journal-maintenance job defaults to 12:01 AM in configured local timezone', () => {
  const tmpDir = makeClawdConfig({ timeZone: 'Europe/Berlin' });

  try {
    withEnv({ JARVOS_CLAWD_DIR: tmpDir }, () => {
      const {
        getJournalMaintenanceSchedule,
        getJournalMaintenanceTimeZone,
      } = require(PATHS_MODULE);
      const { buildJournalMaintenanceJobConfig } = require(JOB_MODULE);

      assert.equal(getJournalMaintenanceSchedule(), '1 0 * * *');
      assert.equal(getJournalMaintenanceTimeZone(), 'Europe/Berlin');

      const job = buildJournalMaintenanceJobConfig({ clawdDir: '/opt/jarvos' });
      assert.equal(job.name, 'journal-maintenance');
      assert.equal(job.schedule, '1 0 * * *');
      assert.equal(job.timezone, 'Europe/Berlin');
      assert.match(job.command, /journal-maintenance\.js"$/);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('journal-maintenance preserves explicit schedule and timezone overrides', () => {
  const tmpDir = makeClawdConfig({
    timeZone: 'Europe/Berlin',
    jobs: {
      journalMaintenance: {
        schedule: '17 4 * * *',
        timezone: 'Asia/Tokyo',
      },
    },
  });

  try {
    withEnv({ JARVOS_CLAWD_DIR: tmpDir }, () => {
      const {
        getJournalMaintenanceSchedule,
        getJournalMaintenanceTimeZone,
      } = require(PATHS_MODULE);
      const { buildJournalMaintenanceJobConfig } = require(JOB_MODULE);

      assert.equal(getJournalMaintenanceSchedule(), '17 4 * * *');
      assert.equal(getJournalMaintenanceTimeZone(), 'Asia/Tokyo');

      const job = buildJournalMaintenanceJobConfig({
        schedule: '42 3 * * *',
        timeZone: 'America/Los_Angeles',
        scriptPath: '/custom/journal-maintenance.js',
      });
      assert.equal(job.schedule, '42 3 * * *');
      assert.equal(job.timezone, 'America/Los_Angeles');
      assert.equal(job.command, 'node "/custom/journal-maintenance.js"');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('journal-maintenance timezone resolves from USER.md before UTC fallback', () => {
  const tmpDir = makeClawdConfig({}, '# USER.md\n\n## Timezone\nPacific/Auckland\n');

  try {
    withEnv({ JARVOS_CLAWD_DIR: tmpDir }, () => {
      const { getJournalMaintenanceTimeZone } = require(PATHS_MODULE);
      assert.equal(getJournalMaintenanceTimeZone(), 'Pacific/Auckland');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('journal-maintenance rejects invalid explicit timezone overrides', () => {
  const tmpDir = makeClawdConfig({
    timeZone: 'Europe/Berlin',
    jobs: {
      journalMaintenance: {
        timezone: 'Not/A_Timezone',
      },
    },
  });

  try {
    withEnv({ JARVOS_CLAWD_DIR: tmpDir }, () => {
      const { getJournalMaintenanceTimeZone } = require(PATHS_MODULE);
      assert.equal(getJournalMaintenanceTimeZone(), 'Europe/Berlin');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('journal-maintenance timezone falls back to UTC when runtime/user timezone is unavailable', () => {
  const tmpDir = makeClawdConfig({});
  const originalDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function DateTimeFormatWithoutTimeZone() {
    return { resolvedOptions: () => ({}) };
  };

  try {
    withEnv({ JARVOS_CLAWD_DIR: tmpDir }, () => {
      const { getJournalMaintenanceTimeZone } = require(PATHS_MODULE);
      assert.equal(getJournalMaintenanceTimeZone(), 'UTC');
    });
  } finally {
    Intl.DateTimeFormat = originalDateTimeFormat;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
