'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  CONTRACT_VERSION,
  buildActionKey,
  canonicalResourceKey,
  commandSpecDigest,
  createManagedSoftwareCatalog,
  createCommand,
  createManagerManifest,
  createRequest,
  toPublicProjection,
  validateManagedSoftwareEntry,
  validateRecord,
} = require('../src/index.js');
const { createPolicyEngine } = require('../src/index.js');

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

test('only explicitly supported, well-formed contract versions are executable', () => {
  for (const version of ['1.999.0', '1.anything', '1.0', 'v1.0.0']) {
    assert.throws(() => createManagerManifest({
      contractVersion: version, managerId: 'bad-version', trust: { level: 'trusted' },
      mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
    }), /compatible/);
  }
});

test('canonical resource and command digests reject ambiguous values', () => {
  assert.notEqual(
    canonicalResourceKey({ machineId: 'a:b', type: 'c', id: 'd' }),
    canonicalResourceKey({ machineId: 'a', type: 'b:c', id: 'd' }),
  );
  assert.throws(() => commandSpecDigest({ operation: 'test', arguments: { value: NaN } }), /Non-finite/);
  assert.throws(() => commandSpecDigest({ operation: 'test', arguments: { value: undefined } }), /Unsupported/);
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

test('trusted manifests must declare target-side fencing', () => {
  assert.throws(() => createManagerManifest({
    managerId: 'unsafe-manager', trust: { level: 'trusted' },
    mutationClasses: [{ resourceType: 'git-repository', class: 'workspace.cleanup' }],
  }), /target-side finalSideEffectFence/);
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

test('nested sensitive paths are validated then structurally redacted', () => {
  const request = sampleRequest({
    sensitivity: { level: 'internal', fields: [{ path: 'commandSpec.arguments.token', level: 'secret' }] },
    commandSpec: {
      operation: 'classify-worktree',
      arguments: { mode: 'dry-run', token: 'not-for-projection' },
      constraints: { destructive: false },
      lifecycle: { idempotent: true },
    },
  });
  const projected = toPublicProjection(request, { maxSensitivity: 'internal' });
  assert.equal(projected.commandSpec.arguments.token, undefined);
  assert.equal(projected.commandSpec.arguments.mode, 'dry-run');
  assert.throws(() => sampleRequest({
    sensitivity: { level: 'internal', fields: [{ path: 'commandSpec.arguments.missing', level: 'secret' }] },
  }), /sensitive field path does not exist/);
  assert.throws(() => sampleRequest({
    sensitivity: { level: 'internal', fields: [{ path: 'commandSpec..arguments', level: 'secret' }] },
  }), /sensitive field path/);
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

test('policy defaults cannot allow unmatched mutations', () => {
  assert.throws(() => createPolicyEngine({ defaultOutcome: 'allow' }), /allow requires an explicit rule/);
});

test('managed-software entries retain relationship dimensions without local paths', () => {
  const entry = validateManagedSoftwareEntry({
    id: 'jarvos',
    label: 'jarvOS',
    ownership: 'jarvos-owned',
    distribution: 'core',
    canonicalUpstream: { repository: 'https://github.com/levineam/jarvOS' },
    integrationBranch: 'main',
    executionAdapter: 'beads',
    tracker: { kind: 'github', repository: 'levineam/jarvOS' },
    defaultVisibility: 'public',
    localChangePolicy: 'default-public',
    updatePolicy: 'managed-release',
    releaseAuthority: 'andrew-approval',
    integrationImpactPolicy: 'direct',
    checkoutSelectors: ['jarvos-public'],
    ignoredPathPolicy: 'git-default',
    versioningPolicy: 'semantic', releaseAdapter: 'jarvos-release-plan', publicationAdapter: 'github-release',
    strategyEvidence: { adapter: 'jarvos-strategy', authority: 'draft-unratified' }, credentialRef: 'credential:jarvos-publication',
    notificationPreferenceRef: 'preference:andrew', approvalPrincipalRefs: ['principal:andrew-telegram'],
    capabilities: { installedVersion: true, developmentCheckout: true, productionRuntime: false },
  });

  assert.equal(entry.id, 'jarvos');
  assert.deepEqual(entry.checkoutSelectors, ['jarvos-public']);
  assert.equal(entry.capabilities.developmentCheckout, true);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, checkoutSelectors: ['/Users/andrew/jarvOS'] }), /opaque/i);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, localPath: '/Users/andrew/jarvOS' }), /unknown/i);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, ownership: 'third-party', localChangePolicy: 'default-public' }), /third-party/i);
});

