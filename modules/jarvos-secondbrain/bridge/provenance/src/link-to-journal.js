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
} = require('fs');
const { mkdirSync } = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('path');
const {
  getTimeZone,
  getVaultDir,
  getVaultJournalDir,
  getVaultNotesDir,
} = require('./lib/provenance-config');
const { repairZeroByteVaultRootDuplicate } = require('../../../packages/jarvos-secondbrain-notes/src/lib/vault-root-duplicate-guard');
const {
  loadConfig,
  normalizeSections,
  renderJournal,
} = require('../../../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');

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

function renderInitialJournal(journalPath, date = dateFromJournalPath(journalPath)) {
  const config = loadConfig();
  const normalized = normalizeSections('', date, config);
  return renderJournal(date, config, normalized);
}

function ensureJournalFile(journalPath, date = dateFromJournalPath(journalPath)) {
  if (existsSync(journalPath)) return;
  const rendered = renderInitialJournal(journalPath, date);
  mkdirSync(path.dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, rendered, 'utf8');
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
  return path.join(path.dirname(path.dirname(journalPath)), '.jarvos', 'journal-maintenance', 'deferred-backlinks.json');
}

function recordDeferredBacklink({ journalPath, noteTitle, section, reason }) {
  const deferredPath = deferredBacklinksPath(journalPath);
  const key = crypto.createHash('sha256')
    .update(`${journalPath}\0${section}\0${noteTitle}`)
    .digest('hex')
    .slice(0, 16);
  withDeferredQueueLock(deferredPath, () => {
    const data = readDeferredQueue(deferredPath);
    const now = new Date().toISOString();
    data.version = 1;
    data.updatedAt = now;
    data.entries[key] = {
      status: 'pending',
      reason,
      noteTitle,
      section,
      journalPath,
      recordedAt: data.entries[key]?.recordedAt || now,
      updatedAt: now,
    };
    writeJson(deferredPath, data);
  });
  return { deferredPath, key };
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
} = {}) {
  if (!noteTitle) throw new Error('noteTitle is required');

  const existedBefore = existsSync(journalPath);
  if (!existedBefore && !createIfMissing) throw new Error(`Journal not found: ${journalPath}`);
  const normalizedSection = normalizeSectionName(section);
  const useObsidianOwnedMutation = isTodayJournalPath(journalPath)
    && process.env.JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE !== '1';
  if (!existedBefore && !useObsidianOwnedMutation) ensureJournalFile(journalPath);
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
        initialContent: existedBefore ? undefined : renderInitialJournal(journalPath),
      });
    } else {
      writeFileSync(journalPath, existing.content, 'utf8');
      mutation = { alreadyPresent: false, mutationOwner: 'jarvos-filesystem' };
    }
  } catch (error) {
    const deferred = recordDeferredBacklink({
      journalPath,
      noteTitle,
      section: normalizedSection,
      reason: 'journal-mutation-failed',
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
  ensureJournalFile,
  escapeRegex,
  linkNoteInSection,
  linkNoteToTodayJournal,
  linkNoteToJournal,
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
