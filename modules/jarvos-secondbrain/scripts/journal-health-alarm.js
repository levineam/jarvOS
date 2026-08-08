#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lifecycle = require('../packages/jarvos-secondbrain-journal/src/journal-lifecycle.js');
const maintenance = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
const { resolveJournalConfig } = require('../bridge/config');

const QUIET = 'NO_REPLY';

function parseDateArg(argv = [], env = process.env) {
  for (const arg of argv) {
    if (arg.startsWith('--date=')) return arg.slice('--date='.length);
  }
  return env.JOURNAL_HEALTH_ALARM_DATE || 'today';
}

function receiptDirectory(journalDir) {
  return lifecycle.receiptDirectory(journalDir);
}

function readReceiptStateForDate(journalDir, date, fsImpl = fs) {
  try {
    const receipt = JSON.parse(fsImpl.readFileSync(lifecycle.receiptSentinelPath(journalDir, date), 'utf8'));
    return receipt?.date === date
      ? { status: 'available', receipts: [receipt] }
      : { status: 'available', receipts: [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', receipts: [] };
    return { status: 'unavailable', receipts: [] };
  }
}

function readReceiptsForDate(journalDir, date, fsImpl = fs) {
  return readReceiptStateForDate(journalDir, date, fsImpl).receipts;
}

function readIndexVisibility(journalDir, date, fileName = 'Journaling.md', fsImpl = fs, enabled = true) {
  if (enabled === false) return { status: 'not-maintained', fileName };
  let markdown;
  try { markdown = fsImpl.readFileSync(path.join(journalDir, fileName), 'utf8'); } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing-index' : 'unavailable', fileName };
  }
  const linkPrefix = lifecycle.resolveJournalLinkPrefix(journalDir, { fs: fsImpl }) || 'Journal';
  const shape = lifecycle.classifyDerivedIndexShape(markdown, linkPrefix);
  if (!shape.managed) return { status: 'unmanaged', fileName };
  return { status: shape.entries.some((entry) => entry.date === date) ? 'listed' : 'not-listed', fileName };
}

function buildAlarmMessage({ date, timeZone, canonical = {}, receipts = [], receiptStatus = 'available', visibility = {} } = {}) {
  const healthyReceipt = receipts.some((receipt) => lifecycle.isSuccessfulJournalOutcome(receipt?.outcome));
  const indexName = visibility.fileName || 'Journaling.md';
  if (receiptStatus === 'unavailable') return `🚨 Journal receipt evidence for ${date} is unavailable; scheduled-capture status cannot be verified.`;
  if (canonical.status === 'healthy' && healthyReceipt) {
    if (visibility.status === 'not-listed') return `⚠️ The journal for ${date} was captured but is not listed in ${indexName}, so it will look missing in Obsidian.`;
    if (visibility.status === 'missing-index') return `⚠️ The journal for ${date} was captured, but ${indexName} is missing, so the daily entries have no navigation page in Obsidian.`;
    if (visibility.status === 'unmanaged') return `⚠️ The journal for ${date} was captured, but ${indexName} contains content jarvOS does not manage, so automatic visibility updates stopped.`;
    if (visibility.status === 'unavailable') return `⚠️ The journal for ${date} was captured, but ${indexName} could not be read, so its visibility is unknown.`;
    return QUIET;
  }
  if (canonical.status === 'missing') return `🚨 No journal for ${date} (${timeZone}): the canonical file is missing and needs investigation.`;
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
  const receiptState = readReceiptStateForDate(journalDir, resolvedDate);
  const message = buildAlarmMessage({
    date: resolvedDate,
    timeZone,
    canonical: health.canonical || {},
    receipts: receiptState.receipts,
    receiptStatus: receiptState.status,
    visibility: readIndexVisibility(journalDir, resolvedDate, visibilityConfig.fileName || 'Journaling.md', fs, visibilityConfig.enabled),
  });
  console.log(message);
  return message;
}

if (require.main === module) main();

module.exports = { QUIET, buildAlarmMessage, main, parseDateArg, readIndexVisibility, readReceiptStateForDate, readReceiptsForDate, receiptDirectory };
