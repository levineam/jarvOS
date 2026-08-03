#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveJournalConfig, isValidTimezone } = require('../../../bridge/config');

const SUCCESS_OUTCOMES = new Set(['created', 'healthy-existing', 'created-concurrently', 'recovered-after-unrecorded-create']);

function localDate(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function safeProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(['source', 'runtime', 'runId']
    .filter((key) => typeof value[key] === 'string' && value[key].trim())
    .map((key) => [key, value[key].trim()]));
}

function loadTemplateConfig() {
  return require('./journal-maintenance.js').loadConfig();
}

function renderScaffold(date, config) {
  const api = require('./journal-maintenance.js');
  return api.renderJournal(date, config, api.normalizeSections('', date, config));
}

function receiptDirectory(journalDir) {
  return path.join(path.dirname(journalDir), '.jarvos', 'journal-maintenance', 'receipts');
}

function receiptFilesForDate(journalDir, date, fsImpl = fs) {
  try {
    return fsImpl.readdirSync(receiptDirectory(journalDir))
      .filter((name) => name.endsWith('.json'))
      .filter((name) => {
        try { return JSON.parse(fsImpl.readFileSync(path.join(receiptDirectory(journalDir), name), 'utf8')).date === date; } catch { return false; }
      });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeReceipt({ journalDir, date, timeZone, outcome, before, after, provenance, fsImpl = fs, now = new Date() }) {
  const directory = receiptDirectory(journalDir);
  fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${new Date(now).toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(4).toString('hex')}.json`);
  const receipt = {
    version: 1,
    date,
    timezone: timeZone,
    outcome,
    healthBefore: before.status,
    healthAfter: after.status,
    provenance: safeProvenance(provenance),
  };
  const temporary = `${file}.tmp`;
  try {
    fsImpl.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
    fsImpl.renameSync(temporary, file);
  } catch (error) {
    try { fsImpl.unlinkSync(temporary); } catch { /* cleanup only */ }
    throw error;
  }
  return receipt;
}

function canonicalHealth(journalPath, fsImpl = fs) {
  try {
    const stat = fsImpl.lstatSync(journalPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'invalid' };
    const content = fsImpl.readFileSync(journalPath, 'utf8');
    return { status: /##\s+/.test(content) ? 'healthy' : 'invalid' };
  } catch (error) {
    return error.code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid' };
  }
}

function detectWriterGuard(journalDir, fsImpl = fs) {
  const dailyNotes = path.join(path.dirname(journalDir), '.obsidian', 'daily-notes.json');
  try {
    if (fsImpl.existsSync(dailyNotes)) return { ok: false, reason: 'configured daily-note writer' };
  } catch { return { ok: false, reason: 'writer configuration unreadable' }; }
  return { ok: true };
}

function resolveInputs(options) {
  if (options.journalDir && options.timeZone) {
    if (!isValidTimezone(options.timeZone)) throw new Error('Journal mutation has an invalid configured IANA timezone');
    return { journalDir: path.resolve(options.journalDir), timeZone: options.timeZone };
  }
  return resolveJournalConfig({ config: options.config, configPath: options.configPath, env: options.env, homeDir: options.homeDir });
}

function ensureTodayJournal(options = {}) {
  const fsImpl = options.fs || fs;
  const provenance = safeProvenance(options.provenance);
  let inputs;
  try { inputs = resolveInputs(options); } catch (error) {
    return { ok: false, outcome: 'invalid-configuration', reason: error.message, provenance };
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const date = localDate(now, inputs.timeZone);
  const journalPath = path.join(inputs.journalDir, `${date}.md`);
  const before = canonicalHealth(journalPath, fsImpl);
  const guard = options.writerGuard || detectWriterGuard(inputs.journalDir, fsImpl);
  const finish = (outcome, after) => {
    try {
      if (typeof options.beforeReceipt === 'function') options.beforeReceipt();
      writeReceipt({ journalDir: inputs.journalDir, date, timeZone: inputs.timeZone, outcome, before, after, provenance, fsImpl, now });
      return { ok: SUCCESS_OUTCOMES.has(outcome), outcome, date, provenance };
    } catch (error) {
      return { ok: false, outcome: 'receipt-failed', date, reason: error.message, provenance };
    }
  };
  if (!guard.ok) return finish('blocked-writer-conflict', before);
  if (before.status !== 'missing') {
    const prior = receiptFilesForDate(inputs.journalDir, date, fsImpl);
    return finish(before.status === 'healthy' ? (prior.length ? 'healthy-existing' : 'recovered-after-unrecorded-create') : 'invalid-existing', before);
  }
  let scaffold;
  try { scaffold = renderScaffold(date, options.templateConfig || loadTemplateConfig()); } catch (error) {
    return { ok: false, outcome: 'failed', date, reason: error.message, provenance };
  }
  try {
    fsImpl.mkdirSync(inputs.journalDir, { recursive: true });
    fsImpl.writeFileSync(journalPath, scaffold, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') return { ok: false, outcome: 'failed', date, reason: error.message, provenance };
    const winner = canonicalHealth(journalPath, fsImpl);
    return finish(winner.status === 'healthy' ? 'created-concurrently' : 'invalid-existing', winner);
  }
  const after = canonicalHealth(journalPath, fsImpl);
  return after.status === 'healthy' ? finish('created', after) : finish('failed', after);
}

function detectDerivedIndexHealth(journalDir, fsImpl = fs) {
  const indexPath = path.join(journalDir, 'Journaling.md');
  let index;
  try { index = fsImpl.readFileSync(indexPath, 'utf8'); } catch { return { status: 'missing-derived' }; }
  const dates = fsImpl.readdirSync(journalDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
  const listed = [...String(index).matchAll(/\[\[Journal\/(\d{4}-\d{2}-\d{2})/g)].map((match) => match[1]);
  return { status: dates.length === listed.length && dates.every((name) => listed.includes(name.slice(0, -3))) ? 'healthy-derived' : 'stale-derived' };
}

function healthToday(options = {}) {
  let inputs;
  try { inputs = resolveInputs(options); } catch (error) { return { ok: false, outcome: 'invalid-configuration', reason: error.message }; }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const date = localDate(now, inputs.timeZone);
  const fsImpl = options.fs || fs;
  return { ok: true, date, canonical: canonicalHealth(path.join(inputs.journalDir, `${date}.md`), fsImpl), derivedIndex: detectDerivedIndexHealth(inputs.journalDir, fsImpl) };
}

function runCreationMaintenance(args = {}, options = {}) {
  const requested = args.dateSpecs || ['today'];
  if (requested.length !== 1 || requested[0] !== 'today') {
    return { status: 'failed', results: [{ ok: false, outcome: 'invalid-date-request' }], output: 'INVALID_DATE_REQUEST' };
  }
  const result = ensureTodayJournal({ ...options, now: options.now });
  return {
    status: result.ok ? 'ok' : 'failed',
    results: [result],
    output: args.json ? JSON.stringify({ status: result.ok ? 'ok' : 'failed', results: [result] }) : result.outcome.toUpperCase(),
  };
}

module.exports = { canonicalHealth, detectDerivedIndexHealth, detectWriterGuard, ensureTodayJournal, healthToday, localDate, runCreationMaintenance, safeProvenance };
