'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const kit = require('../src/index.js');

const TUPLE_A = 'a'.repeat(64);
const TUPLE_B = 'b'.repeat(64);

function profile(overrides = {}) {
  const { egressPolicy: egressOverrides, ...profileOverrides } = overrides;
  return kit.createProviderProfile({
    profileId: 'claude-subscription',
    provider: 'claude',
    model: 'claude-sonnet-5',
    adapterDistribution: {
      id: 'jarvos-claude-cli',
      version: '1.0.0',
      capabilityVersion: 'jarvos-claude-cli-capability/v1',
    },
    authMode: 'subscription',
    promptTransport: { mode: 'owner-private-file', version: 'v1' },
    toolPolicy: { mode: 'deny-all', version: 'v1' },
    egressPolicy: {
      digest: '1'.repeat(64),
      allowedDataClasses: ['source_excerpt', 'project_context'],
      minimizationRevision: 'v1',
      disclosureRevision: 'v1',
      ownerAcceptance: egressOverrides?.ownerAcceptance || 'required',
    },
    ...profileOverrides,
    ...(egressOverrides ? { egressPolicy: {
      digest: '1'.repeat(64),
      allowedDataClasses: ['source_excerpt', 'project_context'],
      minimizationRevision: 'v1',
      disclosureRevision: 'v1',
      ownerAcceptance: 'required',
      ...egressOverrides,
    } } : {}),
  });
}

test('exports strict versioned profile, adapter, health, view, and intent validators', () => {
  assert.equal(kit.PROVIDER_PROFILE_SCHEMA_VERSION, 'jarvos-provider-profile/v1');
  assert.equal(kit.MANAGED_ADAPTER_DESCRIPTOR_SCHEMA_VERSION, 'jarvos-managed-adapter/v1');
  assert.equal(kit.PROVIDER_HEALTH_SCHEMA_VERSION, 'jarvos-provider-health/v1');
  assert.equal(kit.PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION, 'jarvos-provider-runtime-view/v1');
  assert.equal(kit.PROVIDER_SWITCH_INTENT_SCHEMA_VERSION, 'jarvos-provider-switch-intent/v1');

  const candidate = profile();
  assert.equal(kit.validateProviderProfile(candidate).ok, true);
  assert.equal(kit.validateManagedAdapterDescriptor(kit.PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR).ok, true);
  assert.equal(kit.validateProviderHealth(kit.redactedProviderHealth({ status: 'auth_required', reasonCode: 'auth_missing' })).ok, true);
  assert.equal(kit.validateProviderRuntimeView(kit.createFreshProviderView()).ok, true);
  assert.equal(kit.validateProviderSwitchIntent(kit.createProviderSwitchIntent({
    profileId: candidate.profileId,
    tupleDigest: TUPLE_B,
    expectedGeneration: 'fresh-generation',
  })).ok, true);
});

test('rejects unknown and authority-shaped provider fields, paths, credentials, and raw output', () => {
  const unknown = kit.validateProviderProfile({ ...profile(), unexpected: true });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join('\n'), /unknown field/i);

  for (const field of ['authorization', 'credential', 'privateKey', 'executablePath', 'providerOutput']) {
    const invalid = kit.validateProviderProfile({ ...profile(), [field]: 'private' });
    assert.equal(invalid.ok, false, field);
    assert.match(invalid.errors.join('\n'), /forbidden|authority|unknown/i, field);
  }

  const badDescriptor = kit.validateManagedAdapterDescriptor({
    ...kit.PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR,
    distribution: { ...kit.PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR.distribution, executablePath: '/Users/andrew/bin/claude' },
  });
  assert.equal(badDescriptor.ok, false);
  assert.match(badDescriptor.errors.join('\n'), /forbidden|path|unknown/i);

  const badIntent = kit.validateProviderSwitchIntent({
    ...kit.createProviderSwitchIntent({ profileId: 'deterministic-fixture', tupleDigest: TUPLE_B, expectedGeneration: 'fresh-generation' }),
    authorization: { signature: 'secret' },
  });
  assert.equal(badIntent.ok, false);

  const pathLikeId = kit.validateProviderProfile({ ...profile(), profileId: 'private/profile' });
  assert.equal(pathLikeId.ok, false);
  assert.match(pathLikeId.errors.join('\n'), /safe non-empty string/i);
});

test('built-in Claude and deterministic descriptors are portable and deterministic while Grok is typed unsupported', () => {
  assert.deepEqual(kit.PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR, kit.getBuiltInAdapterDescriptors().claude);
  assert.deepEqual(kit.DETERMINISTIC_ADAPTER_DESCRIPTOR, kit.getBuiltInAdapterDescriptors().deterministic);
  assert.deepEqual(kit.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR, kit.getBuiltInAdapterDescriptors().grok);
  assert.equal(kit.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR.support, 'unsupported');
  assert.equal(kit.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR.reasonCode, 'capability_proof_pending');
  assert.equal(kit.validateManagedAdapterDescriptor(kit.GROK_SUBSCRIPTION_ADAPTER_DESCRIPTOR).ok, true);

  const serialized = JSON.stringify(kit.getBuiltInAdapterDescriptors());
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('/home/'), false);
  assert.equal(serialized.includes('XAI_API_KEY'), false);
  assert.equal(serialized.includes('credential'), false);
  assert.deepEqual(
    JSON.stringify(kit.PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR),
    JSON.stringify(kit.PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR),
  );
});

