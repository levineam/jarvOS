'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  RECORD_CONTRACT,
  RECORD_CONTRACT_V2,
  STATUS_BY_KIND,
  cloneRecord,
  normalizeName,
  validateInferenceMetadata,
  validateRecord,
} = require('./records');
const { resolvePriority } = require('./priority');

const REGISTRY_CONTRACT = 'jarvos.projects-registry/v1';
const STATE_FILE = 'CURRENT';
const LOCK_FILE = '.registry.lock';
const LOCK_TIMEOUT_MS = 3000;
const STALE_LOCK_MS = 30_000;

function initialState() {
  return {
    contract: REGISTRY_CONTRACT,
    generation: 0,
    records: {},
    aliases: {},
    parents: {},
    allocator: { project: 1, outcome: 1 },
    receipts: [],
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function generationName(generation) {
  return `generation-${String(generation).padStart(10, '0')}.json`;
}

function fsyncDirectory(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) {
    // The generation and marker files are still individually fsynced on filesystems
    // that do not allow opening a directory descriptor.
  }
}

function writeDurably(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
  fsyncDirectory(path.dirname(filePath));
}

function stateFromFile(stateDir) {
  const markerPath = path.join(stateDir, STATE_FILE);
  if (!fs.existsSync(markerPath)) return initialState();
  const marker = fs.readFileSync(markerPath, 'utf8').trim();
  if (!/^generation-[0-9]{10}\.json$/.test(marker)) throw new Error('registry integrity failure: invalid current generation marker');
  const generationPath = path.join(stateDir, marker);
  if (!fs.existsSync(generationPath)) throw new Error('registry integrity failure: committed generation is missing');
  return JSON.parse(fs.readFileSync(generationPath, 'utf8'));
}

function maxAllocated(records, kind) {
  const prefix = kind === 'project' ? 'prj_' : 'out_';
  return Object.keys(records)
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter(Number.isInteger)
    .reduce((max, value) => Math.max(max, value), 0);
}

function buildIndexes(records) {
  const aliases = {};
  const parents = {};
  for (const record of Object.values(records)) {
    parents[record.id] = record.parentId;
    for (const name of [record.title, ...(record.aliases || [])]) {
      const key = normalizeName(name);
      aliases[key] = [...new Set([...(aliases[key] || []), record.id])].sort();
    }
  }
  return { aliases, parents };
}

function validateState(state) {
  if (!state || state.contract !== REGISTRY_CONTRACT || !Number.isInteger(state.generation) || state.generation < 0) {
    throw new Error('registry integrity failure: invalid state contract');
  }
  if (!state.records || typeof state.records !== 'object' || Array.isArray(state.records)) {
    throw new Error('registry integrity failure: records must be an object');
  }
  for (const record of Object.values(state.records)) validateRecord(record, { records: state.records });
  const indexes = buildIndexes(state.records);
  if (JSON.stringify(indexes.aliases) !== JSON.stringify(state.aliases)) throw new Error('registry integrity failure: alias index drift');
  if (JSON.stringify(indexes.parents) !== JSON.stringify(state.parents)) throw new Error('registry integrity failure: parent index drift');
  for (const kind of ['project', 'outcome']) {
    if (!state.allocator || !Number.isInteger(state.allocator[kind]) || state.allocator[kind] < maxAllocated(state.records, kind) + 1) {
      throw new Error(`registry integrity failure: ${kind} allocator drift`);
    }
  }
  if (!Array.isArray(state.receipts)) throw new Error('registry integrity failure: receipts must be an array');
  return state;
}

function idFor(kind, allocator) {
  const prefix = kind === 'project' ? 'prj_' : 'out_';
  return `${prefix}${String(allocator[kind]).padStart(6, '0')}`;
}

function receiptClaims({ decisionId, reasonCodes } = {}, inference) {
  const hasDecisionId = decisionId !== undefined;
  const hasReasonCodes = reasonCodes !== undefined;
  if (!hasDecisionId && !hasReasonCodes) return {};
  if (!inference) throw new TypeError('receipt inference claims require inference metadata');

  const normalized = validateInferenceMetadata({
    ...inference,
    ...(hasDecisionId ? { decisionId } : {}),
    ...(hasReasonCodes ? { reasonCodes } : {}),
  });
  if (hasDecisionId && normalized.decisionId !== inference.decisionId) {
    throw new TypeError('receipt decisionId must match inference metadata');
  }
  if (hasReasonCodes && JSON.stringify(normalized.reasonCodes) !== JSON.stringify([...inference.reasonCodes].sort())) {
    throw new TypeError('receipt reasonCodes must match inference metadata');
  }

  const claims = {};
  if (hasDecisionId) claims.decisionId = normalized.decisionId;
  if (hasReasonCodes) claims.reasonCodes = normalized.reasonCodes;
  return claims;
}

class ProjectRegistry {
  constructor({ stateDir, now = () => new Date().toISOString() } = {}) {
    if (typeof stateDir !== 'string' || !stateDir.trim()) throw new TypeError('stateDir is required');
    this.stateDir = path.resolve(stateDir);
    this.now = now;
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.reload();
  }

  reload() {
    this.state = validateState(stateFromFile(this.stateDir));
    return this;
  }

  get generation() { return this.state.generation; }

  snapshot() {
    return {
      contract: REGISTRY_CONTRACT,
      generation: this.state.generation,
      records: Object.fromEntries(Object.entries(this.state.records).map(([id, record]) => [id, cloneRecord(record)])),
    };
  }

  get(id) {
    const record = this.state.records[id];
    return record ? cloneRecord(record) : null;
  }

  list() {
    return Object.values(this.state.records).map(cloneRecord).sort((a, b) => a.title.localeCompare(b.title));
  }

  resolve(value) {
    const text = String(value || '').trim();
    if (this.state.records[text]) return { status: 'resolved', record: cloneRecord(this.state.records[text]) };
    const candidates = [...(this.state.aliases[normalizeName(text)] || [])].sort();
    if (candidates.length === 1) return { status: 'resolved', record: cloneRecord(this.state.records[candidates[0]]) };
    if (candidates.length > 1) return { status: 'ambiguous', candidates };
    return { status: 'not-found' };
  }

  breadcrumb(id) {
    const parts = [];
    const visited = new Set();
    let current = this.state.records[id];
    while (current) {
      if (visited.has(current.id)) throw new Error('project hierarchy contains a cycle');
      visited.add(current.id);
      parts.unshift(current.title);
      current = current.parentId ? this.state.records[current.parentId] : null;
    }
    if (!parts.length) throw new Error(`project record not found: ${id}`);
    return parts.join(' › ');
  }

  priority(id) {
    return resolvePriority(id, this.state.records);
  }

  create(input, {
    expectedGeneration,
    actor = 'system',
    session = 'unknown',
    decisionId,
    reasonCodes,
  } = {}) {
    return this._withLock(() => {
      this.reload();
      this.assertGeneration(expectedGeneration);
      const next = cloneState(this.state);
      const { id, record } = this._createInState(next, input);
      return this.commit(next, {
        operation: 'create', actor, session, recordId: id, decisionId, reasonCodes,
      });
    });
  }

  update(id, patch, {
    expectedGeneration,
    expectedRevision,
    actor = 'system',
    session = 'unknown',
    decisionId,
    reasonCodes,
  } = {}) {
    return this._withLock(() => {
      this.reload();
      this.assertGeneration(expectedGeneration);
      const next = cloneState(this.state);
      const { record } = this._updateInState(next, id, patch, { expectedRevision });
      return this.commit(next, {
        operation: 'update', actor, session, recordId: id, decisionId, reasonCodes,
      });
    });
  }

  integrity() {
    try {
      validateState(this.state);
      return { ok: true, generation: this.state.generation };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  assertGeneration(expectedGeneration) {
    const diskState = validateState(stateFromFile(this.stateDir));
    if (diskState.generation !== this.state.generation) this.state = diskState;
    if (expectedGeneration !== undefined && expectedGeneration !== this.state.generation) {
      throw new Error(`stale registry generation: expected ${expectedGeneration}, current ${this.state.generation}`);
    }
  }

  _createInState(next, input) {
    const kind = input.kind || 'project';
    if (!STATUS_BY_KIND[kind]) throw new TypeError(`unsupported kind: ${kind}`);
    const id = idFor(kind, next.allocator);
    next.allocator[kind] += 1;
    const timestamp = this.now();
    const { record } = validateRecord({
      ...input,
      id,
      kind,
      revision: 1,
      createdAt: input.createdAt || timestamp,
      updatedAt: input.updatedAt || timestamp,
    }, { records: next.records });
    next.records[id] = record;
    return { id, record };
  }

  _updateInState(next, id, patch, { expectedRevision } = {}) {
    const current = next.records[id];
    if (!current) throw new Error(`project record not found: ${id}`);
    if (expectedRevision !== current.revision) throw new Error(`stale project revision: expected ${expectedRevision}, current ${current.revision}`);
    if (patch.id !== undefined || patch.kind !== undefined || patch.createdAt !== undefined || patch.revision !== undefined) {
      throw new TypeError('immutable project fields cannot be updated');
    }
    const suppliesInference = Object.prototype.hasOwnProperty.call(patch, 'inference');
    if (current.inference !== undefined && (!suppliesInference || patch.inference === undefined || patch.inference === null)) {
      if (suppliesInference) throw new TypeError('inference metadata cannot be removed');
    }
    if (suppliesInference && patch.inference === undefined) {
      throw new TypeError('inference metadata cannot be removed');
    }
    const timestamp = this.now();
    const { record } = validateRecord({
      ...current,
      ...patch,
      contract: suppliesInference ? RECORD_CONTRACT_V2 : current.contract,
      id: current.id,
      kind: current.kind,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt || timestamp,
    }, { records: next.records });
    next.records[id] = record;
    return { id, record };
  }

  mutate(mutator, {
    expectedGeneration,
    actor = 'system',
    session = 'unknown',
    operation = 'mutate',
    recordId,
    decisionId,
    reasonCodes,
  } = {}) {
    if (typeof mutator !== 'function') throw new TypeError('registry mutator is required');
    return this._withLock(() => {
      this.reload();
      this.assertGeneration(expectedGeneration);
      const next = cloneState(this.state);
      const transaction = {
        generation: next.generation,
        get: (id) => next.records[id] ? cloneRecord(next.records[id]) : null,
        list: () => Object.values(next.records).map(cloneRecord).sort((a, b) => a.title.localeCompare(b.title)),
        create: (input) => cloneRecord(this._createInState(next, input).record),
        update: (id, patch, options = {}) => cloneRecord(this._updateInState(next, id, patch, options).record),
      };
      const result = mutator(transaction);
      const committedRecordId = recordId || result?.recordId || result?.record?.id;
      if (!committedRecordId || !next.records[committedRecordId]) {
        throw new TypeError('registry mutation must identify a committed record');
      }
      const committed = this.commit(next, {
        operation, actor, session, recordId: committedRecordId, decisionId, reasonCodes,
      });
      return { ...committed, result };
    });
  }

  _withLock(fn) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.stateDir, 0o700); } catch (_) { /* best effort on non-POSIX hosts */ }
    const lockPath = path.join(this.stateDir, LOCK_FILE);
    const lockToken = crypto.randomBytes(16).toString('hex');
    const lockOwner = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: lockToken });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let acquired = false;
    while (!acquired) {
      const temporary = `${lockPath}.${process.pid}.${lockToken}.tmp`;
      try {
        writeDurably(temporary, lockOwner);
        fs.linkSync(temporary, lockPath);
        acquired = true;
      } catch (error) {
        if (error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('project registry is busy');
        let stale = false;
        let observed = null;
        try {
          observed = fs.readFileSync(lockPath, 'utf8');
          const lock = JSON.parse(observed);
          stale = !Number.isInteger(lock.pid) || Date.now() - Number(lock.createdAt || 0) > STALE_LOCK_MS;
          if (!stale && lock.pid !== process.pid) {
            try { process.kill(lock.pid, 0); } catch (probeError) { stale = probeError.code === 'ESRCH'; }
          }
        } catch (_) { stale = true; }
        if (stale) {
          const takeover = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
          try {
            fs.renameSync(lockPath, takeover);
            let moved = null;
            try { moved = fs.readFileSync(takeover, 'utf8'); } catch (_) {}
            if (observed !== moved) {
              try { fs.linkSync(takeover, lockPath); } catch (restoreError) {
                if (restoreError.code !== 'EEXIST') throw restoreError;
              }
            }
            try { fs.unlinkSync(takeover); } catch (_) {}
          } catch (takeoverError) {
            if (takeoverError.code !== 'ENOENT') throw takeoverError;
          }
        }
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      } finally {
        try { fs.unlinkSync(temporary); } catch (_) {}
      }
    }
    try {
      return fn();
    } finally {
      try {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (owner.token === lockToken) fs.unlinkSync(lockPath);
      } catch (_) {}
    }
  }

  commit(next, { operation, actor, session, recordId, decisionId, reasonCodes }) {
    next.generation = this.state.generation + 1;
    const indexes = buildIndexes(next.records);
    next.aliases = indexes.aliases;
    next.parents = indexes.parents;
    const receipt = {
      id: `rcpt_${next.generation}_${crypto.randomUUID()}`,
      operation,
      recordId,
      actor,
      session,
      generation: next.generation,
      observedAt: this.now(),
      ...receiptClaims({ decisionId, reasonCodes }, next.records[recordId].inference),
    };
    next.receipts.push(receipt);
    validateState(next);
    const generationFile = path.join(this.stateDir, generationName(next.generation));
    writeDurably(generationFile, `${JSON.stringify(next, null, 2)}\n`);
    writeDurably(path.join(this.stateDir, STATE_FILE), `${generationName(next.generation)}\n`);
    this.state = next;
    return { record: cloneRecord(next.records[recordId]), generation: next.generation, receipt: next.receipts.at(-1) };
  }
}

module.exports = {
  ProjectRegistry,
  RECORD_CONTRACT,
  RECORD_CONTRACT_V2,
  REGISTRY_CONTRACT,
  STATUS_BY_KIND,
  buildIndexes,
  cloneRecord,
  validateState,
  validateRecord,
};
