'use strict';

const crypto = require('node:crypto');

const HANDOFF_CONTRACT = 'jarvos.projects-context-handoff/v1';
const HANDOFF_FIELDS = Object.freeze([
  'contract',
  'handoffId',
  'publicContract',
  'publicRevision',
  'packageDigest',
  'providerContract',
  'providerRevision',
  'consumer',
  'capabilityReceiptId',
  'capabilityDigest',
  'profileRevision',
  'generatedAt',
  'status',
  'blockerCode',
]);
const HANDOFF_STATUSES = Object.freeze(['ready', 'blocked']);
const CONSUMERS = Object.freeze([
  'active-assistant',
  'agent-context',
  'mcp',
  'coding-startup',
  'codex',
  'claude',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value, field) {
  if (value === null) return null;
  return requiredString(value, field);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function handoffIdentity(receipt) {
  return {
    publicContract: receipt.publicContract,
    publicRevision: receipt.publicRevision,
    packageDigest: receipt.packageDigest,
    providerContract: receipt.providerContract,
    providerRevision: receipt.providerRevision,
    consumer: receipt.consumer,
    capabilityReceiptId: receipt.capabilityReceiptId,
    capabilityDigest: receipt.capabilityDigest,
    profileRevision: receipt.profileRevision,
    generatedAt: receipt.generatedAt,
    status: receipt.status,
    blockerCode: receipt.blockerCode,
  };
}

function timestamp(value, field) {
  const normalized = requiredString(value, field);
  if (Number.isNaN(Date.parse(normalized))) throw new TypeError(`${field} must be an ISO timestamp`);
  return normalized;
}

function normalizeReceipt(receipt) {
  if (!exactKeys(receipt, HANDOFF_FIELDS)) throw new TypeError('Projects handoff receipt has unsupported fields');
  const status = requiredString(receipt.status, 'status');
  if (!HANDOFF_STATUSES.includes(status)) throw new TypeError('Projects handoff receipt status is unsupported');
  const normalized = {
    contract: requiredString(receipt.contract, 'contract'),
    handoffId: requiredString(receipt.handoffId, 'handoffId'),
    publicContract: requiredString(receipt.publicContract, 'publicContract'),
    publicRevision: requiredString(receipt.publicRevision, 'publicRevision'),
    packageDigest: requiredString(receipt.packageDigest, 'packageDigest'),
    providerContract: requiredString(receipt.providerContract, 'providerContract'),
    providerRevision: requiredString(receipt.providerRevision, 'providerRevision'),
    consumer: requiredString(receipt.consumer, 'consumer'),
    capabilityReceiptId: optionalString(receipt.capabilityReceiptId, 'capabilityReceiptId'),
    capabilityDigest: optionalString(receipt.capabilityDigest, 'capabilityDigest'),
    profileRevision: requiredString(receipt.profileRevision, 'profileRevision'),
    generatedAt: timestamp(receipt.generatedAt, 'generatedAt'),
    status,
    blockerCode: optionalString(receipt.blockerCode, 'blockerCode'),
  };
  if (normalized.contract !== HANDOFF_CONTRACT) throw new TypeError('Projects handoff receipt has an unsupported contract');
  if (!/^handoff_[a-f0-9]{32}$/.test(normalized.handoffId)) throw new TypeError('handoffId is invalid');
  if (!/^jarvos\.projects-context\/v1$/.test(normalized.publicContract)) throw new TypeError('publicContract is invalid');
  if (!/^[a-z0-9._-]{1,64}$/.test(normalized.publicRevision)) throw new TypeError('publicRevision is invalid');
  if (!/^[a-f0-9]{64}$/.test(normalized.packageDigest)) throw new TypeError('packageDigest is invalid');
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/.test(normalized.providerContract)) throw new TypeError('providerContract is invalid');
  if (!/^[a-z0-9._-]{1,64}$/.test(normalized.providerRevision)) throw new TypeError('providerRevision is invalid');
  if (!CONSUMERS.includes(normalized.consumer)) throw new TypeError('consumer is unsupported');
  if (normalized.capabilityReceiptId !== null && !/^cap_[a-f0-9]{32}$/.test(normalized.capabilityReceiptId)) throw new TypeError('capabilityReceiptId is invalid');
  if (normalized.capabilityDigest !== null && !/^[a-f0-9]{64}$/.test(normalized.capabilityDigest)) throw new TypeError('capabilityDigest is invalid');
  if ((normalized.capabilityReceiptId === null) !== (normalized.capabilityDigest === null)) throw new TypeError('capability receipt metadata must be complete');
  if (status === 'ready' && (!normalized.capabilityReceiptId || !normalized.capabilityDigest || normalized.blockerCode !== null)) {
    throw new TypeError('ready handoff receipts require capability metadata and no blocker');
  }
  if (status === 'blocked' && !normalized.blockerCode) throw new TypeError('blocked handoff receipts require blockerCode');
  if (normalized.handoffId !== `handoff_${digest(handoffIdentity(normalized)).slice(0, 32)}`) throw new TypeError('handoffId does not match receipt contents');
  return normalized;
}

function createHandoffReceipt(input = {}) {
  const candidate = {
    contract: HANDOFF_CONTRACT,
    handoffId: '',
    publicContract: input.publicContract,
    publicRevision: input.publicRevision,
    packageDigest: input.packageDigest,
    providerContract: input.providerContract,
    providerRevision: input.providerRevision,
    consumer: input.consumer,
    capabilityReceiptId: input.capabilityReceiptId ?? null,
    capabilityDigest: input.capabilityDigest ?? null,
    profileRevision: input.profileRevision,
    generatedAt: input.generatedAt,
    status: input.status || 'ready',
    blockerCode: input.blockerCode ?? null,
  };
  candidate.handoffId = `handoff_${digest(handoffIdentity(candidate)).slice(0, 32)}`;
  return normalizeReceipt(candidate);
}

function validateHandoffReceipt(receipt) {
  try {
    return { ok: true, receipt: normalizeReceipt(receipt) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function handoffDigest(receipt) {
  return digest(normalizeReceipt(receipt));
}

module.exports = {
  CONSUMERS,
  HANDOFF_CONTRACT,
  HANDOFF_FIELDS,
  HANDOFF_STATUSES,
  createHandoffReceipt,
  handoffDigest,
  validateHandoffReceipt,
};
