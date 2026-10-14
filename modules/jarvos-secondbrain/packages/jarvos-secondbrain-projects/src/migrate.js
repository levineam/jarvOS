'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ProjectRegistry } = require('./registry');
const legacy = require('./projects');

const MIGRATION_CONTRACT = 'jarvos.project-migration/v1';
const LEDGER_CONTRACT = 'jarvos.project-migration-ledger/v1';
const FIELD_DISPOSITION_FIELDS = Object.freeze([
  'title', 'goal', 'plan', 'definitionOfDone', 'status', 'createdAt', 'updatedAt', 'sourceTitle',
]);
const DISPOSITION_TARGETS = new Set([
  'project.title', 'project.aliases', 'project.goal', 'project.definitionOfDone', 'project.lifecycle', 'project.createdAt', 'project.updatedAt',
  'outcome.title', 'outcome.aliases', 'outcome.goal', 'outcome.definitionOfDone', 'outcome.lifecycle', 'outcome.createdAt', 'outcome.updatedAt',
  'discard', 'proposal',
]);

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function requiredString(value, field) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`); return value.trim(); }
function timestamp(value, field) { requiredString(value, field); if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`); return value; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }
function safeId(value) { return requiredString(value, 'migration id').replace(/[^A-Za-z0-9_.-]/g, '_'); }

