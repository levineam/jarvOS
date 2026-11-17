'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ALERT_CHANNELS = Object.freeze(['chief-of-staff', 'telegram']);
const DEFAULT_ALERT_SETTINGS = Object.freeze({ primary: 'chief-of-staff', escalation: 'telegram' });

function load(configPath) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { source: 'default' };
    if (error instanceof SyntaxError) return { source: 'invalid' };
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { source: 'invalid' };
  const valid = ALERT_CHANNELS.includes(value.primary) && value.escalation === 'telegram';
  return { value, source: valid ? 'file' : 'invalid' };
}

function configFile(configPath) {
  return configPath ?? path.join(os.homedir(), '.jarvos', 'alerts.json');
}

function readAlertSettings({ configPath } = {}) {
  const { value = {}, source } = load(configFile(configPath));
  return {
    primary: ALERT_CHANNELS.includes(value.primary) ? value.primary : DEFAULT_ALERT_SETTINGS.primary,
    escalation: value.escalation === 'telegram' ? value.escalation : DEFAULT_ALERT_SETTINGS.escalation,
    source,
  };
}

function writeAlertSettings({ primary, escalation }, { configPath, updatedBy = 'unknown', now = new Date() } = {}) {
  if (!ALERT_CHANNELS.includes(primary)) throw new Error('Invalid primary alert channel');
  if (escalation !== 'telegram') throw new Error('Invalid escalation alert channel');
  if (typeof updatedBy !== 'string') throw new Error('updatedBy must be a string');
  const file = configFile(configPath);
  const existing = load(file);
  const result = {
    ...(existing.source === 'file' ? existing.value : {}),
    version: 1, primary, escalation, updatedAt: new Date(now).toISOString(), updatedBy,
  };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, `${JSON.stringify(result, null, 2)}\n`);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return result;
}

function resetAlertSettings(opts = {}) {
  return writeAlertSettings({ primary: 'chief-of-staff', escalation: readAlertSettings(opts).escalation }, opts);
}

async function deliverRoutineAlert({ title, text }, { configPath, inboxDir, now = new Date(), sendTelegram } = {}) {
  if (typeof title !== 'string' || !title.trim() || typeof text !== 'string' || !text.trim()) {
    throw new TypeError('title and text must be non-empty strings');
  }
  const channel = readAlertSettings({ configPath }).primary;
  if (channel === 'telegram') {
    if (!sendTelegram) return { sent: false, channel, error: 'telegram-sender-missing' };
    const result = await sendTelegram(text);
    return { sent: result?.sent !== false, channel, result };
  }
  if (!inboxDir) return { sent: false, channel, error: 'inbox-dir-missing' };
  const date = new Date(now);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const file = path.join(inboxDir, `${day}.md`);
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.appendFileSync(file, `\nRoutine result: ${title}\n${text.trim()}\n${date.toISOString()}\n`);
  return { sent: true, channel, path: file };
}

module.exports = { ALERT_CHANNELS, DEFAULT_ALERT_SETTINGS, readAlertSettings, writeAlertSettings, resetAlertSettings, deliverRoutineAlert };
