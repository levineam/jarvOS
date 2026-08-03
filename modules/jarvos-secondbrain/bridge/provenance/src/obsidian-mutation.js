#!/usr/bin/env node
'use strict';

// Neutral transport for serialized Obsidian vault mutations. Callers provide
// the self-contained content transform and any helper functions it needs;
// note-link policy remains in link-to-journal.js and storage policy remains in
// the Obsidian adapter.

const {
  readFileSync,
} = require('node:fs');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const {
  getVaultDir,
  getVaultJournalDir,
} = require('./lib/provenance-config');

const OBSIDIAN_MUTATION_RESULT_STORE = '__jarvosJournalMutationResults';
const OBSIDIAN_MUTATION_TIMEOUT_MS = 10 * 1000;

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

function isPathInside(parentDir, candidatePath) {
  const relativePath = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function resolveVaultRootForJournal(journalPath, suppliedVaultRoot) {
  if (suppliedVaultRoot) return path.resolve(suppliedVaultRoot);
  const configuredVaultRoot = path.resolve(getVaultDir());
  if (isPathInside(configuredVaultRoot, journalPath)) return configuredVaultRoot;

  const configuredJournalDir = path.resolve(getVaultJournalDir());
  if (isPathInside(configuredJournalDir, journalPath)) return path.dirname(configuredJournalDir);
  return configuredVaultRoot;
}

function journalPathRelativeToVault(journalPath, vaultRoot) {
  const root = resolveVaultRootForJournal(journalPath, vaultRoot);
  const relativePath = path.relative(root, path.resolve(journalPath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Journal is outside the active Obsidian vault: ${journalPath}`);
  }
  return relativePath.split(path.sep).join('/');
}

function obsidianMutationScript({
  journalPath,
  noteTitle,
  section,
  token,
  initialContent,
  mutation,
  mutationPayload = {},
  helperFunctions = [],
  vaultRoot,
}) {
  if (typeof mutation !== 'function') throw new Error('Obsidian journal mutation function is required');
  const payload = Buffer.from(JSON.stringify({
    ...mutationPayload,
    journalPath: journalPathRelativeToVault(journalPath, vaultRoot),
    noteTitle,
    section,
    token,
    initialContent,
  }), 'utf8').toString('base64');
  const helpers = helperFunctions
    .filter((fn) => typeof fn === 'function')
    .map((fn) => fn.toString())
    .join('\n');
  const mutationDeclaration = `const mutateContent = (${mutation.toString()});`;

  return `(() => {
    ${helpers}
    ${mutationDeclaration}
    const bytes = Uint8Array.from(atob('${payload}'), (char) => char.charCodeAt(0));
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const store = globalThis.${OBSIDIAN_MUTATION_RESULT_STORE} ||= {};
    store[input.token] = { status: 'pending' };
    const processFile = (file) => app.vault.process(file, (current) => {
        const result = mutateContent(current, input);
        const nextContent = typeof result === 'string' ? result : result?.content;
        if (typeof nextContent !== 'string') throw new Error('Obsidian journal mutation returned no content');
        store[input.token] = { status: 'writing', alreadyPresent: Boolean(result?.alreadyPresent) };
        return nextContent;
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
  mutation,
  mutationPayload,
  helperFunctions = [],
  vaultRoot,
  verifyCommitted,
  evaluate,
  maxPollAttempts = 40,
  pollIntervalMs = 50,
} = {}) {
  if (typeof mutation !== 'function') throw new Error('Obsidian journal mutation function is required');
  const resolvedVaultRoot = resolveVaultRootForJournal(journalPath, vaultRoot);
  const runEvaluate = evaluate || ((code) => runObsidianEval(code, {
    vaultName: path.basename(resolvedVaultRoot),
  }));
  const token = crypto.randomUUID();
  const queued = runEvaluate(obsidianMutationScript({
    journalPath,
    noteTitle,
    section,
    token,
    initialContent,
    mutation,
    mutationPayload,
    helperFunctions,
    vaultRoot: resolvedVaultRoot,
  }));
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
  if (verifyCommitted && verifyCommitted(committed) === false) {
    throw new Error('Obsidian completed without committing the journal mutation');
  }
  return {
    alreadyPresent: Boolean(result.alreadyPresent),
    mutationOwner: 'obsidian-vault-process',
  };
}

module.exports = {
  isPathInside,
  journalPathRelativeToVault,
  mutateJournalThroughObsidian,
  obsidianMutationScript,
  parseObsidianEvalResult,
  resolveVaultRootForJournal,
  runObsidianEval,
};
