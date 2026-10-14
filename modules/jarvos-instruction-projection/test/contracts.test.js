'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../../..');
const {
  ROLE_CATALOG_SCHEMA_VERSION,
  REDACTED_RECEIPT_SCHEMA_VERSION,
  ADAPTER_CONTRACT_VERSION,
  CONTRACT_VERSION,
  HARNESSES,
  ROLE_DEFINITIONS,
  ROLE_IDS,
  normalizeRoleCatalog,
  validateRoleCatalog,
  roleCatalogDigest,
  validateRedactedRoleReceipt,
  validateInstructionProjectionAdapter,
} = require('../src/contracts');

const D = 'a'.repeat(64);

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
      directives: [{
        id: `${role}-baseline`,
        dispositions: Object.fromEntries(HARNESSES.map((harness) => [harness, dispositionFor(role)])),
      }],
    })),
  };
}

function convergedReceipt() {
  return {
    schemaVersion: REDACTED_RECEIPT_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    harness: 'codex',
    adapterVersion: '1.0.0',
    harnessVersion: '0.146.0',
    catalogGeneration: D,
    renderedDigest: D,
    targetIdentity: { kind: 'digest', digest: D },
    observedPrecedence: { status: 'proved', digest: D },
    states: { desired: D, projected: D, installed: D, loaded: D, parity: D },
    projectionStatus: 'clean',
    loadStatus: 'loaded',
    parityStatus: 'equivalent',
    checkedAt: '2026-08-24T12:00:00.000Z',
  };
}

test('defines every stable semantic role and validates a complete disposition matrix', () => {
  const catalog = completeCatalog();
  assert.equal(validateRoleCatalog(catalog), true);
  assert.deepEqual(normalizeRoleCatalog(catalog).roles.map((role) => role.role), ROLE_IDS);
  assert.match(roleCatalogDigest(catalog), /^[a-f0-9]{64}$/);
});

test('rejects unknown roles, duplicate directives, missing harness dispositions, and invalid visibility', () => {
  const unknown = completeCatalog();
  unknown.roles[0].role = 'voice-personality';
  assert.throws(() => validateRoleCatalog(unknown), /unknown/);

  const duplicate = completeCatalog();
  duplicate.roles[0].directives.push(duplicate.roles[0].directives[0]);
  assert.throws(() => validateRoleCatalog(duplicate), /duplicate ids/);

  const missing = completeCatalog();
  delete missing.roles[0].directives[0].dispositions.hermes;
  assert.throws(() => validateRoleCatalog(missing), /hermes is required/);

  const visibility = completeCatalog();
  visibility.roles[0].visibility = 'secret';
  assert.throws(() => validateRoleCatalog(visibility), /visibility is invalid/);

  const incomplete = completeCatalog();
  incomplete.roles.pop();
  assert.throws(() => validateRoleCatalog(incomplete), /missing required roles/);

  const emptyRole = completeCatalog();
  emptyRole.roles[0].directives = [];
  assert.throws(() => validateRoleCatalog(emptyRole), /non-empty array/);
});

test('permits explicit unsupported and not-evaluable outcomes but rejects silent omission', () => {
  const catalog = completeCatalog();
  catalog.roles[0].directives[0].dispositions.claude = { status: 'unsupported', reason: 'Loader not proved.' };
  catalog.roles[0].directives[0].dispositions.hermes = { status: 'not-evaluable', reason: 'No semantic probe exists.' };
  assert.equal(validateRoleCatalog(catalog), true);
  delete catalog.roles[0].directives[0].dispositions.codex;
  assert.throws(() => validateRoleCatalog(catalog), /codex is required/);
});

test('rejects private source and installed-target fields at the public catalog boundary', () => {
  for (const [field, value] of [
    ['sourceBody', 'Andrew-specific identity text'],
    ['sourcePath', '/Users/example/SOUL.md'],
    ['credential', 'secret'],
    ['privateMetadata', { owner: 'local' }],
  ]) {
    const catalog = completeCatalog();
    catalog.roles[0][field] = value;
    assert.throws(() => validateRoleCatalog(catalog), /unsupported fields/);
  }
});

