#!/usr/bin/env node
// Bridge-owned canonical note→journal linker.
// Input (stdin): { "noteTitle": "...", "section": "📝 Notes" }
// Finds today's journal, adds [[noteTitle]] under the specified section if not present.
// Output: { "linked": true, "journalPath": "...", "alreadyPresent": false }

'use strict';

const {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  readdirSync,
} = require('fs');
const { mkdirSync } = require('node:fs');
const crypto = require('node:crypto');
const path = require('path');
const {
  getTimeZone,
  getVaultDir,
  getVaultJournalDir,
  getVaultNotesDir,
} = require('./lib/provenance-config');
const { createObsidianOwnedMutationService } = require('./obsidian-mutation');
const {
  loadConfig,
  normalizeSections,
  renderJournal,
} = require('../../../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

const DEFERRED_QUEUE_LOCK_MAX_AGE_MS = 30 * 1000;

function todayPath() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: getTimeZone() });
  return path.join(getVaultJournalDir(), `${today}.md`);
}

function dateFromJournalPath(journalPath) {
  const fromName = path.basename(journalPath, '.md');
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromName)) return fromName;
  return new Date().toLocaleDateString('en-CA', { timeZone: getTimeZone() });
}

function renderInitialJournal(journalPath, date = dateFromJournalPath(journalPath)) {
  const config = loadConfig();
  const normalized = normalizeSections('', date, config);
  return renderJournal(date, config, normalized);
}

function ensureJournalFile() { throw new Error('Journal creation must use the canonical Obsidian mutation service'); }

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readDeferredQueue(filePath) {
  const data = readJsonSafe(filePath, { version: 1, entries: {} });
  if (!isPlainObject(data)) throw new Error(`Invalid deferred backlink queue shape: ${filePath}`);
  if (data.entries === undefined) data.entries = {};
  if (!isPlainObject(data.entries)) throw new Error(`Invalid deferred backlink queue entries: ${filePath}`);
  return data;
}

function deferredQueuePathForJournalDir(journalDir = getVaultJournalDir()) {
  return path.join(path.dirname(journalDir), '.jarvos', 'journal-maintenance', 'deferred-backlinks.json');
}

function queueEvent(entry, event) {
  const events = Array.isArray(entry.events) ? entry.events : [];
  return [...events, event];
}

