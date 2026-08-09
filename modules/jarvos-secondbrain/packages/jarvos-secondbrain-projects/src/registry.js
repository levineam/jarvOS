'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  STATUS_BY_KIND,
  cloneRecord,
  normalizeName,
  validateRecord,
} = require('./records');
const { resolvePriority } = require('./priority');

const REGISTRY_CONTRACT = 'jarvos.projects-registry/v1';
const STATE_FILE = 'CURRENT';

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

  create(input, { expectedGeneration, actor = 'system', session = 'unknown' } = {}) {
    this.assertGeneration(expectedGeneration);
    const next = cloneState(this.state);
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
    return this.commit(next, { operation: 'create', actor, session, recordId: id });
  }

  update(id, patch, { expectedGeneration, expectedRevision, actor = 'system', session = 'unknown' } = {}) {
    this.assertGeneration(expectedGeneration);
    const current = this.state.records[id];
    if (!current) throw new Error(`project record not found: ${id}`);
    if (expectedRevision !== current.revision) throw new Error(`stale project revision: expected ${expectedRevision}, current ${current.revision}`);
    if (patch.id !== undefined || patch.kind !== undefined || patch.createdAt !== undefined || patch.revision !== undefined) {
      throw new TypeError('immutable project fields cannot be updated');
    }
    const next = cloneState(this.state);
    const timestamp = this.now();
    const { record } = validateRecord({
      ...current,
      ...patch,
      id: current.id,
      kind: current.kind,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: patch.updatedAt || timestamp,
    }, { records: next.records });
    next.records[id] = record;
    return this.commit(next, { operation: 'update', actor, session, recordId: id });
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

  commit(next, { operation, actor, session, recordId }) {
    next.generation = this.state.generation + 1;
    const indexes = buildIndexes(next.records);
    next.aliases = indexes.aliases;
    next.parents = indexes.parents;
    next.receipts.push({
      id: `rcpt_${next.generation}_${crypto.randomUUID()}`,
      operation,
      recordId,
      actor,
      session,
      generation: next.generation,
      observedAt: this.now(),
    });
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
  REGISTRY_CONTRACT,
  STATUS_BY_KIND,
  buildIndexes,
  validateState,
  validateRecord,
};
