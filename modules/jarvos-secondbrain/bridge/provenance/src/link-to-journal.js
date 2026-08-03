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
const { execFileSync } = require('node:child_process');
const path = require('path');
const { resolveJournalConfig } = require('../../../bridge/config');
const {
  getTimeZone,
  getVaultDir,
  getVaultJournalDir,
  getVaultNotesDir,
} = require('./lib/provenance-config');
const { repairZeroByteVaultRootDuplicate } = require('../../../packages/jarvos-secondbrain-notes/src/lib/vault-root-duplicate-guard');
const {
  ensureTodayJournal,
  mutateExistingJournal,
} = require('../../../packages/jarvos-secondbrain-journal/src/journal-lifecycle.js');

const OBSIDIAN_MUTATION_RESULT_STORE = '__jarvosJournalMutationResults';
const OBSIDIAN_MUTATION_TIMEOUT_MS = 10 * 1000;
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

function ensureJournalFile(journalPath, date = dateFromJournalPath(journalPath)) {
  const configured = resolveJournalConfig();
  if (path.resolve(configured.journalDir) !== path.resolve(path.dirname(journalPath))) {
    throw new Error('journal ensure target does not match configured journal directory');
  }
  const result = ensureTodayJournal({
    journalDir: configured.journalDir,
    timeZone: configured.timeZone,
  });
  if (!result.ok || result.date !== date || !existsSync(journalPath)) {
    throw new Error(`journal ensure ${result.outcome || 'failed'}`);
  }
  return result;
}

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
    try {
      const journal = existsSync(entry.journalPath) ? readFileSync(entry.journalPath, 'utf8') : '';
      if (journal.split(/\r?\n/).some((line) => linkLineRegex(entry.noteTitle).test(line))) {
        return { status: 'linked', reason: 'legacy-exact-link-present', noteTitle: entry.noteTitle };
      }
    } catch {
      return { status: 'unresolved', reason: 'legacy-journal-unreadable' };
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

function parseObsidianEvalResult(output) {
  const matches = [...String(output || '').matchAll(/^=>\s*(.+)$/gm)];
  if (!matches.length) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]);
  } catch (error) {
    throw new Error(`Obsidian CLI returned invalid JSON: ${error.message}`);
  }
}

