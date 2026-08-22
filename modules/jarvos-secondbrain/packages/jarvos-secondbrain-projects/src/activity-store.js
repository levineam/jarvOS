'use strict';

/**
 * Replay-safe Project Activity read model.
 *
 * Producers submit already-admitted, metadata-only activity receipts. The
 * store owns persistence, exact causal deduplication, occurrence-time reads,
 * and the separate unattributed observation lane. It never reads a vault,
 * transcript, issue tracker, or provider directly.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateVerifiedReceipt,
  validateAdmittedInferenceEvidence,
  ADMITTED_INFERENCE_EVIDENCE_CONTRACT,
  digest,
} = require('./provider-contracts');

const STORE_CONTRACT = 'jarvos.project-activity-store/v1';
const UNATTRIBUTED_INFERENCE_CONTRACT = 'jarvos.project-activity-unattributed-inference/v1';
const UNATTRIBUTED_CONFLICT_CONTRACT = 'jarvos.project-activity-unattributed-conflict/v1';
const GENERATION_FILE = /^generation-[0-9]{10}\.json$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const LOCK_TIMEOUT_MS = 3000;
const STALE_LOCK_MS = 30_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function timestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function opaqueReference(value, field, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new TypeError(`${field} must be an opaque identifier`);
  const normalized = value.trim();
  if (/\s|[\\/]|:\/\//.test(normalized) || normalized.startsWith('~') || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) {
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  return normalized;
}

function reasonCode(value) {
  const normalized = value === null || value === undefined ? 'canonical_mapping_unavailable' : value;
  return opaqueReference(normalized, 'reason').toLocaleLowerCase('en-US');
}

function canonicalId(value) {
  if (typeof value !== 'string' || !/^(?:prj|out)_[0-9]{6,}$/.test(value)) throw new TypeError('canonicalId must be a canonical project or outcome ID');
  return value;
}

function stableIdentity({ dedupeKey, derivedFrom = null } = {}) {
  const base = derivedFrom && typeof derivedFrom.causalIdentity === 'string' && derivedFrom.causalIdentity.trim()
    ? derivedFrom.causalIdentity.trim()
    : dedupeKey;
  if (typeof base !== 'string' || !base.trim()) throw new TypeError('causal identity is required');
  return base.trim();
}

function initialState() {
  return {
    contract: STORE_CONTRACT,
    generation: 0,
    activities: {},
    causalIndex: {},
    updatedAt: null,
  };
}

function stateFile(stateDir) {
  const marker = path.join(stateDir, 'CURRENT');
  if (!fs.existsSync(marker)) return initialState();
  const name = fs.readFileSync(marker, 'utf8').trim();
  if (!GENERATION_FILE.test(name)) throw new Error('activity store marker is invalid');
  const filePath = path.join(stateDir, name);
  if (!fs.existsSync(filePath)) throw new Error('activity store generation is missing');
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!state || state.contract !== STORE_CONTRACT || !Number.isInteger(state.generation) || !state.activities || !state.causalIndex) {
    throw new Error('activity store generation is invalid');
  }
  return state;
}

function writeDurably(filePath, content) {
  const temp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, filePath);
}

function inferenceEvidenceIdentity(row) {
  return typeof row.evidenceId === 'string' && row.evidenceId.trim()
    ? row.evidenceId.trim()
    : null;
}

function sortUnattributedRows(rows) {
  return [...rows].sort((left, right) => {
    const leftKey = [inferenceEvidenceIdentity(left) || left.observationId || '', left.observedAt || left.receivedAt || '', left.evidenceDigest || ''].join('\u0000');
    const rightKey = [inferenceEvidenceIdentity(right) || right.observationId || '', right.observedAt || right.receivedAt || '', right.evidenceDigest || ''].join('\u0000');
    return leftKey.localeCompare(rightKey);
  });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function normalizeDerivedFrom(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('derivedFrom must be an object or null');
  const causalIdentity = value.causalIdentity;
  if (typeof causalIdentity !== 'string' || !causalIdentity.trim()) throw new TypeError('derivedFrom.causalIdentity is required');
  return {
    causalIdentity: causalIdentity.trim(),
    sourceId: typeof value.sourceId === 'string' && value.sourceId.trim() ? value.sourceId.trim() : null,
    role: typeof value.role === 'string' && value.role.trim() ? value.role.trim() : 'derived',
  };
}

function canonicalAtAdmission(receipt, registry) {
  if (!registry || typeof registry.get !== 'function') return null;
  const record = registry.get(receipt.canonicalId);
  if (!record) throw new Error('canonical activity record is unavailable');
  let root = record;
  const visited = new Set();
  while (root.parentId) {
    if (visited.has(root.id)) throw new Error('canonical activity hierarchy contains a cycle');
    visited.add(root.id);
    root = registry.get(root.parentId);
    if (!root) throw new Error('canonical activity parent is unavailable');
  }
  if (root.kind !== 'project') throw new Error('canonical activity root must be a Project');
  return {
    canonicalId: record.id,
    canonicalKind: record.kind,
    canonicalRevision: record.revision,
    rootProjectId: root.id,
    rootProjectRevision: root.revision,
    rootProjectLifecycle: root.lifecycle,
    registryGeneration: Number.isInteger(registry.generation) ? registry.generation : null,
  };
}

function activityEnvelope(receipt, { derivedFrom = null, provenanceClass = 'direct', registry = null } = {}) {
  const normalized = validateVerifiedReceipt(receipt);
  const relation = normalizeDerivedFrom(derivedFrom);
  const causalIdentity = stableIdentity({ dedupeKey: normalized.dedupeKey, derivedFrom: relation });
  return {
    id: `activity_${digest({ receipt: normalized, causalIdentity }).slice(0, 32)}`,
    receipt: normalized,
    causalIdentity,
    provenanceClass: typeof provenanceClass === 'string' && provenanceClass.trim() ? provenanceClass.trim() : 'direct',
    derivedFrom: relation,
    canonicalAtAdmission: canonicalAtAdmission(normalized, registry),
  };
}

function mergeEvidence(left, right) {
  return [...new Set([...(left || []), ...(right || [])])].sort();
}

function mergeEnvelope(existing, incoming) {
  return {
    ...existing,
    receipt: {
      ...existing.receipt,
      evidenceRefs: mergeEvidence(existing.receipt.evidenceRefs, incoming.receipt.evidenceRefs),
    },
    provenanceClass: existing.provenanceClass === incoming.provenanceClass
      ? existing.provenanceClass
      : 'direct_and_derived',
    derivedFrom: existing.derivedFrom || incoming.derivedFrom || null,
    canonicalAtAdmission: existing.canonicalAtAdmission || incoming.canonicalAtAdmission || null,
  };
}

function normalizeQuery(query = {}, now = new Date()) {
  const source = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const from = source.from == null ? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString() : timestamp(source.from, 'query.from');
  const to = source.to == null ? now.toISOString() : timestamp(source.to, 'query.to');
  if (Date.parse(from) > Date.parse(to)) throw new RangeError('query.from must not be after query.to');
  const limit = source.limit == null ? DEFAULT_LIMIT : source.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RangeError('query.limit is outside bounds');
  const projectIds = Array.isArray(source.projectIds) ? [...new Set(source.projectIds.map(canonicalId))].sort() : [];
  const outcomeIds = Array.isArray(source.outcomeIds) ? [...new Set(source.outcomeIds.map(canonicalId))].sort() : [];
  return { from, to, projectIds, outcomeIds, limit, cursor: source.cursor == null ? null : String(source.cursor) };
}

class ActivityStore {
  constructor({
    stateDir,
    now = () => new Date().toISOString(),
    admission = null,
    inferenceVerifier = null,
    inferenceAdmission = null,
    inferenceAdmissionVerifier = null,
    registry = null,
    canonicalRegistry = null,
  } = {}) {
    if (typeof stateDir !== 'string' || !stateDir.trim()) throw new TypeError('stateDir is required');
    this.stateDir = path.resolve(stateDir);
    this.now = now;
    this.admission = admission;
    this.inferenceVerifier = inferenceVerifier || inferenceAdmission || inferenceAdmissionVerifier || null;
    this.registry = registry || canonicalRegistry || null;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.stateDir, 0o700); } catch (_) { /* best effort on platforms without chmod */ }
    for (const filePath of [this._unattributedPath(), this._unattributedConflictPath()]) {
      if (fs.existsSync(filePath)) {
        try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort on platforms without chmod */ }
      }
    }
    this.state = stateFile(this.stateDir);
  }

  get generation() { return this.state.generation; }

  reload() {
    this.state = stateFile(this.stateDir);
    return this;
  }

  commit(next) {
    next.generation = this.state.generation + 1;
    next.updatedAt = this.now();
    const generationName = `generation-${String(next.generation).padStart(10, '0')}.json`;
    writeDurably(path.join(this.stateDir, generationName), `${JSON.stringify(next, null, 2)}\n`);
    writeDurably(path.join(this.stateDir, 'CURRENT'), `${generationName}\n`);
    this.state = next;
    return { generation: next.generation };
  }

  admit(receipt, { derivedFrom = null, provenanceClass = 'direct', expectedGeneration, admission = this.admission } = {}) {
    if (expectedGeneration !== undefined && expectedGeneration !== this.state.generation) throw new Error('stale activity store generation');
    if (!admission || typeof admission.verifyVerifiedReceipt !== 'function') throw new Error('activity receipt admission verifier required');
    const verified = admission.verifyVerifiedReceipt(receipt);
    if (!verified || verified.ok !== true || !verified.receipt) throw new Error('activity receipt admission invalid');
    const incoming = activityEnvelope(verified.receipt, { derivedFrom, provenanceClass, registry: this.registry });
    const existingId = this.state.causalIndex[incoming.causalIdentity];
    if (existingId) {
      const existing = this.state.activities[existingId];
      if (!existing) throw new Error('activity store causal index is corrupt');
      if (existing.receipt.canonicalId !== incoming.receipt.canonicalId
        || existing.receipt.producerId !== incoming.receipt.producerId
        || existing.receipt.kind !== incoming.receipt.kind) {
        return { status: 'quarantined', reason: 'causal_identity_conflict', activity: clone(existing) };
      }
      const merged = mergeEnvelope(existing, incoming);
      const next = clone(this.state);
      next.activities[existingId] = merged;
      this.commit(next);
      return { status: 'deduped', generation: this.state.generation, activity: clone(merged) };
    }
    const next = clone(this.state);
    next.activities[incoming.id] = incoming;
    next.causalIndex[incoming.causalIdentity] = incoming.id;
    const committed = this.commit(next);
    return { status: 'admitted', ...committed, activity: clone(incoming) };
  }

  _unattributedPath() {
    return path.join(this.stateDir, 'unattributed.jsonl');
  }

  _unattributedConflictPath() {
    return path.join(this.stateDir, 'unattributed-conflicts.jsonl');
  }

  _withUnattributedLock(fn) {
    const lockPath = path.join(this.stateDir, '.unattributed.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let fd = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} fd = null; }
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('unattributed evidence store is busy');
        let stale = false;
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          stale = !Number.isInteger(lock.pid) || Date.now() - Number(lock.createdAt || 0) > STALE_LOCK_MS;
          if (!stale && lock.pid !== process.pid) {
            try { process.kill(lock.pid, 0); } catch (probeError) { stale = probeError.code === 'ESRCH'; }
          }
        } catch (_) { stale = true; }
        if (stale) { try { fs.unlinkSync(lockPath); } catch (_) {} }
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  }

  _writeUnattributedRows(rows) {
    const filePath = this._unattributedPath();
    const normalized = sortUnattributedRows(rows);
    writeDurably(filePath, normalized.length ? `${normalized.map((row) => JSON.stringify(row)).join('\n')}\n` : '');
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort */ }
  }

  _recordUnattributedConflict(conflict) {
    const filePath = this._unattributedConflictPath();
    const rows = readJsonl(filePath);
    const identity = `${conflict.evidenceId}\u0000${conflict.attemptedDigest}`;
    if (!rows.some((row) => `${row.evidenceId}\u0000${row.attemptedDigest}` === identity)) rows.push(conflict);
    writeDurably(filePath, `${sortUnattributedRows(rows).map((row) => JSON.stringify(row)).join('\n')}\n`);
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort */ }
  }

  _findUnattributedEvidence(rows, evidenceId) {
    return rows.find((row) => row.contract === UNATTRIBUTED_INFERENCE_CONTRACT && row.evidenceId === evidenceId) || null;
  }

  _verifyInferenceEvidence(envelope, verifier) {
    if (!verifier) throw new Error('inference evidence admission verifier required');
    const verifierFunction = typeof verifier === 'function'
      ? verifier
      : verifier.verifyAdmittedInferenceEvidence || verifier.verifyInferenceEvidence || verifier.verifyEvidenceUnit;
    if (typeof verifierFunction !== 'function') throw new Error('inference evidence admission verifier required');
    const result = verifierFunction.call(typeof verifier === 'function' ? null : verifier, envelope);
    if (!result || result.ok !== true) return result || { ok: false, reason: 'invalid-signature' };
    const normalized = validateAdmittedInferenceEvidence(envelope);
    return {
      ...result,
      envelope: normalized,
      evidence: normalized.evidence,
      admission: normalized.admission,
    };
  }

  admitUnattributedEvidence(envelope, {
    candidateId = null,
    decisionId = null,
    reason = undefined,
    reasonCode: explicitReasonCode = undefined,
    verifier = this.inferenceVerifier,
    inferenceVerifier = null,
    inferenceAdmission = null,
  } = {}) {
    verifier = inferenceVerifier || inferenceAdmission || verifier;
    const verified = this._verifyInferenceEvidence(envelope, verifier);
    if (verified.ok !== true) {
      if (verified.reason !== 'evidence-conflict') throw new Error('inference evidence admission invalid');
      const normalized = validateAdmittedInferenceEvidence(envelope);
      const rows = readJsonl(this._unattributedPath());
      const prior = this._findUnattributedEvidence(rows, normalized.evidence.evidenceId);
      if (!prior) throw new Error('inference evidence admission invalid');
      return this._withUnattributedLock(() => {
        this._recordUnattributedConflict({
          contract: UNATTRIBUTED_CONFLICT_CONTRACT,
          evidenceId: normalized.evidence.evidenceId,
          observationId: normalized.evidence.observationId,
          sourceClass: normalized.evidence.sourceClass,
          observedAt: normalized.evidence.observedAt,
          existingDigest: prior.evidenceDigest,
          attemptedDigest: normalized.admission.evidenceDigest,
          reason: 'evidence_digest_conflict',
          trust: 'quarantined',
        });
        return { status: 'quarantined', reason: 'evidence_digest_conflict', observation: clone(prior) };
      });
    }

    const evidence = verified.evidence;
    const admission = verified.admission;
    const normalizedCandidateId = opaqueReference(candidateId, 'candidateId', { nullable: true });
    const normalizedDecisionId = opaqueReference(decisionId, 'decisionId', { nullable: true });
    const selectedReason = explicitReasonCode !== undefined ? explicitReasonCode : reason;
    if (explicitReasonCode !== undefined && reason !== undefined && explicitReasonCode !== reason) {
      throw new TypeError('reason and reasonCode must agree');
    }
    const safe = {
      contract: UNATTRIBUTED_INFERENCE_CONTRACT,
      observationId: evidence.observationId,
      evidenceId: evidence.evidenceId,
      sourceClass: evidence.sourceClass,
      occurredAt: evidence.occurredAt,
      observedAt: evidence.observedAt,
      sourceRevision: evidence.sourceRevision,
      sensitivity: evidence.sensitivity,
      coverageState: evidence.coverageState,
      contentDigest: evidence.contentDigest,
      evidenceDigest: admission.evidenceDigest,
      producerId: admission.producerId,
      authorityDigest: admission.authorityDigest,
      candidateId: normalizedCandidateId,
      decisionId: normalizedDecisionId,
      reason: reasonCode(selectedReason),
      trust: 'admitted-inference',
    };

    return this._withUnattributedLock(() => {
      const rows = readJsonl(this._unattributedPath());
      const prior = this._findUnattributedEvidence(rows, safe.evidenceId);
      if (prior) {
        if (prior.evidenceDigest !== safe.evidenceDigest) {
          this._recordUnattributedConflict({
            contract: UNATTRIBUTED_CONFLICT_CONTRACT,
            evidenceId: safe.evidenceId,
            observationId: safe.observationId,
            sourceClass: safe.sourceClass,
            observedAt: safe.observedAt,
            existingDigest: prior.evidenceDigest,
            attemptedDigest: safe.evidenceDigest,
            reason: 'evidence_digest_conflict',
            trust: 'quarantined',
          });
          return { status: 'quarantined', reason: 'evidence_digest_conflict', observation: clone(prior) };
        }
        return { status: 'deduped', observation: clone(prior), generation: this.state.generation };
      }
      rows.push(safe);
      this._writeUnattributedRows(rows);
      return { status: 'admitted', observation: clone(safe), generation: this.state.generation };
    });
  }

  admitUnresolvedEvidence(envelope, options = {}) {
    return this.admitUnattributedEvidence(envelope, options);
  }

  observeAdmittedUnattributed(envelope, options = {}) {
    return this.admitUnattributedEvidence(envelope, options);
  }

  observeUnattributed(observation, options = {}) {
    const candidate = observation && typeof observation === 'object' ? observation : {};
    if (candidate.contract === ADMITTED_INFERENCE_EVIDENCE_CONTRACT) {
      return this.admitUnattributedEvidence(observation, options);
    }
    if (candidate.canonicalId != null) throw new TypeError('unattributed observations cannot carry canonicalId');
    const safe = {
      observationId: typeof candidate.observationId === 'string' && candidate.observationId.trim()
        ? candidate.observationId.trim()
        : `obs_${digest(candidate).slice(0, 32)}`,
      sourceId: typeof candidate.sourceId === 'string' ? candidate.sourceId.trim() : null,
      sourceRevision: typeof candidate.sourceRevision === 'string' ? candidate.sourceRevision.trim() : null,
      receivedAt: timestamp(candidate.receivedAt || this.now(), 'receivedAt'),
      evidenceRefs: Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs.map((ref) => String(ref)).sort() : [],
      reason: typeof candidate.reason === 'string' && candidate.reason.trim() ? candidate.reason.trim().slice(0, 160) : 'canonical_mapping_unavailable',
      trust: 'unattributed',
    };
    const filePath = this._unattributedPath();
    fs.appendFileSync(filePath, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort */ }
    return { status: 'quarantined', observation: clone(safe) };
  }

  listUnattributed() {
    return readJsonl(this._unattributedPath());
  }

  listUnattributedConflicts() {
    return readJsonl(this._unattributedConflictPath());
  }

  query(query = {}, { now = new Date() } = {}) {
    const normalized = normalizeQuery(query, now);
    const wanted = new Set([...normalized.projectIds, ...normalized.outcomeIds]);
    const rows = Object.values(this.state.activities)
      .filter((entry) => {
        const occurred = Date.parse(entry.receipt.occurredAt);
        if (occurred < Date.parse(normalized.from) || occurred > Date.parse(normalized.to)) return false;
        return !wanted.size || wanted.has(entry.receipt.canonicalId);
      })
      .sort((left, right) => Date.parse(left.receipt.occurredAt) - Date.parse(right.receipt.occurredAt) || left.id.localeCompare(right.id));
    const start = normalized.cursor ? Math.max(0, rows.findIndex((row) => row.id === normalized.cursor) + 1) : 0;
    const selected = rows.slice(start, start + normalized.limit);
    return {
      contract: STORE_CONTRACT,
      status: 'ok',
      generation: this.state.generation,
      from: normalized.from,
      to: normalized.to,
      activities: selected.map(clone),
      unattributed: this.listUnattributed().map(clone),
      watermark: `activity:${this.state.generation}`,
      cursor: selected.length ? selected.at(-1).id : normalized.cursor,
      truncated: start + selected.length < rows.length,
    };
  }
}

module.exports = {
  ActivityStore,
  canonicalAtAdmission,
  UNATTRIBUTED_CONFLICT_CONTRACT,
  UNATTRIBUTED_INFERENCE_CONTRACT,
  STORE_CONTRACT,
  activityEnvelope,
  normalizeQuery,
};
