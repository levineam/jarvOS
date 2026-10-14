'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ROLE_CATALOG_SCHEMA_VERSION,
  CONTRACT_VERSION,
  HARNESSES,
  ROLE_DEFINITIONS,
  ROLE_IDS,
} = require('../src/contracts');
const { STATIC_ROLE_IDS, normalizeContentBundle } = require('../src/catalog');
const {
  RENDER_VERSION,
  LOGICAL_BUNDLE_SCHEMA_VERSION,
  computeGenerationDigest,
  renderHarnessBundle,
  renderAllHarnesses,
} = require('../src/render');

const NON_APPLICABLE_STATUS = Object.freeze({
  claude: 'unsupported',
  codex: 'deferred',
  openclaw: 'not-evaluable',
  hermes: 'unsupported',
});

function dispositionsFor(role) {
  if (role === 'dynamic-memory') {
    return Object.fromEntries(HARNESSES.map((harness) => [harness, { status: 'equivalent-native' }]));
  }
  return Object.fromEntries(HARNESSES.map((harness) => [
    harness,
    { status: NON_APPLICABLE_STATUS[harness], reason: `${role} is ${NON_APPLICABLE_STATUS[harness]} on ${harness}.` },
  ]));
}

function mixedCatalog() {
  return {
    schemaVersion: ROLE_CATALOG_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    catalogId: 'render-fixture',
    roles: ROLE_IDS.map((role) => ({
      role,
      sourceClass: ROLE_DEFINITIONS[role].sourceClass,
      scope: ROLE_DEFINITIONS[role].scope,
      visibility: ['stable-user-constraints', 'dynamic-memory'].includes(role) ? 'private' : 'public',
      directives: [{
        id: `${role}-baseline`,
        dispositions: dispositionsFor(role),
      }],
    })),
  };
}

function mixedBundle() {
  const bundle = {};
  for (const role of STATIC_ROLE_IDS) {
    bundle[role] = { [`${role}-baseline`]: `${role} baseline body text.` };
  }
  return bundle;
}

function normalizedFixture() {
  return normalizeContentBundle(mixedCatalog(), mixedBundle());
}

test('renders one logical bundle per U1 harness deterministically', () => {
  const normalized = normalizedFixture();
  const rendered = renderAllHarnesses(normalized);
  assert.deepEqual(Object.keys(rendered).sort(), [...HARNESSES].sort());

  const again = renderAllHarnesses(normalizedFixture());
  for (const harness of HARNESSES) {
    assert.deepEqual(rendered[harness], again[harness]);
    assert.equal(rendered[harness].schemaVersion, LOGICAL_BUNDLE_SCHEMA_VERSION);
    assert.equal(rendered[harness].rendererVersion, RENDER_VERSION);
    assert.equal(rendered[harness].catalogGeneration, normalized.catalogGeneration);
  }

  const generationDigests = HARNESSES.map((harness) => rendered[harness].generationDigest);
  assert.equal(new Set(generationDigests).size, HARNESSES.length);

  const renderedDigests = HARNESSES.map((harness) => rendered[harness].renderedDigest);
  assert.equal(new Set(renderedDigests).size, HARNESSES.length);
});

test('changing valid content changes catalog generation, renderer-bound generation, and rendered digest', () => {
  const baselineNormalized = normalizedFixture();
  const baselineRendered = renderHarnessBundle(baselineNormalized, 'claude');

  const changedBundle = mixedBundle();
  changedBundle.governance['governance-baseline'] = 'governance baseline body text, revised.';
  const changedNormalized = normalizeContentBundle(mixedCatalog(), changedBundle);
  const changedRendered = renderHarnessBundle(changedNormalized, 'claude');

  assert.notEqual(changedNormalized.catalogGeneration, baselineNormalized.catalogGeneration);
  assert.notEqual(changedRendered.generationDigest, baselineRendered.generationDigest);
  assert.notEqual(changedRendered.renderedDigest, baselineRendered.renderedDigest);
});

test('computeGenerationDigest is a pure function of catalog generation, harness, and renderer version', () => {
  const normalized = normalizedFixture();

  const first = computeGenerationDigest(normalized.catalogGeneration, 'claude');
  const second = computeGenerationDigest(normalized.catalogGeneration, 'claude');
  assert.equal(first, second);

  const otherHarness = computeGenerationDigest(normalized.catalogGeneration, 'codex');
  assert.notEqual(first, otherHarness);

  const otherVersion = computeGenerationDigest(normalized.catalogGeneration, 'claude', 'jarvos-instruction-projection-render/v2-test-only');
  assert.notEqual(first, otherVersion);
  assert.equal(RENDER_VERSION, 'jarvos-instruction-projection-render/v1');
});

