#!/usr/bin/env node
// Executable Obsidian note <-> journal contract for AI personalities.

'use strict';

const fs = require('fs');
const path = require('path');
const { writeNoteFile, todayDate } = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault');
const { sourcePathFor } = require('../../../packages/jarvos-secondbrain-notes/src/knowledge-optimizer');
const { getVaultNotesDir, getVaultJournalDir } = require('./lib/provenance-config');
const { frontmatterToObject, parseFrontmatter } = require('../../../packages/jarvos-secondbrain-notes/src/lib/note-schema');
const { createObsidianOwnedMutationService } = require('./obsidian-mutation');
const { linkNoteToJournal } = require('./link-to-journal');
const { createArtifactReceipt } = require('../../../src/artifact-receipt');

const SUPPORTED_PERSONALITIES = new Set(['michael', 'claude-code', 'hermes', 'codex']);
const LIGHTWEIGHT_IDEA_RE = /^\s*idea\s*[:\-]/i;

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInsideDir(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function countJournalBacklinks(journalMd, title) {
  const re = new RegExp(`(^|\\n)\\s*-\\s*\\[\\[${escapeRegex(title)}(?:\\|[^\\]]+)?\\]\\]\\s*(?=\\n|$)`, 'g');
  const matches = String(journalMd || '').match(re);
  return matches ? matches.length : 0;
}

function parseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('input must be a JSON object');
  }
  const personality = String(input.personality || '').trim().toLowerCase();
  if (!SUPPORTED_PERSONALITIES.has(personality)) {
    throw new Error(`unsupported personality "${input.personality || ''}"; expected one of ${[...SUPPORTED_PERSONALITIES].join(', ')}`);
  }
  if (!input.title || typeof input.title !== 'string') throw new Error('title is required');
  if (input.content === undefined || input.content === null) throw new Error('content is required');
  if (input.frontmatter !== undefined && (!input.frontmatter || typeof input.frontmatter !== 'object' || Array.isArray(input.frontmatter))) {
    throw new Error('frontmatter must be an object when provided');
  }
  if (
    LIGHTWEIGHT_IDEA_RE.test(String(input.content || ''))
    && input.substantive !== true
    && input.createDurableNote !== true
    && input.forceDurable !== true
  ) {
    throw new Error('lightweight Idea: captures must use node scripts/jarvos-capture.js; pass substantive:true or createDurableNote:true only for intentional durable idea notes');
  }
  const suppliedFrontmatter = input.frontmatter || {};
  const contentOrigin = input.content_origin ?? input.contentOrigin ?? suppliedFrontmatter.content_origin ?? 'unknown';
  const contentOriginBasis = input.content_origin_basis
    ?? input.contentOriginBasis
    ?? suppliedFrontmatter.content_origin_basis
    ?? 'unknown';
  const contentOriginSource = input.user_source
    ?? input.userSource
    ?? suppliedFrontmatter.content_origin_source;
  const humanEvidenceEligible = input.human_evidence_eligible
    ?? suppliedFrontmatter.human_evidence_eligible
    ?? false;

  return {
    personality,
    title: input.title,
    content: String(input.content),
    frontmatter: {
      ...suppliedFrontmatter,
      source_personality: personality,
      contract: 'obsidian-note-journal-v1',
      content_origin: contentOrigin,
      content_origin_basis: contentOriginBasis,
      ...(contentOriginSource !== undefined ? { content_origin_source: contentOriginSource } : {}),
      human_evidence_eligible: humanEvidenceEligible,
    },
  };
}

