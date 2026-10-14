'use strict';

const crypto = require('node:crypto');

const ROLE_CATALOG_SCHEMA_VERSION = 'jarvos.instruction-role-catalog/v1';
const REDACTED_RECEIPT_SCHEMA_VERSION = 'jarvos.instruction-role-receipt-redacted/v1';
const ADAPTER_CONTRACT_VERSION = 'jarvos-instruction-projection-adapter/v1';
const CONTRACT_VERSION = '1.0.0';

const HARNESSES = Object.freeze(['claude', 'codex', 'openclaw', 'hermes']);
const DISPOSITIONS = Object.freeze([
  'equivalent-native',
  'harness-native-translation',
  'unsupported',
  'deferred',
  'private-only',
  'not-evaluable',
]);
const PROJECTION_STATES = Object.freeze([
  'unsupported',
  'incompatible',
  'missing',
  'unknown',
  'conflict',
  'clean',
  'outdated',
  'local_modified',
]);
const LOAD_STATES = Object.freeze(['load_pending', 'loaded', 'not_evaluable', 'stale', 'partial', 'failed']);
const PARITY_STATES = Object.freeze(['pending', 'equivalent', 'not_evaluable', 'failed']);
const ADAPTER_STATES = Object.freeze(['discovery-pending', 'supported', 'unsupported']);

const ROLE_DEFINITIONS = Object.freeze({
  governance: Object.freeze({ sourceClass: 'shared-static', scope: 'global', deliveryPlane: 'native-loader' }),
  soul: Object.freeze({ sourceClass: 'shared-static', scope: 'global', deliveryPlane: 'native-loader' }),
  identity: Object.freeze({ sourceClass: 'shared-static', scope: 'global', deliveryPlane: 'native-loader' }),
  'stable-user-constraints': Object.freeze({ sourceClass: 'private-static', scope: 'global', deliveryPlane: 'native-loader' }),
  'tool-mechanics': Object.freeze({ sourceClass: 'harness-native', scope: 'workspace', deliveryPlane: 'native-loader' }),
  'durable-orientation': Object.freeze({ sourceClass: 'shared-static', scope: 'global', deliveryPlane: 'native-loader' }),
  'heartbeat-intent': Object.freeze({ sourceClass: 'shared-static', scope: 'global', deliveryPlane: 'native-loader' }),
  'dynamic-memory': Object.freeze({ sourceClass: 'dynamic-service', scope: 'dynamic', deliveryPlane: 'dynamic-context' }),
  'repository-instructions': Object.freeze({ sourceClass: 'repository-native', scope: 'repository', deliveryPlane: 'native-loader' }),
});
const ROLE_IDS = Object.freeze(Object.keys(ROLE_DEFINITIONS));

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,79}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,79}$/;
const UTC_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
}

function opaqueId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`${label} must be a canonical id`);
  return value;
}

