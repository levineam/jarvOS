'use strict';

const crypto = require('node:crypto');
const {
  WORKSPACE_CONTRACT_VERSION,
  createWorkspaceObservation,
  isOpaqueId,
  validatePublicWorkspaceRecord,
} = require('../contracts');

const ARCHIVE_SCHEMA_VERSION = 'jarvos-workspace-manager.archive.v1';

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeTimestamp(value, field) {
  const date = new Date(value == null ? Date.now() : value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function createArchiveRecord({ observation, evidenceRef = null, reason = 'metadata archive', archivedAt } = {}) {
  const normalized = createWorkspaceObservation(observation);
  if (evidenceRef != null && !isOpaqueId(evidenceRef)) throw new Error('archive.evidenceRef must be an opaque identifier');
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 160) throw new Error('archive.reason must be a bounded non-empty string');
  const validation = validatePublicWorkspaceRecord({ version: WORKSPACE_CONTRACT_VERSION, candidateId: normalized.candidateId, evidenceId: evidenceRef });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return {
    version: WORKSPACE_CONTRACT_VERSION,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    candidateId: normalized.candidateId,
    disposition: 'archived',
    mutationClass: null,
    evidenceRef,
    reason,
    archivedAt: normalizeTimestamp(archivedAt, 'archive.archivedAt'),
    observation: normalized,
    observationDigest: digest(normalized),
  };
}

function createMetadataArchive(options = {}) {
  const store = options.store;
  if (!store || (typeof store.append !== 'function' && typeof store.save !== 'function')) {
    throw new Error('archive store must expose append or save');
  }
  for (const field of ['gitMutationPort', 'fileMutationPort', 'mutationPort', 'executor']) {
    if (options[field]) throw new Error('metadata archive cannot accept mutation ports');
  }

  async function archive(input = {}) {
    for (const field of ['gitMutationPort', 'fileMutationPort', 'mutationPort', 'executor']) {
      if (input[field]) throw new Error('metadata archive cannot dispatch mutations');
    }
    const record = createArchiveRecord(input);
    const persisted = typeof store.append === 'function'
      ? await store.append(record)
      : await store.save(record);
    return { ok: true, record, persisted: persisted === undefined ? true : persisted, mutationDispatched: false };
  }

  return { archive, createArchiveRecord };
}

module.exports = { ARCHIVE_SCHEMA_VERSION, createArchiveRecord, createMetadataArchive };
