#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveJournalConfig, isValidTimezone } = require('../../../bridge/config');

const SUCCESS_OUTCOMES = new Set(['created', 'healthy-existing', 'created-concurrently', 'recovered-after-unrecorded-create']);
const JOURNAL_MUTATION_LOCK_MAX_AGE_MS = 30 * 1000;
const JOURNALING_INDEX_FILE = 'Journaling.md';
const ACTIVE_INDEX_QUIET_WINDOW_MS = 5 * 60 * 1000;
const INDEX_BACKUP_RETENTION_DAYS = 90;

function isSuccessfulJournalOutcome(value) {
  return SUCCESS_OUTCOMES.has(value);
}

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

function journalStateRoot(journalDir) {
  return path.dirname(receiptDirectory(journalDir));
}

function receiptSentinelPath(journalDir, date) {
  return path.join(receiptDirectory(journalDir), `${date}.receipt`);
}

function hasReceiptForDate(journalDir, date, fsImpl = fs) {
  try {
    const receipt = JSON.parse(fsImpl.readFileSync(receiptSentinelPath(journalDir, date), 'utf8'));
    return isSuccessfulJournalOutcome(receipt?.outcome);
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
    if (Array.isArray(communityPlugins) && ['journals', 'obsidian-journals', 'journaling'].some((plugin) => communityPlugins.includes(plugin))) {
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

function normalizeJournalLinkPrefix(prefix = 'Journal') {
  const normalized = String(prefix || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return normalized || 'Journal';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveJournalLinkPrefix(journalDir, options = {}) {
  const fsImpl = options.fs || fs;
  const configuredVault = options.vaultDir
    || options.config?.paths?.vault
    || options.env?.JARVOS_VAULT_DIR;
  const vaultRoot = typeof configuredVault === 'string' && path.isAbsolute(configuredVault)
    ? configuredVault
    : inferVaultRoot(journalDir, fsImpl);
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(journalDir));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return normalizeJournalLinkPrefix(relative.split(path.sep).join('/'));
}

function classifyDerivedIndexShape(markdown, linkPrefix = 'Journal') {
  const entries = [];
  const prefix = normalizeJournalLinkPrefix(linkPrefix);
  const pattern = new RegExp(`^!\\[\\[${escapeRegex(prefix)}\\/(?:[^\\[\\]|]+\\/)*(\\d{4}-\\d{2}-\\d{2})\\.md\\]\\]$`);
  for (const line of String(markdown).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(pattern);
    if (!match) return { managed: false, reason: 'index contains content jarvOS did not generate', entries: [] };
    entries.push({ date: match[1], line: trimmed });
  }
  return { managed: true, entries };
}

function loadDerivedIndexConfig(options = {}) {
  let packageConfig = {};
  try { packageConfig = loadTemplateConfig(); } catch { /* shared config may be sufficient in tests */ }
  const supplied = options.config && typeof options.config === 'object' ? options.config : {};
  return {
    ...packageConfig,
    ...supplied,
    derivedIndex: { ...(packageConfig.derivedIndex || {}), ...(supplied.derivedIndex || {}) },
  };
}

function resolveDateSpec(spec, now, timeZone) {
  const value = String(spec || 'today').trim();
  if (value === 'today') return localDate(now, timeZone);
  if (value === 'yesterday') {
    const current = localDate(now, timeZone).split('-').map(Number);
    return new Date(Date.UTC(current[0], current[1] - 1, current[2] - 1)).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid journal date: ${value}`);
  return value;
}

/**
 * Add one date to the generated Journaling.md index without taking ownership
 * of authored prose. The file must already exist and contain only embeds.
 */
function ensureIndexEntry(options = {}) {
  const fsImpl = options.fs || fs;
  let inputs;
  try { inputs = resolveInputs(options); } catch (error) {
    return { ok: false, outcome: 'index-failed', reason: error.message };
  }
  const config = loadDerivedIndexConfig(options);
  const indexConfig = config.derivedIndex || {};
  const enabled = options.enabled !== undefined ? options.enabled === true : indexConfig.enabled === true;
  const fileName = options.indexFileName || indexConfig.fileName || JOURNALING_INDEX_FILE;
  const baseResult = (outcome, reason, date, indexPath) => ({
    ok: !['index-unmanaged', 'index-conflict', 'index-failed'].includes(outcome),
    outcome,
    reason,
    date,
    indexPath,
  });
  let date;
  try { date = resolveDateSpec(options.date || options.dateSpec || 'today', options.now instanceof Date ? options.now : new Date(options.now || Date.now()), inputs.timeZone); } catch (error) {
    return baseResult('index-failed', error.message, undefined, undefined);
  }
  if (path.basename(fileName) !== fileName || fileName.includes('\\')) {
    return baseResult('index-failed', 'derived index file name must stay inside the journal directory', date, path.join(inputs.journalDir, fileName));
  }
  const indexPath = path.join(inputs.journalDir, fileName);
  if (!enabled) return baseResult('index-disabled', 'derived index maintenance is disabled for this vault', date, indexPath);
  const linkPrefix = options.indexLinkPrefix || resolveJournalLinkPrefix(inputs.journalDir, options);
  if (!linkPrefix) return baseResult('index-unmanaged', 'journal directory is not safely addressable from the vault root', date, indexPath);

  let stat;
  try { stat = fsImpl.lstatSync(indexPath); } catch (error) {
    if (error.code === 'ENOENT') return baseResult('index-unmanaged', 'derived index does not exist; automation does not create it', date, indexPath);
    return baseResult('index-failed', `derived index could not be inspected: ${error.message}`, date, indexPath);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return baseResult('index-unmanaged', 'derived index is not a regular file', date, indexPath);

  let current;
  try { current = fsImpl.readFileSync(indexPath, 'utf8'); } catch (error) {
    return baseResult('index-failed', `derived index could not be read: ${error.message}`, date, indexPath);
  }
  const shape = classifyDerivedIndexShape(current, linkPrefix);
  if (!shape.managed) return baseResult('index-unmanaged', shape.reason, date, indexPath);
  let journalDates;
  try {
    journalDates = fsImpl.readdirSync(inputs.journalDir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => name.slice(0, -3));
  } catch (error) {
    return baseResult('index-failed', `journal directory could not be inspected: ${error.message}`, date, indexPath);
  }
  const listedDates = new Set(shape.entries.map((entry) => entry.date));
  const missingDates = [...new Set([...journalDates, date])]
    .filter((entryDate) => !listedDates.has(entryDate))
    .sort((left, right) => right.localeCompare(left));
  if (missingDates.length === 0) {
    return baseResult('index-healthy', 'derived index already lists this date', date, indexPath);
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const idleMtimeMs = typeof options.observedMtimeMs === 'number' ? options.observedMtimeMs : stat.mtimeMs;
  if (now.getTime() - idleMtimeMs < ACTIVE_INDEX_QUIET_WINDOW_MS) {
    return baseResult('index-deferred', 'derived index was edited moments ago; deferring to the next window', date, indexPath);
  }

  const lines = current.split(/\r?\n/);
  const entries = [...shape.entries];
  for (const missingDate of missingDates) {
    const embed = `![[${linkPrefix}/${missingDate}.md]]`;
    const orderedEntries = [...entries].sort((left, right) => right.date.localeCompare(left.date));
    const olderEntry = orderedEntries.find((entry) => entry.date < missingDate);
    const anchor = olderEntry || orderedEntries[orderedEntries.length - 1];
    let insertAt = lines.length;
    let addition = [embed, ''];
    if (anchor) {
      const anchorAt = lines.findIndex((line) => line.trim() === anchor.line);
      if (anchorAt < 0) return baseResult('index-failed', 'derived index insertion point could not be resolved', date, indexPath);
      if (olderEntry) {
        insertAt = anchorAt;
      } else {
        insertAt = Math.min(anchorAt + 2, lines.length);
        addition = lines[anchorAt + 1] === undefined || lines[anchorAt + 1].trim() ? ['', embed] : [embed, ''];
      }
    }
    lines.splice(insertAt, 0, ...addition);
    entries.push({ date: missingDate, line: embed });
  }
  const next = lines.join('\n');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupDir = path.join(journalStateRoot(inputs.journalDir), 'index-backups');
  const backupPath = path.join(backupDir, `${fileName}.${stamp}.${crypto.randomBytes(3).toString('hex')}.bak`);
  const temporary = path.join(backupDir, `.${fileName}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let publishedBackupPath;
  try {
    fsImpl.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const update = withJournalMutationLock(indexPath, fsImpl, () => {
      // Re-read before publishing the swap so a concurrent Sync/client edit is
      // reported rather than overwritten.
      if (fsImpl.readFileSync(indexPath, 'utf8') !== current) return { conflict: true };
      fsImpl.writeFileSync(backupPath, current, { encoding: 'utf8', mode: 0o600 });
      fsImpl.writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600 });
      fsImpl.renameSync(temporary, indexPath);
      return { backupPath };
    });
    if (update?.conflict) return baseResult('index-conflict', 'derived index changed while the entry was being composed', date, indexPath);
    publishedBackupPath = update?.backupPath;
  } catch (error) {
    try { fsImpl.unlinkSync(temporary); } catch { /* cleanup only */ }
    return baseResult('index-failed', `derived index could not be updated: ${error.message}`, date, indexPath);
  }
  try {
    if (fsImpl.readFileSync(indexPath, 'utf8') !== next) {
      return baseResult('index-conflict', 'derived index did not match the written content after the write', date, indexPath);
    }
  } catch (error) {
    return baseResult('index-conflict', `derived index could not be verified after the write: ${error.message}`, date, indexPath);
  }
  try {
    const cutoff = now.getTime() - INDEX_BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fsImpl.readdirSync(backupDir)) {
      if (!name.startsWith(`${fileName}.`) || !name.endsWith('.bak')) continue;
      const candidate = path.join(backupDir, name);
      if (fsImpl.statSync(candidate).mtimeMs < cutoff) fsImpl.unlinkSync(candidate);
    }
  } catch { /* pruning is best effort */ }
  return { ...baseResult('index-updated', 'derived index now lists this date', date, indexPath), backupPath: publishedBackupPath };
}

function detectDerivedIndexHealth(journalDir, fsImpl = fs, fileName = JOURNALING_INDEX_FILE, linkPrefix) {
  const indexPath = path.join(journalDir, fileName);
  let index;
  try { index = fsImpl.readFileSync(indexPath, 'utf8'); } catch { return { status: 'missing-derived', indexPath }; }
  let dates;
  try { dates = fsImpl.readdirSync(journalDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)); } catch { return { status: 'unavailable', indexPath }; }
  const shape = classifyDerivedIndexShape(index, linkPrefix || resolveJournalLinkPrefix(journalDir, { fs: fsImpl }) || 'Journal');
  if (!shape.managed) return { status: 'unmanaged-derived', indexPath, expectedCount: dates.length, listedCount: 0, managedShape: false };
  const listed = shape.entries.map((entry) => entry.date);
  const listedDates = new Set(listed);
  return {
    status: dates.length === listed.length && dates.every((name) => listedDates.has(name.slice(0, -3))) ? 'healthy-derived' : 'stale-derived',
    indexPath,
    expectedCount: dates.length,
    listedCount: listed.length,
    managedShape: shape.managed,
  };
}

function healthToday(options = {}) {
  let inputs;
  try { inputs = resolveInputs(options); } catch (error) { return { ok: false, outcome: 'invalid-configuration', reason: error.message }; }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  let date;
  try { date = resolveDateSpec(options.date || options.dateSpec || 'today', now, inputs.timeZone); } catch (error) {
    return { ok: false, outcome: 'invalid-date', reason: error.message };
  }
  const fsImpl = options.fs || fs;
  const journalPath = path.join(inputs.journalDir, `${date}.md`);
  const indexFileName = loadDerivedIndexConfig(options).derivedIndex?.fileName || JOURNALING_INDEX_FILE;
  const linkPrefix = options.indexLinkPrefix || resolveJournalLinkPrefix(inputs.journalDir, options);
  return { ok: true, date, journalPath, canonical: canonicalHealth(journalPath, fsImpl), derivedIndex: detectDerivedIndexHealth(inputs.journalDir, fsImpl, indexFileName, linkPrefix) };
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withJournalMutationLock(journalPath, fsImpl, fn, { maxAttempts = 40, retryMs = 25 } = {}) {
  const lockPath = `${journalPath}.lock`;
  const lockToken = crypto.randomBytes(16).toString('hex');
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lockOwner = JSON.stringify({ pid: process.pid, token: lockToken });
  const reclaimStaleLock = () => {
    let stat;
    try { stat = fsImpl.statSync(lockPath); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (Date.now() - stat.mtimeMs <= JOURNAL_MUTATION_LOCK_MAX_AGE_MS) return false;

    let owner;
    try { owner = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8')); } catch { owner = null; }
    let ownerAlive = false;
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); ownerAlive = true; } catch (probeError) { ownerAlive = probeError.code !== 'ESRCH'; }
    }
    if (ownerAlive) return false;

    // Claim the stale pathname atomically before removing it. Multiple
    // reclaimers can race here, but only one rename can move this pathname;
    // a replacement lock is restored rather than accidentally unlinked.
    const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    try { fsImpl.renameSync(lockPath, stalePath); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    let movedOwner;
    try { movedOwner = JSON.parse(fsImpl.readFileSync(stalePath, 'utf8')); } catch { movedOwner = null; }
    const sameOwner = owner?.token
      ? movedOwner?.token === owner.token
      : !movedOwner?.token;
    if (!sameOwner) {
      try { fsImpl.linkSync(stalePath, lockPath); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    try { fsImpl.unlinkSync(stalePath); } catch { /* cleanup only */ }
    return sameOwner;
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const temporary = `${lockPath}.${process.pid}.${lockToken}.tmp`;
    try {
      // Fully write metadata before atomically publishing the lock pathname.
      // A stale reclaimer can never observe an empty, partially initialized
      // owner record.
      fsImpl.writeFileSync(temporary, lockOwner, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fsImpl.linkSync(temporary, lockPath);
      try { fsImpl.unlinkSync(temporary); } catch { /* cleanup only */ }
      break;
    } catch (error) {
      try { fsImpl.unlinkSync(temporary); } catch { /* cleanup only */ }
      if (error.code !== 'EEXIST') throw error;
      try {
        reclaimStaleLock();
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
    try {
      const owner = JSON.parse(fsImpl.readFileSync(lockPath, 'utf8'));
      if (owner?.token === lockToken) fsImpl.unlinkSync(lockPath);
    } catch { /* stale-lock cleanup or a failed lock write may have removed it */ }
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
  const fsImpl = options.fs || fs;
  let indexResults = [];
  if (result.ok) {
    let journalDir;
    try { journalDir = resolveInputs(options).journalDir; } catch { /* canonical result already carries the useful failure */ }
    const indexName = loadDerivedIndexConfig(options).derivedIndex?.fileName || JOURNALING_INDEX_FILE;
    let observedMtimeMs;
    if (journalDir) {
      try { observedMtimeMs = fsImpl.statSync(path.join(journalDir, indexName)).mtimeMs; } catch { /* missing/unreadable index is reported by ensureIndexEntry */ }
    }
    indexResults = [ensureIndexEntry({
      ...options,
      now: options.now,
      date: result.date,
      observedMtimeMs,
    })];
  }
  const indexProblems = indexResults.filter((entry) => !entry.ok && entry.outcome !== 'index-disabled');
  const fatalIndexProblem = indexProblems.some((entry) => ['index-failed', 'index-conflict'].includes(entry.outcome));
  const report = {
    status: result.ok && !fatalIndexProblem ? 'ok' : 'failed',
    results: [result],
    indexResults,
  };
  if (indexProblems.length) report.indexProblems = indexProblems;
  const quietCapture = ['healthy-existing', 'recovered-after-unrecorded-create'].includes(result.outcome);
  const indexPrinted = indexResults
    .filter((entry) => !['index-healthy', 'index-disabled'].includes(entry.outcome))
    .map((entry) => `${entry.outcome.toUpperCase()} ${entry.indexPath}${entry.reason ? ` (${entry.reason})` : ''}`);
  report.output = args.json
    ? JSON.stringify(report)
    : (quietCapture && !indexPrinted.length ? 'NO_REPLY' : [result.outcome.toUpperCase(), ...indexPrinted].join('\n'));
  return report;
}

module.exports = {
  canonicalHealth,
  classifyDerivedIndexShape,
  detectDerivedIndexHealth,
  detectWriterGuard,
  ensureIndexEntry,
  ensureTodayJournal,
  healthToday,
  isSuccessfulJournalOutcome,
  localDate,
  mutateExistingJournal,
  receiptDirectory,
  receiptSentinelPath,
  resolveJournalLinkPrefix,
  runCreationMaintenance,
  safeProvenance,
};
