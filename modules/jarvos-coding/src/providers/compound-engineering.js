'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_SCHEMA_VERSION = 'jarvos-managed-workflow-provider/v1';
const WORKFLOW_PROVIDER_CONTRACT_VERSION = 'jarvos-workflow-provider/v1';
const CANONICAL_REPOSITORY = 'https://github.com/EveryInc/compound-engineering-plugin.git';
const REQUIRED_HARNESSES = ['codex', 'claude-code', 'openclaw', 'hermes'];
const OPERATIONS = ['plan', 'work', 'compound'];
const SHA256 = /^[a-f0-9]{64}$/i;
const REVISION = /^[a-f0-9]{40}$/i;
const VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HARNESS = /^[a-z][a-z0-9-]{1,31}$/;
const ADAPTER = /^[a-z][a-z0-9-]{1,47}\.v\d+$/;
const SAFE_EVIDENCE = /^[^\0\r\n]{1,500}$/;
const ALLOWED_ROOT_FIELDS = new Set(['schemaVersion', 'id', 'version', 'contractVersion', 'source', 'review', 'operations', 'harnesses']);
const ALLOWED_SOURCE_FIELDS = new Set(['repository', 'revision', 'contentDigest', 'license', 'capabilityRecord']);
const ALLOWED_REVIEW_FIELDS = new Set(['status', 'reviewedAt', 'reviewEvidence']);
const ALLOWED_HARNESS_FIELDS = new Set(['status', 'adapter', 'capabilityRecord']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownFields(value, allowed, prefix, errors) {
  if (!isObject(value)) return;
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${prefix}.${field} is not allowed`);
  }
}

function validateCompoundEngineeringProviderManifest(manifest = {}) {
  const errors = [];
  if (!isObject(manifest)) return { ok: false, errors: ['provider manifest must be an object'] };
  unknownFields(manifest, ALLOWED_ROOT_FIELDS, 'manifest', errors);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) errors.push(`manifest.schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  if (manifest.id !== 'compound-engineering') errors.push('manifest.id must be compound-engineering');
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) errors.push('manifest.version must be a semantic version');
  if (manifest.contractVersion !== WORKFLOW_PROVIDER_CONTRACT_VERSION) errors.push(`manifest.contractVersion must be ${WORKFLOW_PROVIDER_CONTRACT_VERSION}`);

  if (!isObject(manifest.source)) {
    errors.push('manifest.source must be an object');
  } else {
    unknownFields(manifest.source, ALLOWED_SOURCE_FIELDS, 'manifest.source', errors);
    if (manifest.source.repository !== CANONICAL_REPOSITORY) errors.push(`manifest.source.repository must be ${CANONICAL_REPOSITORY}`);
    if (typeof manifest.source.revision !== 'string' || !REVISION.test(manifest.source.revision)) errors.push('manifest.source.revision must be an immutable 40-character commit');
    if (typeof manifest.source.contentDigest !== 'string' || !SHA256.test(manifest.source.contentDigest)) errors.push('manifest.source.contentDigest must be a SHA-256 digest');
    if (manifest.source.license !== 'MIT') errors.push('manifest.source.license must be MIT');
    if (typeof manifest.source.capabilityRecord !== 'string' || !/^runtimes\/[a-z0-9._-]+\/[^/]+\.json$/.test(manifest.source.capabilityRecord)) {
      errors.push('manifest.source.capabilityRecord must be a safe runtime-relative JSON path');
    }
  }

  if (!isObject(manifest.review)) {
    errors.push('manifest.review must be an object');
  } else {
    unknownFields(manifest.review, ALLOWED_REVIEW_FIELDS, 'manifest.review', errors);
    if (manifest.review.status !== 'approved') errors.push('manifest.review.status must be approved');
    if (typeof manifest.review.reviewedAt !== 'string' || !DATE.test(manifest.review.reviewedAt)) errors.push('manifest.review.reviewedAt must be YYYY-MM-DD');
    if (!Array.isArray(manifest.review.reviewEvidence) || manifest.review.reviewEvidence.length < 1 || manifest.review.reviewEvidence.length > 16) {
      errors.push('manifest.review.reviewEvidence must contain 1 to 16 entries');
    } else {
      manifest.review.reviewEvidence.forEach((entry, index) => {
        if (typeof entry !== 'string' || !SAFE_EVIDENCE.test(entry)) errors.push(`manifest.review.reviewEvidence[${index}] must be bounded text`);
      });
    }
  }

  if (!Array.isArray(manifest.operations) || manifest.operations.length !== OPERATIONS.length || manifest.operations.some((entry, index) => entry !== OPERATIONS[index])) {
    errors.push(`manifest.operations must be exactly ${OPERATIONS.join(', ')}`);
  }

  if (!isObject(manifest.harnesses)) {
    errors.push('manifest.harnesses must be an object');
  } else {
    const keys = Object.keys(manifest.harnesses).sort();
    const expected = [...REQUIRED_HARNESSES].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) errors.push(`manifest.harnesses must contain exactly ${REQUIRED_HARNESSES.join(', ')}`);
    for (const harnessName of REQUIRED_HARNESSES) {
      const entry = manifest.harnesses[harnessName];
      if (!isObject(entry)) {
        errors.push(`manifest.harnesses.${harnessName} must be an object`);
        continue;
      }
      unknownFields(entry, ALLOWED_HARNESS_FIELDS, `manifest.harnesses.${harnessName}`, errors);
      if (!HARNESS.test(harnessName)) errors.push(`manifest.harnesses.${harnessName} has an invalid harness name`);
      if (!['supported', 'unsupported', 'disabled'].includes(entry.status)) errors.push(`manifest.harnesses.${harnessName}.status is invalid`);
      if (typeof entry.adapter !== 'string' || !ADAPTER.test(entry.adapter)) errors.push(`manifest.harnesses.${harnessName}.adapter must be a versioned adapter identity`);
      if (entry.capabilityRecord !== undefined && (typeof entry.capabilityRecord !== 'string' || !/^runtimes\/[a-z0-9._-]+\/[^/]+\.json$/.test(entry.capabilityRecord))) {
        errors.push(`manifest.harnesses.${harnessName}.capabilityRecord must be a safe runtime-relative JSON path`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function loadCompoundEngineeringProviderManifest(manifestPath, options = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath) throw new Error('manifestPath is required');
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const resolved = path.resolve(manifestPath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootPrefix)) throw new Error('provider manifest must be inside the supplied root');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`unable to read provider manifest: ${error.message}`);
  }
  const validation = validateCompoundEngineeringProviderManifest(manifest);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return { manifest, path: resolved };
}

module.exports = {
  CANONICAL_REPOSITORY,
  MANIFEST_SCHEMA_VERSION,
  OPERATIONS,
  REQUIRED_HARNESSES,
  WORKFLOW_PROVIDER_CONTRACT_VERSION,
  loadCompoundEngineeringProviderManifest,
  validateCompoundEngineeringProviderManifest,
};