function parseInlineSource(sourcePath, content, config) {
  const { frontmatter, body } = legacy.splitFrontmatter(content);
  const meta = legacy.parseFrontmatter(frontmatter);
  const sections = legacy.parseSections(body);
  const basename = path.basename(sourcePath, path.extname(sourcePath));
  const title = meta.title || (String(body || '').match(/^#\s+(.+)$/m)?.[1] || basename).trim();
  const section = (heading) => sections.get(heading) || '';
  const required = legacy.requiredSections(config);
  const missingSections = required.filter((item) => !legacy.isFilled(section(item.heading))).map((item) => item.id);
  return {
    sourcePath,
    sourceDigest: digest(content),
    title,
    status: String(meta.status || legacy.defaultStatus(config)).toLowerCase(),
    created: meta.created || null,
    sections: {
      goal: section('## Goal'),
      plan: section('## High-level plan'),
      'definition-of-done': section('## Definition of Done'),
    },
    missingSections,
    complete: missingSections.length === 0,
  };
}

function readLegacySource(source, { config = legacy.loadConfig() } = {}) {
  if (typeof source === 'string') source = { path: source };
  if (!isPlainObject(source)) throw new TypeError('migration source must be a path or object');
  const sourcePath = requiredString(source.path || source.sourcePath, 'source path');
  const content = source.content === undefined ? fs.readFileSync(sourcePath, 'utf8') : String(source.content);
  return parseInlineSource(sourcePath, content, config);
}

function validateFieldDispositions(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== FIELD_DISPOSITION_FIELDS.length || FIELD_DISPOSITION_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) {
    throw new TypeError(`field dispositions must account for: ${FIELD_DISPOSITION_FIELDS.join(', ')}`);
  }
  const normalized = {};
  for (const field of FIELD_DISPOSITION_FIELDS) {
    const disposition = value[field];
    if (typeof disposition !== 'string' || !DISPOSITION_TARGETS.has(disposition)) throw new TypeError(`unsupported disposition for ${field}`);
    normalized[field] = disposition;
  }
  return normalized;
}

function normalizeMapping(mapping) {
  if (!isPlainObject(mapping)) throw new TypeError('migration mapping is required');
  const version = requiredString(mapping.version || mapping.contract || '1', 'mapping version');
  const entries = Array.isArray(mapping.entries) ? mapping.entries : [];
  const seen = new Set();
  const normalizedEntries = entries.map((entry, index) => {
    if (!isPlainObject(entry)) throw new TypeError(`mapping entry ${index} must be an object`);
    const sourcePath = requiredString(entry.sourcePath || entry.path, `mapping entry ${index}.sourcePath`);
    if (seen.has(sourcePath)) throw new TypeError(`duplicate mapping source: ${sourcePath}`);
    seen.add(sourcePath);
    const fieldDispositions = validateFieldDispositions(entry.fieldDispositions || entry.fieldDisposition);
    const project = entry.project === null ? null : (isPlainObject(entry.project) ? clone(entry.project) : (() => { throw new TypeError(`mapping entry ${index}.project must be an object or null`); })());
    const outcome = entry.outcome === undefined || entry.outcome === null ? null : (isPlainObject(entry.outcome) ? clone(entry.outcome) : (() => { throw new TypeError(`mapping entry ${index}.outcome must be an object or null`); })());
    if (!project && !outcome) throw new TypeError(`mapping entry ${index} needs a project or outcome target`);
    return {
      sourcePath,
      sourceDigest: entry.sourceDigest || null,
      fieldDispositions,
      project,
      outcome,
      approved: entry.approved === true,
    };
  });
  return { contract: MIGRATION_CONTRACT, version, entries: normalizedEntries };
}

function mapField(source, disposition, targets) {
  if (disposition === 'discard' || disposition === 'proposal') return;
  const [kind, field] = disposition.split('.');
  const target = targets[kind];
  if (!target) return;
  const values = {
    title: source.title,
    goal: source.sections.goal,
    plan: source.sections.plan,
    definitionOfDone: source.sections['definition-of-done'],
    status: source.status,
    createdAt: source.created ? `${source.created}T00:00:00.000Z` : null,
    updatedAt: source.created ? `${source.created}T00:00:00.000Z` : null,
    sourceTitle: source.title,
  };
  const value = values[field];
  if (value === null || value === undefined || value === '') return;
  if (field === 'status' && target.lifecycle === undefined) target.lifecycle = kind === 'project' ? (value === 'done' || value === 'abandoned' ? 'archived' : value) : (value === 'done' ? 'complete' : value === 'abandoned' ? 'archived' : value);
  else if (field === 'sourceTitle') target.aliases = [...new Set([...(target.aliases || []), String(value)])];
  else if (field === 'plan') target.goal = target.goal ? `${target.goal}\n\nPlan:\n${value}` : `Plan:\n${value}`;
  else if (target[field] === undefined) target[field] = value;
}

function targetForEntry(source, entry) {
  const project = entry.project ? { ...entry.project } : null;
  const outcome = entry.outcome ? { ...entry.outcome } : null;
  const targets = { project, outcome };
  for (const field of FIELD_DISPOSITION_FIELDS) mapField(source, entry.fieldDispositions[field], targets);
  if (project && !project.title) project.title = source.title;
  if (outcome && !outcome.title) outcome.title = source.title;
  return { project, outcome };
}

function buildMigrationPlan({ sources = [], mapping, migrationId = `migration-${Date.now()}`, now = new Date().toISOString(), config = legacy.loadConfig() } = {}) {
  const normalizedMapping = normalizeMapping(mapping);
  const loaded = sources.map((source) => readLegacySource(source, { config }));
  const loadedPaths = new Set(loaded.map((source) => source.sourcePath));
  const conflicts = [];
  const proposals = [];
  const targets = [];
  const dispositions = [];
  for (const entry of normalizedMapping.entries) {
    if (!loadedPaths.has(entry.sourcePath)) conflicts.push({ sourcePath: entry.sourcePath, reason: 'mapping-source-not-provided' });
  }
  for (const source of loaded) {
    const entry = normalizedMapping.entries.find((candidate) => candidate.sourcePath === source.sourcePath);
    if (!entry) {
      proposals.push({ sourcePath: source.sourcePath, sourceDigest: source.sourceDigest, title: source.title, reason: 'explicit-mapping-required' });
      continue;
    }
    if (entry.sourceDigest && entry.sourceDigest !== source.sourceDigest) {
      conflicts.push({ sourcePath: source.sourcePath, reason: 'source-digest-mismatch', expected: entry.sourceDigest, actual: source.sourceDigest });
      continue;
    }
    if (!entry.approved) {
      proposals.push({ sourcePath: source.sourcePath, sourceDigest: source.sourceDigest, title: source.title, reason: 'mapping-not-approved' });
      continue;
    }
    const target = targetForEntry(source, entry);
    if (target.project && !target.project.title) conflicts.push({ sourcePath: source.sourcePath, reason: 'project-title-missing' });
    if (target.outcome && !target.outcome.title) conflicts.push({ sourcePath: source.sourcePath, reason: 'outcome-title-missing' });
    const names = [target.project?.title, target.outcome?.title].filter(Boolean).map((name) => String(name).trim().toLocaleLowerCase('en-US'));
    if (new Set(names).size !== names.length) conflicts.push({ sourcePath: source.sourcePath, reason: 'duplicate-target-title' });
    targets.push({ sourcePath: source.sourcePath, sourceDigest: source.sourceDigest, ...target });
    dispositions.push({ sourcePath: source.sourcePath, ...entry.fieldDispositions });
  }
  const targetNames = new Map();
  for (const target of targets) {
    for (const kind of ['project', 'outcome']) {
      const title = target[kind]?.title;
      if (!title) continue;
      const key = `${kind}:${String(title).trim().toLocaleLowerCase('en-US')}`;
      if (targetNames.has(key)) conflicts.push({ sourcePath: target.sourcePath, reason: 'duplicate-target', target: key, otherSourcePath: targetNames.get(key) });
      else targetNames.set(key, target.sourcePath);
    }
  }
  const status = conflicts.length ? 'conflict' : proposals.length ? 'proposed' : 'ready';
  const plan = {
    contract: MIGRATION_CONTRACT,
    migrationId: safeId(migrationId),
    createdAt: timestamp(now, 'migration plan createdAt'),
    sourceDigests: Object.fromEntries(loaded.map((source) => [source.sourcePath, source.sourceDigest])),
    mappingDigest: digest(normalizedMapping),
    mapping: normalizedMapping,
    targets,
    proposals,
    conflicts,
    dispositions,
    status,
  };
  return plan;
}

function ledgerPath(ledgerDir, migrationId) {
  return path.join(requiredString(ledgerDir, 'ledger directory'), `migration-${safeId(migrationId)}.json`);
}

function readMigrationLedger(ledgerDir, migrationId) {
  try {
    const value = JSON.parse(fs.readFileSync(ledgerPath(ledgerDir, migrationId), 'utf8'));
    return value && value.contract === LEDGER_CONTRACT ? value : null;
  } catch {
    return null;
  }
}

function writeMigrationLedger(ledgerDir, ledger) {
  const filePath = ledgerPath(ledgerDir, ledger.migrationId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return filePath;
}

function applyMigration(plan, { registry, ledgerDir, approved = false, actor = 'migration', session = 'migration', now = new Date().toISOString() } = {}) {
  if (!(registry instanceof ProjectRegistry)) throw new TypeError('applyMigration requires a ProjectRegistry');
  if (!approved || plan.status !== 'ready') return { status: plan.status === 'ready' ? 'approval-required' : plan.status, plan };
  const prior = readMigrationLedger(ledgerDir, plan.migrationId);
  if (prior && prior.mappingDigest !== plan.mappingDigest) return { status: 'conflict', reason: 'mapping-digest-drift', ledger: prior };
  if (prior && JSON.stringify(stableValue(prior.sourceDigests)) !== JSON.stringify(stableValue(plan.sourceDigests))) return { status: 'conflict', reason: 'source-digest-drift', ledger: prior };
  if (prior && prior.state === 'committed') return { status: 'already_satisfied', ledger: prior };
  let ledger = prior || {
    contract: LEDGER_CONTRACT,
    migrationId: plan.migrationId,
    mappingDigest: plan.mappingDigest,
    sourceDigests: plan.sourceDigests,
    targetIds: {},
    dispositions: plan.dispositions,
    state: 'prepared',
    createdAt: plan.createdAt,
    updatedAt: now,
  };
  writeMigrationLedger(ledgerDir, ledger);
  try {
    for (const target of plan.targets) {
      let projectRecord = null;
      if (target.project) {
        const targetKey = `${target.sourcePath}:project`;
        const resumed = ledger.targetIds[targetKey] ? registry.get(ledger.targetIds[targetKey]) : null;
        if (ledger.targetIds[targetKey] && !resumed) throw new Error(`migration ledger target is missing: ${ledger.targetIds[targetKey]}`);
        if (resumed) {
          projectRecord = resumed;
        } else {
          if (target.project.id) {
            const existing = registry.get(target.project.id);
            if (!existing || existing.kind !== 'project' || existing.title !== target.project.title) {
              throw new Error(`canonical project identity is not an exact match: ${target.project.id}`);
            }
            projectRecord = existing;
          } else {
            const result = registry.resolve(target.project.title);
            if (result.status === 'resolved' || result.status === 'ambiguous') throw new Error(`target already exists or is ambiguous: ${target.project.title}`);
            const created = registry.create({ ...target.project, kind: 'project', aliases: [...new Set(target.project.aliases || [])], links: { ...(target.project.links || {}), migrationId: plan.migrationId, sourcePath: target.sourcePath } }, { expectedGeneration: registry.generation, actor, session });
            projectRecord = created.record;
          }
          ledger.targetIds[targetKey] = projectRecord.id;
          ledger.state = 'project-reconciled';
          ledger.updatedAt = now;
          writeMigrationLedger(ledgerDir, ledger);
        }
      }
      if (target.outcome) {
        const parentId = projectRecord?.id || ledger.targetIds[`${target.sourcePath}:project`] || target.outcome.parentId;
        if (!parentId) throw new Error(`outcome mapping has no project parent: ${target.sourcePath}`);
        const targetKey = `${target.sourcePath}:outcome`;
        const resumed = ledger.targetIds[targetKey] ? registry.get(ledger.targetIds[targetKey]) : null;
        if (ledger.targetIds[targetKey] && !resumed) throw new Error(`migration ledger target is missing: ${ledger.targetIds[targetKey]}`);
        if (!resumed) {
          let outcomeRecord = null;
          if (target.outcome.id) {
            const existing = registry.get(target.outcome.id);
            if (!existing || existing.kind !== 'outcome' || existing.title !== target.outcome.title || existing.parentId !== parentId) {
              throw new Error(`canonical outcome identity is not an exact match: ${target.outcome.id}`);
            }
            outcomeRecord = existing;
          } else {
            const result = registry.resolve(target.outcome.title);
            if (result.status === 'resolved' || result.status === 'ambiguous') throw new Error(`target already exists or is ambiguous: ${target.outcome.title}`);
            const created = registry.create({ ...target.outcome, kind: 'outcome', parentId, aliases: [...new Set(target.outcome.aliases || [])], links: { ...(target.outcome.links || {}), migrationId: plan.migrationId, sourcePath: target.sourcePath } }, { expectedGeneration: registry.generation, actor, session });
            outcomeRecord = created.record;
          }
          ledger.targetIds[targetKey] = outcomeRecord.id;
          ledger.state = 'outcome-reconciled';
          ledger.updatedAt = now;
          writeMigrationLedger(ledgerDir, ledger);
        }
      }
    }
    ledger.state = 'committed';
    ledger.updatedAt = now;
    ledger.committedAt = now;
    writeMigrationLedger(ledgerDir, ledger);
    return { status: 'committed', ledger };
  } catch (error) {
    ledger.state = 'requires-reconciliation';
    ledger.updatedAt = now;
    ledger.error = error.message;
    writeMigrationLedger(ledgerDir, ledger);
    return { status: 'requires-reconciliation', ledger };
  }
}

function rollbackMigration({ ledgerDir, migrationId, registry, now = new Date().toISOString(), actor = 'migration-rollback', session = 'migration-rollback' } = {}) {
  const ledger = readMigrationLedger(ledgerDir, migrationId);
  if (!ledger) return { status: 'not-found' };
  if (ledger.state === 'rolled-back') return { status: 'already_satisfied', ledger };
  if (!(registry instanceof ProjectRegistry)) throw new TypeError('rollbackMigration requires a ProjectRegistry');
  for (const id of Object.values(ledger.targetIds || {}).reverse()) {
    const record = registry.get(id);
    if (!record || record.lifecycle === 'archived') continue;
    const lifecycle = 'archived';
    registry.update(id, { lifecycle }, { expectedGeneration: registry.generation, expectedRevision: record.revision, actor, session });
  }
  const next = { ...ledger, state: 'rolled-back', updatedAt: now, rolledBackAt: now };
  writeMigrationLedger(ledgerDir, next);
  return { status: 'rolled-back', ledger: next };
}

module.exports = {
  FIELD_DISPOSITION_FIELDS,
  LEDGER_CONTRACT,
  MIGRATION_CONTRACT,
  applyMigration,
  buildMigrationPlan,
  digest,
  ledgerPath,
  normalizeMapping,
  readLegacySource,
  readMigrationLedger,
  rollbackMigration,
  validateFieldDispositions,
  writeMigrationLedger,
};
