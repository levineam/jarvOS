'use strict';

// Pure target-hydration assessment. Given a context packet build result (or
// its failure), the exact target canonical record, and the durable-work
// causal keys the host expects to see, report whether the target and its
// activity are present -- and when they are not, why, with typed omission
// codes. A target that is missing must never look like a healthy quiet
// packet. This module reads no store and renders nothing.

const crypto = require('node:crypto');

const TARGET_HYDRATION_CONTRACT = 'jarvos.target-hydration/v1';
const OMISSION_CODES = Object.freeze([
  'scope',
  'generation_mismatch',
  'item_limit',
  'byte_limit',
  'age_window',
  'render_truncation',
  'provider_unavailable',
  'unbound',
]);
const TARGET_STATUSES = Object.freeze(['present', 'partial', 'omitted']);
const CANONICAL_ID = /^(?:prj|out)_[0-9]{6,}$/;
const CAUSAL_KEY = /^dwe_[a-f0-9]{32}$/;
const MAX_EXPECTED = 64;

function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function sha256(value) { return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }

function countItems(packet) {
  return packet.canonical.records.length + packet.activity.length + packet.currentWork.length + packet.attention.length + packet.evidence.length
    + (packet.inference?.candidates?.length || 0);
}

function normalizeExpected(expected) {
  if (expected === undefined || expected === null) return [];
  if (!Array.isArray(expected) || expected.length > MAX_EXPECTED) throw new TypeError('expected must be a bounded array');
  return expected.map((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.causalKey !== 'string' || !CAUSAL_KEY.test(entry.causalKey)) {
      throw new TypeError(`expected[${index}].causalKey is invalid`);
    }
    const occurredAt = entry.occurredAt === undefined || entry.occurredAt === null ? null : entry.occurredAt;
    if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) throw new TypeError(`expected[${index}].occurredAt is invalid`);
    return { causalKey: entry.causalKey, occurredAt };
  });
}

function omission(code, subject) {
  return { code, subject };
}

