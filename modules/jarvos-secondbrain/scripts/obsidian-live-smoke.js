#!/usr/bin/env node
// Explicit workstation-only smoke for the canonical Obsidian Vault.process backlink path.
// It is intentionally disabled unless JARVOS_LIVE_OBSIDIAN_SMOKE=1.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  getVaultDir,
  getVaultJournalDir,
  getVaultNotesDir,
} = require('../bridge/provenance/src/lib/provenance-config');
const {
  linkNoteInSection,
  mutateJournalThroughObsidian,
  readNoteId,
  runObsidianEval,
} = require('../bridge/provenance/src/link-to-journal');

const LIVE_GATE = 'JARVOS_LIVE_OBSIDIAN_SMOKE';
const JOURNAL_PATH_ENV = 'JARVOS_LIVE_OBSIDIAN_JOURNAL_PATH';
const NOTE_PATH_ENV = 'JARVOS_LIVE_OBSIDIAN_NOTE_PATH';
const NOTE_TARGET_ENV = 'JARVOS_LIVE_OBSIDIAN_NOTE_TARGET';
const MINIMUM_OBSIDIAN_VERSION = [1, 12, 7];

function isPathInside(parentDir, candidatePath) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveConfiguredPath(value, root, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required when ${LIVE_GATE}=1`);
  }
  const resolved = path.resolve(root, value);
  if (!isPathInside(root, resolved)) throw new Error(`${label} must be inside ${root}: ${value}`);
  return resolved;
}

function relativePathFromVault(vaultRoot, filePath) {
  return path.relative(vaultRoot, filePath).split(path.sep).join('/');
}

function noteTargetForPath(vaultRoot, notePath, configuredTarget) {
  const target = configuredTarget || relativePathFromVault(vaultRoot, notePath).replace(/\.md$/i, '');
  if (typeof target !== 'string' || !target.trim() || /[\r\n\[\]]/.test(target)) {
    throw new Error(`${NOTE_TARGET_ENV} must be a non-empty Obsidian link target without brackets or newlines`);
  }
  return target.trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalLinkCount(journalContent, noteTarget) {
  const link = new RegExp(`^\\s*-\\s*\\[\\[${escapeRegex(noteTarget)}\\]\\]\\s*$`, 'gm');
  return [...String(journalContent).matchAll(link)].length;
}

function parseObsidianVersion(output) {
  const match = String(output || '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

function isSupportedObsidianVersion(version) {
  if (!Array.isArray(version) || version.length !== 3 || version.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < MINIMUM_OBSIDIAN_VERSION.length; index += 1) {
    if (version[index] !== MINIMUM_OBSIDIAN_VERSION[index]) return version[index] > MINIMUM_OBSIDIAN_VERSION[index];
  }
  return true;
}

function verifyObsidianCli({ command = 'obsidian', execute = execFileSync } = {}) {
  let output;
  try {
    output = execute(command, ['version'], {
      encoding: 'utf8',
      timeout: 10 * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    throw new Error(`Registered Obsidian CLI could not run \`${command} version\`${detail ? `: ${detail}` : ''}`);
  }
  const version = parseObsidianVersion(output);
  if (!isSupportedObsidianVersion(version)) {
    throw new Error(`Obsidian CLI must report version ${MINIMUM_OBSIDIAN_VERSION.join('.')} or newer; got ${String(output).trim() || '(no version)'}`);
  }
  return { command, version: version.join('.') };
}

function buildVaultVerificationCode({ journalRelativePath, noteRelativePath, noteTarget }) {
  const payload = Buffer.from(JSON.stringify({ journalRelativePath, noteRelativePath, noteTarget }), 'utf8').toString('base64');
  return `(() => {
    const bytes = Uint8Array.from(atob('${payload}'), (char) => char.charCodeAt(0));
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const journal = app.vault.getFileByPath(input.journalRelativePath);
    const note = app.vault.getFileByPath(input.noteRelativePath);
    const target = app.metadataCache.getFirstLinkpathDest(input.noteTarget, input.journalRelativePath);
    return JSON.stringify({
      vaultName: app.vault.getName(),
      journalPath: journal?.path || null,
      notePath: note?.path || null,
      linkTargetPath: target?.path || null,
    });
  })()`;
}

