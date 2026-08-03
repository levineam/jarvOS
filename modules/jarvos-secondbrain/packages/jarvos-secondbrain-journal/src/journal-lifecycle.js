#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveJournalConfig, isValidTimezone } = require('../../../bridge/config');

const SUCCESS_OUTCOMES = new Set(['created', 'healthy-existing', 'created-concurrently', 'recovered-after-unrecorded-create']);
const JOURNAL_MUTATION_LOCK_MAX_AGE_MS = 30 * 1000;

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
  return require('./journal-maintenance.js').readConfig();
}

function renderScaffold(date, config) {
  const api = require('./journal-maintenance.js');
  return api.renderJournal(date, config, api.normalizeSections('', date, config));
}

function receiptDirectory(journalDir) {
  return path.join(path.dirname(journalDir), '.jarvos', 'journal-maintenance', 'receipts');
}

function receiptSentinelPath(journalDir, date) {
  return path.join(receiptDirectory(journalDir), `${date}.receipt`);
}

function hasReceiptForDate(journalDir, date, fsImpl = fs) {
  try {
    return fsImpl.lstatSync(receiptSentinelPath(journalDir, date)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
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
  const serialized = `${JSON.stringify(receipt)}\n`;
  const temporary = `${file}.tmp`;
  try {
    // Idempotent health confirmations only refresh the date-addressable
    // marker; state-changing attempts retain an immutable audit record.
    if (outcome !== 'healthy-existing') {
      fsImpl.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(temporary, file);
    }

    // Publish a date-addressable marker so existing-file checks never scan or
    // parse the immutable history.
    const sentinel = receiptSentinelPath(journalDir, date);
    const sentinelTemporary = `${sentinel}.${process.pid}.${Date.now()}.tmp`;
    try {
      fsImpl.writeFileSync(sentinelTemporary, serialized, { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(sentinelTemporary, sentinel);
    } catch (error) {
      try { fsImpl.unlinkSync(sentinelTemporary); } catch { /* cleanup only */ }
      throw error;
    }
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

function readJsonOptional(filePath, fallback, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function folderMatchesJournal(vaultRoot, configuredFolder, journalDir) {
  const raw = String(configuredFolder || '').trim();
  if (!raw) return false;
  const resolved = path.isAbsolute(raw) ? raw : path.join(vaultRoot, raw);
  return path.resolve(resolved) === path.resolve(journalDir);
}

function inferVaultRoot(journalDir, fsImpl = fs) {
  let candidate = path.dirname(path.resolve(journalDir));
  const filesystemRoot = path.parse(candidate).root;
  while (candidate !== filesystemRoot) {
    try {
      if (fsImpl.existsSync(path.join(candidate, '.obsidian'))) return candidate;
    } catch {
      // Fall back to the immediate parent if the host cannot inspect an ancestor.
      break;
    }
    candidate = path.dirname(candidate);
  }
  return path.dirname(path.resolve(journalDir));
}

function detectWriterGuard(journalDir, fsImpl = fs) {
  const resolvedJournalDir = path.resolve(journalDir);
  const vaultRoot = inferVaultRoot(resolvedJournalDir, fsImpl);
  const obsidianDir = path.join(vaultRoot, '.obsidian');
  try {
    const communityPlugins = readJsonOptional(path.join(obsidianDir, 'community-plugins.json'), [], fsImpl);
    if (Array.isArray(communityPlugins) && communityPlugins.includes('journals')) {
      return { ok: false, reason: 'configured journals writer' };
    }

    const corePlugins = readJsonOptional(path.join(obsidianDir, 'core-plugins.json'), {}, fsImpl);
    if (corePlugins?.['daily-notes']) {
      const dailyNotes = readJsonOptional(path.join(obsidianDir, 'daily-notes.json'), {}, fsImpl);
      if (folderMatchesJournal(vaultRoot, dailyNotes.folder, resolvedJournalDir)) {
        return { ok: false, reason: 'configured daily-note writer' };
      }
    }

    if (Array.isArray(communityPlugins) && communityPlugins.includes('periodic-notes')) {
      const periodicNotes = readJsonOptional(
        path.join(obsidianDir, 'plugins', 'periodic-notes', 'data.json'),
        {},
        fsImpl,
      );
      if (periodicNotes?.daily?.enabled && folderMatchesJournal(vaultRoot, periodicNotes.daily.folder, resolvedJournalDir)) {
        return { ok: false, reason: 'configured periodic-notes writer' };
      }
    }
  } catch {
    return { ok: false, reason: 'writer configuration unreadable' };
  }
  return { ok: true };
}

function resolveInputs(options) {
  const hasJournalDir = Object.prototype.hasOwnProperty.call(options, 'journalDir');
  const hasTimeZone = Object.prototype.hasOwnProperty.call(options, 'timeZone');
  if (hasJournalDir || hasTimeZone) {
    if (!hasJournalDir || !hasTimeZone) throw new Error('Journal mutation requires both an explicit journal directory and timezone');
    if (typeof options.journalDir !== 'string' || !path.isAbsolute(options.journalDir.trim())) {
      throw new Error('Journal mutation has an invalid configured absolute journal directory');
    }
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
  if (options.journalPath !== undefined
    && (typeof options.journalPath !== 'string' || path.resolve(options.journalPath) !== path.resolve(journalPath))) {
    return {
      ok: false,
      outcome: 'invalid-configuration',
      date,
      journalPath,
      reason: 'Journal mutation target does not match the configured journal directory and date',
      provenance,
    };
  }
  const before = canonicalHealth(journalPath, fsImpl);
  const guard = options.writerGuard || detectWriterGuard(inputs.journalDir, fsImpl);
  const finish = (outcome, after) => {
    try {
      if (typeof options.beforeReceipt === 'function') options.beforeReceipt();
      writeReceipt({ journalDir: inputs.journalDir, date, timeZone: inputs.timeZone, outcome, before, after, provenance, fsImpl, now });
      return { ok: SUCCESS_OUTCOMES.has(outcome), outcome, date, journalPath, provenance };
    } catch (error) {
      return { ok: false, outcome: 'receipt-failed', date, journalPath, reason: error.message, provenance };
    }
  };
  if (!guard.ok) return finish('blocked-writer-conflict', before);
  if (before.status !== 'missing') {
    let prior;
    try {
      prior = hasReceiptForDate(inputs.journalDir, date, fsImpl);
    } catch (error) {
      return { ok: false, outcome: 'receipt-failed', date, journalPath, reason: error.message, provenance };
    }
    return finish(before.status === 'healthy' ? (prior ? 'healthy-existing' : 'recovered-after-unrecorded-create') : 'invalid-existing', before);
  }
  let scaffold;
  try { scaffold = renderScaffold(date, options.templateConfig || loadTemplateConfig()); } catch (error) {
    return { ok: false, outcome: 'failed', date, journalPath, reason: error.message, provenance };
  }
  try {
    fsImpl.mkdirSync(inputs.journalDir, { recursive: true });
    fsImpl.writeFileSync(journalPath, scaffold, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') return { ok: false, outcome: 'failed', date, journalPath, reason: error.message, provenance };
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
  const listedDates = new Set(listed);
  return { status: dates.length === listed.length && dates.every((name) => listedDates.has(name.slice(0, -3))) ? 'healthy-derived' : 'stale-derived' };
}

function healthToday(options = {}) {
  let inputs;
  try { inputs = resolveInputs(options); } catch (error) { return { ok: false, outcome: 'invalid-configuration', reason: error.message }; }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const date = localDate(now, inputs.timeZone);
  const fsImpl = options.fs || fs;
  const journalPath = path.join(inputs.journalDir, `${date}.md`);
  return { ok: true, date, journalPath, canonical: canonicalHealth(journalPath, fsImpl), derivedIndex: detectDerivedIndexHealth(inputs.journalDir, fsImpl) };
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withJournalMutationLock(journalPath, fsImpl, fn, { maxAttempts = 40, retryMs = 25 } = {}) {
  const lockPath = `${journalPath}.lock`;
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fd = fsImpl.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fsImpl.statSync(lockPath).mtimeMs > JOURNAL_MUTATION_LOCK_MAX_AGE_MS) fsImpl.unlinkSync(lockPath);
      } catch {
        // The lock may disappear between attempts.
      }
      if (attempt === maxAttempts) throw new Error(`Timed out locking canonical journal mutation: ${journalPath}`);
      sleepSync(retryMs);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) fsImpl.closeSync(fd);
    try { fsImpl.unlinkSync(lockPath); } catch { /* stale-lock cleanup may have removed it */ }
  }
}

// Backlink and append callers may update an already-existing canonical journal,
// but creation callers must remain on ensureTodayJournal's creation-only path.
function mutateExistingJournal({ journalPath, expectedContent, nextContent, fsImpl = fs } = {}) {
  if (typeof journalPath !== 'string' || !journalPath) throw new Error('journalPath is required');
  if (typeof expectedContent !== 'string' || typeof nextContent !== 'string') {
    throw new Error('expectedContent and nextContent are required');
  }
  return withJournalMutationLock(journalPath, fsImpl, () => {
    const current = fsImpl.readFileSync(journalPath, 'utf8');
    if (current !== expectedContent) throw new Error('canonical journal changed before mutation');
    if (current === nextContent) return { changed: false };
    const temporary = path.join(path.dirname(journalPath), `.${path.basename(journalPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fsImpl.writeFileSync(temporary, nextContent, { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(temporary, journalPath);
    } catch (error) {
      try { fsImpl.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
    return { changed: true };
  });
}

function runCreationMaintenance(args = {}, options = {}) {
  const requested = args.dateSpecs || ['today'];
  if (requested.length !== 1 || requested[0] !== 'today') {
    return { status: 'failed', results: [{ ok: false, outcome: 'invalid-date-request' }], output: 'INVALID_DATE_REQUEST' };
  }
  if (args.dryRun) {
    const health = healthToday({ ...options, now: options.now });
    const result = health.ok
      ? {
        ok: health.canonical.status !== 'invalid',
        outcome: health.canonical.status === 'missing' ? 'would-create' : `${health.canonical.status}-existing`,
        date: health.date,
        journalPath: health.journalPath,
        canonicalStatus: health.canonical.status,
        derivedIndexStatus: health.derivedIndex.status,
      }
      : { ok: false, outcome: health.outcome, reason: health.reason };
    return {
      status: result.ok ? 'ok' : 'failed',
      results: [result],
      output: args.json ? JSON.stringify({ status: result.ok ? 'ok' : 'failed', results: [result] }) : result.outcome.toUpperCase(),
    };
  }
  const result = ensureTodayJournal({ ...options, now: options.now });
  return {
    status: result.ok ? 'ok' : 'failed',
    results: [result],
    output: args.json ? JSON.stringify({ status: result.ok ? 'ok' : 'failed', results: [result] }) : result.outcome.toUpperCase(),
  };
}

module.exports = { canonicalHealth, detectDerivedIndexHealth, detectWriterGuard, ensureTodayJournal, healthToday, localDate, mutateExistingJournal, runCreationMaintenance, safeProvenance };
