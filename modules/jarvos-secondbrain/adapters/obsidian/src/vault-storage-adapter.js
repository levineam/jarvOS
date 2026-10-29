#!/usr/bin/env node
'use strict';

// Obsidian-facing composition adapter. It turns storage requests into the
// reviewed operations understood by vault-mutation-adapter; it never edits
// vault Markdown itself.
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { loadConfig, normalizeSections, renderJournal } = require('../../../packages/jarvos-secondbrain-journal/src/journal-maintenance.js');
const { noteFilePath, writeNoteFile } = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault.js');
const { getTimeZone, getVaultDir, getVaultJournalDir } = require('../../../bridge/provenance/src/lib/provenance-config.js');
const { cleanJournalEntryText, digestText } = require('../../../bridge/provenance/src/content-origin-contract.js');
const { vaultFileExists } = require('./vault-mutation-contract');
const {
  artifactFromMutationResult,
  createArtifactReceipt,
} = require('../../../src/artifact-receipt');

const IDEAS_HEADING = '## 💡 Ideas';
const NOTES_HEADING = '## 📝 Notes';
const FLAGGED_HEADING = '## 📌 Flagged';

function todayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: getTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function relativeToVault(vaultRoot, absolutePath) {
  const relative = path.relative(path.resolve(vaultRoot), path.resolve(absolutePath)).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Journal path is outside the configured vault');
  return relative;
}
function renderJournalScaffold(date) {
  const config = loadConfig();
  return renderJournal(date, config, normalizeSections('', date, config));
}
function receiptIsAcknowledged(receipt) { return ['committed', 'already_satisfied'].includes(receipt?.status); }
function artifactReceiptFor(entries = []) {
  return createArtifactReceipt({ artifacts: entries.filter(Boolean) });
}
function journalArtifact({ journalPath, vaultRoot, receipt, intent = 'auxiliary' }) {
  return {
    record: artifactFromMutationResult({
      kind: 'journal',
      vaultRelativePath: relativeToVault(vaultRoot, journalPath),
      result: receipt,
    }),
    intent,
  };
}

