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
const { getVaultDir, getVaultJournalDir } = require('../../../bridge/provenance/src/lib/provenance-config.js');
const {
  artifactFromMutationResult,
  createArtifactReceipt,
} = require('../../../src/artifact-receipt');

const IDEAS_HEADING = '## 💡 Ideas';
const NOTES_HEADING = '## 📝 Notes';
const FLAGGED_HEADING = '## 📌 Flagged';

function todayDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
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
  function contextFor(vaultRelativePath, intentId) { return service.createWriteContext({ vaultRelativePath, intentId, operationSource: service.source }); }
  function executeTransform({ date, transformName, replayPayload, intentId }) {
    const journalPath = path.join(journalDir, `${date}.md`);
    const vaultRelativePath = relativeToVault(vaultRoot, journalPath);
    const context = contextFor(vaultRelativePath, intentId);
    const receipt = context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath, sequence: context.sequence, operationKind: 'transform', transformName, transformVersion: 1, replayPayload, source: context.source });
    return { journalPath, receipt };
  }
  return Object.freeze({
    ensureJournal({ date = todayDate(), intentId } = {}) {
      const journalPath = path.join(journalDir, `${date}.md`);
      const existed = fs.existsSync(journalPath);
      const vaultRelativePath = relativeToVault(vaultRoot, journalPath);
      const context = contextFor(vaultRelativePath, intentId || `journal-create-${date}-${crypto.randomUUID()}`);
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
    appendLineToJournalSection({ heading, line, date = todayDate(), intentId } = {}) {
      if (!heading) throw new Error('heading is required');
      if (!line || !String(line).trim()) throw new Error('line is required');
      const ensured = this.ensureJournal({ date, intentId: intentId ? `${intentId}:create` : undefined });
      if (!receiptIsAcknowledged(ensured.receipt)) return { journalPath: ensured.journalPath, heading, line: String(line).trim(), receipt: ensured.receipt, acknowledged: false, artifactReceipt: ensured.artifactReceipt };
      const outcome = executeTransform({ date, transformName: 'journal-section-line', replayPayload: { heading, line }, intentId: intentId ? `${intentId}:section` : undefined });
      return {
        journalPath: outcome.journalPath,
        heading,
        line: String(line).trim(),
        receipt: outcome.receipt,
        acknowledged: receiptIsAcknowledged(outcome.receipt),
        alreadyPresent: outcome.receipt.status === 'already_satisfied',
        artifactReceipt: artifactReceiptFor([
          ...(ensured.artifactReceipt?.artifacts || []),
          journalArtifact({ journalPath: outcome.journalPath, vaultRoot, receipt: outcome.receipt, intent: 'user_requested' }),
        ]),
      };
    },
    writeNote({ title, content, frontmatter = {}, intentId } = {}) {
      const filePath = noteFilePath(title);
      return writeNoteFile({ title, content, frontmatter, ...contextFor(relativeToVault(vaultRoot, filePath), intentId) });
    },
    linkNoteToJournal({ noteTitle, noteId, date = todayDate(), heading = NOTES_HEADING, intentId } = {}) {
      if (!noteTitle) throw new Error('noteTitle is required');
      const ensured = this.ensureJournal({ date, intentId: intentId ? `${intentId}:create` : undefined });
      if (!receiptIsAcknowledged(ensured.receipt)) return { journalPath: ensured.journalPath, receipt: ensured.receipt, acknowledged: false, artifactReceipt: ensured.artifactReceipt };
      const outcome = executeTransform({ date, transformName: 'journal-backlink', replayPayload: { linkTarget: noteTitle, section: heading, ...(noteId ? { noteId } : {}) }, intentId: intentId ? `${intentId}:backlink` : undefined });
      return {
        journalPath: outcome.journalPath,
        receipt: outcome.receipt,
        acknowledged: receiptIsAcknowledged(outcome.receipt),
        alreadyPresent: outcome.receipt.status === 'already_satisfied',
        artifactReceipt: artifactReceiptFor([
          ...(ensured.artifactReceipt?.artifacts || []),
          journalArtifact({ journalPath: outcome.journalPath, vaultRoot, receipt: outcome.receipt, intent: 'auxiliary' }),
        ]),
      };
    },
  });
}

module.exports = { FLAGGED_HEADING, IDEAS_HEADING, NOTES_HEADING, createVaultStorageAdapter, relativeToVault, renderJournalScaffold, todayDate };
