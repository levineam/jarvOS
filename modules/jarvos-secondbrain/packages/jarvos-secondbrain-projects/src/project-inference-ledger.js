'use strict';

const fs = require('node:fs');
const path = require('node:path');

const contracts = require('./project-inference-contracts');

const LEDGER_CONTRACT = 'jarvos.project-inference-ledger/v1';
const LEDGER_EVENT_CONTRACT = 'jarvos.project-inference-ledger-event/v1';
const EVENT_TYPES = Object.freeze(['evidence', 'correction', 'candidate', 'decision', 'coverage']);
const EVENT_FIELDS = Object.freeze([
  'contract', 'eventId', 'eventType', 'entityId', 'entityDigest', 'sourceClass', 'watermark', 'payload',
]);
const WATERMARK_FIELDS = Object.freeze(['sourceClass', 'state', 'observedAt', 'sourceRevision', 'evidenceId']);
const LOCK_TIMEOUT_MS = 3000;
const STALE_LOCK_MS = 30_000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function stableStringify(value) {
  return contracts.stableStringify(value);
}

function stableDigest(value) {
  return contracts.stableDigest(value);
}

function assertExactKeys(value, fields, label) {
  if (!contracts.isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const expected = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError(`${label} must contain exact fields: ${fields.join(', ')}`);
  }
}

function opaque(value, field, { nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /\s|[\\/]|:\/\//.test(value)) {
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) throw new TypeError(`${field} must be an opaque identifier`);
  return value;
}

function enumValue(value, field, allowed) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function normalizeWatermark(value) {
  if (value === null || value === undefined) return null;
  assertExactKeys(value, WATERMARK_FIELDS, 'ledger watermark');
  const sourceClass = enumValue(value.sourceClass, 'watermark.sourceClass', contracts.SOURCE_CLASSES);
  const state = enumValue(value.state, 'watermark.state', contracts.COVERAGE_STATES);
  const observedAt = new Date(value.observedAt);
  if (typeof value.observedAt !== 'string' || Number.isNaN(observedAt.getTime())) throw new TypeError('watermark.observedAt must be an ISO timestamp');
  const sourceRevision = opaque(value.sourceRevision, 'watermark.sourceRevision');
  const evidenceId = value.evidenceId === null || value.evidenceId === undefined ? null : opaque(value.evidenceId, 'watermark.evidenceId');
  return {
    sourceClass,
    state,
    observedAt: observedAt.toISOString(),
    sourceRevision,
    evidenceId,
  };
}

function payloadFor(eventType, payload, { attestor = null } = {}) {
  switch (eventType) {
    case 'evidence': return contracts.createEvidenceUnit(payload);
    case 'correction': return contracts.createCorrectionEvidence(payload, { attestor });
    case 'candidate': return contracts.createProjectCandidate(payload);
    case 'decision': return contracts.createInferenceDecision(payload);
    case 'coverage': return contracts.createCoverageStatus(payload);
    default: throw new TypeError(`unsupported inference ledger event type: ${eventType}`);
  }
}

function entityFor(eventType, payload) {
  if (eventType === 'evidence') return payload.evidenceId;
  if (eventType === 'correction') return payload.correctionId;
  if (eventType === 'candidate') return payload.candidateId;
  if (eventType === 'decision') return payload.decisionId;
  return `coverage_${stableDigest({ sourceClass: payload.sourceClass, state: payload.state, observedAt: payload.observedAt, sourceRevision: payload.sourceRevision }).slice(0, 32)}`;
}

function digestFor(eventType, payload, { attestor = null } = {}) {
  if (eventType === 'evidence') return contracts.evidenceUnitDigest(payload);
  if (eventType === 'correction') return contracts.correctionDigest(payload, { attestor });
  if (eventType === 'candidate') return contracts.projectCandidateDigest(payload);
  if (eventType === 'decision') return contracts.inferenceDecisionDigest(payload);
  return stableDigest(payload);
}

function watermarkFor(eventType, payload) {
  if (eventType === 'evidence' || eventType === 'correction') {
    return {
      sourceClass: payload.sourceClass,
      state: payload.coverageState,
      observedAt: payload.observedAt,
      sourceRevision: payload.sourceRevision,
      evidenceId: payload.evidenceId,
    };
  }
  if (eventType === 'coverage') {
    return {
      sourceClass: payload.sourceClass,
      state: payload.state,
      observedAt: payload.observedAt,
      sourceRevision: payload.sourceRevision,
      evidenceId: null,
    };
  }
  return null;
}