function resolveLivePair(env = process.env, roots = {}) {
  const vaultRoot = path.resolve(roots.vaultRoot || getVaultDir());
  const journalDir = path.resolve(roots.journalDir || getVaultJournalDir());
  const notesDir = path.resolve(roots.notesDir || getVaultNotesDir());
  if (!isPathInside(vaultRoot, journalDir) || !isPathInside(vaultRoot, notesDir)) {
    throw new Error('Configured Journal and Notes directories must be inside the configured vault');
  }

  const journalPath = resolveConfiguredPath(env[JOURNAL_PATH_ENV], vaultRoot, JOURNAL_PATH_ENV);
  const notePath = resolveConfiguredPath(env[NOTE_PATH_ENV], vaultRoot, NOTE_PATH_ENV);
  if (!isPathInside(journalDir, journalPath) || path.extname(journalPath).toLowerCase() !== '.md') {
    throw new Error(`${JOURNAL_PATH_ENV} must name a Markdown file inside ${journalDir}`);
  }
  if (!isPathInside(notesDir, notePath) || path.extname(notePath).toLowerCase() !== '.md') {
    throw new Error(`${NOTE_PATH_ENV} must name a Markdown file inside ${notesDir}`);
  }
  if (!fs.existsSync(journalPath) || !fs.statSync(journalPath).isFile()) {
    throw new Error(`Configured journal does not exist: ${journalPath}`);
  }
  if (!fs.existsSync(notePath) || !fs.statSync(notePath).isFile()) {
    throw new Error(`Configured note does not exist: ${notePath}`);
  }
  const noteId = readNoteId(notePath);
  if (!noteId) throw new Error(`Configured note has no jarvos_note_id: ${notePath}`);

  return {
    vaultRoot,
    journalPath,
    notePath,
    noteId,
    journalRelativePath: relativePathFromVault(vaultRoot, journalPath),
    noteRelativePath: relativePathFromVault(vaultRoot, notePath),
    noteTarget: noteTargetForPath(vaultRoot, notePath, env[NOTE_TARGET_ENV]),
  };
}

function assertPreconditions({ pair, evaluate, readFile = fs.readFileSync }) {
  const vault = evaluate(buildVaultVerificationCode(pair));
  if (!vault || vault.vaultName !== path.basename(pair.vaultRoot)) {
    throw new Error(`Obsidian CLI targeted the wrong vault: expected ${path.basename(pair.vaultRoot)}, got ${vault?.vaultName || '(none)'}`);
  }
  if (vault.journalPath !== pair.journalRelativePath || vault.notePath !== pair.noteRelativePath) {
    throw new Error('Obsidian CLI could not resolve the configured existing journal-note pair');
  }
  if (vault.linkTargetPath !== pair.noteRelativePath) {
    throw new Error(`Configured note target does not resolve to the selected note: [[${pair.noteTarget}]]`);
  }

  const journal = readFile(pair.journalPath, 'utf8');
  const canonical = linkNoteInSection(journal, pair.noteTarget);
  if (!canonical.alreadyPresent || canonical.content !== journal || canonicalLinkCount(journal, pair.noteTarget) !== 1) {
    throw new Error(`Configured journal must already contain exactly one canonical link: [[${pair.noteTarget}]]`);
  }
  return journal;
}

function runLiveSmoke({
  env = process.env,
  roots,
  evaluate,
  mutate = mutateJournalThroughObsidian,
  readFile = fs.readFileSync,
  execute = execFileSync,
} = {}) {
  if (env[LIVE_GATE] !== '1') {
    return { skipped: true, reason: `${LIVE_GATE} is not 1` };
  }

  const command = env.OBSIDIAN_CLI || 'obsidian';
  const cli = verifyObsidianCli({ command, execute });
  const pair = resolveLivePair(env, roots);
  const runner = evaluate || ((code) => runObsidianEval(code, {
    vaultName: path.basename(pair.vaultRoot),
    command: cli.command,
  }));
  const before = assertPreconditions({ pair, evaluate: runner, readFile });

  for (let pass = 1; pass <= 2; pass += 1) {
    const result = mutate({
      journalPath: pair.journalPath,
      noteTitle: pair.noteTarget,
      section: '📝 Notes',
      evaluate: runner,
    });
    if (!result?.alreadyPresent || result.mutationOwner !== 'obsidian-vault-process') {
      throw new Error(`Canonical Obsidian mutation did not report an existing no-op link on pass ${pass}`);
    }
    const current = readFile(pair.journalPath, 'utf8');
    if (current !== before || canonicalLinkCount(current, pair.noteTarget) !== 1) {
      throw new Error(`Canonical Obsidian mutation changed the journal or duplicated [[${pair.noteTarget}]] on pass ${pass}`);
    }
  }

  return {
    skipped: false,
    vault: pair.vaultRoot,
    journalPath: pair.journalPath,
    notePath: pair.notePath,
    noteId: pair.noteId,
    noteTarget: pair.noteTarget,
    obsidianVersion: cli.version,
    linkCount: 1,
    mutationPasses: 2,
  };
}

function main() {
  try {
    const result = runLiveSmoke();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

module.exports = {
  LIVE_GATE,
  JOURNAL_PATH_ENV,
  NOTE_PATH_ENV,
  NOTE_TARGET_ENV,
  MINIMUM_OBSIDIAN_VERSION,
  buildVaultVerificationCode,
  canonicalLinkCount,
  parseObsidianVersion,
  resolveLivePair,
  runLiveSmoke,
  verifyObsidianCli,
};

if (require.main === module) main();