function sortOmissions(omissions) {
  const seen = new Set();
  return omissions.filter((entry) => {
    const key = `${entry.code}\0${entry.subject}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => OMISSION_CODES.indexOf(left.code) - OMISSION_CODES.indexOf(right.code)
    || left.subject.localeCompare(right.subject));
}

// Splits a packet's truncation count into the part the item bound removed and
// the part the byte bound removed. The packet builder trims by item count
// first, then by bytes, so any omission beyond the item overage is a byte
// omission.
function truncationCauses(packet) {
  const truncation = packet.truncation;
  if (!truncation || truncation.truncated !== true || !Number.isInteger(truncation.omittedItems) || truncation.omittedItems < 1) {
    return { item: false, byte: false };
  }
  const before = countItems(packet) + truncation.omittedItems;
  const itemTrim = Math.max(0, before - truncation.maxItems);
  const byteTrim = truncation.omittedItems - Math.min(itemTrim, truncation.omittedItems);
  return { item: itemTrim > 0, byte: byteTrim > 0 };
}

function inScope(packet, targetId) {
  const scope = packet.query?.scope;
  if (!scope) return false;
  if (!scope.projectIds.length && !scope.outcomeIds.length) return true;
  if (scope.projectIds.includes(targetId) || scope.outcomeIds.includes(targetId)) return true;
  // A descendant target is only in scope when the packet's own records show
  // its ancestry: a scope cannot be widened by the assessor.
  if (!scope.includeDescendants) return false;
  const byId = new Map(packet.canonical.records.map((record) => [record.id, record]));
  let current = byId.get(targetId);
  const visited = new Set();
  while (current && current.parentId && !visited.has(current.id)) {
    visited.add(current.id);
    if (scope.projectIds.includes(current.parentId) || scope.outcomeIds.includes(current.parentId)) return true;
    current = byId.get(current.parentId);
  }
  return false;
}

function activityPresent(packet, causalKey, targetId) {
  const matches = (entry) => entry && entry.id === causalKey && (entry.canonicalId === targetId || entry.canonicalAtAdmission?.rootProjectId === targetId);
  return packet.activity.some(matches) || packet.evidence.some(matches);
}

function withinWindow(occurredAt, activityWindow) {
  if (!occurredAt || !activityWindow) return true;
  const occurred = Date.parse(occurredAt);
  return occurred >= Date.parse(activityWindow.from) && occurred < Date.parse(activityWindow.to);
}

function assessmentReceipt({ targetId, status, omissions, packet, presentCausalKeys, expected }) {
  const receipt = {
    contract: TARGET_HYDRATION_CONTRACT,
    targetId,
    status,
    omissions: sortOmissions(omissions),
    packetId: packet?.packetId || null,
    registryGeneration: Number.isInteger(packet?.canonical?.generation) ? packet.canonical.generation : null,
    presentCausalKeys: [...presentCausalKeys].sort(),
    expectedCausalKeys: expected.map((entry) => entry.causalKey).sort(),
  };
  receipt.assessmentDigest = sha256(receipt);
  return receipt;
}

// Inputs:
//   targetId            exact canonical id, or null when the session is unbound
//   result              buildContextPacket() result ({status, packet} or {status, code})
//   expected            [{ causalKey, occurredAt? }] durable-work receipts that should be visible
//   expectedGeneration  registry generation the host pinned, if any
//   activityWindow      { from, to } the reader applied, if any
//   rendered            { text, markers } model-visible markdown and the target markers it must carry
function assessTargetHydration({
  targetId = null,
  result = null,
  expected = [],
  expectedGeneration,
  activityWindow = null,
  rendered = null,
} = {}) {
  const normalizedExpected = normalizeExpected(expected);
  const packet = result && result.status === 'ok' && isPlainObject(result.packet) ? result.packet : null;
  if (targetId === null || targetId === undefined) {
    return assessmentReceipt({ targetId: null, status: 'omitted', omissions: [omission('unbound', 'target')], packet, presentCausalKeys: [], expected: normalizedExpected });
  }
  if (typeof targetId !== 'string' || !CANONICAL_ID.test(targetId)) throw new TypeError('targetId must be a canonical project or outcome ID');

  if (!packet) {
    const code = typeof result?.code === 'string' ? result.code : '';
    const reason = /GENERATION_MISMATCH/.test(code) ? 'generation_mismatch' : /BUDGET_TOO_SMALL/.test(code) ? 'byte_limit' : 'provider_unavailable';
    return assessmentReceipt({ targetId, status: 'omitted', omissions: [omission(reason, 'packet')], packet: null, presentCausalKeys: [], expected: normalizedExpected });
  }

  const omissions = [];
  if (expectedGeneration !== undefined && expectedGeneration !== null && packet.canonical.generation !== expectedGeneration) {
    omissions.push(omission('generation_mismatch', 'packet'));
  }
  const causes = truncationCauses(packet);
  const truncationOmissions = (subject) => [
    ...(causes.item ? [omission('item_limit', subject)] : []),
    ...(causes.byte ? [omission('byte_limit', subject)] : []),
  ];

  const scoped = inScope(packet, targetId);
  const recordPresent = packet.canonical.records.some((record) => record.id === targetId);
  if (!recordPresent) {
    if (!scoped) omissions.push(omission('scope', 'record'));
    else {
      const truncated = truncationOmissions('record');
      omissions.push(...(truncated.length ? truncated : [omission('provider_unavailable', 'record')]));
    }
  }

  const activityView = packet.providers?.activity;
  const activityUnavailable = !activityView || ['omitted', 'unknown', 'unavailable'].includes(activityView.state);
  const present = [];
  for (const entry of normalizedExpected) {
    if (activityPresent(packet, entry.causalKey, targetId)) {
      present.push(entry.causalKey);
      continue;
    }
    if (!scoped) omissions.push(omission('scope', entry.causalKey));
    else if (activityUnavailable) omissions.push(omission('provider_unavailable', entry.causalKey));
    else if (!withinWindow(entry.occurredAt, activityWindow)) omissions.push(omission('age_window', entry.causalKey));
    else {
      const truncated = truncationOmissions(entry.causalKey);
      omissions.push(...(truncated.length ? truncated : [omission('age_window', entry.causalKey)]));
    }
  }

  if (rendered && recordPresent) {
    const text = typeof rendered.text === 'string' ? rendered.text : '';
    const markers = Array.isArray(rendered.markers) ? rendered.markers.filter((marker) => typeof marker === 'string' && marker) : [];
    if (!text || markers.some((marker) => !text.includes(marker))) omissions.push(omission('render_truncation', 'record'));
  }

  const targetMissing = !recordPresent || omissions.some((entry) => entry.code === 'generation_mismatch');
  const status = !omissions.length ? 'present' : (targetMissing && present.length === 0 ? 'omitted' : 'partial');
  return assessmentReceipt({ targetId, status, omissions, packet, presentCausalKeys: present, expected: normalizedExpected });
}

module.exports = {
  OMISSION_CODES,
  TARGET_HYDRATION_CONTRACT,
  TARGET_STATUSES,
  assessTargetHydration,
};