function normalizeEvent(input, { eventId, attestor = null } = {}) {
  if (!contracts.isPlainObject(input)) throw new TypeError('ledger event must be a plain object');
  const eventType = enumValue(input.eventType, 'eventType', EVENT_TYPES);
  const payload = payloadFor(eventType, input.payload, { attestor });
  const entityId = entityFor(eventType, payload);
  const entityDigest = digestFor(eventType, payload, { attestor });
  const sourceClass = payload.sourceClass || null;
  const watermark = normalizeWatermark(watermarkFor(eventType, payload));
  const derivedEventId = `evt_${stableDigest({ eventType, entityId }).slice(0, 32)}`;
  const normalized = {
    contract: LEDGER_EVENT_CONTRACT,
    eventId: eventId || input.eventId || derivedEventId,
    eventType,
    entityId,
    entityDigest,
    sourceClass,
    watermark,
    payload,
  };
  opaque(normalized.eventId, 'eventId');
  if (!DIGEST_PATTERN.test(normalized.entityDigest)) throw new TypeError('ledger event entityDigest must be exactly 64 lowercase hexadecimal characters');
  if (normalized.eventId !== (eventId || input.eventId || derivedEventId)) throw new TypeError('eventId is not normalized');
  if (input.contract !== undefined && input.contract !== LEDGER_EVENT_CONTRACT) throw new TypeError(`contract must be ${LEDGER_EVENT_CONTRACT}`);
  if (input.entityId !== undefined && input.entityId !== entityId) throw new TypeError('ledger event entityId does not match payload');
  if (input.entityDigest !== undefined && input.entityDigest !== entityDigest) throw new TypeError('ledger event digest does not match payload');
  if (input.sourceClass !== undefined && input.sourceClass !== sourceClass) throw new TypeError('ledger event sourceClass does not match payload');
  if (input.watermark !== undefined && stableStringify(normalizeWatermark(input.watermark)) !== stableStringify(watermark)) {
    throw new TypeError('ledger event watermark does not match payload');
  }
  // A full persisted event must use the exact public shape. Creation input may
  // omit derived fields, but no arbitrary fields may enter either route.
  const allowedCreation = new Set(['eventType', 'payload', ...EVENT_FIELDS]);
  const unknown = Object.keys(input).filter((key) => !allowedCreation.has(key));
  if (unknown.length) throw new TypeError(`ledger event contains unsupported fields: ${unknown.join(', ')}`);
  return normalized;
}

function normalizePersistedEvent(input, { attestor = null } = {}) {
  assertExactKeys(input, EVENT_FIELDS, 'persisted ledger event');
  return normalizeEvent(input, { attestor });
}

function compareWatermarks(left, right) {
  const time = left.observedAt.localeCompare(right.observedAt);
  if (time) return time;
  const revision = left.sourceRevision.localeCompare(right.sourceRevision);
  if (revision) return revision;
  const evidence = (left.evidenceId || '').localeCompare(right.evidenceId || '');
  if (evidence) return evidence;
  return left.state.localeCompare(right.state);
}

function sortedEvents(events) {
  return [...events].sort((left, right) => left.eventId.localeCompare(right.eventId) || left.entityDigest.localeCompare(right.entityDigest));
}

function assertOwnerMode(options = {}) {
  const mode = options.mode === undefined ? 'owner' : options.mode;
  if (mode !== 'owner' || options.owner === false) throw new Error('inference ledger is owner-only');
}

class InferenceLedger {
  constructor(options = {}) {
    assertOwnerMode(options);
    this.mode = 'owner';
    this.attestor = options.attestor || null;
    this._events = new Map();
    this.root = null;
    this.filePath = null;
    if (options.root !== undefined || options.filePath !== undefined || options.file !== undefined) {
      const root = path.resolve(String(options.root || path.dirname(String(options.filePath || options.file))));
      if (!path.isAbsolute(root) || root === path.parse(root).root) throw new Error('protected inference ledger root is required');
      this.root = root;
      this.filePath = path.resolve(String(options.filePath || options.file || path.join(root, 'inference-events.jsonl')));
      if (!this.filePath.startsWith(`${this.root}${path.sep}`)) throw new Error('inference ledger file must stay within its owned root');
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      this._enforceRootMode();
      this._enforceFileMode();
      this._events = this._readDisk();
    }
  }

  _enforceRootMode() {
    fs.chmodSync(this.root, 0o700);
    const mode = fs.statSync(this.root).mode & 0o777;
    if (mode !== 0o700) throw new Error('inference ledger root must use mode 0700');
  }

