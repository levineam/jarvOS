'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs } = require('../scripts/journal-health.js');

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
