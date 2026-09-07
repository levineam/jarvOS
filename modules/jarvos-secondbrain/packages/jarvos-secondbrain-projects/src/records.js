'use strict';

const { isPlainObject: isInferencePlainObject } = require('./project-inference-contracts');

const RECORD_CONTRACT = 'jarvos.project-record/v1';
const RECORD_CONTRACT_V2 = 'jarvos.project-record/v2';
const INFERENCE_METADATA_FIELDS = Object.freeze([
  'candidateId', 'decisionId', 'disposition', 'suppressionKeys', 'supersededBy', 'reasonCodes',
]);
const CANONICAL_INFERENCE_DISPOSITIONS = Object.freeze([
  'established', 'associated', 'corrected', 'unchanged', 'superseded',
]);
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

function inferenceOpaque(value, field, { prefix = null, nullable = false } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be an opaque identifier`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length > 256 || /[\u0000\r\n]/.test(normalized)
    || /\s/.test(normalized) || /[\\/]/.test(normalized) || /:\/\//.test(normalized) || normalized.startsWith('~')
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(normalized)) {
    throw new TypeError(`${field} must be an opaque identifier`);
  }
  if (prefix) {
    const pattern = prefix === 'cand_' ? /^cand_[a-f0-9]{32}$/ : /^dec_[a-f0-9]{32}$/;
    if (!pattern.test(normalized)) throw new TypeError(`${field} must reference a ${prefix.slice(0, -1)}`);
  }
  return normalized;
}

function normalizeInferenceReasonCodes(value) {
  if (!Array.isArray(value)) throw new TypeError('inference.reasonCodes must be an array of opaque IDs');
  const normalized = value.map((entry, index) => inferenceOpaque(entry, `inference.reasonCodes[${index}]`).toLocaleLowerCase('en-US'));
  if (new Set(normalized).size !== normalized.length) throw new TypeError('inference.reasonCodes must not contain duplicates');
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizeInferenceSuppressionKeys(value) {
  if (!Array.isArray(value)) throw new TypeError('inference.suppressionKeys must be an array of opaque IDs');
  const normalized = value.map((entry, index) => inferenceOpaque(entry, `inference.suppressionKeys[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError('inference.suppressionKeys must not contain duplicates');
  return normalized.sort((left, right) => left.localeCompare(right));
}

function validateInferenceMetadata(input) {
  if (!isInferencePlainObject(input)) throw new TypeError('inference metadata must be a plain object');
  const expected = new Set(INFERENCE_METADATA_FIELDS);
  const actual = Object.keys(input);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new TypeError(`inference metadata must contain exact fields: ${INFERENCE_METADATA_FIELDS.join(', ')}`);
  }
  const candidateId = inferenceOpaque(input.candidateId, 'inference.candidateId', { prefix: 'cand_' });
  const decisionId = inferenceOpaque(input.decisionId, 'inference.decisionId', { prefix: 'dec_' });
  if (!CANONICAL_INFERENCE_DISPOSITIONS.includes(input.disposition)) {
    throw new TypeError(`inference.disposition must be one of: ${CANONICAL_INFERENCE_DISPOSITIONS.join(', ')}`);
  }
  const suppressionKeys = normalizeInferenceSuppressionKeys(input.suppressionKeys);
  const supersededBy = inferenceOpaque(input.supersededBy, 'inference.supersededBy', { prefix: 'dec_', nullable: true });
  if (input.disposition === 'superseded' && !supersededBy) throw new TypeError('superseded inference metadata requires supersededBy');
  if (input.disposition !== 'superseded' && supersededBy) throw new TypeError('supersededBy is only valid for a superseded inference disposition');
  const reasonCodes = normalizeInferenceReasonCodes(input.reasonCodes);
  return {
    candidateId,
    decisionId,
    disposition: input.disposition,
    suppressionKeys,
    supersededBy,
    reasonCodes,
  };
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
  if (!record) return record;
  const clone = { ...record, aliases: [...(record.aliases || [])], links: { ...(record.links || {}) } };
  if (record.inference !== undefined) {
    clone.inference = {
      ...record.inference,
      suppressionKeys: [...(record.inference.suppressionKeys || [])],
      reasonCodes: [...(record.inference.reasonCodes || [])],
    };
  }
  return clone;
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

  const hasInference = input.inference !== undefined;
  const contract = hasInference ? RECORD_CONTRACT_V2 : RECORD_CONTRACT;
  if (input.contract !== undefined && input.contract !== contract) {
    throw new TypeError(`contract must be ${contract}`);
  }
  const inference = hasInference ? validateInferenceMetadata(input.inference) : null;

  const record = {
    contract,
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
  if (inference) record.inference = inference;
  return { ok: true, record };
}

module.exports = {
  CANONICAL_INFERENCE_DISPOSITIONS,
  INFERENCE_METADATA_FIELDS,
  ID_PATTERN,
  KINDS,
  PRIORITIES,
  RECORD_CONTRACT,
  RECORD_CONTRACT_V2,
  STATUS_BY_KIND,
  cloneRecord,
  defaultLifecycle,
  normalizeAliases,
  normalizeName,
  validateInferenceMetadata,
  validateRecord,
};