function readNoteId(notePath) {
  let content;
  try {
    content = readFileSync(notePath, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return null;
  const match = frontmatter[1].match(/^jarvos_note_id:\s*(?:["']([^"']+)["']|([^\s#]+))\s*(?:#.*)?$/m);
  return (match?.[1] || match?.[2] || '').trim() || null;
}

function normalizeVaultRelativeNotePath(notePath, vaultRoot = getVaultDir(), notesDir = getVaultNotesDir()) {
  if (typeof notePath !== 'string' || !notePath.trim()) return null;
  const candidate = notePath.replace(/\\/g, '/');
  if (path.isAbsolute(candidate)) return null;
  const resolved = path.resolve(vaultRoot, candidate);
  if (!isPathInside(notesDir, resolved) || path.extname(resolved).toLowerCase() !== '.md') return null;
  const relative = path.relative(vaultRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function normalizeQueuedNotePath(notePath, journalPath) {
  if (typeof notePath !== 'string' || !notePath.trim()) return null;
  const configuredRoot = resolveVaultRootForJournal(journalPath);
  const journalRoot = path.dirname(path.dirname(path.resolve(journalPath)));
  const roots = [...new Set([configuredRoot, journalRoot].map((root) => path.resolve(root)))];
  if (path.isAbsolute(notePath)) {
    for (const vaultRoot of roots) {
      const configuredNotesDir = getVaultNotesDir();
      const notesDir = isPathInside(vaultRoot, configuredNotesDir) ? configuredNotesDir : path.join(vaultRoot, 'Notes');
      if (!isPathInside(notesDir, notePath) || !isPathInside(vaultRoot, notePath)) continue;
      const relative = path.relative(vaultRoot, path.resolve(notePath));
      if (path.extname(relative).toLowerCase() === '.md') return relative.split(path.sep).join('/');
    }
    return null;
  }
  for (const vaultRoot of roots) {
    const configuredNotesDir = getVaultNotesDir();
    const notesDir = isPathInside(vaultRoot, configuredNotesDir) ? configuredNotesDir : path.join(vaultRoot, 'Notes');
    const normalized = normalizeVaultRelativeNotePath(notePath, vaultRoot, notesDir);
    if (normalized) return normalized;
  }
  return null;
}

function wikilinkTargetFromNotePath(notePath) {
  return notePath.replace(/\.md$/i, '').split(path.sep).join('/');
}

function recursivelyFindNotesById(notesDir, noteId) {
  const matches = [];
  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && readNoteId(candidate) === noteId) matches.push(candidate);
    }
  }
  visit(notesDir);
  return matches;
}

function canonicalLegacyNotePath(notesDir, noteTitle) {
  if (typeof noteTitle !== 'string' || !noteTitle || noteTitle.includes('/') || noteTitle.includes('\\') || noteTitle.includes('\0')) return null;
  const candidate = path.join(notesDir, `${noteTitle}.md`);
  return isPathInside(notesDir, candidate) ? candidate : null;
}

function classifyDeferredBacklink(entry, {
  vaultRoot = getVaultDir(),
  notesDir = getVaultNotesDir(),
  journalDir,
} = {}) {
  if (!isPlainObject(entry)) return { status: 'unresolved', reason: 'invalid-entry' };
  if (typeof entry.journalPath !== 'string' || !entry.journalPath
    || (journalDir && !isPathInside(journalDir, entry.journalPath))) {
    return { status: 'unresolved', reason: 'journal-path-unsafe' };
  }
  const isV2 = Boolean(entry.noteId || entry.notePath);
  if (!isV2) {
    if (typeof entry.noteTitle !== 'string' || !entry.noteTitle || typeof entry.journalPath !== 'string') {
      return { status: 'unresolved', reason: 'legacy-entry-missing-title-or-journal' };
    }
    const canonical = canonicalLegacyNotePath(notesDir, entry.noteTitle);
    if (!canonical) return { status: 'unresolved', reason: 'legacy-note-title-unsafe' };
    return existsSync(canonical)
      ? { status: 'retry', reason: 'legacy-exact-note-present', noteTitle: entry.noteTitle, notePath: path.relative(vaultRoot, canonical).split(path.sep).join('/') }
      : { status: 'unresolved', reason: 'legacy-exact-note-missing' };
  }

  if (typeof entry.noteId !== 'string' || !entry.noteId || typeof entry.notePath !== 'string' || !entry.notePath || typeof entry.journalPath !== 'string') {
    return { status: 'unresolved', reason: 'v2-entry-missing-identity-or-path' };
  }
  const normalizedPath = normalizeVaultRelativeNotePath(entry.notePath, vaultRoot, notesDir);
  if (!normalizedPath) return { status: 'unresolved', reason: 'v2-note-path-unsafe' };
  const exactPath = path.resolve(vaultRoot, normalizedPath);
  if (existsSync(exactPath)) {
    return readNoteId(exactPath) === entry.noteId
      ? { status: 'retry', reason: 'v2-exact-identity-present', notePath: normalizedPath, noteTitle: wikilinkTargetFromNotePath(normalizedPath) }
      : { status: 'unresolved', reason: 'v2-note-identity-mismatch' };
  }
  const matches = recursivelyFindNotesById(notesDir, entry.noteId);
  if (matches.length === 1) {
    return { status: 'superseded', reason: 'v2-note-moved', notePath: path.relative(vaultRoot, matches[0]).split(path.sep).join('/') };
  }
  return matches.length === 0
    ? { status: 'unresolved', reason: 'v2-note-identity-missing' }
    : { status: 'unresolved', reason: 'v2-note-identity-conflict', matches: matches.map((match) => path.relative(vaultRoot, match).split(path.sep).join('/')) };
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Cleanup is best-effort; preserve the original write failure.
    }
    throw error;
  }
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withDeferredQueueLock(deferredPath, fn, { maxAttempts = 40, retryMs = 25 } = {}) {
  const lockPath = `${deferredPath}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > DEFERRED_QUEUE_LOCK_MAX_AGE_MS) unlinkSync(lockPath);
      } catch {
        // The lock may disappear between attempts.
      }
      if (attempt === maxAttempts) throw new Error(`Timed out locking deferred backlink queue: ${deferredPath}`);
      sleepSync(retryMs);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale-lock cleanup may already have removed it.
    }
  }
}

function parseObsidianEvalResult() { throw new Error('Direct Obsidian evaluation is retired; use the canonical mutation service'); }
function runObsidianEval() { throw new Error('Direct Obsidian evaluation is retired; use the canonical mutation service'); }

function isPathInside(parentDir, candidatePath) {
  const relativePath = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveVaultRootForJournal(journalPath) {
  const configuredVaultRoot = path.resolve(getVaultDir());
  if (isPathInside(configuredVaultRoot, journalPath)) return configuredVaultRoot;

  const configuredJournalDir = path.resolve(getVaultJournalDir());
  if (isPathInside(configuredJournalDir, journalPath)) return path.dirname(configuredJournalDir);
  return configuredVaultRoot;
}

function journalPathRelativeToVault(journalPath, vaultRoot = resolveVaultRootForJournal(journalPath)) {
  const relativePath = path.relative(vaultRoot, path.resolve(journalPath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Journal is outside the active Obsidian vault: ${journalPath}`);
  }
  return relativePath.split(path.sep).join('/');
}

function obsidianMutationScript() { throw new Error('Bespoke backlink mutation scripts are retired; use the canonical mutation service'); }
function mutateJournalThroughObsidian({ journalPath, noteTitle, section = '📝 Notes', noteId, mutationService, vaultRoot } = {}) {
  return submitBacklinkMutation({ journalPath, linkTarget: noteTitle, section, noteId, mutationService, vaultRoot });
}

function isTodayJournalPath(journalPath) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: getTimeZone() });
  return path.basename(journalPath, '.md') === today;
}

