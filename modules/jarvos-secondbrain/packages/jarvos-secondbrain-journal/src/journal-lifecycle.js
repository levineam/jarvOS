#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveJournalConfig } = require('../../../bridge/config');

function localDate(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function renderScaffold(date) {
  return [
    '---',
    'journal: Journal',
    `journal-date: ${date}`,
    '---',
    '',
    '## 📝 Notes',
    '-',
    '',
    '## 💡 Ideas',
    '-',
    '',
    '## 📓 Journal Entry',
    '-',
    '',
  ].join('\n');
}

function safeProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const key of ['source', 'runtime', 'runId']) {
    if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim();
  }
  return result;
}

function ensureTodayJournal(options = {}) {
  let journal;
  try {
    journal = options.journalDir && options.timeZone
      ? { journalDir: path.resolve(options.journalDir), timeZone: options.timeZone }
      : resolveJournalConfig({ config: options.config, configPath: options.configPath, env: options.env, homeDir: options.homeDir });
  } catch (error) {
    return { ok: false, outcome: 'invalid-configuration', reason: error.message, provenance: safeProvenance(options.provenance) };
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const date = localDate(now, journal.timeZone);
  const journalPath = path.join(journal.journalDir, `${date}.md`);
  const provenance = safeProvenance(options.provenance);
  try {
    const existing = fs.lstatSync(journalPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      return { ok: false, outcome: 'invalid-existing', date, provenance };
    }
    return { ok: true, outcome: 'healthy-existing', date, provenance };
  } catch (error) {
    if (error.code !== 'ENOENT') return { ok: false, outcome: 'failed', date, reason: error.message, provenance };
  }

  try {
    fs.mkdirSync(journal.journalDir, { recursive: true });
    fs.writeFileSync(journalPath, renderScaffold(date), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: true, outcome: 'created-concurrently', date, provenance };
    return { ok: false, outcome: 'failed', date, reason: error.message, provenance };
  }
  return { ok: true, outcome: 'created', date, provenance };
}

module.exports = { ensureTodayJournal, localDate, safeProvenance };
