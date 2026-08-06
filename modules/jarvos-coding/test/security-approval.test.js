'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  ACTIVATION_AUDIENCE,
  ACTIVATION_PURPOSE,
  ACTIVATION_TYPE,
  approvalStampVerifierId,
  createActivationVerifier,
  createProjectsCapabilityVerifier,
  projectsVerifierId,
} = require('../src');
const { issueApprovedRequest } = require('../src/features/security/approval');

const now = Date.now();
const envelope = `sha256:${'a'.repeat(64)}`;

function timestamp(offsetMs) {
  return new Date(now + offsetMs).toISOString();
}

function signer(purpose) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const pinnedVerifierId = purpose === 'activation'
    ? approvalStampVerifierId(publicKeyPem)
    : projectsVerifierId(publicKeyPem);
  const descriptor = purpose === 'activation'
    ? {
      schema: 'jarvos.owner-approval-stamp/v1',
      type: ACTIVATION_TYPE,
      purpose: ACTIVATION_PURPOSE,
      audience: ACTIVATION_AUDIENCE,
      pinnedVerifierId,
      publicKeyPem,
    }
    : {
      schema: 'jarvos.projects-capability-issuer/v1',
      type: 'jarvos.project-context/v1',
      purpose: 'managed-software-stewardship',
      audience: 'jarvos-projects',
      pinnedVerifierId,
      publicKeyPem,
    };
  return { descriptor, privateKeyPem };
}

test('one vault API signs both protocols with distinct purpose-specific keys', async () => {
  const activation = signer('activation');
  const projects = signer('projects');
  const loaded = [];
  const signReceipt = async ({ purpose, descriptor, payload }) => {
    loaded.push({ purpose, descriptor });
    const privateKeyPem = purpose === 'activation' ? activation.privateKeyPem : projects.privateKeyPem;
    return crypto.sign(null, payload, crypto.createPrivateKey(privateKeyPem)).toString('base64url');
  };
  const readDescriptor = async (purpose) => (
    purpose === 'activation' ? activation.descriptor : projects.descriptor
  );

  const activationReceipt = await issueApprovedRequest({
    request: {
      type: ACTIVATION_TYPE,
      purpose: ACTIVATION_PURPOSE,
      audience: ACTIVATION_AUDIENCE,
      receiptId: 'activation:shadow:one',
      issuerId: activation.descriptor.pinnedVerifierId,
      owner: 'owner',
      mode: 'shadow',
      activationEnvelopeDigest: envelope,
      opportunityKeys: ['window:one'],
      issuedAt: timestamp(-60_000),
      expiresAt: timestamp(60 * 60 * 1000),
    },
    now,
    clock: () => now,
    signReceipt,
    readDescriptor,
  });
  assert.equal(createActivationVerifier(activation.descriptor, { now: () => now }).verify(activationReceipt), true);

  const projectsReceipt = await issueApprovedRequest({
    request: {
      type: 'jarvos.project-context/v1',
      purpose: 'managed-software-stewardship',
      audience: 'jarvos-projects',
      destinationSelectors: ['projects:stewardship'],
      allowedVisibilities: ['private', 'mixed'],
      capabilityRevision: 'projects:one',
      activationEnvelopeDigest: envelope,
      issuedAt: timestamp(-60_000),
      expiresAt: timestamp(60 * 60 * 1000),
    },
    now,
    clock: () => now,
    signReceipt,
    readDescriptor,
  });
  assert.equal(createProjectsCapabilityVerifier(projects.descriptor, { now: () => now }).verify(projectsReceipt), true);
  assert.deepEqual(loaded, [
    { purpose: 'activation', descriptor: activation.descriptor },
    { purpose: 'projects', descriptor: projects.descriptor },
  ]);
  assert.notEqual(activation.descriptor.pinnedVerifierId, projects.descriptor.pinnedVerifierId);
});

test('unsupported protocols are rejected before the vault is unlocked', async () => {
  let signed = false;
  await assert.rejects(
    issueApprovedRequest({
      request: { type: 'jarvos.release-publication/v1' },
      signReceipt: async () => { signed = true; },
    }),
    /unsupported jarvOS approval request/,
  );
  assert.equal(signed, false);
});

test('expired bounded requests are rejected before the vault is unlocked', async () => {
  let signed = false;
  const signReceipt = async () => { signed = true; };
  await assert.rejects(
    issueApprovedRequest({
      request: {
        type: ACTIVATION_TYPE,
        purpose: ACTIVATION_PURPOSE,
        audience: ACTIVATION_AUDIENCE,
        receiptId: 'activation:expired',
        issuerId: `approval-stamp:ed25519:${'b'.repeat(64)}`,
        owner: 'owner',
        mode: 'shadow',
        activationEnvelopeDigest: envelope,
        opportunityKeys: ['window:expired'],
        issuedAt: timestamp(-2 * 60 * 60 * 1000),
        expiresAt: timestamp(-60_000),
      },
      now,
      signReceipt,
    }),
    /not a current bounded shadow approval/,
  );
  await assert.rejects(
    issueApprovedRequest({
      request: {
        type: 'jarvos.project-context/v1',
        purpose: 'managed-software-stewardship',
        audience: 'jarvos-projects',
        destinationSelectors: ['projects:expired'],
        allowedVisibilities: ['private'],
        capabilityRevision: 'projects:expired',
        activationEnvelopeDigest: envelope,
        issuedAt: timestamp(-2 * 60 * 60 * 1000),
        expiresAt: timestamp(-60_000),
      },
      now,
      signReceipt,
    }),
    /not a current bounded receipt/,
  );
  assert.equal(signed, false);
});

test('Projects verifier rejects a correctly signed receipt after it expires', async () => {
  const projects = signer('projects');
  const receipt = await issueApprovedRequest({
    request: {
      type: 'jarvos.project-context/v1',
      purpose: 'managed-software-stewardship',
      audience: 'jarvos-projects',
      destinationSelectors: ['projects:one'],
      allowedVisibilities: ['private'],
      capabilityRevision: 'projects:expiry-test',
      activationEnvelopeDigest: envelope,
      issuedAt: timestamp(-60_000),
      expiresAt: timestamp(60 * 60 * 1000),
    },
    now,
    clock: () => now,
    signReceipt: async ({ payload }) => (
      crypto.sign(null, payload, crypto.createPrivateKey(projects.privateKeyPem)).toString('base64url')
    ),
    readDescriptor: async () => projects.descriptor,
  });
  const afterExpiry = now + 60 * 60 * 1000;
  assert.equal(
    createProjectsCapabilityVerifier(projects.descriptor, { now: () => afterExpiry }).verify(receipt),
    false,
  );
});

test('privileged vault and signing operations are not part of the public agent API', () => {
  const publicApi = require('../src');
  for (const name of [
    'defaultSecurityRoot',
    'initializeSecurityVault',
    'issueApprovedRequest',
    'loadSigningKey',
    'withSigningKey',
    'readVaultDescriptor',
    'securityVaultPaths',
  ]) {
    assert.equal(Object.hasOwn(publicApi, name), false, `${name} must remain internal`);
  }
  for (const subpath of [
    '@jarvos/coding/features/security/approval',
    '@jarvos/coding/src/features/security/vault',
  ]) {
    assert.throws(() => require(subpath), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
