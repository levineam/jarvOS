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
const { STATIC_ROLE_IDS, DYNAMIC_ROLE_IDS, normalizeContentBundle } = require('../src/catalog');

function dispositionFor(role) {
  if (role === 'tool-mechanics') return { status: 'harness-native-translation' };
  if (role === 'stable-user-constraints') return { status: 'private-only', reason: 'Profile content remains private.' };
  if (role === 'dynamic-memory') return { status: 'not-evaluable', reason: 'Dynamic context is outside static projection.' };
  if (role === 'repository-instructions') return { status: 'deferred', reason: 'Repository instructions remain repository-owned.' };
  return { status: 'equivalent-native' };
}

function completeCatalog() {
  return {
    schemaVersion: ROLE_CATALOG_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    catalogId: 'portable-role-contract',
    roles: ROLE_IDS.map((role) => ({
      role,
      sourceClass: ROLE_DEFINITIONS[role].sourceClass,
      scope: ROLE_DEFINITIONS[role].scope,
      visibility: ['stable-user-constraints', 'dynamic-memory'].includes(role) ? 'private' : 'public',
      directives: [
        {
          id: `${role}-baseline`,
          dispositions: Object.fromEntries(HARNESSES.map((harness) => [harness, dispositionFor(role)])),
        },
        {
          id: `${role}-detail`,
          dispositions: Object.fromEntries(HARNESSES.map((harness) => [harness, dispositionFor(role)])),
        },
      ],
    })),
  };
}

function completeBundle() {
  const bundle = {};
  for (const role of STATIC_ROLE_IDS) {
    bundle[role] = {
      [`${role}-baseline`]: `${role} baseline body text.`,
      [`${role}-detail`]: `${role} detail body text.`,
    };
  }
  return bundle;
}

function reverseObjectKeys(value) {
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, value[key]]));
}

test('normalizes a complete catalog and content bundle', () => {
  const normalized = normalizeContentBundle(completeCatalog(), completeBundle());
  assert.equal(normalized.catalog.roles.length, ROLE_IDS.length);
  assert.match(normalized.catalogGeneration, /^[a-f0-9]{64}$/);
  for (const role of STATIC_ROLE_IDS) {
    assert.equal(normalized.content[role][`${role}-baseline`], `${role} baseline body text.`);
  }
  for (const role of DYNAMIC_ROLE_IDS) {
    assert.equal(Object.hasOwn(normalized.content, role), false);
  }
});

test('produces the same generation digest regardless of insertion order', () => {
  const forward = normalizeContentBundle(completeCatalog(), completeBundle());

  const reorderedCatalog = completeCatalog();
  reorderedCatalog.roles.reverse();
  for (const role of reorderedCatalog.roles) role.directives.reverse();

  const reorderedBundle = reverseObjectKeys(completeBundle());
  for (const role of Object.keys(reorderedBundle)) {
    reorderedBundle[role] = reverseObjectKeys(reorderedBundle[role]);
  }

  const backward = normalizeContentBundle(reorderedCatalog, reorderedBundle);
  assert.equal(backward.catalogGeneration, forward.catalogGeneration);
  assert.deepEqual(backward.content, forward.content);
});

test('changes the catalog generation when valid content changes', () => {
  const baseline = normalizeContentBundle(completeCatalog(), completeBundle());

  const changedBundle = completeBundle();
  changedBundle.governance['governance-baseline'] = 'governance baseline body text, revised.';
  const changed = normalizeContentBundle(completeCatalog(), changedBundle);

  assert.notEqual(changed.catalogGeneration, baseline.catalogGeneration);
});