test('fresh installation is unconfigured and never picks a paid default', () => {
  const registry = kit.createProviderRegistry();
  const view = kit.createFreshProviderView();
  const listed = kit.listProviderProfiles({ registry });

  assert.equal(view.state, 'unconfigured');
  assert.equal(view.activeProfile, null);
  assert.equal(view.readOnly, true);
  assert.equal(listed.ok, true);
  assert.equal(listed.activeProfileId, null);
  assert.equal(listed.profiles.some((item) => item.state === 'active'), false);
  assert.equal(listed.defaultProfileId, null);
  assert.equal(listed.profiles.find((item) => item.profileId === 'grok-subscription').status, 'unsupported');
  assert.equal(JSON.stringify(view).includes('XAI_API_KEY'), false);
});

test('health distinguishes missing executable, missing auth, unsupported capability, outage, and active state', () => {
  const descriptor = kit.PORTABLE_CLAUDE_ADAPTER_DESCRIPTOR;
  assert.equal(kit.classifyProviderHealth({ descriptor, evidence: { executable: 'missing' } }).status, 'unhealthy');
  assert.equal(kit.classifyProviderHealth({ descriptor, evidence: { executable: 'present', authenticated: false } }).status, 'auth_required');
  assert.equal(kit.classifyProviderHealth({ descriptor, evidence: { executable: 'present', authenticated: true, capability: 'unsupported' } }).status, 'unsupported');
  assert.equal(kit.classifyProviderHealth({ descriptor, evidence: { executable: 'present', authenticated: true, unhealthy: true } }).status, 'unhealthy');
  assert.equal(kit.classifyProviderHealth({ descriptor, evidence: { executable: 'present', authenticated: true, active: true } }).status, 'active');
  assert.equal(kit.classifyProviderHealth({ descriptor: kit.DETERMINISTIC_ADAPTER_DESCRIPTOR }).status, 'available');
});

test('active legacy migration preserves the exact incumbent tuple without false requalification', () => {
  const incumbent = profile({
    state: 'active',
    qualificationState: 'legacy',
    runtimeTuple: { tupleDigest: TUPLE_A, generation: 'incumbent-generation' },
    egressPolicy: { ownerAcceptance: 'accepted' },
  });
  assert.equal(kit.validateProviderProfile(incumbent).ok, true);
  const view = kit.renderProviderReadView({
    generation: 'incumbent-generation',
    operatorState: { state: 'active', activeProfile: incumbent },
  });
  assert.equal(view.state, 'active');
  assert.equal(view.activeProfile.qualificationState, 'legacy');
  assert.deepEqual(view.activeProfile.runtimeTuple, incumbent.runtimeTuple);
  assert.notEqual(view.activeProfile.qualificationState, 'current');
  assert.equal(kit.canPrepareProviderView(view, {
    operatorGeneration: 'incumbent-generation',
    selectedTupleDigest: TUPLE_A,
  }), true);
  assert.equal(kit.canPrepareProviderView(view, {
    operatorGeneration: 'different-generation',
    selectedTupleDigest: TUPLE_A,
  }), false);
  assert.equal(kit.canPrepareProviderView(view, {
    operatorGeneration: 'incumbent-generation',
    selectedTupleDigest: TUPLE_B,
  }), false);
  assert.equal(kit.canDeliverProviderView(view, {
    operatorGeneration: 'incumbent-generation',
    selectedTupleDigest: TUPLE_A,
  }), false);
});

test('runtime-rendered views are opaque, generation-bound, read-only, and never expose private state', () => {
  const privateState = {
    state: 'candidate',
    activeProfile: null,
    candidateProfile: profile({
      profileId: 'deterministic-fixture',
      provider: 'deterministic',
      model: 'deterministic-v1',
      authMode: 'none',
      promptTransport: { mode: 'deterministic-memory', version: 'v1' },
      adapterDistribution: {
        id: 'jarvos-deterministic',
        version: '1.0.0',
        capabilityVersion: 'jarvos-deterministic-capability/v1',
      },
    }),
    credentialPath: '/Users/andrew/.config/private-credentials',
    providerOutput: 'never publish this',
  };
  const view = kit.renderProviderReadView({ generation: 'candidate-generation', operatorState: privateState });
  const validation = kit.validateProviderRuntimeView(view);
  assert.equal(validation.ok, true, validation.errors?.join('\n'));
  assert.equal(view.readOnly, true);
  assert.equal(view.source, 'runtime-rendered');
  assert.equal(view.generation, 'candidate-generation');
  assert.equal(Object.hasOwn(view, 'canPrepare'), false);
  assert.equal(Object.hasOwn(view, 'canDeliver'), false);
  assert.equal(JSON.stringify(view).includes('credentialPath'), false);
  assert.equal(JSON.stringify(view).includes('private-credentials'), false);
  assert.equal(JSON.stringify(view).includes('providerOutput'), false);
  assert.equal(kit.canPrepareProviderView(view, {
    operatorGeneration: 'candidate-generation',
    selectedTupleDigest: TUPLE_B,
  }), false);
  assert.equal(kit.canDeliverProviderView(view), false);
});