  _enforceFileMode() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    fs.chmodSync(this.filePath, 0o600);
    const mode = fs.statSync(this.filePath).mode & 0o777;
    if (mode !== 0o600) throw new Error('inference ledger file must use mode 0600');
  }

  _readDisk() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return new Map();
    const content = fs.readFileSync(this.filePath, 'utf8');
    const events = new Map();
    for (const [index, line] of content.split('\n').filter(Boolean).entries()) {
      let parsed;
      try { parsed = JSON.parse(line); } catch (_) { throw new Error(`inference ledger has malformed JSONL at line ${index + 1}`); }
      const event = normalizePersistedEvent(parsed, { attestor: this.attestor });
      const prior = events.get(event.eventId);
      if (prior && prior.entityDigest !== event.entityDigest) throw new Error(`inference ledger event conflict: ${event.eventId}`);
      events.set(event.eventId, event);
    }
    return events;
  }

  _withLock(fn) {
    if (!this.root) return fn();
    const lockPath = path.join(this.root, '.inference-events.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let fd = null;
    while (fd === null) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} fd = null; }
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('inference ledger is busy');
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
    try { return fn(); } finally {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(lockPath); } catch (_) {}
    }
  }

  _appendEvents(events) {
    return this._withLock(() => {
      if (this.filePath) this._events = this._readDisk();
      if (this.filePath) this._enforceRootMode();
      const results = [];
      let fd = null;
      try {
        for (const event of events) {
          const prior = this._events.get(event.eventId);
          if (prior) {
            if (prior.entityDigest !== event.entityDigest) throw new Error(`inference ledger event conflict: ${event.eventId}`);
            results.push({ status: 'duplicate', event: contracts.clone(prior) });
            continue;
          }
          if (this.filePath) {
            fd ??= fs.openSync(this.filePath, 'a', 0o600);
            fs.fchmodSync(fd, 0o600);
            fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
            fs.fsyncSync(fd);
          }
          this._events.set(event.eventId, contracts.clone(event));
          results.push({ status: 'appended', event: contracts.clone(event) });
        }
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
      if (fd !== null) this._enforceFileMode();
      return results;
    });
  }

  append(input) {
    const event = normalizeEvent(input, { attestor: this.attestor });
    return this._appendEvents([event])[0];
  }

  _normalizeReplayItem(item) {
    if (contracts.isPlainObject(item) && item.contract === LEDGER_EVENT_CONTRACT) return normalizeEvent(item, { attestor: this.attestor });
    if (contracts.isPlainObject(item) && item.eventType) return normalizeEvent(item, { attestor: this.attestor });
    if (contracts.isPlainObject(item) && item.contract === contracts.EVIDENCE_UNIT_CONTRACT) return normalizeEvent({ eventType: 'evidence', payload: item }, { attestor: this.attestor });
    if (contracts.isPlainObject(item) && item.contract === contracts.CORRECTION_EVIDENCE_CONTRACT) return normalizeEvent({ eventType: 'correction', payload: item }, { attestor: this.attestor });
    if (contracts.isPlainObject(item) && item.contract === contracts.PROJECT_CANDIDATE_CONTRACT) return normalizeEvent({ eventType: 'candidate', payload: item }, { attestor: this.attestor });
    if (contracts.isPlainObject(item) && item.contract === contracts.INFERENCE_DECISION_CONTRACT) return normalizeEvent({ eventType: 'decision', payload: item }, { attestor: this.attestor });
    if (contracts.isPlainObject(item) && item.contract === contracts.COVERAGE_CONTRACT) return normalizeEvent({ eventType: 'coverage', payload: item }, { attestor: this.attestor });
    throw new TypeError('ledger replay item is not a supported inference payload');
  }

  appendEvidence(evidence) {
    return this.append({ eventType: 'evidence', payload: evidence });
  }

  appendCorrection(correction) {
    return this.append({ eventType: 'correction', payload: correction });
  }

  appendCandidate(candidate) {
    return this.append({ eventType: 'candidate', payload: candidate });
  }

  appendDecision(decision) {
    return this.append({ eventType: 'decision', payload: decision });
  }

  appendCoverage(coverage) {
    return this.append({ eventType: 'coverage', payload: coverage });
  }

  replay(items = []) {
    if (!Array.isArray(items)) throw new TypeError('ledger replay requires an array');
    return this._appendEvents(items.map((item) => this._normalizeReplayItem(item)));
  }

  listEvents() {
    if (this.filePath) this._events = this._readDisk();
    return sortedEvents([...this._events.values()]).map(contracts.clone);
  }

  latestWatermarks() {
    const latest = {};
    for (const event of this._events.values()) {
      if (!event.watermark) continue;
      const current = latest[event.watermark.sourceClass];
      if (!current || compareWatermarks(current, event.watermark) < 0) latest[event.watermark.sourceClass] = contracts.clone(event.watermark);
    }
    return Object.fromEntries(Object.keys(latest).sort().map((sourceClass) => [sourceClass, latest[sourceClass]]));
  }

  snapshot() {
    return {
      contract: LEDGER_CONTRACT,
      events: this.listEvents(),
      watermarks: this.latestWatermarks(),
    };
  }

  get size() {
    return this._events.size;
  }
}

function createMemoryInferenceLedger(options = {}) {
  if (options.root !== undefined || options.filePath !== undefined || options.file !== undefined) {
    throw new TypeError('memory inference ledger cannot accept persistence paths');
  }
  return new InferenceLedger(options);
}

function createFileInferenceLedger(options = {}) {
  if (options.root === undefined && options.filePath === undefined && options.file === undefined) {
    throw new TypeError('file inference ledger requires an owned root or file path');
  }
  return new InferenceLedger(options);
}

module.exports = {
  EVENT_FIELDS,
  EVENT_TYPES,
  INFERENCE_LEDGER_CONTRACT: LEDGER_CONTRACT,
  LEDGER_CONTRACT,
  LEDGER_EVENT_CONTRACT,
  WATERMARK_FIELDS,
  InferenceLedger,
  ProjectInferenceLedger: InferenceLedger,
  createFileInferenceLedger,
  createMemoryInferenceLedger,
  compareWatermarks,
  normalizeEvent,
  normalizeWatermark,
};