function createVaultStorageAdapter({ mutationService, vaultRoot = getVaultDir(), journalDir = getVaultJournalDir(), source = 'obsidian.vault-storage-adapter' } = {}) {
  const service = mutationService || require('../../../src/vault-mutation-service.js').createConfiguredVaultMutationService({ vaultRoot: path.resolve(vaultRoot), source });
  if (typeof service.execute !== 'function' || typeof service.createWriteContext !== 'function') throw new Error('vault storage adapter requires the configured mutation service');
  // An "ensure the journal exists" create is redundant, and a liability, when the
  // journal is already there: its ack can fail on a flaky Obsidian CLI and leave
  // an ambiguous head operation that blocks every later write to that day. Disk
  // bytes alone are not proof the app has registered the file, so presence is
  // confirmed by the service's read of the app vault index. Anything short of a
  // clean "present" (no such read, app unreachable, absent) keeps the create.
  function journalIsPresent(journalPath) {
    const vaultRelativePath = relativeToVault(vaultRoot, journalPath);
    if (!vaultFileExists({ vaultRoot: path.resolve(vaultRoot), vaultRelativePath })) return false;
    return typeof service.vaultFileState === 'function' && service.vaultFileState(vaultRelativePath) === 'present';
  }
  function contextFor(vaultRelativePath, intentId, requestHash) { return service.createWriteContext({ vaultRelativePath, intentId, requestHash, operationSource: service.source }); }
  function executeTransform({ date, transformName, transformVersion = 1, replayPayload, intentId, requestHash }) {
    const journalPath = path.join(journalDir, `${date}.md`);
    const vaultRelativePath = relativeToVault(vaultRoot, journalPath);
    const context = contextFor(vaultRelativePath, intentId, requestHash);
    const receipt = context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath, sequence: context.sequence, operationKind: 'transform', transformName, transformVersion, replayPayload, source: context.source });
    return { journalPath, receipt };
  }
  return Object.freeze({
    ensureJournal({ date = todayDate(), intentId, requestHash } = {}) {
      const journalPath = path.join(journalDir, `${date}.md`);
      const existed = fs.existsSync(journalPath);
      const vaultRelativePath = relativeToVault(vaultRoot, journalPath);
      const context = contextFor(vaultRelativePath, intentId || `journal-create-${date}-${crypto.randomUUID()}`, requestHash);
      const content = existed ? fs.readFileSync(journalPath, 'utf8') : renderJournalScaffold(date);
      const receipt = context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath, sequence: context.sequence, operationKind: 'create', content, source: context.source });
      return {
        journalPath,
        existed,
        receipt,
        acknowledged: receiptIsAcknowledged(receipt),
        artifactReceipt: artifactReceiptFor([journalArtifact({ journalPath, vaultRoot, receipt })]),
      };
    },
    appendLineToJournalSection({ heading, line, date = todayDate(), intentId, requestHash, contentOrigin } = {}) {
      if (!heading) throw new Error('heading is required');
      if (!line || !String(line).trim()) throw new Error('line is required');
      // An existing journal needs only the section operation's app-owned
      // readback. Rechecking the original scaffold's exact bytes after the
      // backlink was added would turn every successful retry into conflict, and
      // an unidentified capture's redundant create can strand the day's FIFO.
      const journalExists = (requestHash && fs.existsSync(path.join(journalDir, `${date}.md`))) || journalIsPresent(path.join(journalDir, `${date}.md`));
      const ensured = journalExists ? null : this.ensureJournal({ date, intentId: intentId ? `${intentId}:create` : undefined, requestHash });
      if (ensured && !receiptIsAcknowledged(ensured.receipt)) return { journalPath: ensured.journalPath, heading, line: String(line).trim(), receipt: ensured.receipt, acknowledged: false, artifactReceipt: ensured.artifactReceipt };
      const cleanLine = cleanJournalEntryText(String(line).trim());
      const canonicalCleanText = cleanLine.startsWith('- ')
        ? cleanLine.slice(2).trim()
        : cleanLine.replace(/^[-\s]+/, '').trim();
      const contentOriginPayload = contentOrigin
        ? {
          ...contentOrigin,
          clean_text_digest: digestText(canonicalCleanText),
        }
        : null;
      const outcome = executeTransform({
        date,
        transformName: 'journal-section-line',
        transformVersion: contentOriginPayload ? 2 : 1,
        replayPayload: { heading, line, ...(contentOriginPayload ? { contentOrigin: contentOriginPayload } : {}) },
        intentId: intentId ? `${intentId}:section` : undefined,
        requestHash,
      });
      return {
        journalPath: outcome.journalPath,
        heading,
        line: String(line).trim(),
        receipt: outcome.receipt,
        acknowledged: receiptIsAcknowledged(outcome.receipt),
        alreadyPresent: outcome.receipt.status === 'already_satisfied',
        artifactReceipt: artifactReceiptFor([
          ...(ensured?.artifactReceipt?.artifacts || []),
          journalArtifact({ journalPath: outcome.journalPath, vaultRoot, receipt: outcome.receipt, intent: 'user_requested' }),
        ]),
      };
    },
    writeNote({ title, content, frontmatter = {}, intentId, requestHash, resolveUserSource, resolveServedModel } = {}) {
      const filePath = noteFilePath(title);
      return writeNoteFile({ title, content, frontmatter, resolveUserSource, resolveServedModel, ...contextFor(relativeToVault(vaultRoot, filePath), intentId, requestHash) });
    },
    linkNoteToJournal({ noteTitle, noteId, date = todayDate(), heading = NOTES_HEADING, intentId } = {}) {
      if (!noteTitle) throw new Error('noteTitle is required');
      const ensured = journalIsPresent(path.join(journalDir, `${date}.md`)) ? null : this.ensureJournal({ date, intentId: intentId ? `${intentId}:create` : undefined });
      if (ensured && !receiptIsAcknowledged(ensured.receipt)) return { journalPath: ensured.journalPath, receipt: ensured.receipt, acknowledged: false, artifactReceipt: ensured.artifactReceipt };
      const outcome = executeTransform({ date, transformName: 'journal-backlink', replayPayload: { linkTarget: noteTitle, section: heading, ...(noteId ? { noteId } : {}) }, intentId: intentId ? `${intentId}:backlink` : undefined });
      return {
        journalPath: outcome.journalPath,
        receipt: outcome.receipt,
        acknowledged: receiptIsAcknowledged(outcome.receipt),
        alreadyPresent: outcome.receipt.status === 'already_satisfied',
        artifactReceipt: artifactReceiptFor([
          ...(ensured?.artifactReceipt?.artifacts || []),
          journalArtifact({ journalPath: outcome.journalPath, vaultRoot, receipt: outcome.receipt, intent: 'auxiliary' }),
        ]),
      };
    },
  });
}

module.exports = { FLAGGED_HEADING, IDEAS_HEADING, NOTES_HEADING, createVaultStorageAdapter, relativeToVault, renderJournalScaffold, todayDate };
