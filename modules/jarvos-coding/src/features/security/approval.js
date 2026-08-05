'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const {
  ACTIVATION_FIELDS,
  ACTIVATION_TYPE,
  activationReceiptPayload,
  createActivationVerifier,
  validActivationReceipt,
} = require('./managed-software-activation');
const {
  PROJECT_CONTEXT_TYPE,
  createProjectsCapabilityVerifier,
  receiptPayload,
  validReceiptShape,
} = require('./projects-capability');
const { defaultRoot, loadSigningKey, vaultPaths } = require('./vault');

async function readVaultDescriptor(purpose, root = defaultRoot()) {
  const files = vaultPaths(root);
  const descriptor = purpose === 'activation' ? files.activationDescriptor : files.projectsDescriptor;
  return JSON.parse(await fs.readFile(descriptor, 'utf8'));
}

function activationRequest(request, now) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== ACTIVATION_FIELDS.length
    || !ACTIVATION_FIELDS.every((field) => Object.hasOwn(request, field))) {
    throw new Error('activation request must contain exactly the approved fields');
  }
  if (!validActivationReceipt({ ...request, signature: 'a'.repeat(86) }, now)) {
    throw new Error('activation request is not a current bounded shadow approval');
  }
  return Object.freeze({ ...request, opportunityKeys: Object.freeze([...request.opportunityKeys]) });
}

function projectsRequest(request, now) {
  const candidate = { ...request, signature: 'a'.repeat(86) };
  if (!validReceiptShape(candidate)
    || Date.parse(candidate.issuedAt) > now
    || Date.parse(candidate.expiresAt) <= now) {
    throw new Error('Projects capability request is not a current bounded receipt');
  }
  return Object.freeze({
    ...request,
    allowedVisibilities: Object.freeze([...request.allowedVisibilities]),
    destinationSelectors: Object.freeze([...request.destinationSelectors]),
  });
}

async function issueApprovedRequest({
  root = defaultRoot(),
  request,
  now = Date.now(),
  clock = Date.now,
  recovery = false,
  loadKey = loadSigningKey,
  readDescriptor = readVaultDescriptor,
} = {}) {
  let purpose;
  let approved;
  if (request?.type === ACTIVATION_TYPE) {
    purpose = 'activation';
    approved = activationRequest(request, now);
  } else if (request?.type === PROJECT_CONTEXT_TYPE) {
    purpose = 'projects';
    approved = projectsRequest(request, now);
  } else {
    throw new Error('unsupported jarvOS approval request');
  }

  const descriptor = await readDescriptor(purpose, root);
  const privateKeyPem = await loadKey({ root, purpose, recovery, descriptor });
  const signingNow = clock();
  try {
    if (purpose === 'activation') activationRequest(approved, signingNow);
    else projectsRequest(approved, signingNow);
  } catch (_) {
    throw new Error('approval request expired during unlock');
  }
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const payload = purpose === 'activation'
    ? activationReceiptPayload(approved)
    : receiptPayload(approved);
  const receipt = Object.freeze({
    ...approved,
    signature: crypto.sign(null, payload, privateKey).toString('base64url'),
  });

  if (purpose === 'activation') {
    const verifier = createActivationVerifier(descriptor, { now: () => signingNow });
    if (receipt.issuerId !== verifier.pinnedVerifierId || verifier.verify(receipt) !== true) {
      throw new Error('new activation receipt did not match its pinned verifier');
    }
  } else if (createProjectsCapabilityVerifier(descriptor, { now: () => signingNow }).verify(receipt) !== true) {
    throw new Error('new Projects receipt did not match its pinned verifier');
  }
  return receipt;
}

module.exports = {
  activationRequest,
  issueApprovedRequest,
  projectsRequest,
  readVaultDescriptor,
};