function verifyContract(result, personality) {
  const notesDir = getVaultNotesDir();
  const journalDir = getVaultJournalDir();
  const journalPath = path.join(journalDir, `${todayDate()}.md`);
  const failures = [];
  const journal = result.journal || {};
  let journalComplete = false;
  let deferred = false;
  let recoveryKey = null;
  let deferredBacklinkPath = null;
  const noteStatus = result.receipt?.status;
  const noteAcknowledged = ['committed', 'already_satisfied'].includes(noteStatus);
  const notePending = !noteAcknowledged && [
    'saved_locally_sync_pending',
    'deferred',
    'unknown_after_dispatch',
    'unavailable',
    'blocked',
    'conflict',
    'failed',
  ].includes(noteStatus);

  if (!noteStatus) failures.push('missing canonical note mutation receipt');

  if (!isInsideDir(notesDir, result.path)) {
    failures.push(`note path is outside canonical Notes dir: ${result.path}`);
  }

  const noteExists = fs.existsSync(result.path);
  if (!noteExists && !notePending) failures.push(`note does not exist: ${result.path}`);
  const noteMd = noteExists ? fs.readFileSync(result.path, 'utf8') : '';
  const fm = frontmatterToObject(parseFrontmatter(noteMd));
  if (noteExists) {
    for (const field of ['status', 'type', 'project', 'created', 'updated', 'author']) {
      if (fm[field] === undefined) failures.push(`missing canonical frontmatter field: ${field}`);
    }
    if (fm.source_personality !== personality) failures.push(`frontmatter source_personality mismatch: ${fm.source_personality || '(missing)'}`);
    if (fm.contract !== 'obsidian-note-journal-v1') failures.push(`frontmatter contract mismatch: ${fm.contract || '(missing)'}`);
    if (!fm.jarvos_note_id) failures.push('missing writer-owned frontmatter field: jarvos_note_id');
  }

  if (journal.status === 'linked') {
    if (!fs.existsSync(journalPath)) {
      failures.push(`journal does not exist: ${journalPath}`);
    } else {
      const journalMd = fs.readFileSync(journalPath, 'utf8');
      const backlinkCount = countJournalBacklinks(journalMd, result.title);
      if (backlinkCount !== 1) failures.push(`expected exactly one journal backlink for [[${result.title}]], found ${backlinkCount}`);
      else journalComplete = true;
    }
  } else if (journal.status === 'deferred') {
    deferred = true;
    const receipt = journal.deferredBacklink || {};
    deferredBacklinkPath = receipt.deferredPath || journal.deferredPath || null;
    recoveryKey = receipt.key || journal.recoveryKey || null;
    if (!deferredBacklinkPath || !recoveryKey) {
      failures.push('missing deferred backlink queue receipt');
    } else if (!fs.existsSync(deferredBacklinkPath)) {
      failures.push(`deferred backlink queue does not exist: ${deferredBacklinkPath}`);
    } else {
      let deferredQueue;
      try {
        deferredQueue = readJson(deferredBacklinkPath);
      } catch (error) {
        failures.push(`invalid deferred backlink queue: ${error.message}`);
      }
      const entry = deferredQueue?.entries?.[recoveryKey];
      if (!entry) failures.push(`missing deferred backlink queue record: ${recoveryKey}`);
      else {
        if (entry.status !== 'pending') failures.push(`deferred backlink status is ${entry.status || '(missing)'}, expected pending`);
        if (entry.noteTitle !== result.title) failures.push(`deferred backlink note title mismatch: ${entry.noteTitle || '(missing)'}`);
        if (entry.journalPath !== journalPath) failures.push(`deferred backlink journal path mismatch: ${entry.journalPath || '(missing)'}`);
        if (entry.noteId !== fm.jarvos_note_id) failures.push(`deferred backlink note id mismatch: ${entry.noteId || '(missing)'}`);
        const vaultRelativeNotePath = path.relative(path.dirname(journalDir), result.path).split(path.sep).join('/');
        if (entry.notePath !== vaultRelativeNotePath) failures.push(`deferred backlink note path mismatch: ${entry.notePath || '(missing)'}`);
      }
    }
  } else if (notePending && ['pending', 'failed'].includes(journal.status)) {
    // Preserve a valid pending/failed mutation receipt without claiming that
    // a backlink was acknowledged by Obsidian.
  } else {
    failures.push(`journal backlink ${journal.status || 'failure'}: ${journal.reason || 'no durable journal result'}`);
  }

  const qmdPendingPath = result.knowledge?.qmdPendingPath;
  if (noteExists && (!qmdPendingPath || !fs.existsSync(qmdPendingPath))) {
    failures.push('missing QMD pending-refresh queue');
  } else if (noteExists) {
    const qmd = readJson(qmdPendingPath);
    const sourcePath = sourcePathFor(result.path, notesDir);
    const pending = qmd.entries?.[sourcePath];
    if (!pending) failures.push(`missing QMD pending-refresh entry for ${sourcePath}`);
    else if (pending.status !== 'pending-refresh') failures.push(`QMD status is ${pending.status}, expected pending-refresh`);
  }

  if (noteExists && result.knowledge?.qmdStatus !== 'pending-refresh') {
    failures.push(`writer returned QMD status ${result.knowledge?.qmdStatus || '(missing)'}, expected pending-refresh`);
  }

  return {
    ok: failures.length === 0,
    failures,
    notePath: result.path,
    journalPath,
    qmdPendingPath,
    frontmatter: fm,
    journalComplete,
    notePending,
    deferred,
    recoveryKey,
    deferredBacklinkPath,
  };
}