test('preserves every directive disposition explicitly with no silent drops', () => {
  const rendered = renderAllHarnesses(normalizedFixture());
  for (const harness of HARNESSES) {
    const roleNames = rendered[harness].roles.map((role) => role.role);
    assert.deepEqual(roleNames, ROLE_IDS);
    for (const role of rendered[harness].roles) {
      assert.equal(role.directives.length, 1);
    }
  }
});

test('marks non-applicable dispositions explicitly and withholds their body', () => {
  const rendered = renderAllHarnesses(normalizedFixture());
  for (const harness of HARNESSES) {
    const governance = rendered[harness].roles.find((role) => role.role === 'governance').directives[0];
    assert.equal(governance.disposition.status, NON_APPLICABLE_STATUS[harness]);
    assert.equal(governance.applicable, false);
    assert.equal(governance.body, null);
  }
});

test('renders applicable static content for equivalent-native and harness-native-translation dispositions', () => {
  const rendered = renderAllHarnesses(normalizedFixture());
  const catalog = mixedCatalog();
  catalog.roles.forEach((role) => {
    if (role.role === 'dynamic-memory') return;
    role.directives[0].dispositions = Object.fromEntries(HARNESSES.map((harness) => [harness, { status: 'equivalent-native' }]));
  });
  const bundle = mixedBundle();
  const normalized = normalizeContentBundle(catalog, bundle);
  const applicableRendered = renderAllHarnesses(normalized);
  for (const harness of HARNESSES) {
    for (const role of applicableRendered[harness].roles) {
      if (role.role === 'dynamic-memory') continue;
      const directive = role.directives[0];
      assert.equal(directive.applicable, true);
      assert.equal(directive.body, `${role.role} baseline body text.`);
    }
  }
});

test('renders private-only static content locally for non-dynamic roles', () => {
  const catalog = mixedCatalog();
  const privateOnlyRole = catalog.roles.find((role) => role.role === 'stable-user-constraints');
  privateOnlyRole.directives[0].dispositions = Object.fromEntries(
    HARNESSES.map((harness) => [harness, { status: 'private-only', reason: 'Profile content remains private.' }]),
  );
  const normalized = normalizeContentBundle(catalog, mixedBundle());
  const rendered = renderAllHarnesses(normalized);
  for (const harness of HARNESSES) {
    const directive = rendered[harness].roles.find((role) => role.role === 'stable-user-constraints').directives[0];
    assert.equal(directive.disposition.status, 'private-only');
    assert.equal(directive.applicable, true);
    assert.equal(directive.body, 'stable-user-constraints baseline body text.');
  }
});

test('never renders static bytes for dynamic-memory even when its disposition claims equivalence', () => {
  const rendered = renderAllHarnesses(normalizedFixture());
  for (const harness of HARNESSES) {
    const dynamic = rendered[harness].roles.find((role) => role.role === 'dynamic-memory').directives[0];
    assert.equal(dynamic.disposition.status, 'equivalent-native');
    assert.equal(dynamic.applicable, false);
    assert.equal(dynamic.body, null);
  }
});

test('never renders static bytes for dynamic-memory even when its disposition claims private-only', () => {
  const catalog = mixedCatalog();
  const dynamicRole = catalog.roles.find((role) => role.role === 'dynamic-memory');
  dynamicRole.directives[0].dispositions = Object.fromEntries(
    HARNESSES.map((harness) => [harness, { status: 'private-only', reason: 'Dynamic context is never statically bodied.' }]),
  );
  const normalized = normalizeContentBundle(catalog, mixedBundle());
  const rendered = renderAllHarnesses(normalized);
  for (const harness of HARNESSES) {
    const dynamic = rendered[harness].roles.find((role) => role.role === 'dynamic-memory').directives[0];
    assert.equal(dynamic.applicable, false);
    assert.equal(dynamic.body, null);
  }
});

test('rendered bundles never carry installed-path, loaded, or native-loader-compatibility claims', () => {
  const rendered = renderAllHarnesses(normalizedFixture());
  for (const harness of HARNESSES) {
    const serialized = JSON.stringify(rendered[harness]);
    assert.doesNotMatch(serialized, /installedPath/i);
    assert.doesNotMatch(serialized, /nativeLoader/i);
    assert.doesNotMatch(serialized, /loaderCompat/i);
    assert.doesNotMatch(serialized, /"loaded"/i);
    assert.doesNotMatch(serialized, /semanticParity/i);
  }
});

test('rejects rendering for an unknown harness', () => {
  const normalized = normalizedFixture();
  assert.throws(() => renderHarnessBundle(normalized, 'gpt'), /harness is unknown/);
});