function deferredBacklinksPath(journalPath) {
  return deferredQueuePathForJournalDir(path.dirname(journalPath));
}

function recordDeferredBacklink({
  journalPath,
  noteTitle,
  section,
  reason,
  noteId,
  notePath,
  auditState,
  mutationIntentId,
}) {
  const deferredPath = deferredBacklinksPath(journalPath);
  const normalizedNotePath = normalizeQueuedNotePath(notePath, journalPath);
  const key = crypto.createHash('sha256')
    .update(`${journalPath}\0${section}\0${noteId || normalizedNotePath || noteTitle}`)
    .digest('hex')
    .slice(0, 16);
  withDeferredQueueLock(deferredPath, () => {
    const data = readDeferredQueue(deferredPath);
    const now = new Date().toISOString();
    const existing = data.entries[key];
    data.version = 2;
    data.updatedAt = now;
    data.entries[key] = {
      ...existing,
      status: 'pending',
      reason,
      noteTitle,
      section,
      journalPath,
      ...(noteId ? { noteId } : {}),
      ...(normalizedNotePath ? { notePath: normalizedNotePath } : {}),
      mutationIntentId: existing?.mutationIntentId || mutationIntentId || `backlink-${crypto.randomUUID()}`,
      auditState: auditState || existing?.auditState || 'recorded',
      recordedAt: existing?.recordedAt || now,
      updatedAt: now,
      events: queueEvent(existing || {}, {
        at: now,
        type: 'recorded',
        status: 'pending',
        reason,
      }),
    };
    writeJson(deferredPath, data);
  });
  return { deferredPath, key };
}

function outcomeSummary(outcomes, deferredPath) {
  const summary = {
    checked: 0,
    linked: 0,
    pending: 0,
    unresolved: 0,
    superseded: 0,
    queuePath: deferredPath,
    entries: [],
  };
  for (const outcome of outcomes.values()) {
    summary.checked += 1;
    summary[outcome.status] += 1;
    summary.entries.push({ key: outcome.key, status: outcome.status, reason: outcome.reason, ...(outcome.error ? { error: outcome.error } : {}) });
  }
  return summary;
}

