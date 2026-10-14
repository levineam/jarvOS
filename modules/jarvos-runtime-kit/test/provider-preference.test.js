'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const kit = require('../src/index.js');

function subscriptionEntry(overrides = {}) {
  return {
    schemaVersion: kit.CATALOG_ENTRY_SCHEMA_VERSION,
    entryId: 'host-subscription',
    provider: 'claude',
    model: 'claude-sonnet-5',
    authCategory: 'subscription',
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
    defaultReasoningEffort: 'max',
    ...overrides,
  };
}

test('a fresh installation never hard-codes or advertises a paid provider as authenticated or admitted', () => {
  const defaults = kit.getDefaultProviderCatalogEntries();
  assert.equal(defaults.length, 1);
  assert.deepEqual(defaults[0], kit.DETERMINISTIC_CATALOG_ENTRY);
  assert.equal(defaults[0].authCategory, 'none');
  assert.notEqual(defaults[0].provider, 'claude');
  assert.notEqual(defaults[0].provider, 'openai');
  assert.notEqual(defaults[0].provider, 'grok');

  const catalog = kit.createProviderCatalog();
  assert.equal(kit.validateProviderCatalog(catalog).ok, true);
  assert.equal(catalog.entries.every((entry) => entry.authCategory === 'none'), true);

  const preference = kit.createInitialProviderPreference();
  const status = kit.renderProviderSafeStatus({ catalog, preference });
  assert.equal(status.state, 'unselected');
  assert.equal(status.selected, null);

  // Even an empty, host-supplied catalog is a legal provider-neutral catalog.
  const empty = kit.createProviderCatalog({ entries: [] });
  assert.equal(kit.validateProviderCatalog(empty).ok, true);
  assert.equal(empty.entries.length, 0);
});

test('keeps max in the reasoning-effort vocabulary and accepts a host-supplied subscription choice at max', () => {
  assert.deepEqual(kit.PROVIDER_REASONING_EFFORTS, ['low', 'medium', 'high', 'max']);

  const entry = subscriptionEntry();
  assert.equal(kit.validateProviderCatalogEntry(entry).ok, true);

  const catalog = kit.createProviderCatalog({ entries: [entry] });
  const proposal = kit.createProviderProposal({ catalog, entryId: entry.entryId, expectedGeneration: 'initial-generation' });
  const preference = kit.createInitialProviderPreference({ generation: 'initial-generation' });
  const outcome = kit.previewProviderProposal({ catalog, preference, proposal, result: 'passed' });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.preference.entryId, entry.entryId);

  const status = kit.renderProviderSafeStatus({ catalog, preference: outcome.preference });
  assert.equal(status.selected.authCategory, 'subscription');
  assert.equal(status.selected.reasoningEffort, 'max');
});

test('safe status is a closed, non-secret projection that exposes auth category without profile identity or credentials', () => {
  const catalog = kit.createProviderCatalog({ entries: [subscriptionEntry()] });
  const preference = kit.createInitialProviderPreference();
  const status = kit.renderProviderSafeStatus({ catalog, preference });
  assert.equal(kit.validateProviderSafeStatus(status).ok, true);

  const unknown = kit.validateProviderSafeStatus({ ...status, credentialPath: '/Users/andrew/.config/private' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join('\n'), /forbidden|unknown/i);

  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('credential'), false);
  assert.equal(serialized.includes('token'), false);
  assert.equal(serialized.includes('/Users/'), false);

  for (const field of ['authorization', 'credential', 'privateKey', 'executablePath', 'accountId']) {
    const invalid = kit.validateProviderSafeStatus({ ...status, [field]: 'private' });
    assert.equal(invalid.ok, false, field);
  }
});

test('a failed preview preserves the incumbent preference and generation, recording only a bounded lastPreview: failed status', () => {
  const catalog = kit.createProviderCatalog({ entries: [subscriptionEntry()] });
  const preference = kit.createInitialProviderPreference({ generation: 'incumbent-generation' });
  const proposal = kit.createProviderProposal({ catalog, entryId: 'host-subscription', expectedGeneration: 'incumbent-generation' });

  const outcome = kit.previewProviderProposal({ catalog, preference, proposal, result: 'failed' });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.preference.entryId, null);
  assert.equal(outcome.preference.generation, 'incumbent-generation');
  assert.deepEqual(outcome.preference.lastPreview, {
    entryId: 'host-subscription',
    generation: 'incumbent-generation',
    result: 'failed',
  });

  const status = kit.renderProviderSafeStatus({ catalog, preference: outcome.preference });
  assert.equal(status.state, 'unselected');
  assert.equal(status.selected, null);
  assert.equal(status.lastPreview.result, 'failed');
});

