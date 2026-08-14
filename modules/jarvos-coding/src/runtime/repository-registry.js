'use strict';

// The registry is deliberately a host-owned file.  Nothing that crosses the
// coding-tool boundary (paths, executables, credentials, or provider names)
// is used to construct this authority.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_REGISTRY_SCHEMA_VERSION = 'jarvos-coding-repository-registry/v1';
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ABSOLUTE_PATH = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/;
const SAFE_LABEL = /^[^\0\r\n]{1,160}$/;
const SECRET = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const ACCEPTANCE_MODES = new Set(['human-evidence-required', 'agent-mediated-allowed']);

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function assertNoSecret(value, label = 'registry') {
  if (typeof value === 'string' && SECRET.test(value)) throw new Error(`${label} must not contain a secret value`);
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoSecret(entry, `${label}[${index}]`));
  if (isObject(value)) Object.entries(value).forEach(([key, entry]) => assertNoSecret(entry, `${label}.${key}`));
}
function canonical(input, label) {
  if (typeof input !== 'string' || !ABSOLUTE_PATH.test(input) || input.includes('\0')) throw new Error(`${label} must be an absolute path`);
  let resolved;
  try { resolved = fs.realpathSync(input); } catch { throw new Error(`${label} must exist and resolve canonically`); }
  return resolved;
}
function inside(parent, child) { return child === parent || child.startsWith(`${parent}${path.sep}`); }
function deriveRepositoryId(entry) {
  const identity = `${entry.publicLabel || entry.label || ''}\0${entry.root || entry.repositoryRoot || ''}`;
  return `repo_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}
function publicRepository(entry) {
  return { repositoryId: entry.repositoryId, label: entry.publicLabel, agentSelectable: entry.agentSelectable };
}
function normalizeEntry(raw) {
  if (!isObject(raw)) throw new Error('repository entry must be an object');
  const allowed = new Set(['repositoryId', 'id', 'publicLabel', 'agentSelectable', 'root', 'repositoryRoot', 'stateRoot', 'tracker', 'worktreePolicy', 'acceptancePolicy', 'providerEgressPolicy', 'credentialReferences', 'learning', 'learningPublicationTarget']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`repository entry.${key} is not allowed`);
  assertNoSecret(raw);
  const root = canonical(raw.root || raw.repositoryRoot, 'repository root');
  const stateRoot = canonical(raw.stateRoot, 'repository stateRoot');
  const repositoryId = raw.repositoryId || raw.id || deriveRepositoryId({ ...raw, root });
  if (!OPAQUE_ID.test(repositoryId)) throw new Error('repositoryId must be an opaque identifier');
  if (typeof raw.publicLabel !== 'string' || !SAFE_LABEL.test(raw.publicLabel) || SECRET.test(raw.publicLabel) || ABSOLUTE_PATH.test(raw.publicLabel)) throw new Error('repository publicLabel must be public-safe text');
  if (typeof raw.agentSelectable !== 'boolean') throw new Error('repository agentSelectable must be boolean');
  if (!isObject(raw.worktreePolicy)) throw new Error('repository worktreePolicy is required');
  const worktreeRoot = canonical(raw.worktreePolicy.root || raw.worktreePolicy.worktreeRoot, 'repository worktreePolicy.root');
  if (inside(root, stateRoot) || inside(root, worktreeRoot) || inside(stateRoot, root) || inside(worktreeRoot, root) || inside(stateRoot, worktreeRoot) || inside(worktreeRoot, stateRoot)) throw new Error('repository roots must not overlap');
  const acceptancePolicy = raw.acceptancePolicy || { mode: 'human-evidence-required' };
  if (!isObject(acceptancePolicy) || !ACCEPTANCE_MODES.has(acceptancePolicy.mode)) throw new Error('repository acceptancePolicy.mode is invalid');
  if (acceptancePolicy.evidenceFreshnessMs !== undefined && (!Number.isInteger(acceptancePolicy.evidenceFreshnessMs) || acceptancePolicy.evidenceFreshnessMs < 0)) throw new Error('repository acceptancePolicy.evidenceFreshnessMs is invalid');
  if (raw.providerEgressPolicy !== undefined && !isObject(raw.providerEgressPolicy)) throw new Error('repository providerEgressPolicy must be an object');
  if (raw.tracker !== undefined && !isObject(raw.tracker)) throw new Error('repository tracker must be an object');
  if (raw.credentialReferences !== undefined && !isObject(raw.credentialReferences)) throw new Error('repository credentialReferences must be an object');
  return Object.freeze({
    repositoryId, publicLabel: raw.publicLabel, agentSelectable: raw.agentSelectable,
    root, stateRoot, tracker: raw.tracker || {},
    worktreePolicy: Object.freeze({ ...raw.worktreePolicy, root: worktreeRoot }),
    acceptancePolicy: Object.freeze({ ...acceptancePolicy }), providerEgressPolicy: Object.freeze({ ...(raw.providerEgressPolicy || {}) }),
    credentialReferences: Object.freeze({ ...(raw.credentialReferences || {}) }),
    learning: Object.freeze({ ...(raw.learning || {}) }), learningPublicationTarget: raw.learningPublicationTarget || null,
  });
}
function validateRepositoryRegistry(registry) {
  const errors = [];
  if (!isObject(registry)) return { ok: false, errors: ['registry must be an object'] };
  for (const key of Object.keys(registry)) if (!new Set(['schemaVersion', 'generation', 'repositories']).has(key)) errors.push(`registry.${key} is not allowed`);
  if (registry.schemaVersion !== REPOSITORY_REGISTRY_SCHEMA_VERSION) errors.push(`registry.schemaVersion must be ${REPOSITORY_REGISTRY_SCHEMA_VERSION}`);
  if (!Number.isInteger(registry.generation) || registry.generation < 1) errors.push('registry.generation must be a positive integer');
  if (!Array.isArray(registry.repositories)) errors.push('registry.repositories must be an array');
  const entries = [];
  for (const raw of registry.repositories || []) { try { entries.push(normalizeEntry(raw)); } catch (error) { errors.push(error.message); } }
  const ids = new Set();
  for (const entry of entries) { if (ids.has(entry.repositoryId)) errors.push(`duplicate repositoryId ${entry.repositoryId}`); ids.add(entry.repositoryId); }
  return { ok: errors.length === 0, errors, entries };
}
function loadRepositoryRegistry(registryPath, options = {}) {
  if (typeof registryPath !== 'string' || !ABSOLUTE_PATH.test(registryPath)) throw new Error('registryPath must be an absolute host-bound path');
  const resolvedPath = canonical(registryPath, 'registryPath');
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error('registryPath must be a file');
  if ((stat.mode & 0o077) !== 0) throw new Error('registryPath permissions must not grant group or other access');
  if (options.ownerUid !== undefined && stat.uid !== options.ownerUid) throw new Error('registryPath is not owned by the expected owner');
  let parsed; try { parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')); } catch (error) { throw new Error(`registryPath contains invalid JSON: ${error.message}`); }
  const validation = validateRepositoryRegistry(parsed);
  if (!validation.ok) throw new Error(`invalid repository registry: ${validation.errors.join('; ')}`);
  const byId = new Map(validation.entries.map((entry) => [entry.repositoryId, entry]));
  return Object.freeze({ schemaVersion: REPOSITORY_REGISTRY_SCHEMA_VERSION, generation: parsed.generation, path: resolvedPath, repositories: validation.entries, resolve(repositoryId) {
    if (!OPAQUE_ID.test(repositoryId || '')) throw new Error('repositoryId must be an opaque identifier');
    const entry = byId.get(repositoryId); if (!entry) throw new Error('unknown repository'); return entry;
  }, listPublic() { return validation.entries.filter((entry) => entry.agentSelectable).map(publicRepository); } });
}

module.exports = { REPOSITORY_REGISTRY_SCHEMA_VERSION, deriveRepositoryId, loadRepositoryRegistry, publicRepository, validateRepositoryRegistry };
