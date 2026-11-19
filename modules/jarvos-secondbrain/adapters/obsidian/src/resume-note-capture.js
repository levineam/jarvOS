'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { readContainedNote } = require('../../../packages/jarvos-secondbrain-notes/src/write-to-vault.js');
const { parseFrontmatter, frontmatterToObject } = require('../../../packages/jarvos-secondbrain-notes/src/lib/note-schema.js');
const { normalizeDraftingList } = require('../../../bridge/provenance/src/content-origin-contract.js');
const { ENSURE_EXISTS_RESOLUTION } = require('./vault-mutation-reconciler');

const BLOCKED = new Set(['conflict', 'abandoned', 'superseded', 'quarantined']);
const AMBIGUOUS = new Set(['unknown_after_dispatch', 'dispatched', 'local_mutating', 'local_applied']);
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const fields = content => frontmatterToObject(parseFrontmatter(content));
const matches = (adapter, operation) => {
  const check = adapter.inspectInvariant(operation);
  return check.status === 'satisfied' && check.invariant === true;
};

// Local host repair only. Neither the CLI status/Resume request nor Guide can
// provide provenance. Accepted baseline and revision hashes come from the
// owner of the manuscript, and the original save stays in the ledger.
function repairLegacyCaptureProvenance(storage, service, { intentId, originalHash, baselinePath, baselineHash, revision, revisionHash, journalPath } = {}) {
  if (!/^capture:op:[a-f0-9]{64}$/.test(intentId || '')) throw new Error('Invalid capture identity');
  const { adapter, vaultId, vaultRoot, source } = service;
  const data = adapter.ledger.verify({ repairMode: false });
  const reservation = data.captures?.[intentId];
  const original = data.operations[`${intentId}:note`];
  const op = original?.operation;
  if (!op || BLOCKED.has(original.status) || op.operationKind !== 'create' || op.vaultId !== vaultId
    || op.source !== source || reservation?.vaultId !== vaultId || op.captureRequestHash !== reservation.requestHash
    || reservation.plan.resumeNote || reservation.plan.route !== 'note' || typeof revision !== 'string'
    || hash(revision) !== revisionHash || revision.trim() !== reservation.plan.noteContent.trim()
    || hash(op.content) !== originalHash) return { state: 'conflict' };
  const repairKey = `${intentId}:provenance`;
  const existing = data.operations[repairKey];
  if (existing) return resumeNoteCapture(storage, service, { intentId, resume: false });
  const expected = storage.noteCapturePlan({ title: reservation.plan.noteTitle, date: reservation.plan.date });
  if (expected.notePath !== op.vaultRelativePath || expected.journalPath !== journalPath || expected.link !== 'link') return { state: 'conflict' };

  const baseline = typeof baselinePath === 'string' && path.isAbsolute(baselinePath) && readContainedNote(baselinePath, vaultRoot);
  if (!baseline || hash(baseline) !== baselineHash || path.relative(vaultRoot, baselinePath) === op.vaultRelativePath) return { state: 'conflict' };
  const donor = fields(baseline);
  const target = fields(op.content);
  const history = normalizeDraftingList(donor.content_origin_drafting);
  if (!donor.jarvos_note_id || !target.jarvos_note_id || donor.jarvos_note_id === target.jarvos_note_id
    || donor.content_origin !== 'mixed' || donor.content_origin_basis !== 'mixed_composition' || donor.human_evidence_eligible !== false
    || !history.ok || !history.entries.length || history.entries.some(entry => entry.kind === 'user_source' || entry.model_evidence === 'served')) return { state: 'unsupported' };
  const donorPath = path.relative(vaultRoot, baselinePath).split(path.sep).join('/');
  if (!matches(adapter, { ...op, operationId: `${intentId}:baseline`, vaultRelativePath: donorPath, content: baseline })
    || !matches(adapter, op)) return { state: 'unavailable' };
  if (original.status !== 'acknowledged' && !adapter.acknowledgeIfSatisfied(op)) return { state: 'unavailable' };

  const result = storage.writeNote({
    title: reservation.plan.noteTitle, content: reservation.plan.noteContent,
    intentId: repairKey, requestHash: reservation.requestHash, exact: true, expectedExistingContent: op.content,
    frontmatter: {
      content_origin: 'mixed', content_origin_basis: 'mixed_composition',
      content_origin_drafting: [...history.entries, { kind: 'assistant_edit', harness: 'codex', model: 'unknown', model_evidence: 'unknown' }],
      capture_recovery_journal_path: journalPath,
      capture_provenance_correction: { original_operation: op.operationId, original_note_sha256: originalHash,
        inherited_note: donor.jarvos_note_id, inherited_note_sha256: baselineHash, approved_revision_sha256: revisionHash,
        original_declaration: 'incorrect_whole_document_assistant_draft' },
    },
  });
  return { state: result.written ? 'corrected' : 'pending', notePath: op.vaultRelativePath };
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

// This executes stored intent only. Neither the public status nor resume
// accepts fresh text, a path, a request hash or an acknowledgement.
function resumeNoteCapture(storage, service, { intentId, resume = false } = {}) {
  if (!/^capture:op:[a-f0-9]{64}$/.test(intentId || '')) throw new Error('Invalid capture identity');
  const { adapter, vaultId, source } = service;
  const snapshot = () => adapter.ledger.verify({ repairMode: false });
  const data = snapshot();
  const reservation = data.captures?.[intentId];
  if (!reservation) return { state: 'not_found' };
  const { plan, requestHash } = reservation;
  if (reservation.vaultId !== vaultId || !/^[a-f0-9]{64}$/.test(requestHash || '')
    || !plan || !validDate(plan.date) || plan.route !== 'note' || plan.createNote !== true
    || typeof plan.noteTitle !== 'string' || typeof plan.noteContent !== 'string') {
    return { state: 'unsupported' };
  }
  const noteKey = `${intentId}:note`;
  const journalCreateKey = `${intentId}:note-link:create`;
  const journalKey = `${intentId}:note-link:section`;
  const provenanceKey = `${intentId}:provenance`;
  const requested = plan.resumeNote?.backlinkRequested
    ?? (typeof plan.journalSection === 'string' && plan.journalLine === `- [[${plan.noteTitle}]]`);
  const bound = (record, key) => !record || (record.operation.operationId === key
    && record.operation.vaultId === vaultId && record.operation.source === source
    && record.operation.captureRequestHash === requestHash);
  const verify = (record, mayResume, safeToDispatch = true) => {
    if (!record) return 'pending';
    if (BLOCKED.has(record.status)) return 'conflict';
    const { operation } = record;
    const result = adapter.inspectInvariant(operation);
    if (result.status === 'satisfied' && result.invariant === true) {
      if (record.status === 'acknowledged') return 'confirmed';
      return mayResume && adapter.acknowledgeIfSatisfied(operation, { recoverBlockedJournal: true }) ? 'confirmed' : 'unconfirmed';
    }
    if (result.status === 'unavailable') return 'unavailable';
    if (AMBIGUOUS.has(record.status) || record.status === 'acknowledged') return 'conflict';
    if (!safeToDispatch && record.status === 'planned') return 'conflict';
    if (mayResume && record.status === 'planned') {
      adapter.execute(operation, { drain: false, recoverBlockedJournal: true });
      return verify(snapshot().operations[operation.operationId], false);
    }
    return 'pending';
  };
  let note = data.operations[noteKey];
  let journal = data.operations[journalKey];
  const journalCreate = data.operations[journalCreateKey];
  const provenance = data.operations[provenanceKey];
  if (!bound(note, noteKey) || !bound(journal, journalKey) || !bound(journalCreate, journalCreateKey) || !bound(provenance, provenanceKey)) return { state: 'conflict' };
  if (provenance && (note?.status !== 'acknowledged' || provenance.operation.operationKind !== 'replace'
    || provenance.operation.vaultRelativePath !== note.operation.vaultRelativePath
    || provenance.operation.expectedHash !== hash(note.operation.content))) return { state: 'conflict' };
  const linkChoice = { journalPolicy: plan.resumeNote?.journalPolicy, explicitBacklink: plan.resumeNote?.explicitBacklink };
  const targets = storage.noteCapturePlan({ title: plan.noteTitle, date: plan.date, frontmatter: plan.resumeNote?.frontmatter, ...linkChoice });
  const pinnedJournal = plan.resumeNote?.journalPath || (provenance && fields(provenance.operation.content).capture_recovery_journal_path);
  if (plan.resumeNote && (plan.resumeNote.notePath !== targets.notePath || pinnedJournal !== targets.journalPath)
    || provenance && pinnedJournal !== targets.journalPath
    || note && note.operation.vaultRelativePath !== targets.notePath
    || journal && pinnedJournal && journal.operation.vaultRelativePath !== pinnedJournal
    || journalCreate && pinnedJournal && journalCreate.operation.vaultRelativePath !== pinnedJournal) return { state: 'conflict' };
  if (!note && resume && plan.resumeNote) {
    const written = storage.writeNote({ title: plan.noteTitle, content: plan.noteContent,
      frontmatter: plan.resumeNote.frontmatter, createOnly: true, intentId: noteKey, requestHash, exact: true });
    if (written.receipt?.status === 'conflict') return { state: 'conflict' };
    note = snapshot().operations[noteKey];
    if (!bound(note, noteKey)) return { state: 'conflict' };
  }
  const noteState = verify(provenance || note, resume && Boolean(data.operations[noteKey]) && Boolean(plan.resumeNote || provenance));
  const notePath = ['confirmed', 'unconfirmed'].includes(noteState) ? note.operation.vaultRelativePath : null;
  let journalState = requested ? 'pending' : 'not_requested';
  if (resume && requested && !journal && !plan.resumeNote && !provenance) {
    // Earlier reservations need host-verified provenance before a missing link can be completed.
    return { state: 'unsupported', note: noteState, journal: journalState, ...(notePath ? { notePath } : {}) };
  }
  if (noteState === 'confirmed' && requested) {
    const createResolved = journalCreate?.status === 'superseded' && journalCreate.operation.operationKind === 'create'
      && journalCreate.evidence?.reason === ENSURE_EXISTS_RESOLUTION;
    const ready = journal || !journalCreate || journalCreate.status === 'acknowledged' || createResolved
      ? 'confirmed' : verify(journalCreate, resume);
    if (!journal && ['conflict', 'unavailable'].includes(ready)) journalState = ready;
    if (resume && !journal && ready === 'confirmed') {
      if (targets.link !== 'link') return { state: 'conflict', note: noteState, journal: 'conflict', notePath };
      const title = path.basename(notePath, '.md');
      storage.appendLineToJournalSection({ heading: plan.journalSection, line: `- [[${title}]]`,
        date: plan.date, intentId: `${intentId}:note-link`, requestHash, ...linkChoice, exact: true });
      journal = snapshot().operations[journalKey];
      if (!bound(journal, journalKey)) return { state: 'conflict' };
    }
    if (journal) journalState = verify(journal, resume && Boolean(data.operations[journalKey]),
      journal.operation.transformName === 'journal-backlink' && journal.operation.replayPayload.preserveExistingLinks === true);
    if (journalState === 'confirmed' && journal.operation.transformName !== 'journal-backlink') {
      const inspection = adapter.inspectInvariant({
        ...journal.operation,
        transformName: 'journal-backlink',
        transformVersion: 1,
        replayPayload: { linkTarget: path.basename(notePath, '.md'), section: plan.journalSection },
      });
      if (inspection.status === 'unavailable') journalState = 'unavailable';
      else if (inspection.status !== 'satisfied' || inspection.invariant !== true) journalState = 'conflict';
    }
  }
  const complete = noteState === 'confirmed' && ['confirmed', 'not_requested'].includes(journalState);
  const state = complete ? 'complete' : [noteState, journalState].includes('conflict') ? 'conflict'
    : [noteState, journalState].includes('unavailable') ? 'unavailable' : 'pending';
  return { state, date: plan.date, note: noteState, journal: journalState, ...(notePath ? { notePath } : {}) };
}

module.exports = { resumeNoteCapture, repairLegacyCaptureProvenance };
