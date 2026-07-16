'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  CONTRACT_VERSION,
  buildActionKey,
  createCommand,
  createManagerManifest,
  createRequest,
  toPublicProjection,
  validateRecord,
} = require('../src/index.js');

function sampleResource(id = 'repo-1') {
  return { machineId: 'machine-a', type: 'git-repository', id };
}

function sampleRequest(overrides = {}) {
  return createRequest({
    principal: { id: 'principal:codex', issuedBy: 'fixture-auth' },
    actor: { kind: 'agent', harness: 'codex', sessionId: 'session-1' },
    resource: sampleResource(),
    mutationClass: 'workspace.cleanup',
    desiredGeneration: 'gen-1',
    commandSpec: {
      operation: 'classify-worktree',
      arguments: { mode: 'dry-run' },
      constraints: { destructive: false },
      lifecycle: { idempotent: true },
    },
    ...overrides,
  });
}

test('request contract separates authorization envelope from action-key dedupe inputs', () => {
  const requestA = sampleRequest({ id: 'request-a', principal: { id: 'principal:a' } });
  const requestB = sampleRequest({ id: 'request-b', principal: { id: 'principal:b' } });

  const commandA = createCommand({
    requestId: requestA.id,
    managerId: 'workspace-manager',
    resource: requestA.resource,
    mutationClass: requestA.mutationClass,
    desiredGeneration: requestA.desiredGeneration,
    commandSpec: requestA.commandSpec,
  });
  const commandB = createCommand({
    requestId: requestB.id,
    managerId: 'workspace-manager',
    resource: requestB.resource,
    mutationClass: requestB.mutationClass,
    desiredGeneration: requestB.desiredGeneration,
    commandSpec: requestB.commandSpec,
  });

  assert.equal(commandA.actionKey, commandB.actionKey);
  assert.equal(buildActionKey(commandA), commandA.actionKey);
  assert.notEqual(requestA.id, requestB.id);
});

test('canonical command-spec digest changes when executable arguments change', () => {
  const request = sampleRequest();
  const base = createCommand({
    requestId: request.id,
    managerId: 'workspace-manager',
    resource: request.resource,
    mutationClass: request.mutationClass,
    desiredGeneration: request.desiredGeneration,
    commandSpec: request.commandSpec,
  });
  const changed = createCommand({
    requestId: request.id,
    managerId: 'workspace-manager',
    resource: request.resource,
    mutationClass: request.mutationClass,
    desiredGeneration: request.desiredGeneration,
    commandSpec: {
      ...request.commandSpec,
      arguments: { mode: 'apply' },
    },
  });

  assert.notEqual(base.specDigest, changed.specDigest);
  assert.notEqual(base.actionKey, changed.actionKey);
});

test('unknown contract major fails closed before executable manager registration', () => {
  assert.throws(() => createManagerManifest({
    contractVersion: '2.0.0',
    managerId: 'future-manager',
    trust: { level: 'trusted' },
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
  }), /compatible/);
});

test('trusted compatible manifest accepts fence and verifier declarations', () => {
  const manifest = createManagerManifest({
    contractVersion: CONTRACT_VERSION,
    managerId: 'workspace-manager',
    trust: { level: 'trusted' },
    capabilities: ['observe', 'execute', 'verify'],
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
    operationContract: {
      finalSideEffectFence: { required: true, mode: 'compare-and-set' },
      verifier: {
        port: 'verifyWorkspaceCleanup',
        authoritativeReadPath: 'git worktree list',
        nilBehavior: 'unsatisfied',
        errorBehavior: 'unverifiable',
      },
    },
  });

  assert.equal(manifest.operationContract.finalSideEffectFence.required, true);
  assert.equal(manifest.operationContract.verifier.errorBehavior, 'unverifiable');
});

test('sensitive adapter data is omitted from unauthorized projections', () => {
  const request = sampleRequest({
    sensitivity: { level: 'private' },
    adapterExtensions: {
      paperclipIssueId: 'private-id',
      absolutePath: '/private/machine/path',
    },
  });

  const redacted = toPublicProjection(request, { maxSensitivity: 'internal' });
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.adapterExtensions, undefined);

  const internal = toPublicProjection(request, { maxSensitivity: 'private' });
  assert.equal(internal.redacted, undefined);
  assert.equal(internal.adapterExtensions, undefined);
});

test('record validation rejects malformed lifecycle records', () => {
  const request = sampleRequest();
  const invalid = {
    ...request,
    type: 'request',
    actor: { kind: 'unknown' },
  };

  assert.throws(() => validateRecord(invalid), /actor.kind/);
});
