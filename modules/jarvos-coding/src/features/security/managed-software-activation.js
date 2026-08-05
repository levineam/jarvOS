'use strict';

const crypto = require('node:crypto');

const ACTIVATION_TYPE = 'jarvos.managed-software-activation/v1';
const ACTIVATION_PURPOSE = 'managed-software-shadow';
const ACTIVATION_AUDIENCE = 'jarvos-managed-software-host';
const APPROVAL_STAMP_SCHEMA = 'jarvos.owner-approval-stamp/v1';
const ACTIVATION_FIELDS = Object.freeze([
  'activationEnvelopeDigest', 'audience', 'expiresAt', 'issuedAt', 'issuerId', 'mode',
  'opportunityKeys', 'owner', 'purpose', 'receiptId', 'type',
]);
const RECEIPT_FIELDS = Object.freeze([...ACTIVATION_FIELDS, 'signature']);

function text(value) {
  return typeof value === 'string' && value.trim() && !/[\0\r\n]/.test(value)
    ? value.trim()
    : null;
}

function digest(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ''))
    ? String(value).toLowerCase()
    : null;
}

function safeIdentifier(value) {
  const normalized = text(value);
  return normalized && /^[A-Za-z0-9._:-]{1,200}$/.test(normalized) ? normalized : null;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('unsupported canonical value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function activationReceiptPayload(receipt = {}) {
  const payload = {};
  for (const field of ACTIVATION_FIELDS) payload[field] = receipt[field];
  return Buffer.from(canonicalJson(payload));
}

function approvalStampVerifierId(publicKeyPem) {
  try {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return `approval-stamp:ed25519:${crypto.createHash('sha256').update(der).digest('hex')}`;
  } catch (_) {
    return null;
  }
}

function exactKeys(value, fields) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field)));
}

function validActivationReceiptShape(receipt) {
  const issuedAt = Date.parse(receipt?.issuedAt || '');
  const expiresAt = Date.parse(receipt?.expiresAt || '');
  return exactKeys(receipt, RECEIPT_FIELDS)
    && safeIdentifier(receipt.receiptId)
    && safeIdentifier(receipt.issuerId)
    && safeIdentifier(receipt.owner)
    && digest(receipt.activationEnvelopeDigest)
    && Array.isArray(receipt.opportunityKeys)
    && receipt.opportunityKeys.length >= 1
    && receipt.opportunityKeys.length <= 14
    && receipt.opportunityKeys.every(safeIdentifier)
    && new Set(receipt.opportunityKeys).size === receipt.opportunityKeys.length
    && typeof receipt.signature === 'string'
    && /^[A-Za-z0-9_-]{80,}$/.test(receipt.signature)
    && Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt);
}

function validActivationReceipt(receipt, now) {
  const issuedAt = Date.parse(receipt?.issuedAt || '');
  const expiresAt = Date.parse(receipt?.expiresAt || '');
  return validActivationReceiptShape(receipt)
    && receipt.type === ACTIVATION_TYPE
    && receipt.purpose === ACTIVATION_PURPOSE
    && receipt.audience === ACTIVATION_AUDIENCE
    && receipt.mode === 'shadow'
    && issuedAt <= now
    && now < expiresAt;
}

function validDescriptor(descriptor = {}) {
  if (!exactKeys(descriptor, ['audience', 'pinnedVerifierId', 'publicKeyPem', 'purpose', 'schema', 'type'])) return false;
  if (descriptor.schema !== APPROVAL_STAMP_SCHEMA
    || descriptor.type !== ACTIVATION_TYPE
    || descriptor.purpose !== ACTIVATION_PURPOSE
    || descriptor.audience !== ACTIVATION_AUDIENCE
    || !safeIdentifier(descriptor.pinnedVerifierId)
    || typeof descriptor.publicKeyPem !== 'string'
    || !descriptor.publicKeyPem.trim()
    || descriptor.publicKeyPem.includes('\0')) return false;
  if (descriptor.pinnedVerifierId !== approvalStampVerifierId(descriptor.publicKeyPem)) return false;
  try {
    return crypto.createPublicKey(descriptor.publicKeyPem).asymmetricKeyType === 'ed25519';
  } catch (_) {
    return false;
  }
}

function createActivationVerifier(descriptor = {}, { now = Date.now } = {}) {
  if (!validDescriptor(descriptor)) throw new Error('invalid activation approval descriptor');
  const publicKey = crypto.createPublicKey(descriptor.publicKeyPem);
  return Object.freeze({
    pinnedVerifierId: descriptor.pinnedVerifierId,
    verify(receipt) {
      if (!validActivationReceipt(receipt, now()) || receipt.issuerId !== descriptor.pinnedVerifierId) return false;
      try {
        return crypto.verify(null, activationReceiptPayload(receipt), publicKey, Buffer.from(receipt.signature, 'base64url'));
      } catch (_) {
        return false;
      }
    },
  });
}

module.exports = {
  ACTIVATION_AUDIENCE,
  ACTIVATION_FIELDS,
  ACTIVATION_PURPOSE,
  ACTIVATION_TYPE,
  APPROVAL_STAMP_SCHEMA,
  activationReceiptPayload,
  approvalStampVerifierId,
  canonicalJson,
  createActivationVerifier,
  exactKeys,
  validActivationReceipt,
};
