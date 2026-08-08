#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lifecycle = require('../packages/jarvos-secondbrain-journal/src/journal-lifecycle.js');
const maintenance = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
const { resolveJournalConfig } = require('../bridge/config');

const QUIET = 'NO_REPLY';
const HEALTHY_RECEIPT_OUTCOMES = new Set(['created', 'healthy-existing', 'created-concurrently', 'recovered-after-unrecorded-create']);

function parseDateArg(argv = [], env = process.env) {
  for (const arg of argv) {
    if (arg.startsWith('--date=')) return arg.slice('--date='.length);
  }
  return env.JOURNAL_HEALTH_ALARM_DATE || 'today';
}

function receiptDirectory(journalDir) {
  return path.join(path.dirname(path.resolve(journalDir)), '.jarvos', 'journal-maintenance', 'receipts');
}

function readReceiptsForDate(journalDir, date, fsImpl = fs) {
  let names;
  try { names = fsImpl.readdirSync(receiptDirectory(journalDir)); } catch { return []; }
  return names.filter((name) => name.endsWith('.json')).flatMap((name) => {
    try {
      const receipt = JSON.parse(fsImpl.readFileSync(path.join(receiptDirectory(journalDir), name), 'utf8'));
      return receipt?.date === date ? [receipt] : [];
    } catch { return []; }
  });
}

function readIndexVisibility(journalDir, date, fileName = 'Journaling.md', fsImpl = fs, enabled = true) {
  if (enabled === false) return { status: 'not-maintained', fileName };
  let markdown;
  try { markdown = fsImpl.readFileSync(path.join(journalDir, fileName), 'utf8'); } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing-index' : 'unavailable', fileName };
  }
  const shape = lifecycle.classifyDerivedIndexShape(markdown);
  if (!shape.managed) return { status: 'unmanaged', fileName };
  return { status: shape.entries.some((entry) => entry.date === date) ? 'listed' : 'not-listed', fileName };
}

function buildAlarmMessage({ date, timeZone, canonical = {}, receipts = [], visibility = {} } = {}) {
  const healthyReceipt = receipts.some((receipt) => HEALTHY_RECEIPT_OUTCOMES.has(receipt?.outcome));
  const indexName = visibility.fileName || 'Journaling.md';
  if (canonical.status === 'healthy' && healthyReceipt) {
    if (visibility.status === 'not-listed') return `⚠️ The journal for ${date} was captured but is not listed in ${indexName}, so it will look missing in Obsidian.`;
    if (visibility.status === 'missing-index') return `⚠️ The journal for ${date} was captured, but ${indexName} is missing, so the daily entries have no navigation page in Obsidian.`;
    if (visibility.status === 'unmanaged') return `⚠️ The journal for ${date} was captured, but ${indexName} contains content jarvOS does not manage, so automatic visibility updates stopped.`;
    return QUIET;
  }
  if (canonical.status === 'missing') return `🚨 No journal for ${date} (${timeZone}): both scheduled windows failed to create it.`;
  if (canonical.status === 'healthy') return `⚠️ The journal for ${date} exists but no healthy scheduled receipt claims it.`;
  return `🚨 The journal for ${date} is ${canonical.status || 'unreadable'} and needs manual inspection.`;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const config = maintenance.readConfig();
  const requestedDate = parseDateArg(argv, env);
  let inputs;
  try {
    inputs = resolveJournalConfig({ env });
  } catch (error) {
    const message = `🚨 Journal configuration unavailable: ${error.message}`;
    console.log(message);
    return message;
  }
  const { journalDir, timeZone } = inputs;
  const health = lifecycle.healthToday({ journalDir, timeZone, date: requestedDate });
  const resolvedDate = health.date || requestedDate;
  const visibilityConfig = config.derivedIndex || {};
  const message = buildAlarmMessage({
    date: resolvedDate,
    timeZone,
    canonical: health.canonical || {},
    receipts: readReceiptsForDate(journalDir, resolvedDate),
    visibility: readIndexVisibility(journalDir, resolvedDate, visibilityConfig.fileName || 'Journaling.md', fs, visibilityConfig.enabled),
  });
  console.log(message);
  return message;
}

if (require.main === module) main();

module.exports = { QUIET, buildAlarmMessage, main, parseDateArg, readIndexVisibility, readReceiptsForDate };