test('a passed preview advances only on the matching generation; a stale replay conflicts', () => {
  const catalog = kit.createProviderCatalog({ entries: [subscriptionEntry()] });
  const preference = kit.createInitialProviderPreference({ generation: 'generation-a' });
  const proposal = kit.createProviderProposal({ catalog, entryId: 'host-subscription', expectedGeneration: 'generation-a' });

  const passed = kit.previewProviderProposal({ catalog, preference, proposal, result: 'passed' });
  assert.equal(passed.ok, true);
  assert.equal(passed.preference.entryId, 'host-subscription');
  assert.notEqual(passed.preference.generation, 'generation-a');

  // Replaying the same proposal against the advanced preference is stale.
  const replay = kit.previewProviderProposal({ catalog, preference: passed.preference, proposal, result: 'passed' });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'stale_generation');
  assert.deepEqual(replay.preference, passed.preference);

  // A failed replay against the advanced preference conflicts the same way.
  const failedReplay = kit.previewProviderProposal({ catalog, preference: passed.preference, proposal, result: 'failed' });
  assert.equal(failedReplay.ok, false);
  assert.equal(failedReplay.code, 'stale_generation');
  assert.deepEqual(failedReplay.preference, passed.preference);
});

test('legacy classification requires an exact recognized old schema and a recognized old provider', () => {
  assert.equal(kit.classifyLegacyProviderRecord(null), null);
  assert.equal(kit.classifyLegacyProviderRecord({}), null);
  assert.equal(kit.classifyLegacyProviderRecord({ schemaVersion: 'unknown/v1', provider: 'claude', state: 'active' }), null);

  const missingProvider = { schemaVersion: kit.LEGACY_PROVIDER_PROFILE_SCHEMA_VERSION, state: 'active' };
  assert.equal(kit.classifyLegacyProviderRecord(missingProvider), null);

  const unknownProvider = { schemaVersion: kit.LEGACY_PROVIDER_PROFILE_SCHEMA_VERSION, provider: 'unknown-vendor', state: 'active' };
  assert.equal(kit.classifyLegacyProviderRecord(unknownProvider), null);

  const activeIncumbentProfile = { schemaVersion: kit.LEGACY_PROVIDER_PROFILE_SCHEMA_VERSION, provider: 'claude', state: 'active' };
  assert.equal(kit.classifyLegacyProviderRecord(activeIncumbentProfile), 'rollback_only');

  const candidateProfile = { schemaVersion: kit.LEGACY_PROVIDER_PROFILE_SCHEMA_VERSION, provider: 'grok', state: 'candidate' };
  assert.equal(kit.classifyLegacyProviderRecord(candidateProfile), 'migration_required');

  const activeIncumbentView = {
    schemaVersion: kit.LEGACY_PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
    state: 'active',
    activeProfile: { provider: 'deterministic', state: 'active' },
  };
  assert.equal(kit.classifyLegacyProviderRecord(activeIncumbentView), 'rollback_only');

  const unconfiguredView = {
    schemaVersion: kit.LEGACY_PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
    state: 'unconfigured',
    activeProfile: { provider: 'claude', state: 'candidate' },
  };
  assert.equal(kit.classifyLegacyProviderRecord(unconfiguredView), 'migration_required');

  const viewWithUnknownProvider = {
    schemaVersion: kit.LEGACY_PROVIDER_RUNTIME_VIEW_SCHEMA_VERSION,
    state: 'active',
    activeProfile: { provider: 'unknown-vendor', state: 'active' },
  };
  assert.equal(kit.classifyLegacyProviderRecord(viewWithUnknownProvider), null);
});

test('registry rejects duplicate identities and a proposal requires a registered catalog entry', () => {
  assert.throws(
    () => kit.createProviderCatalog({ entries: [kit.DETERMINISTIC_CATALOG_ENTRY, kit.DETERMINISTIC_CATALOG_ENTRY] }),
    (error) => error.code === 'duplicate_catalog_entry',
  );
  const catalog = kit.createProviderCatalog();
  assert.throws(
    () => kit.createProviderProposal({ catalog, entryId: 'never-registered', expectedGeneration: 'initial-generation' }),
    (error) => error.code === 'entry_not_registered',
  );
});

test('provider-neutral control contract keeps proposal/preview read-only and the CLI equivalent to the library', () => {
  const catalog = kit.createProviderCatalog();
  const preference = kit.createInitialProviderPreference();
  const control = kit.createProviderSelectionControl({ catalog, preference });

  const proposal = control.propose({ entryId: 'deterministic-fixture' });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.proposal.entryId, 'deterministic-fixture');
  assert.equal(proposal.proposal.expectedGeneration, preference.generation);

  const preview = control.preview({ entryId: 'deterministic-fixture', result: 'passed' });
  assert.equal(preview.ok, true);
  assert.equal(preview.preference.entryId, 'deterministic-fixture');
  assert.equal(preview.status.state, 'selected');

  const cliStatus = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../../scripts/active-assistant-provider-preference.js'),
    'status', '--json',
  ], { encoding: 'utf8' });
  assert.equal(cliStatus.status, 0, cliStatus.stderr);
  assert.deepEqual(JSON.parse(cliStatus.stdout), control.status());

  const cliPreview = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../../scripts/active-assistant-provider-preference.js'),
    'preview', 'deterministic-fixture', '--result', 'passed', '--json',
  ], { encoding: 'utf8' });
  assert.equal(cliPreview.status, 0, cliPreview.stderr);
  const cliResult = JSON.parse(cliPreview.stdout);
  assert.equal(cliResult.ok, true);
  assert.equal(cliResult.preference.entryId, 'deterministic-fixture');
});
