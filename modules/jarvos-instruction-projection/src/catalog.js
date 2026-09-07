'use strict';

const crypto = require('node:crypto');

const { normalizeRoleCatalog, roleCatalogDigest, ROLE_DEFINITIONS, ROLE_IDS } = require('./contracts');

const CATALOG_NORMALIZATION_VERSION = 'jarvos-instruction-projection-catalog/v1';
const CONTENT_BUNDLE_SCHEMA_VERSION = 'jarvos.instruction-content-bundle/v1';

const STATIC_ROLE_IDS = Object.freeze(ROLE_IDS.filter((role) => ROLE_DEFINITIONS[role].sourceClass !== 'dynamic-service'));
const DYNAMIC_ROLE_IDS = Object.freeze(ROLE_IDS.filter((role) => ROLE_DEFINITIONS[role].sourceClass === 'dynamic-service'));

const ID_RE = /^[a-z][a-z0-9-]{0,79}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function canonicalId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new Error(`${label} must be a canonical id`);
  return value;
}

function assertExactKeySet(value, allowed, label) {
  const providedKeys = Object.keys(value);
  const allowedSet = new Set(allowed);
  const providedSet = new Set(providedKeys);
  const unknown = providedKeys.filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !providedSet.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported entries: ${unknown.join(', ')}`);
  if (missing.length) throw new Error(`${label} is missing required entries: ${missing.join(', ')}`);
}

function normalizeBody(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function stableDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function normalizeContentBundle(rawCatalog, rawBundle) {
  const catalog = normalizeRoleCatalog(rawCatalog);
  const label = 'content bundle';
  assertObject(rawBundle, label);

  for (const key of Object.keys(rawBundle)) canonicalId(key, `${label} role id`);

  for (const dynamicRole of DYNAMIC_ROLE_IDS) {
    if (Object.hasOwn(rawBundle, dynamicRole)) {
      throw new Error(`${label} must not include static content for dynamic-memory role ${dynamicRole}`);
    }
  }

  const catalogRoleIds = catalog.roles.map((role) => role.role);
  const requiredRoleIds = STATIC_ROLE_IDS.filter((role) => catalogRoleIds.includes(role));
  assertExactKeySet(rawBundle, requiredRoleIds, label);

  const content = {};
  for (const role of catalog.roles) {
    if (!STATIC_ROLE_IDS.includes(role.role)) continue;
    const roleLabel = `${label}.${role.role}`;
    const roleBundle = assertObject(rawBundle[role.role], roleLabel);
    for (const key of Object.keys(roleBundle)) canonicalId(key, `${roleLabel} directive id`);
    const directiveIds = role.directives.map((directive) => directive.id);
    assertExactKeySet(roleBundle, directiveIds, roleLabel);
    const directives = {};
    for (const directiveId of directiveIds) {
      directives[directiveId] = normalizeBody(roleBundle[directiveId], `${roleLabel}.${directiveId}`);
    }
    content[role.role] = directives;
  }

  const catalogGeneration = stableDigest({
    schemaVersion: CATALOG_NORMALIZATION_VERSION,
    catalogDigest: roleCatalogDigest(catalog),
    content,
  });

  return { catalog, content, catalogGeneration };
}

module.exports = {
  CATALOG_NORMALIZATION_VERSION,
  CONTENT_BUNDLE_SCHEMA_VERSION,
  STATIC_ROLE_IDS,
  DYNAMIC_ROLE_IDS,
  stableDigest,
  normalizeContentBundle,
};
