'use strict';

const crypto = require('node:crypto');

const MAX_PROPOSAL_BYTES = 32768;
const MAX_LINKS = 16;
const ID_PATTERN = /^(?:prj|out)_[0-9]{6,}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class ProposalValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProposalValidationError';
    this.code = 'PROJECTS_PROPOSAL_INVALID';
  }
}

function invalid(message) { throw new ProposalValidationError(message); }

function isJsonValue(value, seen = new Set(), depth = 0) {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) return false;
    seen.add(value);
    const names = Object.getOwnPropertyNames(value);
    const valid = names.length === value.length + 1 && names.includes('length') && Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && isJsonValue(descriptor.value, seen, depth + 1);
    }).every(Boolean);
    seen.delete(value);
    return valid;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  const keys = Object.keys(value);
  const valid = Object.getOwnPropertyNames(value).length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') && isJsonValue(descriptor.value, seen, depth + 1);
  });
  seen.delete(value);
  return valid;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(`${label} must be a JSON object`);
  return value;
}

function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label} contains an unknown field`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(`${label} is missing a required field`);
}

function text(value, label, maximum) {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) invalid(`${label} is out of bounds`);
  return normalized;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeUtcIso(value) {
  if (typeof value !== 'string' || !UTC_ISO_PATTERN.test(value)) invalid('expiresAt must be an ISO UTC timestamp');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) invalid('expiresAt must be an ISO UTC timestamp');
  const normalized = parsed.toISOString();
  const comparable = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (normalized !== comparable) invalid('expiresAt must be an ISO UTC timestamp');
  return normalized;
}

function normalizeLinks(value) {
  if (value === undefined) return undefined;
  const links = object(value, 'record.links');
  const keys = Object.keys(links);
  if (keys.length > MAX_LINKS) invalid('record.links has too many entries');
  const normalizedEntries = [];
  const normalizedKeys = new Set();
  for (const key of keys.sort()) {
    const normalizedKey = text(key, 'record.links key', 200);
    if (normalizedKey === '__proto__' || normalizedKey === 'prototype' || normalizedKey === 'constructor' || normalizedKeys.has(normalizedKey)) {
      invalid('record.links contains an unsafe or duplicate key');
    }
    normalizedKeys.add(normalizedKey);
    normalizedEntries.push([normalizedKey, text(links[key], 'record.links value', 2000)]);
  }
  return Object.fromEntries(normalizedEntries);
}

function normalizeProposal(value) {
  if (!isJsonValue(value)) invalid('proposal must contain JSON data only');
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_PROPOSAL_BYTES) invalid('proposal exceeds the encoded size limit');
  const proposal = object(value, 'proposal');
  exactKeys(proposal, ['kind', 'expectedGeneration', 'record', 'rationale', 'evidenceRefs', 'expiresAt'], [], 'proposal');
  if (proposal.kind !== 'create') invalid('proposal.kind must be create');
  if (!Number.isSafeInteger(proposal.expectedGeneration) || proposal.expectedGeneration < 0) invalid('expectedGeneration must be a nonnegative safe integer');

  const record = object(proposal.record, 'record');
  exactKeys(record, ['kind', 'title', 'parentId', 'goal', 'definitionOfDone'], ['links'], 'record');
  if (record.kind !== 'project' && record.kind !== 'outcome') invalid('record.kind is invalid');
  const parentId = record.parentId === null ? null : text(record.parentId, 'record.parentId', 200);
  if (parentId !== null && !ID_PATTERN.test(parentId)) invalid('record.parentId must be a canonical Projects id');
  if (record.kind === 'outcome' && parentId === null) invalid('outcomes require a parentId');

  if (!Array.isArray(proposal.evidenceRefs) || Object.getPrototypeOf(proposal.evidenceRefs) !== Array.prototype
    || proposal.evidenceRefs.length < 1 || proposal.evidenceRefs.length > 16) invalid('evidenceRefs must contain between one and sixteen entries');
  const evidenceRefs = proposal.evidenceRefs.map((ref) => text(ref, 'evidenceRefs entry', 2000));
  const normalized = {
    kind: 'create',
    expectedGeneration: proposal.expectedGeneration,
    record: {
      kind: record.kind,
      title: text(record.title, 'record.title', 200),
      parentId,
      goal: text(record.goal, 'record.goal', 4000),
      definitionOfDone: text(record.definitionOfDone, 'record.definitionOfDone', 8000),
    },
    rationale: text(proposal.rationale, 'rationale', 2000),
    evidenceRefs,
    expiresAt: normalizeUtcIso(proposal.expiresAt),
  };
  const links = normalizeLinks(record.links);
  if (links !== undefined) normalized.record.links = links;
  const encoded = canonicalJson(normalized);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROPOSAL_BYTES) invalid('proposal exceeds the encoded size limit');
  return Object.freeze({
    proposal: Object.freeze(normalized),
    digest: crypto.createHash('sha256').update(encoded).digest('hex'),
  });
}

module.exports = { MAX_PROPOSAL_BYTES, ProposalValidationError, canonicalJson, normalizeProposal };
