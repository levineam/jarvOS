'use strict';

const crypto = require('node:crypto');
const { canonicalJson, exactKeys } = require('./managed-software-activation');

const PROJECTS_ISSUER_SCHEMA = 'jarvos.projects-capability-issuer/v1';
const PROJECT_CONTEXT_TYPE = 'jarvos.project-context/v1';
const PROJECT_CONTEXT_PURPOSE = 'managed-software-stewardship';
const PROJECT_CONTEXT_AUDIENCE = 'jarvos-projects';
const PROJECT_RECEIPT_FIELDS = Object.freeze([
  'activationEnvelopeDigest', 'allowedVisibilities', 'audience', 'capabilityRevision',
  'destinationSelectors', 'expiresAt', 'issuedAt', 'purpose', 'type',
]);

function identifier(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:-]{1,200}$/.test(value)
    && !/[\0\r\n]/.test(value)
    ? value
    : null;
}

function digest(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value || ''));
}

function projectsVerifierId(publicKeyPem) {
  try {
    const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return `projects-capability:ed25519:${crypto.createHash('sha256').update(der).digest('hex')}`;
  } catch (_) {
    return null;
  }
}

function receiptPayload(receipt = {}) {
  const payload = {};
  for (const field of PROJECT_RECEIPT_FIELDS) payload[field] = receipt[field];
  return Buffer.from(canonicalJson(payload));
}

function validReceiptShape(receipt) {
  const issued = Date.parse(receipt?.issuedAt || '');
  const expires = Date.parse(receipt?.expiresAt || '');
  return exactKeys(receipt, [...PROJECT_RECEIPT_FIELDS, 'signature'])
    && receipt.type === PROJECT_CONTEXT_TYPE
    && receipt.purpose === PROJECT_CONTEXT_PURPOSE
    && receipt.audience === PROJECT_CONTEXT_AUDIENCE
    && digest(receipt.activationEnvelopeDigest)
    && identifier(receipt.capabilityRevision)
    && Array.isArray(receipt.destinationSelectors)
    && receipt.destinationSelectors.length > 0
    && receipt.destinationSelectors.every(identifier)
    && Array.isArray(receipt.allowedVisibilities)
    && receipt.allowedVisibilities.length > 0
    && receipt.allowedVisibilities.every((value) => value === 'private' || value === 'mixed')
    && typeof receipt.signature === 'string'
    && /^[A-Za-z0-9_-]{80,}$/.test(receipt.signature)
    && Number.isFinite(issued)
    && Number.isFinite(expires)
    && issued < expires;
}

function validDescriptor(descriptor = {}) {
  if (!exactKeys(descriptor, ['audience', 'pinnedVerifierId', 'publicKeyPem', 'purpose', 'schema', 'type'])) return false;
  if (descriptor.schema !== PROJECTS_ISSUER_SCHEMA
    || descriptor.type !== PROJECT_CONTEXT_TYPE
    || descriptor.purpose !== PROJECT_CONTEXT_PURPOSE
    || descriptor.audience !== PROJECT_CONTEXT_AUDIENCE
    || !identifier(descriptor.pinnedVerifierId)
    || typeof descriptor.publicKeyPem !== 'string'
    || !descriptor.publicKeyPem.trim()
    || descriptor.publicKeyPem.includes('\0')) return false;
  if (descriptor.pinnedVerifierId !== projectsVerifierId(descriptor.publicKeyPem)) return false;
  try {
    return crypto.createPublicKey(descriptor.publicKeyPem).asymmetricKeyType === 'ed25519';
  } catch (_) {
    return false;
  }
}

function createProjectsCapabilityVerifier(descriptor = {}, { now = Date.now } = {}) {
  if (!validDescriptor(descriptor)) throw new Error('invalid Projects capability verifier descriptor');
  const publicKey = crypto.createPublicKey(descriptor.publicKeyPem);
  return Object.freeze({
    pinnedVerifierId: descriptor.pinnedVerifierId,
    verify(receipt) {
      if (!validReceiptShape(receipt)) return false;
      const current = now();
      if (Date.parse(receipt.issuedAt) > current || Date.parse(receipt.expiresAt) <= current) return false;
      try {
        return crypto.verify(null, receiptPayload(receipt), publicKey, Buffer.from(receipt.signature, 'base64url'));
      } catch (_) {
        return false;
      }
    },
  });
}

module.exports = {
  PROJECTS_ISSUER_SCHEMA,
  PROJECT_CONTEXT_AUDIENCE,
  PROJECT_CONTEXT_PURPOSE,
  PROJECT_CONTEXT_TYPE,
  PROJECT_RECEIPT_FIELDS,
  createProjectsCapabilityVerifier,
  projectsVerifierId,
  receiptPayload,
  validReceiptShape,
};
