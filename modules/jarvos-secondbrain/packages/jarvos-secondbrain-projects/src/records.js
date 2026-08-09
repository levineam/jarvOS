'use strict';

const RECORD_CONTRACT = 'jarvos.project-record/v1';
const KINDS = Object.freeze(['project', 'outcome']);
const PRIORITIES = Object.freeze(['high', 'medium', 'low', 'unset']);
const STATUS_BY_KIND = Object.freeze({
  project: Object.freeze(['active', 'paused', 'archived']),
  outcome: Object.freeze(['planned', 'active', 'complete', 'archived']),
});
const ID_PATTERN = /^(?:prj|out)_[0-9]{6,}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function isoTimestamp(value, field) {
  nonEmpty(value, field);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function cloneRecord(record) {
  return record && { ...record, aliases: [...(record.aliases || [])], links: { ...(record.links || {}) } };
}

function normalizeAliases(aliases) {
  if (aliases === undefined) return [];
  if (!Array.isArray(aliases)) throw new TypeError('aliases must be an array');
  const seen = new Set();
  return aliases.map((alias, index) => {
    const display = nonEmpty(alias, `aliases[${index}]`);
    const key = normalizeName(display);
    if (seen.has(key)) throw new TypeError(`duplicate alias: ${display}`);
    seen.add(key);
    return display;
  });
}

function defaultLifecycle(kind) {
  return kind === 'outcome' ? 'planned' : 'active';
}

function validateRecord(input, { records = {} } = {}) {
  if (!isPlainObject(input)) throw new TypeError('project record must be an object');
  const kind = input.kind;
  if (!KINDS.includes(kind)) throw new TypeError(`kind must be one of: ${KINDS.join(', ')}`);
  const id = nonEmpty(input.id, 'id');
  if (!ID_PATTERN.test(id)) throw new TypeError('id must be an opaque project or outcome identifier');
  const title = nonEmpty(input.title, 'title');
  const aliases = normalizeAliases(input.aliases);
  const parentId = input.parentId === undefined ? null : input.parentId;
  if (parentId !== null) nonEmpty(parentId, 'parentId');
  const lifecycle = input.lifecycle === undefined ? defaultLifecycle(kind) : input.lifecycle;
  if (!STATUS_BY_KIND[kind].includes(lifecycle)) throw new TypeError(`invalid lifecycle for ${kind}: ${lifecycle}`);
  const declaredPriority = input.declaredPriority === undefined ? 'unset' : input.declaredPriority;
  if (!PRIORITIES.includes(declaredPriority)) throw new TypeError(`declaredPriority must be one of: ${PRIORITIES.join(', ')}`);
  if (!Number.isInteger(input.revision) || input.revision < 1) throw new TypeError('revision must be a positive integer');
  const createdAt = isoTimestamp(input.createdAt, 'createdAt');
  const updatedAt = isoTimestamp(input.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new TypeError('updatedAt cannot precede createdAt');
  if (kind === 'outcome' && parentId === null) throw new TypeError('outcome requires a project parent');
  if (parentId !== null) {
    const parent = records[parentId];
    if (!parent) throw new TypeError(`parent record not found: ${parentId}`);
    if (parent.kind !== 'project') throw new TypeError('parent must be a project');
    const ancestors = new Set([id]);
    let ancestor = parent;
    while (ancestor) {
      if (ancestors.has(ancestor.id)) throw new TypeError('project hierarchy contains a cycle');
      ancestors.add(ancestor.id);
      ancestor = ancestor.parentId ? records[ancestor.parentId] : null;
    }
  }

  const record = {
    contract: RECORD_CONTRACT,
    id,
    kind,
    title,
    aliases,
    parentId,
    lifecycle,
    declaredPriority,
    revision: input.revision,
    createdAt,
    updatedAt,
  };
  if (input.goal !== undefined) record.goal = String(input.goal);
  if (input.definitionOfDone !== undefined) record.definitionOfDone = String(input.definitionOfDone);
  if (input.links !== undefined) {
    if (!isPlainObject(input.links)) throw new TypeError('links must be an object');
    record.links = { ...input.links };
  } else {
    record.links = {};
  }
  return { ok: true, record };
}

module.exports = {
  ID_PATTERN,
  KINDS,
  PRIORITIES,
  RECORD_CONTRACT,
  STATUS_BY_KIND,
  cloneRecord,
  defaultLifecycle,
  normalizeAliases,
  normalizeName,
  validateRecord,
};