test('keeps desired, projected, installed, loaded, and parity generations distinct', () => {
  assert.equal(validateRedactedRoleReceipt(convergedReceipt()), true);
  const pending = convergedReceipt();
  pending.states.loaded = null;
  pending.states.parity = null;
  pending.loadStatus = 'load_pending';
  pending.parityStatus = 'pending';
  assert.equal(validateRedactedRoleReceipt(pending), true);
});

test('refuses false convergence and private receipt fields', () => {
  const falseParity = convergedReceipt();
  falseParity.states.loaded = 'b'.repeat(64);
  assert.throws(() => validateRedactedRoleReceipt(falseParity), /matching installed and loaded generations/);

  const falseClean = convergedReceipt();
  falseClean.states.desired = 'b'.repeat(64);
  falseClean.parityStatus = 'pending';
  falseClean.states.parity = null;
  assert.throws(() => validateRedactedRoleReceipt(falseClean), /matching desired, projected, and installed generations/);

  const unprovedPrecedence = convergedReceipt();
  unprovedPrecedence.observedPrecedence.status = 'pending';
  unprovedPrecedence.observedPrecedence.digest = null;
  assert.throws(() => validateRedactedRoleReceipt(unprovedPrecedence), /equivalent parity requires proved precedence/);

  const unprovedPrecedenceWithDigest = convergedReceipt();
  unprovedPrecedenceWithDigest.observedPrecedence.status = 'pending';
  assert.throws(() => validateRedactedRoleReceipt(unprovedPrecedenceWithDigest), /must not claim a digest/);

  const looseTimestamp = convergedReceipt();
  looseTimestamp.checkedAt = '2026';
  assert.throws(() => validateRedactedRoleReceipt(looseTimestamp), /ISO UTC timestamp/);

  const impossibleTimestamp = convergedReceipt();
  impossibleTimestamp.checkedAt = '2026-02-30T12:00:00Z';
  assert.throws(() => validateRedactedRoleReceipt(impossibleTimestamp), /real ISO UTC timestamp/);

  for (const [field, value] of [
    ['sourceBody', 'private role text'],
    ['installedPath', '/Users/example/.codex/AGENTS.md'],
    ['credential', 'secret'],
    ['privateMetadata', { receiptPath: '/private/receipt.json' }],
  ]) {
    const receipt = convergedReceipt();
    receipt[field] = value;
    assert.throws(() => validateRedactedRoleReceipt(receipt), /unsupported fields/);
  }
});

test('ships truthful discovery-pending adapter facts for all four harnesses', () => {
  for (const harness of HARNESSES) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', harness, 'adapter.json'), 'utf8'));
    assert.equal(manifest.id, harness);
    assert.equal(validateInstructionProjectionAdapter(manifest.instructionProjection), true);
    assert.deepEqual(manifest.instructionProjection, {
      version: ADAPTER_CONTRACT_VERSION,
      status: 'discovery-pending',
      loader: null,
      supportedVersions: null,
      precedence: null,
      reason: 'Native instruction loader discovery is required before compatibility can be declared.',
    });
  }
});

test('rejects unproved adapter facts and parses the portable JSON schemas', () => {
  assert.throws(() => validateInstructionProjectionAdapter({
    version: ADAPTER_CONTRACT_VERSION,
    status: 'discovery-pending',
    loader: 'AGENTS.md',
    supportedVersions: null,
    precedence: null,
    reason: 'Not proved.',
  }), /must not claim loader facts/);

  for (const schema of ['role-catalog.schema.json', 'role-receipt.schema.json']) {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', schema), 'utf8'));
    assert.equal(parsed.additionalProperties, false);
    assert.equal(parsed.$schema, 'https://json-schema.org/draft/2020-12/schema');
  }

  const catalogSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'role-catalog.schema.json'), 'utf8'));
  assert.equal(catalogSchema.properties.roles.minItems, ROLE_IDS.length);
  assert.equal(catalogSchema.properties.roles.maxItems, ROLE_IDS.length);
  assert.equal(catalogSchema.properties.roles.allOf.length, ROLE_IDS.length);
});
