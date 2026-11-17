'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readAlertSettings, writeAlertSettings, resetAlertSettings, deliverRoutineAlert } = require('../src/index.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, configPath: path.join(dir, 'config', 'alerts.json') };
}

const defaults = { primary: 'chief-of-staff', escalation: 'telegram' };
const now = new Date(2025, 0, 2, 12, 0, 0);

test('reads missing, valid and invalid settings with field defaults', (t) => {
  const { configPath } = fixture(t);
  assert.deepEqual(readAlertSettings({ configPath }), { ...defaults, source: 'default' });
  fs.mkdirSync(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify({ primary: 'telegram', escalation: 'telegram' }));
  assert.deepEqual(readAlertSettings({ configPath }), { primary: 'telegram', escalation: 'telegram', source: 'file' });
  fs.writeFileSync(configPath, '{');
  assert.deepEqual(readAlertSettings({ configPath }), { ...defaults, source: 'invalid' });
  fs.writeFileSync(configPath, JSON.stringify({ primary: 'wrong', escalation: 'telegram' }));
  assert.deepEqual(readAlertSettings({ configPath }), { ...defaults, source: 'invalid' });
  fs.writeFileSync(configPath, JSON.stringify({ primary: 'telegram', escalation: 'wrong' }));
  assert.deepEqual(readAlertSettings({ configPath }), { primary: 'telegram', escalation: 'telegram', source: 'invalid' });
  fs.writeFileSync(configPath, '[]');
  assert.equal(readAlertSettings({ configPath }).source, 'invalid');
  assert.throws(() => readAlertSettings({ configPath: path.dirname(configPath) }));
});

test('writes atomically, creates the directory, preserves extras and resets', (t) => {
  const { configPath } = fixture(t);
  const opts = { configPath, now, updatedBy: 'test' };
  const written = writeAlertSettings({ primary: 'telegram', escalation: 'telegram' }, opts);
  assert.deepEqual(written, { version: 1, primary: 'telegram', escalation: 'telegram', updatedAt: now.toISOString(), updatedBy: 'test' });
  assert.deepEqual(fs.readdirSync(path.dirname(configPath)), ['alerts.json']);
  fs.writeFileSync(configPath, JSON.stringify({ ...written, extra: { keep: true } }));
  assert.deepEqual(resetAlertSettings(opts), { ...written, primary: 'chief-of-staff', extra: { keep: true } });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).extra, { keep: true });
  assert.throws(() => writeAlertSettings({ primary: 'bad', escalation: 'telegram' }, opts), /primary/);
  assert.throws(() => writeAlertSettings({ primary: 'telegram', escalation: 'bad' }, opts), /escalation/);
  fs.writeFileSync(configPath, '{');
  assert.deepEqual(writeAlertSettings(defaults, opts), { version: 1, ...defaults, updatedAt: now.toISOString(), updatedBy: 'test' });
});

test('delivers to the local dated inbox or reports a missing inbox', async (t) => {
  const { dir, configPath } = fixture(t);
  const alert = { title: 'Example', text: '  All clear.  ' };
  assert.deepEqual(await deliverRoutineAlert(alert, { configPath }), { sent: false, channel: 'chief-of-staff', error: 'inbox-dir-missing' });
  const inboxDir = path.join(dir, 'inbox');
  const result = await deliverRoutineAlert(alert, { configPath, inboxDir, now });
  assert.deepEqual(result, { sent: true, channel: 'chief-of-staff', path: path.join(inboxDir, '2025-01-02.md') });
  assert.equal(fs.statSync(result.path).mode & 0o077, 0);
  assert.equal(fs.readFileSync(result.path, 'utf8'), `\nRoutine result: Example\nAll clear.\n${now.toISOString()}\n`);
  await assert.rejects(deliverRoutineAlert({ title: ' ', text: 'x' }, { configPath }), TypeError);
  await assert.rejects(deliverRoutineAlert({ title: 'x', text: '' }, { configPath }), TypeError);
});

test('delegates Telegram delivery and propagates sender errors', async (t) => {
  const { configPath } = fixture(t);
  writeAlertSettings({ primary: 'telegram', escalation: 'telegram' }, { configPath });
  const alert = { title: 'Example', text: 'Message' };
  assert.deepEqual(await deliverRoutineAlert(alert, { configPath }), { sent: false, channel: 'telegram', error: 'telegram-sender-missing' });
  const result = { sent: false };
  assert.deepEqual(await deliverRoutineAlert(alert, { configPath, sendTelegram: async (text) => { assert.equal(text, 'Message'); return result; } }), { sent: false, channel: 'telegram', result });
  assert.equal((await deliverRoutineAlert(alert, { configPath, sendTelegram: async () => ({}) })).sent, true);
  assert.equal((await deliverRoutineAlert(alert, { configPath, sendTelegram: async () => false })).sent, false);
  await assert.rejects(deliverRoutineAlert(alert, { configPath, sendTelegram: async () => { throw new Error('failed'); } }), /failed/);
});
