'use strict';

const path = require('node:path');

const ARTIFACT_RECEIPT_SCHEMA_VERSION = 'jarvos.artifact-receipt.v1';
const ARTIFACT_KINDS = Object.freeze(['note', 'journal']);
const ARTIFACT_OUTCOMES = Object.freeze([
  'committed',
  'already_satisfied',
  'saved_locally_sync_pending',
  'deferred',
  'conflict',
  'failed',
]);

const ARTIFACT_KEYS = new Set(['schemaVersion', 'kind', 'vaultRelativePath', 'outcome']);
const RECEIPT_KEYS = new Set(['schemaVersion', 'artifacts']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, message) {
  if (!isObject(value)) throw new Error(message);
}

function assertNoUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
  }
}

function normalizeVaultRelativeMarkdownPath(value) {
  if (typeof value !== 'string' || !value) throw new Error('vaultRelativePath must be a non-empty string');
  const normalizedUnicode = value.normalize('NFC');
  if (
    normalizedUnicode.includes('\\')
    || /[\0-\x1f\x7f]/.test(normalizedUnicode)
    || path.posix.isAbsolute(normalizedUnicode)
    || /^[A-Za-z]:[\\/]/.test(normalizedUnicode)
    || normalizedUnicode.includes('%')
    || /[?#]/.test(normalizedUnicode)
  ) {
    throw new Error('vaultRelativePath must be a canonical vault-relative Markdown path');
  }
  const segments = normalizedUnicode.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('vaultRelativePath must not contain empty or traversal segments');
  }
  const normalizedPath = path.posix.normalize(normalizedUnicode);
  if (normalizedPath !== normalizedUnicode || !normalizedPath.toLowerCase().endsWith('.md')) {
    throw new Error('vaultRelativePath must be a canonical vault-relative Markdown path');
  }
  return normalizedPath;
}

function normalizeArtifactOutcome(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (ARTIFACT_OUTCOMES.includes(raw)) return raw;
  if (raw === 'saved-locally-sync-pending') return 'saved_locally_sync_pending';
  if (raw === 'blocked' || raw === 'unavailable' || raw === 'error' || raw === 'receipt-failed' || raw === 'invalid-configuration') return 'failed';
  if (raw === 'pending' || raw === 'queued' || raw === 'unknown_after_dispatch' || raw === 'unknown-after-dispatch') return 'deferred';
  if (raw === 'linked' || raw === 'created' || raw === 'created-concurrently' || raw === 'healthy-existing' || raw === 'recovered-after-unrecorded-create') return 'committed';
  if (raw === 'already-present' || raw === 'already-present-in-journal') return 'already_satisfied';
  throw new Error(`Unsupported artifact outcome: ${value}`);
}

function createArtifactRecord(input = {}) {
  assertObject(input, 'artifact record must be an object');
  assertNoUnknownFields(input, ARTIFACT_KEYS, 'artifact record');
  if ((input.schemaVersion || ARTIFACT_RECEIPT_SCHEMA_VERSION) !== ARTIFACT_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`Unsupported artifact receipt schemaVersion: ${input.schemaVersion}`);
  }
  if (!ARTIFACT_KINDS.includes(input.kind)) throw new Error(`Unsupported artifact kind: ${input.kind}`);
  const vaultRelativePath = normalizeVaultRelativeMarkdownPath(input.vaultRelativePath);
  return Object.freeze({
    schemaVersion: ARTIFACT_RECEIPT_SCHEMA_VERSION,
    kind: input.kind,
    vaultRelativePath,
    outcome: normalizeArtifactOutcome(input.outcome),
  });
}

function outcomeFromMutationResult(result = {}) {
  if (typeof result === 'string') return normalizeArtifactOutcome(result);
  assertObject(result, 'mutation result must be an object');
  return normalizeArtifactOutcome(
    result.outcome
    || result.status
    || (result.savedLocally ? 'saved_locally_sync_pending' : null)
    || (result.deferred ? 'deferred' : null)
    || (result.failed ? 'failed' : null)
    || (result.written ? 'committed' : null),
  );
}

function artifactFromMutationResult({ kind, vaultRelativePath, result, outcome } = {}) {
  return createArtifactRecord({
    kind,
    vaultRelativePath,
    outcome: outcome || outcomeFromMutationResult(result),
  });
}

function aggregateArtifactRecords(records = []) {
  if (!Array.isArray(records)) throw new Error('artifact records must be an array');
  const grouped = new Map();
  records.forEach((entry, index) => {
    assertObject(entry, 'artifact aggregation entry must be an object');
    const record = createArtifactRecord(entry.record || entry);
    const key = record.vaultRelativePath;
    const intent = entry.intent === 'auxiliary' ? 'auxiliary' : 'user_requested';
    const existing = grouped.get(key);
    const candidate = { record, intent, index };
    if (!existing || (intent === 'user_requested' && existing.intent === 'auxiliary') || (intent === existing.intent && index > existing.index)) {
      grouped.set(key, candidate);
    }
  });
  return [...grouped.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.record);
}

function createArtifactReceipt({ artifacts = [] } = {}) {
  if (!Array.isArray(artifacts)) throw new Error('artifacts must be an array');
  const normalized = aggregateArtifactRecords(artifacts.map((entry) => ({
    record: entry.record || entry,
    ...(entry.intent ? { intent: entry.intent } : {}),
  })));
  return Object.freeze({
    schemaVersion: ARTIFACT_RECEIPT_SCHEMA_VERSION,
    artifacts: Object.freeze(normalized),
  });
}

function validateArtifactReceipt(receipt = {}) {
  assertObject(receipt, 'artifact receipt must be an object');
  assertNoUnknownFields(receipt, RECEIPT_KEYS, 'artifact receipt');
  if (receipt.schemaVersion !== ARTIFACT_RECEIPT_SCHEMA_VERSION) throw new Error(`Unsupported artifact receipt schemaVersion: ${receipt.schemaVersion}`);
  if (!Array.isArray(receipt.artifacts)) throw new Error('artifact receipt artifacts must be an array');
  const normalized = createArtifactReceipt({ artifacts: receipt.artifacts });
  if (normalized.artifacts.length !== receipt.artifacts.length) throw new Error('artifact receipt contains duplicate paths');
  return receipt;
}

module.exports = {
  ARTIFACT_RECEIPT_SCHEMA_VERSION,
  ARTIFACT_KINDS,
  ARTIFACT_OUTCOMES,
  aggregateArtifactRecords,
  artifactFromMutationResult,
  createArtifactRecord,
  createArtifactReceipt,
  normalizeArtifactOutcome,
  normalizeVaultRelativeMarkdownPath,
  outcomeFromMutationResult,
  validateArtifactReceipt,
};