test('rejects missing, extra, and unknown content entries', () => {
  const missingRole = completeBundle();
  delete missingRole.governance;
  assert.throws(() => normalizeContentBundle(completeCatalog(), missingRole), /missing required entries/);

  const missingDirective = completeBundle();
  delete missingDirective.governance['governance-baseline'];
  assert.throws(() => normalizeContentBundle(completeCatalog(), missingDirective), /missing required entries/);

  const extraRole = completeBundle();
  extraRole['voice-personality'] = { 'voice-personality-baseline': 'extra text' };
  assert.throws(() => normalizeContentBundle(completeCatalog(), extraRole), /unsupported entries/);

  const extraDirective = completeBundle();
  extraDirective.governance['governance-extra'] = 'unexpected text';
  assert.throws(() => normalizeContentBundle(completeCatalog(), extraDirective), /unsupported entries/);
});

test('rejects noncanonical role and directive ids in the content bundle', () => {
  const badRoleId = completeBundle();
  badRoleId.Governance = badRoleId.governance;
  delete badRoleId.governance;
  assert.throws(() => normalizeContentBundle(completeCatalog(), badRoleId), /canonical id/);

  const badDirectiveId = completeBundle();
  badDirectiveId.governance['Governance-Baseline'] = badDirectiveId.governance['governance-baseline'];
  delete badDirectiveId.governance['governance-baseline'];
  assert.throws(() => normalizeContentBundle(completeCatalog(), badDirectiveId), /canonical id/);
});

test('rejects non-string and empty directive bodies', () => {
  const numericBody = completeBundle();
  numericBody.governance['governance-baseline'] = 12345;
  assert.throws(() => normalizeContentBundle(completeCatalog(), numericBody), /nonempty string/);

  const emptyBody = completeBundle();
  emptyBody.governance['governance-baseline'] = '';
  assert.throws(() => normalizeContentBundle(completeCatalog(), emptyBody), /nonempty string/);

  const nullBody = completeBundle();
  nullBody.governance['governance-baseline'] = null;
  assert.throws(() => normalizeContentBundle(completeCatalog(), nullBody), /nonempty string/);

  const whitespaceOnlyBody = completeBundle();
  whitespaceOnlyBody.governance['governance-baseline'] = '   \n\t  ';
  assert.throws(() => normalizeContentBundle(completeCatalog(), whitespaceOnlyBody), /nonempty string/);
});

test('preserves the original body bytes for valid, non-whitespace-only content', () => {
  const bundle = completeBundle();
  bundle.governance['governance-baseline'] = '  leading and trailing whitespace preserved  \n';
  const normalized = normalizeContentBundle(completeCatalog(), bundle);
  assert.equal(normalized.content.governance['governance-baseline'], '  leading and trailing whitespace preserved  \n');
});

test('rejects any static body supplied for the dynamic-memory role', () => {
  const bundle = completeBundle();
  bundle['dynamic-memory'] = { 'dynamic-memory-baseline': 'should never exist statically' };
  assert.throws(
    () => normalizeContentBundle(completeCatalog(), bundle),
    /must not include static content for dynamic-memory/,
  );
});

test('keeps failures body-safe and path-safe: no source text or absolute paths leak into error messages', () => {
  const secretBody = '/private/redacted-user/SOUL.md contains: the sky is green at midnight';

  const numericBody = completeBundle();
  numericBody.governance['governance-baseline'] = 12345;
  try {
    normalizeContentBundle(completeCatalog(), numericBody);
    assert.fail('expected normalizeContentBundle to throw');
  } catch (error) {
    assert.doesNotMatch(error.message, /12345/);
  }

  const pathAsRoleId = completeBundle();
  pathAsRoleId['/etc/passwd'] = { x: secretBody };
  try {
    normalizeContentBundle(completeCatalog(), pathAsRoleId);
    assert.fail('expected normalizeContentBundle to throw');
  } catch (error) {
    assert.doesNotMatch(error.message, /etc\/passwd/);
    assert.doesNotMatch(error.message, /the sky is green/);
  }

  const bundleWithSecretBody = completeBundle();
  bundleWithSecretBody.governance['governance-baseline'] = secretBody;
  const normalized = normalizeContentBundle(completeCatalog(), bundleWithSecretBody);
  assert.doesNotMatch(normalized.catalogGeneration, /the sky is green/);
});