test('managed-software entries require an integration branch and execution adapter', () => {
  const entry = {
    id: 'jarvos',
    label: 'jarvOS',
    ownership: 'jarvos-owned',
    distribution: 'core',
    canonicalUpstream: { repository: 'https://github.com/levineam/jarvOS' },
    tracker: { kind: 'github', repository: 'levineam/jarvOS' },
    defaultVisibility: 'public',
    localChangePolicy: 'default-public',
    updatePolicy: 'managed-release',
    releaseAuthority: 'andrew-approval',
    integrationImpactPolicy: 'direct',
    checkoutSelectors: ['jarvos-public'],
    ignoredPathPolicy: 'git-default',
    versioningPolicy: 'semantic', releaseAdapter: 'jarvos-release-plan', publicationAdapter: 'github-release',
    strategyEvidence: { adapter: 'jarvos-strategy', authority: 'draft-unratified' }, credentialRef: 'credential:jarvos-publication',
    notificationPreferenceRef: 'preference:andrew', approvalPrincipalRefs: ['principal:andrew-telegram'],
    capabilities: { installedVersion: true, developmentCheckout: true, productionRuntime: false },
  };

  assert.throws(() => validateManagedSoftwareEntry(entry), /integrationBranch/);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, integrationBranch: 'main' }), /executionAdapter/);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, integrationBranch: '../main', executionAdapter: 'beads' }), /integrationBranch/);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, integrationBranch: 'main', executionAdapter: 'shell' }), /executionAdapter/);
  assert.deepEqual(validateManagedSoftwareEntry({ ...entry, integrationBranch: 'main', executionAdapter: 'beads' }).executionAdapter, 'beads');
});

test('managed-software catalog validates revisions and creates privacy-safe reports', () => {
  const catalog = createManagedSoftwareCatalog({
    revision: 'managed-software.v1',
    entries: [{
      id: 'qmd',
      label: 'QMD',
      ownership: 'third-party',
      distribution: 'managed-integration',
      canonicalUpstream: { repository: 'https://github.com/tobi/qmd' },
      integrationBranch: 'main',
      executionAdapter: 'beads',
      tracker: { kind: 'github', repository: 'tobi/qmd' },
      defaultVisibility: 'internal',
      localChangePolicy: 'contribute-upstream',
      updatePolicy: 'watch-only',
      releaseAuthority: 'upstream',
      integrationImpactPolicy: 'linked-compatibility',
      checkoutSelectors: ['qmd-local'],
      ignoredPathPolicy: 'git-default',
      versioningPolicy: 'upstream', releaseAdapter: 'external-integration', publicationAdapter: 'none',
      strategyEvidence: { adapter: 'upstream-release-notes', authority: 'ratified' }, credentialRef: 'credential:qmd-maintenance',
      notificationPreferenceRef: 'preference:andrew', approvalPrincipalRefs: ['principal:andrew-telegram'],
      capabilities: { installedVersion: true, developmentCheckout: false, productionRuntime: false },
    }],
  });

  assert.equal(catalog.revision, 'managed-software.v1');
  assert.equal(catalog.entries.length, 1);
  assert.deepEqual(catalog.publicReport.entries[0].checkoutSelectors, undefined);
  assert.throws(() => createManagedSoftwareCatalog({ revision: 'managed-software.v2', entries: [catalog.entries[0], catalog.entries[0]] }), /duplicate/i);
});