function flushDeferredBacklinks({
  journalDir = getVaultJournalDir(),
  mutationService,
  dryRun = false,
  key,
  vaultRoot = path.dirname(journalDir),
  notesDir = path.join(path.dirname(journalDir), 'Notes'),
} = {}) {
  const deferredPath = deferredQueuePathForJournalDir(journalDir);
  const snapshot = readDeferredQueue(deferredPath);
  const outcomes = new Map();
  for (const [entryKey, entry] of Object.entries(snapshot.entries)) {
    if (key && entryKey !== key) continue;
    if (!entry || entry.status !== 'pending') continue;
    const classification = classifyDeferredBacklink(entry, { vaultRoot, notesDir, journalDir });
    if (classification.status === 'linked' || classification.status === 'unresolved' || classification.status === 'superseded') {
      outcomes.set(entryKey, { key: entryKey, ...classification });
      continue;
    }
    if (dryRun) {
      outcomes.set(entryKey, { key: entryKey, status: 'pending', reason: classification.reason, proposed: 'retry' });
      continue;
    }
    const mutationIntentId = entry.mutationIntentId || `backlink-recovery-${entryKey}-${crypto.randomUUID()}`;
    try {
      const result = linkNoteToJournal({
        noteTitle: classification.noteTitle,
        section: entry.section || '📝 Notes',
        journalPath: entry.journalPath,
        createIfMissing: true,
        mutationService,
        deferOnFailure: false,
        noteId: entry.noteId,
        notePath: classification.notePath,
        intentId: mutationIntentId,
        vaultRoot,
      });
      outcomes.set(entryKey, { key: entryKey, status: 'linked', reason: result.alreadyPresent ? 'exact-link-present' : 'linked', result, mutationIntentId });
    } catch (error) {
      outcomes.set(entryKey, { key: entryKey, status: 'pending', reason: classification.reason, error: error.message, mutationIntentId });
    }
  }

  const summary = outcomeSummary(outcomes, deferredPath);
  if (dryRun) return { ...summary, dryRun: true };

  const now = new Date().toISOString();
  withDeferredQueueLock(deferredPath, () => {
    const latest = readDeferredQueue(deferredPath);
    for (const [entryKey, outcome] of outcomes) {
      const current = latest.entries[entryKey];
      if (!current) continue; // An operator removed it after the snapshot; never resurrect it.
      const snapshotEntry = snapshot.entries[entryKey];
      if (snapshotEntry?.updatedAt && current.updatedAt !== snapshotEntry.updatedAt) continue;
      const base = { ...current, updatedAt: now };
      if (outcome.status === 'pending') {
        latest.entries[entryKey] = {
          ...base,
          attempts: (Number.isInteger(current.attempts) ? current.attempts : 0) + 1,
          lastAttemptAt: now,
          lastError: outcome.error || undefined,
          mutationIntentId: current.mutationIntentId || outcome.mutationIntentId,
          events: queueEvent(current, {
            at: now,
            type: 'retry-failed',
            status: 'pending',
            reason: outcome.reason,
            error: outcome.error,
          }),
        };
      } else {
        latest.entries[entryKey] = {
          ...base,
          status: outcome.status,
          ...(outcome.status === 'linked' ? { linkedAt: now, result: outcome.result && { alreadyPresent: Boolean(outcome.result.alreadyPresent) } } : {}),
          terminalAt: outcome.status === 'linked' ? undefined : now,
          terminalReason: outcome.status === 'linked' ? undefined : outcome.reason,
          events: queueEvent(current, {
            at: now,
            type: outcome.status === 'linked' ? 'linked' : 'terminal',
            status: outcome.status,
            reason: outcome.reason,
          }),
        };
      }
    }
    latest.version = 2;
    latest.updatedAt = now;
    latest.lastFlushAt = now;
    latest.lastFlushSummary = summary;
    writeJson(deferredPath, latest);
  });
  return summary;
}

function reconcileDeferredBacklink({
  journalDir = getVaultJournalDir(),
  key,
  notePath,
  vaultRoot = path.dirname(journalDir),
  notesDir = path.join(path.dirname(journalDir), 'Notes'),
  dryRun = false,
} = {}) {
  if (!key || !notePath) throw new Error('key and notePath are required for manual reconciliation');
  const deferredPath = deferredQueuePathForJournalDir(journalDir);
  const queue = readDeferredQueue(deferredPath);
  const entry = queue.entries[key];
  if (!entry) throw new Error(`Deferred backlink key not found: ${key}`);
  const normalizedPath = normalizeVaultRelativeNotePath(notePath, vaultRoot, notesDir);
  if (!normalizedPath) throw new Error(`Note path is not a safe Notes-relative Markdown path: ${notePath}`);
  const actualPath = path.resolve(vaultRoot, normalizedPath);
  const noteId = readNoteId(actualPath);
  if (!noteId) throw new Error(`Selected note has no jarvos_note_id: ${normalizedPath}`);
  if (entry.noteId && entry.noteId !== noteId) throw new Error(`Selected note identity does not match deferred backlink ${key}`);
  const result = { key, status: 'pending', noteId, notePath: normalizedPath, adoptedIdentity: !entry.noteId, dryRun };
  if (dryRun) return result;
  const now = new Date().toISOString();
  withDeferredQueueLock(deferredPath, () => {
    const latest = readDeferredQueue(deferredPath);
    const current = latest.entries[key];
    if (!current) throw new Error(`Deferred backlink key disappeared during reconciliation: ${key}`);
    if (current.noteId && current.noteId !== noteId) throw new Error(`Selected note identity does not match deferred backlink ${key}`);
    latest.entries[key] = {
      ...current,
      status: 'pending',
      noteId,
      notePath: normalizedPath,
      updatedAt: now,
      reopenedAt: now,
      events: queueEvent(current, {
        at: now,
        type: 'manual-reconciliation',
        status: 'pending',
        previousStatus: current.status,
        notePath: normalizedPath,
        adoptedIdentity: !current.noteId,
      }),
    };
    latest.version = 2;
    latest.updatedAt = now;
    writeJson(deferredPath, latest);
  });
  return { ...result, dryRun: false };
}