function runObsidianEval(code, {
  vaultName = path.basename(getVaultDir()),
  command = process.env.OBSIDIAN_CLI || 'obsidian',
  timeoutMs = OBSIDIAN_MUTATION_TIMEOUT_MS,
  execute = execFileSync,
} = {}) {
  let output;
  try {
    output = execute(command, [`vault=${vaultName}`, 'eval', `code=${code}`], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    throw new Error(`Obsidian CLI eval failed${detail ? `: ${detail}` : ''}`);
  }
  return parseObsidianEvalResult(output);
}

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

function journalPathRelativeToVault(journalPath) {
  const vaultRoot = resolveVaultRootForJournal(journalPath);
  const relativePath = path.relative(vaultRoot, path.resolve(journalPath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Journal is outside the active Obsidian vault: ${journalPath}`);
  }
  return relativePath.split(path.sep).join('/');
}

function obsidianMutationScript({ journalPath, noteTitle, section, token, initialContent }) {
  const payload = Buffer.from(JSON.stringify({
    journalPath: journalPathRelativeToVault(journalPath),
    noteTitle,
    section,
    token,
    initialContent,
  }), 'utf8').toString('base64');
  const helpers = [escapeRegex, normalizeSectionName, findSectionRange, linkLineRegex, linkNoteInSection]
    .map((fn) => fn.toString())
    .join('\n');

  return `(() => {
    ${helpers}
    const bytes = Uint8Array.from(atob('${payload}'), (char) => char.charCodeAt(0));
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const store = globalThis.${OBSIDIAN_MUTATION_RESULT_STORE} ||= {};
    store[input.token] = { status: 'pending' };
    const processFile = (file) => app.vault.process(file, (current) => {
        const mutation = linkNoteInSection(current, input.noteTitle, input.section);
        store[input.token] = { status: 'writing', alreadyPresent: mutation.alreadyPresent };
        return mutation.content;
      }).then(() => {
        store[input.token] = { ...store[input.token], status: 'done' };
      }).catch((error) => {
        store[input.token] = { status: 'error', error: error?.message || String(error) };
      });
    const existing = app.vault.getFileByPath(input.journalPath);
    if (existing) {
      processFile(existing);
    } else if (typeof input.initialContent === 'string') {
      app.vault.create(input.journalPath, input.initialContent)
        .then(processFile)
        .catch((error) => {
          const concurrentlyCreated = app.vault.getFileByPath(input.journalPath);
          if (concurrentlyCreated) processFile(concurrentlyCreated);
          else store[input.token] = { status: 'error', error: error?.message || String(error) };
        });
    } else {
      store[input.token] = { status: 'error', error: 'Journal not found in Obsidian vault: ' + input.journalPath };
    }
    return JSON.stringify({ queued: true, token: input.token });
  })()`;
}

function mutateJournalThroughObsidian({
  journalPath,
  noteTitle,
  section,
  initialContent,
  evaluate,
  maxPollAttempts = 40,
  pollIntervalMs = 50,
} = {}) {
  const runEvaluate = evaluate || ((code) => runObsidianEval(code, {
    vaultName: path.basename(resolveVaultRootForJournal(journalPath)),
  }));
  const token = crypto.randomUUID();
  const queued = runEvaluate(obsidianMutationScript({ journalPath, noteTitle, section, token, initialContent }));
  if (!queued?.queued || queued.token !== token) {
    throw new Error('Obsidian did not acknowledge the journal mutation');
  }

  let result = null;
  try {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      if (attempt > 0) sleepSync(pollIntervalMs);
      result = runEvaluate(`JSON.stringify(globalThis.${OBSIDIAN_MUTATION_RESULT_STORE}?.['${token}'] || null)`);
      if (result?.status === 'done') break;
      if (result?.status === 'error') throw new Error(`Obsidian journal mutation failed: ${result.error}`);
    }
    if (result?.status !== 'done') throw new Error('Timed out waiting for Obsidian to commit the journal mutation');
  } finally {
    try {
      runEvaluate(`delete globalThis.${OBSIDIAN_MUTATION_RESULT_STORE}?.['${token}']; JSON.stringify(true)`);
    } catch {
      // Cleanup is best-effort and must not mask the mutation result.
    }
  }

  const committed = readFileSync(journalPath, 'utf8');
  const verification = linkNoteInSection(committed, noteTitle, section);
  if (verification.content !== committed) {
    throw new Error(`Obsidian completed without committing [[${noteTitle}]]`);
  }
  return {
    alreadyPresent: Boolean(result.alreadyPresent),
    mutationOwner: 'obsidian-vault-process',
  };
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
  return {
    deferredPath,
    key,
    journalPath,
    noteTitle,
    section,
    ...(noteId ? { noteId } : {}),
    ...(normalizedNotePath ? { notePath: normalizedNotePath } : {}),
  };
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
  ownedJournalMutator,
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
    try {
      const result = linkNoteToJournal({
        noteTitle: classification.noteTitle,
        section: entry.section || '📝 Notes',
        journalPath: entry.journalPath,
        createIfMissing: true,
        ownedJournalMutator,
        deferOnFailure: false,
        noteId: entry.noteId,
        notePath: classification.notePath,
      });
      outcomes.set(entryKey, { key: entryKey, status: 'linked', reason: result.alreadyPresent ? 'exact-link-present' : 'linked', result });
    } catch (error) {
      outcomes.set(entryKey, { key: entryKey, status: 'pending', reason: classification.reason, error: error.message });
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

// Compatibility wrapper for the jarvos-agent-context MCP, which calls
// linkNoteToJournal({ noteTitle, section, createIfMissing }) (WS7 cross-tool unification).
function linkNoteToJournal({
  noteTitle,
  section = '📝 Notes',
  journalPath = todayPath(),
  createIfMissing = true,
  ownedJournalMutator = mutateJournalThroughObsidian,
  noteId,
  notePath,
  deferOnFailure = true,
} = {}) {
  if (!noteTitle) throw new Error('noteTitle is required');

  const existedBefore = existsSync(journalPath);
  if (!existedBefore && !createIfMissing) throw new Error(`Journal not found: ${journalPath}`);
  const normalizedSection = normalizeSectionName(section);
  const useObsidianOwnedMutation = isTodayJournalPath(journalPath)
    && process.env.JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE !== '1';
  if (!existedBefore) ensureJournalFile(journalPath);
  const original = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
  const existing = linkNoteInSection(original, noteTitle, normalizedSection);
  let mutation;
  try {
    if (existing.alreadyPresent) {
      mutation = { alreadyPresent: true, mutationOwner: 'existing-journal-content' };
    } else if (useObsidianOwnedMutation) {
      mutation = ownedJournalMutator({
        journalPath,
        noteTitle,
        section: normalizedSection,
      });
    } else {
      mutateExistingJournal({
        journalPath,
        expectedContent: original,
        nextContent: existing.content,
      });
      mutation = { alreadyPresent: false, mutationOwner: 'jarvos-filesystem' };
    }
  } catch (error) {
    if (!deferOnFailure) throw error;
    const deferred = recordDeferredBacklink({
      journalPath,
      noteTitle,
      section: normalizedSection,
      reason: 'journal-mutation-failed',
      noteId,
      notePath,
    });
    const wrapped = new Error(`${error.message}; backlink queued at ${deferred.deferredPath}`);
    wrapped.cause = error;
    wrapped.deferredBacklink = deferred;
    throw wrapped;
  }
  const effectiveVaultRoot = resolveVaultRootForJournal(journalPath);
  const notesDir = getVaultNotesDir();
  const vaultRootDuplicate = isPathInside(effectiveVaultRoot, notesDir)
    ? repairZeroByteVaultRootDuplicate({ noteTitle, notesDir, vaultRoot: effectiveVaultRoot })
    : {
      checked: false,
      repaired: false,
      reason: 'notes directory is outside the journal vault',
    };
  return {
    linked: true,
    journalPath,
    alreadyPresent: mutation.alreadyPresent,
    mutationOwner: mutation.mutationOwner,
    vaultRootDuplicate,
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
