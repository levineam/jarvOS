#!/usr/bin/env node
// Bridge-owned canonical note→journal linker.
// Input (stdin): { "noteTitle": "...", "section": "📝 Notes" }
// Finds today's journal, adds [[noteTitle]] under the specified section if not present.
// Output: { "linked": true, "journalPath": "...", "alreadyPresent": false }

'use strict';

const { readFileSync, writeFileSync, existsSync } = require('fs');
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
  if (existsSync(journalPath)) return;
  const config = loadConfig();
  const normalized = normalizeSections('', date, config);
  const rendered = renderJournal(date, config, normalized);
  mkdirSync(path.dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, rendered, 'utf8');
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function journalPathRelativeToVault(journalPath) {
  const vaultRoot = path.resolve(getVaultDir());
  const relativePath = path.relative(vaultRoot, path.resolve(journalPath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Journal is outside the active Obsidian vault: ${journalPath}`);
  }
  return relativePath.split(path.sep).join('/');
}

function obsidianMutationScript({ journalPath, noteTitle, section, token }) {
  const payload = Buffer.from(JSON.stringify({
    journalPath: journalPathRelativeToVault(journalPath),
    noteTitle,
    section,
    token,
  }), 'utf8').toString('base64');
  const helpers = [escapeRegex, normalizeSectionName, findSectionRange, linkLineRegex, linkNoteInSection]
    .map((fn) => fn.toString())
    .join('\n');

  return `(() => {
    ${helpers}
    const bytes = Uint8Array.from(atob('${payload}'), (char) => char.charCodeAt(0));
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const store = globalThis.${OBSIDIAN_MUTATION_RESULT_STORE} ||= {};
    const file = app.vault.getFileByPath(input.journalPath);
    if (!file) throw new Error('Journal not found in Obsidian vault: ' + input.journalPath);
    store[input.token] = { status: 'pending' };
    app.vault.process(file, (current) => {
      const mutation = linkNoteInSection(current, input.noteTitle, input.section);
      store[input.token] = { status: 'writing', alreadyPresent: mutation.alreadyPresent };
      return mutation.content;
    }).then(() => {
      store[input.token] = { ...store[input.token], status: 'done' };
    }).catch((error) => {
      store[input.token] = { status: 'error', error: error?.message || String(error) };
    });
    return JSON.stringify({ queued: true, token: input.token });
  })()`;
}

function mutateJournalThroughObsidian({
  journalPath,
  noteTitle,
  section,
  evaluate = runObsidianEval,
  maxPollAttempts = 40,
  pollIntervalMs = 50,
} = {}) {
  const token = crypto.randomUUID();
  const queued = evaluate(obsidianMutationScript({ journalPath, noteTitle, section, token }));
  if (!queued?.queued || queued.token !== token) {
    throw new Error('Obsidian did not acknowledge the journal mutation');
  }

  let result = null;
  try {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      if (attempt > 0) sleepSync(pollIntervalMs);
      result = evaluate(`JSON.stringify(globalThis.${OBSIDIAN_MUTATION_RESULT_STORE}?.['${token}'] || null)`);
      if (result?.status === 'done') break;
      if (result?.status === 'error') throw new Error(`Obsidian journal mutation failed: ${result.error}`);
    }
    if (result?.status !== 'done') throw new Error('Timed out waiting for Obsidian to commit the journal mutation');
  } finally {
    try {
      evaluate(`delete globalThis.${OBSIDIAN_MUTATION_RESULT_STORE}?.['${token}']; JSON.stringify(true)`);
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
  const data = readJsonSafe(deferredPath, { version: 1, entries: {} });
  const now = new Date().toISOString();
  const key = crypto.createHash('sha256')
    .update(`${journalPath}\0${section}\0${noteTitle}`)
    .digest('hex')
    .slice(0, 16);
  data.version = 1;
  data.updatedAt = now;
  data.entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
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

  if (!existsSync(journalPath)) {
    if (!createIfMissing) throw new Error(`Journal not found: ${journalPath}`);
    ensureJournalFile(journalPath);
  }
  const normalizedSection = normalizeSectionName(section);
  const original = readFileSync(journalPath, 'utf8');
  const existing = linkNoteInSection(original, noteTitle, normalizedSection);
  let mutation;
  try {
    if (existing.alreadyPresent) {
      mutation = { alreadyPresent: true, mutationOwner: 'existing-journal-content' };
    } else if (isTodayJournalPath(journalPath)
      && process.env.JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE !== '1') {
      mutation = ownedJournalMutator({ journalPath, noteTitle, section: normalizedSection });
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
  const vaultRootDuplicate = repairZeroByteVaultRootDuplicate({
    noteTitle,
    notesDir: getVaultNotesDir(),
    vaultRoot: getVaultDir(),
  });
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
  runObsidianEval,
};

if (require.main === module) {
  main();
}