test('managed-software catalog separates runtime capability, strategy evidence, and host-private bindings', () => {
  const entry = validateManagedSoftwareEntry({
    id: 'jarvos', label: 'jarvOS', ownership: 'jarvos-owned', distribution: 'core',
    canonicalUpstream: { repository: 'https://github.com/levineam/jarvOS' }, integrationBranch: 'main',
    executionAdapter: 'beads', tracker: { kind: 'github', repository: 'levineam/jarvOS' },
    defaultVisibility: 'public', localChangePolicy: 'default-public', updatePolicy: 'managed-release',
    releaseAuthority: 'andrew-approval', integrationImpactPolicy: 'direct', checkoutSelectors: ['jarvos-public'],
    ignoredPathPolicy: 'git-default', versioningPolicy: 'semantic', releaseAdapter: 'jarvos-release-plan',
    publicationAdapter: 'github-release', strategyEvidence: { adapter: 'jarvos-strategy', authority: 'draft-unratified' },
    credentialRef: 'credential:jarvos-publication', notificationPreferenceRef: 'preference:andrew',
    approvalPrincipalRefs: ['principal:andrew-telegram'],
    runtime: {
      serviceId: 'service:jarvos', stagingRootSelector: 'staging:jarvos', recoveryAuthorityRef: 'ref:jarvos-main', activationPointerSelector: 'activation:jarvos',
      verifierPolicyRef: 'policy:jarvos-runtime-provenance', developmentIdentityRef: 'identity:jarvos-development', developmentStateSelector: 'state:jarvos-development',
      developmentCredentialScopeRef: 'credential-scope:jarvos-development', developmentDestinationScopeRef: 'destination-scope:jarvos-development', mode: 'production',
    },
    capabilities: { installedVersion: true, developmentCheckout: true, productionRuntime: true },
  });

  const catalog = createManagedSoftwareCatalog({ revision: 'managed-software.v1', entries: [entry] });
  const report = JSON.stringify(catalog.publicReport);
  assert.equal(entry.strategyEvidence.authority, 'draft-unratified');
  assert.equal(entry.capabilities.productionRuntime, true);
  assert.doesNotMatch(report, /credential:|principal:|preference:|staging:|activation:|policy:|identity:|state:|destination-scope:/);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, capabilities: { installedVersion: true, developmentCheckout: true } }), /productionRuntime/);
  assert.throws(() => validateManagedSoftwareEntry({ ...entry, runtime: { ...entry.runtime, stagingRootSelector: 'jarvos-public' } }), /distinct/i);
});

test('sensitive catalog revisions require authenticated Andrew authority and invalidate pending approvals', () => {
  const entry = validateManagedSoftwareEntry({
    id: 'jarvos', label: 'jarvOS', ownership: 'jarvos-owned', distribution: 'core',
    canonicalUpstream: { repository: 'https://github.com/levineam/jarvOS' }, integrationBranch: 'main', executionAdapter: 'beads',
    tracker: { kind: 'github', repository: 'levineam/jarvOS' }, defaultVisibility: 'public', localChangePolicy: 'default-public',
    updatePolicy: 'managed-release', releaseAuthority: 'andrew-approval', integrationImpactPolicy: 'direct', checkoutSelectors: ['jarvos-public'],
    ignoredPathPolicy: 'git-default', versioningPolicy: 'semantic', releaseAdapter: 'jarvos-release-plan', publicationAdapter: 'github-release',
    strategyEvidence: { adapter: 'jarvos-strategy', authority: 'draft-unratified' }, credentialRef: 'credential:jarvos-publication',
    notificationPreferenceRef: 'preference:andrew', approvalPrincipalRefs: ['principal:andrew-telegram'],
    capabilities: { installedVersion: true, developmentCheckout: true, productionRuntime: false },
  });
  const catalog = createManagedSoftwareCatalog({ revision: 'managed-software.v1', entries: [entry] });

  assert.throws(() => catalog.revise({ entryId: 'jarvos', patch: { credentialRef: 'credential:next' }, actor: { id: 'andrew', authenticated: false } }), /authenticated/i);
  const revised = catalog.revise({
    entryId: 'jarvos', patch: { credentialRef: 'credential:next' },
    actor: { id: 'andrew', authenticated: true, role: 'andrew' }, pendingApprovals: [{ id: 'approval-1' }],
  });
  assert.equal(revised.revision, 'managed-software.v2');
  assert.equal(revised.provenance.actor.id, 'andrew');
  assert.deepEqual(revised.invalidatedApprovalIds, ['approval-1']);
});