function linkNoteToTodayJournal(noteTitle, section = '📝 Notes') {
  return linkNoteToJournal({ noteTitle, section, journalPath: todayPath() });
}

function receiptAcknowledged(receipt) { return ['committed', 'already_satisfied'].includes(receipt?.status); }
function operationContext(service, vaultRelativePath, intentId) {
  return service.createWriteContext({ vaultRelativePath, intentId, operationSource: service.source });
}
function executeContext(service, context, operation) {
  return typeof context.mutationExecutor === 'function'
    ? context.mutationExecutor(operation)
    : service.execute(operation);
}
function submitBacklinkMutation({ journalPath, linkTarget, section, noteId, mutationService, intentId, vaultRoot: suppliedVaultRoot } = {}) {
  const vaultRoot = suppliedVaultRoot || mutationService?.vaultRoot || resolveVaultRootForJournal(journalPath);
  const vaultRelativePath = journalPathRelativeToVault(journalPath, vaultRoot);
  const service = mutationService || createObsidianOwnedMutationService({ vaultRoot, source: 'bridge.link-to-journal' });
  const context = operationContext(service, vaultRelativePath, intentId || `journal-backlink-${crypto.randomUUID()}`);
  return executeContext(service, context, {
    schemaVersion: 1,
    operationId: context.operationId,
    vaultId: context.vaultId,
    vaultRelativePath,
    sequence: context.sequence,
    operationKind: 'transform',
    transformName: 'journal-backlink',
    transformVersion: 1,
    replayPayload: { linkTarget, section, ...(noteId ? { noteId } : {}) },
    source: context.source,
  });
}

function submitJournalCreate({ journalPath, mutationService, intentId, vaultRoot: suppliedVaultRoot } = {}) {
  const vaultRoot = suppliedVaultRoot || mutationService?.vaultRoot || resolveVaultRootForJournal(journalPath);
  const vaultRelativePath = journalPathRelativeToVault(journalPath, vaultRoot);
  const service = mutationService || createObsidianOwnedMutationService({ vaultRoot, source: 'bridge.link-to-journal' });
  const context = operationContext(service, vaultRelativePath, intentId || `journal-create-${crypto.randomUUID()}`);
  const content = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : renderInitialJournal(journalPath);
  return executeContext(service, context, {
    schemaVersion: 1,
    operationId: context.operationId,
    vaultId: context.vaultId,
    vaultRelativePath,
    sequence: context.sequence,
    operationKind: 'create',
    content,
    source: context.source,
  });
}

