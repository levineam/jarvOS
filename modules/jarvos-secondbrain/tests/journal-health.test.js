'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs } = require('../scripts/journal-health.js');
const { buildAlarmMessage, main: alarmMain, readIndexVisibility, readReceiptStateForDate } = require('../scripts/journal-health-alarm.js');

test('journal-health accepts only read-only date and JSON options', () => {
  assert.deepEqual(parseArgs(['--json', '--date=today']), { json: true, date: 'today' });
  assert.throws(() => parseArgs(['--date=2026-08-02']), /only supports today/);
  assert.throws(() => parseArgs(['--repair']), /Unknown option/);
});

test('journal health and ensure commands return nonzero on invalid configuration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-cli-exit-'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  for (const key of Object.keys(env)) {
    if (/^(?:JARVOS_|CLAWD_DIR$|JOURNAL_DIR$|VAULT_NOTES_DIR$|TZ$)/.test(key)) delete env[key];
  }
  const healthScript = path.resolve(__dirname, '../scripts/journal-health.js');
  const ensureScript = path.resolve(__dirname, '../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
  try {
    const health = spawnSync(process.execPath, [healthScript, '--json'], { encoding: 'utf8', env });
    const ensure = spawnSync(process.execPath, [ensureScript, '--create-if-missing', '--json'], { encoding: 'utf8', env });
    assert.equal(health.status, 1, health.stderr);
    assert.equal(ensure.status, 1, ensure.stderr);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('journal-health exits nonzero when configured canonical journal is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-cli-missing-'));
  const journal = path.join(home, 'vault', 'Journal');
  const env = {
    ...process.env,
    HOME: home,
    JARVOS_JOURNAL_DIR: journal,
    JARVOS_TIMEZONE: 'UTC',
  };
  const healthScript = path.resolve(__dirname, '../scripts/journal-health.js');
  try {
    const health = spawnSync(process.execPath, [healthScript, '--json'], { encoding: 'utf8', env });
    assert.equal(health.status, 1, health.stderr);
    assert.equal(JSON.parse(health.stdout).canonical.status, 'missing');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('creation CLI records the host scheduler provenance contract', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-cli-provenance-'));
  const journal = path.join(home, 'vault', 'Journal');
  const env = {
    ...process.env,
    HOME: home,
    JARVOS_JOURNAL_DIR: journal,
    JARVOS_TIMEZONE: 'UTC',
    OPENCLAW_SOURCE_REVISION: 'source-1',
    OPENCLAW_RUNTIME_REVISION: 'runtime-1',
    OPENCLAW_EXTERNAL_CRON_RUN_ID: 'journal-maintenance:2026-08-08:primary',
    OPENCLAW_EXTERNAL_CRON_EXECUTION_PROVENANCE: 'scheduled',
  };
  const ensureScript = path.resolve(__dirname, '../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
  try {
    const ensure = spawnSync(process.execPath, [ensureScript, '--create-if-missing', '--json'], { encoding: 'utf8', env });
    assert.equal(ensure.status, 0, ensure.stderr);
    assert.equal(JSON.parse(ensure.stdout).results[0].provenance.trigger, 'scheduled');
    const sentinelPath = path.join(home, 'vault', '.jarvos', 'journal-maintenance', 'receipts', '2026-08-08.receipt');
    assert.equal(JSON.parse(fs.readFileSync(sentinelPath, 'utf8')).trigger, 'scheduled');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('journal-health-alarm distinguishes listed, stale, and unmanaged visibility', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-alarm-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(journalDir, 'Journaling.md'), '![[Journal/2026-08-08.md]]\n', 'utf8');
    assert.equal(readIndexVisibility(journalDir, '2026-08-08').status, 'listed');
    assert.equal(readIndexVisibility(journalDir, '2026-08-09').status, 'not-listed');
    fs.writeFileSync(path.join(journalDir, 'Journaling.md'), '# authored index\n', 'utf8');
    assert.equal(readIndexVisibility(journalDir, '2026-08-08').status, 'unmanaged');
    assert.equal(readIndexVisibility(journalDir, '2026-08-08', 'Other.md', fs, false).status, 'not-maintained');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('journal-health-alarm stays quiet only when capture and visibility both pass', () => {
  const healthy = {
    date: '2026-08-08',
    timeZone: 'UTC',
    canonical: { status: 'healthy' },
    receipts: [{ outcome: 'healthy-existing', trigger: 'scheduled' }],
  };
  assert.equal(buildAlarmMessage({ ...healthy, visibility: { status: 'listed', fileName: 'Journaling.md' } }), 'NO_REPLY');
  assert.match(buildAlarmMessage({ ...healthy, visibility: { status: 'not-listed', fileName: 'Journaling.md' } }), /not listed/);
  assert.match(buildAlarmMessage({ ...healthy, visibility: { status: 'unmanaged', fileName: 'Journaling.md' } }), /does not manage/);
  assert.match(buildAlarmMessage({ ...healthy, receipts: [], visibility: { status: 'listed' } }), /no healthy scheduled receipt/);
  assert.match(buildAlarmMessage({
    ...healthy,
    receipts: [{ outcome: 'healthy-existing' }],
    visibility: { status: 'listed' },
  }), /no healthy scheduled receipt/);
  assert.match(buildAlarmMessage({
    ...healthy,
    receipts: [{ outcome: 'healthy-existing', trigger: 'forced' }],
    visibility: { status: 'listed' },
  }), /no healthy scheduled receipt/);
  assert.match(buildAlarmMessage({ ...healthy, receiptStatus: 'unavailable', visibility: { status: 'listed' } }), /receipt evidence.*unavailable/);
  assert.match(buildAlarmMessage({ ...healthy, visibility: { status: 'unavailable', fileName: 'Journaling.md' } }), /visibility is unknown/);
  assert.match(buildAlarmMessage({ date: healthy.date, timeZone: healthy.timeZone, canonical: { status: 'missing' }, receipts: [] }), /needs investigation/);
});

test('journal-health-alarm reads one date-addressable receipt and reports its real state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-alarm-receipt-'));
  const journalDir = path.join(root, 'Journal');
  const env = { ...process.env, JARVOS_JOURNAL_DIR: journalDir, JARVOS_TIMEZONE: 'UTC', JOURNAL_HEALTH_ALARM_DATE: '2026-08-08' };
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, '2026-08-08.md'), '## 📝 Notes\n- today\n', 'utf8');
    fs.writeFileSync(path.join(journalDir, 'Journaling.md'), '![[Journal/2026-08-08.md]]\n', 'utf8');
    const receiptDir = path.join(root, '.jarvos', 'journal-maintenance', 'receipts');
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(path.join(receiptDir, '2026-08-08.receipt'), JSON.stringify({ date: '2026-08-08', outcome: 'created', trigger: 'scheduled' }), 'utf8');
    for (let i = 0; i < 50; i += 1) fs.writeFileSync(path.join(receiptDir, `history-${i}.json`), '{malformed', 'utf8');

    const state = readReceiptStateForDate(journalDir, '2026-08-08');
    assert.equal(state.status, 'available');
    assert.deepEqual(state.receipts.map((receipt) => receipt.outcome), ['created']);
    assert.equal(alarmMain([], env), 'NO_REPLY');

    fs.writeFileSync(path.join(receiptDir, '2026-08-08.receipt'), JSON.stringify({ date: '2026-08-08', outcome: 'receipt-failed' }), 'utf8');
    assert.match(alarmMain([], env), /no healthy scheduled receipt/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
