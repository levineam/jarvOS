'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
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

const now = Date.parse('2026-08-05T12:00:00.000Z');
const envelope = `sha256:${'a'.repeat(64)}`;

function signer(purpose) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
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
  const loadKey = async ({ purpose, descriptor }) => {
    loaded.push({ purpose, descriptor });
    return purpose === 'activation' ? activation.privateKeyPem : projects.privateKeyPem;
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
      issuedAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2026-08-06T12:00:00.000Z',
    },
    now,
    clock: () => now,
    loadKey,
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
      issuedAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2026-08-05T13:00:00.000Z',
    },
    now,
    clock: () => now,
    loadKey,
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
  let loaded = false;
  await assert.rejects(
    issueApprovedRequest({
      request: { type: 'jarvos.release-publication/v1' },
      loadKey: async () => { loaded = true; },
    }),
    /unsupported jarvOS approval request/,
  );
  assert.equal(loaded, false);
});

test('expired bounded requests are rejected before the vault is unlocked', async () => {
  let loaded = false;
  const loadKey = async () => { loaded = true; };
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
        issuedAt: '2026-08-04T10:00:00.000Z',
        expiresAt: '2026-08-05T11:00:00.000Z',
      },
      now,
      loadKey,
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
        issuedAt: '2026-08-04T10:00:00.000Z',
        expiresAt: '2026-08-05T11:00:00.000Z',
      },
      now,
      loadKey,
    }),
    /not a current bounded receipt/,
  );
  assert.equal(loaded, false);
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
      issuedAt: '2026-08-05T12:00:00.000Z',
      expiresAt: '2026-08-05T13:00:00.000Z',
    },
    now,
    clock: () => now,
    loadKey: async () => projects.privateKeyPem,
    readDescriptor: async () => projects.descriptor,
  });
  const afterExpiry = Date.parse('2026-08-05T13:00:00.000Z');
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
    'readVaultDescriptor',
    'securityVaultPaths',
  ]) {
    assert.equal(Object.hasOwn(publicApi, name), false, `${name} must remain internal`);
  }
});