// Compatibility wrapper for the jarvos-agent-context MCP, which calls
// linkNoteToJournal({ noteTitle, section, createIfMissing }) (WS7 cross-tool unification).
function linkNoteToJournal({
  noteTitle,
  section = '📝 Notes',
  journalPath = todayPath(),
  createIfMissing = true,
  mutationService,
  noteId,
  notePath,
  deferOnFailure = true,
  intentId,
  vaultRoot,
} = {}) {
  if (!noteTitle) throw new Error('noteTitle is required');
  const normalizedSection = normalizeSectionName(section);
  const stableIntent = intentId || `backlink-${crypto.randomUUID()}`;
  let receipt;
  try {
    if (createIfMissing) {
      const createReceipt = submitJournalCreate({ journalPath, mutationService, intentId: `${stableIntent}:create`, vaultRoot });
      if (!receiptAcknowledged(createReceipt)) throw Object.assign(new Error('Journal scaffold is not acknowledged by Obsidian'), { receipt: createReceipt });
    } else if (!existsSync(journalPath)) {
      throw new Error(`Journal not found: ${journalPath}`);
    }
    receipt = submitBacklinkMutation({ journalPath, linkTarget: noteTitle, section: normalizedSection, noteId, mutationService, intentId: `${stableIntent}:backlink`, vaultRoot });
    if (!receiptAcknowledged(receipt)) throw Object.assign(new Error('Journal backlink is not acknowledged by Obsidian'), { receipt });
  } catch (error) {
    if (!deferOnFailure) throw error;
    const deferred = recordDeferredBacklink({
      journalPath,
      noteTitle,
      section: normalizedSection,
      reason: 'journal-mutation-failed',
      noteId,
      notePath,
      mutationIntentId: stableIntent,
    });
    const wrapped = new Error(`${error.message}; backlink queued at ${deferred.deferredPath}`);
    wrapped.cause = error;
    wrapped.deferredBacklink = deferred;
    throw wrapped;
  }
  return {
    linked: true,
    journalPath,
    alreadyPresent: receipt.status === 'already_satisfied',
    mutationOwner: 'obsidian-vault-process',
    receipt,
    vaultRootDuplicate: { checked: false, repaired: false, reason: 'duplicate cleanup must not bypass Obsidian' },
  };
}

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(input.trim());
    } catch (e) {
      console.error(JSON.stringify({ error: 'Invalid JSON input', detail: e.message }));
      process.exit(1);
    }

    try {
      const { noteTitle, section = '📝 Notes' } = parsed;
      console.log(JSON.stringify(linkNoteToTodayJournal(noteTitle, section)));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exit(1);
    }
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSectionName(section) {
  const stripped = String(section || '📝 Notes').trim().replace(/^##\s*/, '').trim();
  return stripped === '🗂️ Notes Created' ? '📝 Notes' : stripped;
}

function findSectionRange(lines, heading) {
  const sectionLineStart = lines.findIndex((line) => line.trim() === heading);
  if (sectionLineStart === -1) {
    return { sectionLineStart: -1, sectionLineEnd: -1 };
  }

  let sectionLineEnd = lines.length;
  for (let i = sectionLineStart + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      sectionLineEnd = i;
      break;
    }
  }
  return { sectionLineStart, sectionLineEnd };
}

function linkLineRegex(noteTitle) {
  return new RegExp(`^\\s*-\\s*\\[\\[${escapeRegex(noteTitle)}(?:\\|[^\\]]+)?\\]\\]\\s*$`);
}

function linkNoteInSection(journalMd, noteTitle, section = '📝 Notes') {
  const sectionName = normalizeSectionName(section);
  const heading = `## ${sectionName}`;
  const linkText = `- [[${noteTitle}]]`;
  const exactLinkLine = linkLineRegex(noteTitle);

  let lines = journalMd.split('\n');
  let { sectionLineStart, sectionLineEnd } = findSectionRange(lines, heading);

  if (sectionLineStart === -1) {
    const cleaned = lines.filter((line) => !exactLinkLine.test(line)).join('\n');
    const trimmed = cleaned.trimEnd();
    lines = `${trimmed}\n\n${heading}\n${linkText}\n`.split('\n');
    return { content: lines.join('\n'), alreadyPresent: false };
  }

  const before = lines.slice(0, sectionLineStart + 1).filter((line) => !exactLinkLine.test(line));
  const sectionLines = lines.slice(sectionLineStart + 1, sectionLineEnd);
  const after = lines.slice(sectionLineEnd).filter((line) => !exactLinkLine.test(line));
  const sectionHadLink = sectionLines.some((line) => exactLinkLine.test(line));

  const cleanedSection = sectionLines.filter((line) => {
    if (exactLinkLine.test(line)) return false;
    if (!sectionHadLink && line.trim() === '-') return false;
    return true;
  });

  const rebuilt = [
    ...before,
    linkText,
    ...cleanedSection,
    ...after,
  ];

  return {
    content: rebuilt.join('\n'),
    alreadyPresent: sectionHadLink,
  };
}

module.exports = {
  main,
  todayPath,
  dateFromJournalPath,
  deferredBacklinksPath,
  deferredQueuePathForJournalDir,
  ensureJournalFile,
  escapeRegex,
  isPathInside,
  linkNoteInSection,
  linkNoteToTodayJournal,
  linkNoteToJournal,
  flushDeferredBacklinks,
  reconcileDeferredBacklink,
  classifyDeferredBacklink,
  normalizeVaultRelativeNotePath,
  readNoteId,
  mutateJournalThroughObsidian,
  normalizeSectionName,
  obsidianMutationScript,
  parseObsidianEvalResult,
  recordDeferredBacklink,
  resolveVaultRootForJournal,
  runObsidianEval,
};

if (require.main === module) {
  main();
}