function exactDigest(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO UTC timestamp`);
  }
  const normalized = new Date(value).toISOString();
  const expected = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  if (normalized !== expected) throw new Error(`${label} must be a real ISO UTC timestamp`);
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizeDisposition(value, label) {
  const item = assertObject(value, label);
  assertExactKeys(item, ['status', 'reason'], label);
  if (!DISPOSITIONS.includes(item.status)) throw new Error(`${label}.status is invalid`);
  if (item.reason !== undefined && (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 500)) {
    throw new Error(`${label}.reason must be a bounded nonempty string`);
  }
  if (['unsupported', 'deferred', 'private-only', 'not-evaluable'].includes(item.status) && !item.reason) {
    throw new Error(`${label}.reason is required for ${item.status}`);
  }
  return item.reason === undefined ? { status: item.status } : { status: item.status, reason: item.reason };
}

function normalizeDirective(value, label) {
  const directive = assertObject(value, label);
  assertExactKeys(directive, ['id', 'dispositions'], label);
  const dispositions = assertObject(directive.dispositions, `${label}.dispositions`);
  assertExactKeys(dispositions, HARNESSES, `${label}.dispositions`);
  for (const harness of HARNESSES) {
    if (!Object.hasOwn(dispositions, harness)) throw new Error(`${label}.dispositions.${harness} is required`);
  }
  return {
    id: opaqueId(directive.id, `${label}.id`),
    dispositions: Object.fromEntries(HARNESSES.map((harness) => [
      harness,
      normalizeDisposition(dispositions[harness], `${label}.dispositions.${harness}`),
    ])),
  };
}

function normalizeRole(value, label) {
  const role = assertObject(value, label);
  assertExactKeys(role, ['role', 'sourceClass', 'scope', 'visibility', 'directives'], label);
  if (!ROLE_IDS.includes(role.role)) throw new Error(`${label}.role is unknown`);
  const definition = ROLE_DEFINITIONS[role.role];
  if (role.sourceClass !== definition.sourceClass) throw new Error(`${label}.sourceClass does not match ${role.role}`);
  if (role.scope !== definition.scope) throw new Error(`${label}.scope does not match ${role.role}`);
  if (!['public', 'private'].includes(role.visibility)) throw new Error(`${label}.visibility is invalid`);
  if (!Array.isArray(role.directives) || role.directives.length === 0) throw new Error(`${label}.directives must be a non-empty array`);
  const directives = role.directives.map((directive, index) => normalizeDirective(directive, `${label}.directives[${index}]`));
  const directiveIds = directives.map((directive) => directive.id);
  if (new Set(directiveIds).size !== directiveIds.length) throw new Error(`${label}.directives contains duplicate ids`);
  directives.sort((left, right) => left.id.localeCompare(right.id));
  return {
    role: role.role,
    sourceClass: role.sourceClass,
    scope: role.scope,
    visibility: role.visibility,
    directives,
  };
}

function normalizeRoleCatalog(value) {
  const catalog = assertObject(value, 'role catalog');
  assertExactKeys(catalog, ['schemaVersion', 'contractVersion', 'catalogId', 'roles'], 'role catalog');
  if (catalog.schemaVersion !== ROLE_CATALOG_SCHEMA_VERSION || catalog.contractVersion !== CONTRACT_VERSION) {
    throw new Error('role catalog schema or contract version is unsupported');
  }
  opaqueId(catalog.catalogId, 'role catalog catalogId');
  if (!Array.isArray(catalog.roles) || catalog.roles.length === 0) throw new Error('role catalog roles must be a non-empty array');
  const roles = catalog.roles.map((role, index) => normalizeRole(role, `role catalog roles[${index}]`));
  const roleIds = roles.map((role) => role.role);
  if (new Set(roleIds).size !== roleIds.length) throw new Error('role catalog contains duplicate roles');
  const missingRoles = ROLE_IDS.filter((role) => !roleIds.includes(role));
  if (missingRoles.length) throw new Error(`role catalog is missing required roles: ${missingRoles.join(', ')}`);
  roles.sort((left, right) => ROLE_IDS.indexOf(left.role) - ROLE_IDS.indexOf(right.role));
  return {
    schemaVersion: ROLE_CATALOG_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    catalogId: catalog.catalogId,
    roles,
  };
}

function validateRoleCatalog(value) {
  normalizeRoleCatalog(value);
  return true;
}

function roleCatalogDigest(value) {
  return digest(normalizeRoleCatalog(value));
}

function normalizeGenerationStates(value) {
  const states = assertObject(value, 'redacted receipt states');
  const keys = ['desired', 'projected', 'installed', 'loaded', 'parity'];
  assertExactKeys(states, keys, 'redacted receipt states');
  for (const key of keys) {
    if (!Object.hasOwn(states, key)) throw new Error(`redacted receipt states.${key} is required`);
  }
  return Object.fromEntries(keys.map((key) => [key, exactDigest(states[key], `redacted receipt states.${key}`, { nullable: true })]));
}

function normalizeRedactedRoleReceipt(value) {
  const receipt = assertObject(value, 'redacted receipt');
  assertExactKeys(receipt, [
    'schemaVersion', 'contractVersion', 'harness', 'adapterVersion', 'harnessVersion',
    'catalogGeneration', 'renderedDigest', 'targetIdentity', 'observedPrecedence',
    'states', 'projectionStatus', 'loadStatus', 'parityStatus', 'checkedAt',
  ], 'redacted receipt');
  if (receipt.schemaVersion !== REDACTED_RECEIPT_SCHEMA_VERSION || receipt.contractVersion !== CONTRACT_VERSION) {
    throw new Error('redacted receipt schema or contract version is unsupported');
  }
  if (!HARNESSES.includes(receipt.harness)) throw new Error('redacted receipt harness is invalid');
  if (typeof receipt.adapterVersion !== 'string' || !VERSION_RE.test(receipt.adapterVersion)) throw new Error('redacted receipt adapterVersion is invalid');
  if (typeof receipt.harnessVersion !== 'string' || !VERSION_RE.test(receipt.harnessVersion)) throw new Error('redacted receipt harnessVersion is invalid');
  const targetIdentity = assertObject(receipt.targetIdentity, 'redacted receipt targetIdentity');
  assertExactKeys(targetIdentity, ['kind', 'digest'], 'redacted receipt targetIdentity');
  if (targetIdentity.kind !== 'digest') throw new Error('redacted receipt targetIdentity.kind must be digest');
  const observedPrecedence = assertObject(receipt.observedPrecedence, 'redacted receipt observedPrecedence');
  assertExactKeys(observedPrecedence, ['status', 'digest'], 'redacted receipt observedPrecedence');
  if (!['proved', 'pending', 'not_evaluable'].includes(observedPrecedence.status)) throw new Error('redacted receipt observedPrecedence.status is invalid');
  const normalizedPrecedenceDigest = exactDigest(observedPrecedence.digest, 'redacted receipt observedPrecedence.digest', { nullable: true });
  if (observedPrecedence.status === 'proved' && normalizedPrecedenceDigest === null) throw new Error('proved precedence requires a digest');
  if (observedPrecedence.status !== 'proved' && normalizedPrecedenceDigest !== null) throw new Error('unproved precedence must not claim a digest');
  if (!PROJECTION_STATES.includes(receipt.projectionStatus)) throw new Error('redacted receipt projectionStatus is invalid');
  if (!LOAD_STATES.includes(receipt.loadStatus)) throw new Error('redacted receipt loadStatus is invalid');
  if (!PARITY_STATES.includes(receipt.parityStatus)) throw new Error('redacted receipt parityStatus is invalid');
  const states = normalizeGenerationStates(receipt.states);
  const renderedDigest = exactDigest(receipt.renderedDigest, 'redacted receipt renderedDigest', { nullable: true });
  if (receipt.projectionStatus === 'clean'
    && (!states.desired || states.desired !== states.projected || states.projected !== states.installed)) {
    throw new Error('clean projection requires matching desired, projected, and installed generations');
  }
  if (receipt.loadStatus === 'loaded' && (!states.installed || states.loaded !== states.installed || renderedDigest === null)) {
    throw new Error('loaded state requires matching installed and loaded generations plus a rendered digest');
  }
  if (receipt.parityStatus === 'equivalent') {
    const generations = Object.values(states);
    if (receipt.projectionStatus !== 'clean' || receipt.loadStatus !== 'loaded' || observedPrecedence.status !== 'proved'
      || generations.some((generation) => generation === null)
      || new Set(generations).size !== 1) {
      throw new Error('equivalent parity requires proved precedence and one desired, projected, installed, loaded, and parity generation');
    }
  }
  return {
    schemaVersion: REDACTED_RECEIPT_SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    harness: receipt.harness,
    adapterVersion: receipt.adapterVersion,
    harnessVersion: receipt.harnessVersion,
    catalogGeneration: exactDigest(receipt.catalogGeneration, 'redacted receipt catalogGeneration'),
    renderedDigest,
    targetIdentity: { kind: 'digest', digest: exactDigest(targetIdentity.digest, 'redacted receipt targetIdentity.digest') },
    observedPrecedence: { status: observedPrecedence.status, digest: normalizedPrecedenceDigest },
    states,
    projectionStatus: receipt.projectionStatus,
    loadStatus: receipt.loadStatus,
    parityStatus: receipt.parityStatus,
    checkedAt: timestamp(receipt.checkedAt, 'redacted receipt checkedAt'),
  };
}

function validateRedactedRoleReceipt(value) {
  normalizeRedactedRoleReceipt(value);
  return true;
}

function validateInstructionProjectionAdapter(value) {
  const adapter = assertObject(value, 'instruction projection adapter');
  assertExactKeys(adapter, ['version', 'status', 'loader', 'supportedVersions', 'precedence', 'reason'], 'instruction projection adapter');
  if (adapter.version !== ADAPTER_CONTRACT_VERSION) throw new Error('instruction projection adapter version is invalid');
  if (!ADAPTER_STATES.includes(adapter.status)) throw new Error('instruction projection adapter status is invalid');
  if (adapter.status !== 'supported') {
    if (adapter.loader !== null || adapter.supportedVersions !== null || adapter.precedence !== null) {
      throw new Error('non-supported instruction projection adapters must not claim loader facts');
    }
    if (typeof adapter.reason !== 'string' || !adapter.reason.trim() || adapter.reason.length > 500) {
      throw new Error('non-supported instruction projection adapters require a bounded reason');
    }
    return true;
  }
  if (typeof adapter.loader !== 'string' || !adapter.loader.trim()) throw new Error('supported instruction projection adapter loader is required');
  if (typeof adapter.supportedVersions !== 'string' || !adapter.supportedVersions.trim()) throw new Error('supported instruction projection adapter supportedVersions is required');
  if (!Array.isArray(adapter.precedence) || adapter.precedence.length === 0 || adapter.precedence.some((scope) => typeof scope !== 'string' || !scope.trim())) {
    throw new Error('supported instruction projection adapter precedence is required');
  }
  if (adapter.reason !== null) throw new Error('supported instruction projection adapter reason must be null');
  return true;
}

module.exports = {
  ROLE_CATALOG_SCHEMA_VERSION,
  REDACTED_RECEIPT_SCHEMA_VERSION,
  ADAPTER_CONTRACT_VERSION,
  CONTRACT_VERSION,
  HARNESSES,
  DISPOSITIONS,
  PROJECTION_STATES,
  LOAD_STATES,
  PARITY_STATES,
  ADAPTER_STATES,
  ROLE_DEFINITIONS,
  ROLE_IDS,
  normalizeRoleCatalog,
  validateRoleCatalog,
  roleCatalogDigest,
  normalizeRedactedRoleReceipt,
  validateRedactedRoleReceipt,
  validateInstructionProjectionAdapter,
};
