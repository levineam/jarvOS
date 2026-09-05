'use strict';

// This is a derived, read-only attention pass. It deliberately accepts only
// already-admitted source evidence supplied by the protected host; it never
// reads a filesystem, infers missing intent, or writes the Projects registry.
const crypto = require('node:crypto');

const INTENT_FIELDS = Object.freeze(['goal', 'definitionOfDone']);
const SOURCE_ROLES = Object.freeze(['migration-source', 'canonical-brief', 'owner-decision', 'owning-task-intent']);
const SOURCE_STATUSES = Object.freeze(['current', 'deferred', 'stale', 'withdrawn', 'superseded']);
const SOURCE_SCOPES = Object.freeze(['record', 'narrower']);
const DEFAULT_MAX_EVIDENCE_AGE_SECONDS = 3600;

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function isIntentValue(value) { return typeof value === 'string' && value.trim() !== '' && value.trim() !== '-'; }
function isMissingIntent(value) { return !isIntentValue(value); }
function timestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}
function canonicalId(value, field) {
  if (typeof value !== 'string' || !/^(?:prj|out)_[0-9]{6,}$/.test(value)) throw new TypeError(`${field} must be a canonical Project or Outcome ID`);
  return value;
}
function opaque(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000\r\n]/.test(value)) throw new TypeError(`${field} must be a non-empty reference`);
  return value.trim();
}
function digestValue(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} must be a sha256 digest`);
  return value;
}

function sourceDescriptor(input) {
  if (!isPlainObject(input)) throw new TypeError('intent source must be an object');
  const allowed = new Set([
    'canonicalId', 'recordRevision', 'registryGeneration', 'role', 'status', 'scope', 'fields', 'sourceRef', 'sourceDigest',
    'promisedResolutionAt', 'nextOwner', 'evidence',
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError('intent source has unsupported fields');
  if (!SOURCE_ROLES.includes(input.role)) throw new TypeError('intent source role is unsupported');
  if (!SOURCE_STATUSES.includes(input.status)) throw new TypeError('intent source status is unsupported');
  if (!SOURCE_SCOPES.includes(input.scope)) throw new TypeError('intent source scope is unsupported');
  if (!Number.isInteger(input.recordRevision) || input.recordRevision < 1) throw new TypeError('intent source recordRevision is invalid');
  if (!Number.isInteger(input.registryGeneration) || input.registryGeneration < 0) throw new TypeError('intent source registryGeneration is invalid');
  if (!isPlainObject(input.fields) || Object.keys(input.fields).some((key) => !INTENT_FIELDS.includes(key))) throw new TypeError('intent source fields are unsupported');
  const fields = Object.fromEntries(INTENT_FIELDS.map((field) => [field, input.fields[field] === undefined || input.fields[field] === null ? null : String(input.fields[field])]));
  return {
    canonicalId: canonicalId(input.canonicalId, 'intent source canonicalId'),
    recordRevision: input.recordRevision,
    registryGeneration: input.registryGeneration,
    role: input.role,
    status: input.status,
    scope: input.scope,
    fields,
    sourceRef: opaque(input.sourceRef, 'intent source sourceRef'),
    sourceDigest: digestValue(input.sourceDigest, 'intent source sourceDigest'),
    promisedResolutionAt: input.promisedResolutionAt === undefined || input.promisedResolutionAt === null ? null : timestamp(input.promisedResolutionAt, 'intent source promisedResolutionAt'),
    nextOwner: input.nextOwner === undefined || input.nextOwner === null ? null : opaque(input.nextOwner, 'intent source nextOwner'),
  };
}

function intentSourceDescriptorDigest(input) { return digest(sourceDescriptor(input)); }

function normalizeSource(input) {
  if (!Object.prototype.hasOwnProperty.call(input || {}, 'evidence')) throw new TypeError('intent source evidence is required');
  return { ...sourceDescriptor(input), evidence: input.evidence };
}

function verifySource(source, sourceAuthority, record, registryGeneration, now, maxEvidenceAgeSeconds) {
  if (!sourceAuthority || typeof sourceAuthority.verifyAdmittedInferenceEvidence !== 'function') return { state: 'stale-source', source };
  const verified = sourceAuthority.verifyAdmittedInferenceEvidence(source.evidence);
  if (!verified.ok || verified.evidence.contentDigest !== intentSourceDescriptorDigest(source)) return { state: 'stale-source', source };
  const admitted = { source, evidence: verified.evidence, evidenceDigest: verified.admission.evidenceDigest };
  const observedAt = Date.parse(verified.evidence.observedAt);
  const nowMillis = Date.parse(now);
  if (verified.evidence.coverageState !== 'fresh' || !Number.isFinite(observedAt) || observedAt > nowMillis
    || nowMillis - observedAt > maxEvidenceAgeSeconds * 1000) return { state: 'stale-source', ...admitted };
  // Status is source-controlled material. It becomes authoritative only for
  // the exact canonical revision/generation for which it was admitted.
  if (source.registryGeneration !== registryGeneration || source.recordRevision !== record.revision) return { state: 'stale-source', ...admitted };
  if (source.status === 'withdrawn' || source.status === 'superseded') return { state: 'retired', ...admitted };
  if (source.status === 'deferred') return { state: 'deferred', ...admitted };
  if (source.status === 'stale') return { state: 'stale-source', ...admitted };
  if (source.scope === 'narrower') return { state: 'brief-narrower-than-record', ...admitted };
  return { state: 'current', ...admitted };
}

function evidenceFor(candidate) {
  return {
    sourceRef: candidate.source.sourceRef,
    evidenceId: candidate.evidence ? candidate.evidence.evidenceId : null,
    // An unverifiable/stale admission never gets promoted, but the already
    // linked source digest remains visible so the protected owner can recover
    // precisely what needs refreshing.
    digest: candidate.evidenceDigest || candidate.source.sourceDigest,
    sourceDigest: candidate.source.sourceDigest,
    sourceRevision: candidate.evidence ? candidate.evidence.sourceRevision : null,
    observedAt: candidate.evidence ? candidate.evidence.observedAt : null,
  };
}

function sourcePrecedence(left, right) {
  return SOURCE_ROLES.indexOf(left.role) - SOURCE_ROLES.indexOf(right.role)
    || left.sourceRef.localeCompare(right.sourceRef);
}

function nextOwner(disposition, sources) {
  const named = sources.map((source) => source.nextOwner).find(Boolean);
  if (named) return named;
  if (disposition === 'recoverable-migration') return 'protected-project-owner';
  if (disposition === 'stale-source') return 'source-owner';
  if (disposition === 'deferred') return 'deferred-source-owner';
  return 'project-owner';
}

function entryFor(record, registryGeneration, sources, sourceAuthority, now, maxEvidenceAgeSeconds) {
  const missingFields = INTENT_FIELDS.filter((field) => isMissingIntent(record[field]));
  if (!missingFields.length) return null;
  const linked = sources.filter((source) => source.canonicalId === record.id).sort(sourcePrecedence);
  const verified = linked.map((source) => verifySource(source, sourceAuthority, record, registryGeneration, now, maxEvidenceAgeSeconds));
  if (verified.length && verified.every((candidate) => candidate.state === 'retired')) {
    return { retired: { canonicalId: record.id, reason: 'source-withdrawn-or-superseded' } };
  }
  const fieldDispositions = {};
  const fieldSources = {};
  const proposedPatch = {};
  for (const field of missingFields) {
    const relevant = verified.filter((candidate) => candidate.source.fields[field] !== null
      && (candidate.state !== 'current' || isIntentValue(candidate.source.fields[field])));
    const selected = relevant[0] || null;
    if (!selected) {
      fieldDispositions[field] = 'unresolved-intent';
      continue;
    }
    fieldSources[field] = selected.source.sourceRef;
    if (selected.state === 'current' && isIntentValue(selected.source.fields[field])) {
      fieldDispositions[field] = 'recoverable-migration';
      proposedPatch[field] = selected.source.fields[field].trim();
    } else if (selected.state === 'current') {
      fieldDispositions[field] = 'unresolved-intent';
    } else {
      fieldDispositions[field] = selected.state;
    }
  }
  const states = Object.values(fieldDispositions);
  const disposition = states.every((state) => state === 'recoverable-migration') ? 'recoverable-migration'
    : states.includes('brief-narrower-than-record') ? 'brief-narrower-than-record'
      : states.includes('stale-source') ? 'stale-source'
        : states.includes('deferred') ? 'deferred' : 'unresolved-intent';
  const evidence = verified
    .filter((candidate) => candidate.state !== 'retired')
    .map(evidenceFor)
    .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  const promisedResolutionAt = verified.map((candidate) => candidate.source.promisedResolutionAt).find(Boolean) || null;
  const resolutionOverdue = promisedResolutionAt !== null && Date.parse(promisedResolutionAt) < Date.parse(now);
  const fingerprint = digest({
    canonicalId: record.id,
    recordRevision: record.revision,
    missingFields,
    fieldDispositions,
    fieldSources,
    evidence: evidence.map(({ sourceRef, sourceDigest }) => ({ sourceRef, sourceDigest })),
    nextOwner: nextOwner(disposition, verified.map((candidate) => candidate.source)),
    promisedResolutionAt,
    resolutionOverdue,
  });
  return {
    entry: {
      id: `intentgap_${fingerprint.slice(0, 32)}`,
      canonicalId: record.id,
      canonicalKind: record.kind,
      canonicalRevision: record.revision,
      registryGeneration,
      missingFields,
      fieldDispositions,
      disposition,
      nextOwner: nextOwner(disposition, verified.map((candidate) => candidate.source)),
      evidence,
      proposedPatch: Object.keys(proposedPatch).length ? proposedPatch : null,
      promisedResolutionAt,
      resolutionOverdue,
      fingerprint,
      title: record.title,
    },
  };
}

function createMemoryIntentGapAlertState() {
  const alertKeys = new Set();
  return {
    has(key) { return alertKeys.has(key); },
    mark(key) { alertKeys.add(key); },
  };
}

function normalizeAlertState(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value.has !== 'function' || typeof value.mark !== 'function') throw new TypeError('intent gap alert state must expose has and mark');
  return value;
}

function deriveIntentGapAttention({ records, registryGeneration, sources, sourceAuthority = null, maxEvidenceAgeSeconds = DEFAULT_MAX_EVIDENCE_AGE_SECONDS, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(records)) throw new TypeError('intent gap records must be an array');
  if (!Number.isInteger(registryGeneration) || registryGeneration < 0) throw new TypeError('intent gap registryGeneration is invalid');
  if (!Array.isArray(sources)) throw new TypeError('intent gap sources must be an array');
  if (!Number.isInteger(maxEvidenceAgeSeconds) || maxEvidenceAgeSeconds < 1 || maxEvidenceAgeSeconds > 86_400) throw new TypeError('intent gap maxEvidenceAgeSeconds is invalid');
  const capturedAt = timestamp(now, 'intent gap now');
  const normalizedSources = sources.map(normalizeSource);
  const entries = [];
  const retired = [];
  for (const record of records) {
    if (!record || (record.lifecycle !== 'active' && record.lifecycle !== 'planned')) continue;
    const result = entryFor(record, registryGeneration, normalizedSources, sourceAuthority, capturedAt, maxEvidenceAgeSeconds);
    if (!result) continue;
    if (result.retired) { retired.push(result.retired); continue; }
    entries.push(result.entry);
  }
  entries.sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
  return { entries: entries.map(clone), retired };
}

function acknowledgeIntentGapAlerts(entries, { alertState, consumerKey } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('intent gap entries must be an array');
  const state = normalizeAlertState(alertState);
  if (!state) throw new TypeError('intent gap alert state is required');
  const consumer = opaque(consumerKey, 'intent gap consumerKey');
  const alerts = [];
  for (const entry of entries) {
    const key = `${consumer}:${entry.fingerprint}`;
    if (state.has(key)) continue;
    state.mark(key);
    alerts.push(clone(entry));
  }
  return alerts;
}

function attentionSummaries(entries, { observedAt } = {}) {
  const capturedAt = timestamp(observedAt || new Date().toISOString(), 'intent attention observedAt');
  return entries.map((entry) => ({
    id: entry.id,
    canonicalId: entry.canonicalId,
    category: 'attention',
    status: entry.disposition,
    title: `Intent gap: ${entry.title} (${entry.disposition}); next owner: ${entry.nextOwner}`,
    occurredAt: null,
    observedAt: capturedAt,
    evidenceRefs: entry.evidence.flatMap((evidence) => [evidence.sourceRef, `digest:${evidence.digest}`]),
    canonicalAtAdmission: null,
    source: 'projects-intent-gap',
  }));
}

module.exports = {
  INTENT_FIELDS,
  DEFAULT_MAX_EVIDENCE_AGE_SECONDS,
  SOURCE_ROLES,
  SOURCE_SCOPES,
  SOURCE_STATUSES,
  acknowledgeIntentGapAlerts,
  attentionSummaries,
  createMemoryIntentGapAlertState,
  deriveIntentGapAttention,
  intentSourceDescriptorDigest,
};