test('egress policy is bound to provider identity and policy changes require fresh qualification', () => {
  const first = profile({ egressPolicy: { ownerAcceptance: 'accepted' } });
  const second = profile({ egressPolicy: { ownerAcceptance: 'accepted', minimizationRevision: 'v2' } });
  assert.notEqual(kit.providerProfileIdentity(first), kit.providerProfileIdentity(second));
  assert.equal(kit.qualificationRequiresFreshMatrix(first, second), true);
  assert.equal(kit.qualificationRequiresFreshMatrix(first, first), false);

  const reordered = {
    runtimeTuple: first.runtimeTuple,
    state: first.state,
    qualificationState: first.qualificationState,
    egressPolicy: {
      ownerAcceptance: first.egressPolicy.ownerAcceptance,
      disclosureRevision: first.egressPolicy.disclosureRevision,
      minimizationRevision: first.egressPolicy.minimizationRevision,
      allowedDataClasses: first.egressPolicy.allowedDataClasses,
      digest: first.egressPolicy.digest,
    },
    toolPolicy: first.toolPolicy,
    promptTransport: first.promptTransport,
    authMode: first.authMode,
    adapterDistribution: first.adapterDistribution,
    model: first.model,
    provider: first.provider,
    profileId: first.profileId,
    schemaVersion: first.schemaVersion,
  };
  assert.equal(kit.providerProfileIdentity(first), kit.providerProfileIdentity(reordered));
});

test('registry rejects duplicate identities and proposals require a registered profile', () => {
  assert.throws(
    () => kit.createProviderRegistry({
      descriptors: [kit.DETERMINISTIC_ADAPTER_DESCRIPTOR, kit.DETERMINISTIC_ADAPTER_DESCRIPTOR],
    }),
    (error) => error.code === 'duplicate_adapter_profile',
  );
  assert.throws(
    () => kit.createProviderRegistry({
      descriptors: [kit.DETERMINISTIC_ADAPTER_DESCRIPTOR],
      profiles: [
        kit.createProviderProfile({
          ...profile(),
          profileId: 'deterministic-fixture',
          provider: 'deterministic',
          model: 'deterministic-v1',
          authMode: 'none',
          promptTransport: { mode: 'deterministic-memory', version: 'v1' },
          adapterDistribution: {
            id: 'jarvos-deterministic',
            version: 'portable-v1',
            capabilityVersion: 'jarvos-deterministic-capability/v1',
          },
        }),
        kit.createProviderProfile({
          ...profile(),
          profileId: 'deterministic-fixture',
          provider: 'deterministic',
          model: 'deterministic-v1',
          authMode: 'none',
          promptTransport: { mode: 'deterministic-memory', version: 'v1' },
          adapterDistribution: {
            id: 'jarvos-deterministic',
            version: 'portable-v1',
            capabilityVersion: 'jarvos-deterministic-capability/v1',
          },
        }),
      ],
    }),
    (error) => error.code === 'duplicate_provider_profile',
  );

  const registry = kit.createProviderRegistry({
    descriptors: [kit.DETERMINISTIC_ADAPTER_DESCRIPTOR],
    profiles: [],
  });
  const control = kit.createProviderControl({ registry, view: kit.createFreshProviderView() });
  assert.equal(control.proposeSwitch({ profileId: 'deterministic-fixture', tupleDigest: TUPLE_B }).code, 'profile_not_registered');
});

test('provider-neutral control contract keeps proposal read-only and agent/CLI intent views equivalent', () => {
  const registry = kit.createProviderRegistry();
  const view = kit.createFreshProviderView();
  const control = kit.createProviderControl({ registry, view });
  const proposal = control.proposeSwitch({ profileId: 'deterministic-fixture', tupleDigest: TUPLE_B });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.intent.candidate.profileId, 'deterministic-fixture');
  assert.equal(proposal.intent.expectedGeneration, view.generation);
  assert.equal(proposal.view.state, 'unconfigured');
  assert.throws(() => control.authorizeAndRun(proposal.intent), (error) => error.code === 'owner_authorization_required');
  assert.throws(() => control.rollback(), (error) => error.code === 'owner_authorization_required');

  const cli = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../../scripts/active-assistant-provider.js'),
    'propose-switch', 'deterministic-fixture', '--tuple', TUPLE_B, '--json',
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assert.deepEqual(cliResult.intent, proposal.intent);
  assert.deepEqual(cliResult.view, proposal.view);
});