function normalizeJournalResult(result) {
  return result?.linked === true
    ? { ...result, status: 'linked', linked: true, deferred: false, disabled: false, failed: false }
    : { ...result, status: 'failed', linked: false, deferred: false, disabled: false, failed: true, reason: result?.reason || 'journal linker returned an unsuccessful result' };
}

function journalResultFromError(error) {
  const deferredBacklink = error?.deferredBacklink;
  return deferredBacklink?.deferredPath && deferredBacklink?.key
    ? { status: 'deferred', linked: false, deferred: true, disabled: false, failed: false, reason: error.message, deferredBacklink, deferredPath: deferredBacklink.deferredPath, recoveryKey: deferredBacklink.key, artifactReceipt: error.artifactReceipt }
    : { status: 'failed', linked: false, deferred: false, disabled: false, failed: true, reason: error.message };
}

function dispatchBacklink({ result, section = '📝 Notes', createIfMissing = true, link = linkNoteToJournal, mutationService } = {}) {
  if (!result.written && !result.savedLocally) return result.journal;
  try {
    return normalizeJournalResult(link({
      noteTitle: result.title,
      section,
      createIfMissing,
      noteId: result.noteId,
      notePath: result.path,
      mutationService,
    }));
  } catch (error) {
    return journalResultFromError(error);
  }
}

function writeNoteThroughContract(rawInput, { mutationService, link } = {}) {
  const input = parseInput(rawInput);
  const service = mutationService || createObsidianOwnedMutationService({ source: 'bridge.note-journal-contract' });
  const filePath = path.join(getVaultNotesDir(), `${String(input.title).trim().replace(/[/\\:*?"<>|]/g, '-')}.md`);
  const vaultRelativePath = path.relative(service.vaultRoot, filePath).split(path.sep).join('/');
  const writeContext = service.createWriteContext({
    vaultRelativePath,
    intentId: rawInput.intentId,
    operationSource: service.source,
  });
  const noteResult = writeNoteFile({
    title: input.title,
    content: input.content,
    frontmatter: input.frontmatter,
    ...writeContext,
  });
  const result = {
    ...noteResult,
    journal: dispatchBacklink({ result: noteResult, section: rawInput.section || '📝 Notes', createIfMissing: rawInput.createJournalIfMissing !== false, link, mutationService: service }),
  };
  result.artifactReceipt = createArtifactReceipt({ artifacts: [
    ...(noteResult.artifactReceipt?.artifacts || []),
    ...(result.journal?.artifactReceipt?.artifacts || []),
  ] });
  const verification = verifyContract(result, input.personality);
  if (!verification.ok) {
    const err = new Error(`note/journal contract failed: ${verification.failures.join('; ')}`);
    err.result = result;
    err.verification = verification;
    throw err;
  }
  return {
    personality: input.personality,
    written: result.written,
    savedLocally: result.savedLocally,
    title: result.title,
    created: result.created,
    notePath: verification.notePath,
    journalPath: verification.journalPath,
    qmdPendingPath: verification.qmdPendingPath,
    journalBacklink: `[[${result.title}]]`,
    noteId: verification.frontmatter.jarvos_note_id,
    journalStatus: result.journal.status,
    qmdStatus: result.knowledge?.qmdStatus || null,
    mutationStatus: result.receipt?.status || 'unknown',
    artifactReceipt: result.artifactReceipt,
    verification,
  };
}

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(input.trim() || '{}');
      process.stdout.write(`${JSON.stringify(writeNoteThroughContract(parsed), null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        error: error.message,
        failures: error.verification?.failures || [],
      }, null, 2)}\n`);
      process.exit(1);
    }
  });
}

module.exports = {
  SUPPORTED_PERSONALITIES,
  countJournalBacklinks,
  dispatchBacklink,
  main,
  parseInput,
  verifyContract,
  writeNoteThroughContract,
};

if (require.main === module) {
  main();
}
