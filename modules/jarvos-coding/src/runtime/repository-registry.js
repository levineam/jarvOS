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
const OWNER_ACTIONS_SCHEMA_VERSION = 'jarvos-coding-owner-actions/v1';

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

function assertOwner(stat, label, ownerUid = process.getuid?.()) {
  if (ownerUid !== undefined && stat.uid !== ownerUid) throw new Error(`${label} is not owned by the current owner`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must not grant group or other access`);
}
function requireProvisioningPath(value, label) {
  if (typeof value !== 'string' || !ABSOLUTE_PATH.test(value) || value.includes('\0')) throw new Error(`${label} is required and must be an absolute path`);
  return path.resolve(value);
}
function assertNotSymlink(value, label, required = true) {
  if (!fs.existsSync(value)) {
    if (required) throw new Error(`${label} must exist`);
    return;
  }
  if (fs.lstatSync(value).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
}
function ensureOwnedDirectory(value, label, options = {}) {
  const absolute = requireProvisioningPath(value, label);
  assertNotSymlink(absolute, label, false);
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  assertOwner(stat, label, options.ownerUid);
  fs.chmodSync(absolute, 0o700);
  return fs.realpathSync(absolute);
}
function assertExistingOwnedDirectory(value, label, options = {}) {
  const absolute = requireProvisioningPath(value, label);
  assertNotSymlink(absolute, label);
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (options.private !== false) assertOwner(stat, label, options.ownerUid);
  else if (options.ownerUid !== undefined && stat.uid !== options.ownerUid) throw new Error(`${label} is not owned by the current owner`);
  return fs.realpathSync(absolute);
}
function atomicWriteJson(filePath, data, options = {}) {
  const parent = path.dirname(filePath);
  assertExistingOwnedDirectory(parent, 'registry parent directory', options);
  const temporary = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function requireProvisioningPolicies(raw) {
  for (const key of ['tracker', 'worktreePolicy', 'acceptancePolicy', 'providerEgressPolicy', 'credentialReferences', 'learning']) {
    if (!isObject(raw[key])) throw new Error(`repository ${key} is required`);
  }
  if (typeof raw.learningPublicationTarget !== 'string' || !raw.learningPublicationTarget.trim()) throw new Error('repository learningPublicationTarget is required');
}
function preparedEntry(raw, options = {}) {
  if (!isObject(raw)) throw new Error('repository entry must be an object');
  requireProvisioningPolicies(raw);
  const root = assertExistingOwnedDirectory(raw.root || raw.repositoryRoot, 'repository root', { ...options, private: false });
  const stateRoot = ensureOwnedDirectory(raw.stateRoot, 'repository stateRoot', options);
  const worktreeRoot = ensureOwnedDirectory(raw.worktreePolicy.root || raw.worktreePolicy.worktreeRoot, 'repository worktreePolicy.root', options);
  if (inside(root, stateRoot) || inside(root, worktreeRoot) || inside(stateRoot, root) || inside(worktreeRoot, root) || inside(stateRoot, worktreeRoot) || inside(worktreeRoot, stateRoot)) throw new Error('repository roots must not overlap');
  return normalizeEntry({ ...raw, root, stateRoot, worktreePolicy: { ...raw.worktreePolicy, root: worktreeRoot } });
}
function registryTarget(registryPath, options = {}) {
  const target = requireProvisioningPath(registryPath, 'registryPath');
  assertNotSymlink(target, 'registryPath', false);
  assertExistingOwnedDirectory(path.dirname(target), 'registry parent directory', options);
  if (fs.existsSync(target)) assertOwner(fs.statSync(target), 'registryPath', options.ownerUid);
  return target;
}
function readProvisionedRegistry(registryPath, options = {}) {
  const target = registryTarget(registryPath, options);
  if (!fs.existsSync(target)) return { schemaVersion: REPOSITORY_REGISTRY_SCHEMA_VERSION, generation: 0, repositories: [] };
  const loaded = loadRepositoryRegistry(target, options);
  return { schemaVersion: loaded.schemaVersion, generation: loaded.generation, repositories: loaded.repositories };
}
function receiptFor(registry, action, repository) {
  return Object.freeze({ schemaVersion: 'jarvos-coding-repository-provisioning-receipt/v1', action, generation: registry.generation, repository: repository ? publicRepository(repository) : null, repositoryCount: registry.repositories.length });
}
function writeProvisionedRegistry(registryPath, registry, action, repository, options = {}) {
  const target = registryTarget(registryPath, options);
  const validation = validateRepositoryRegistry(registry);
  if (!validation.ok) throw new Error(`invalid repository registry: ${validation.errors.join('; ')}`);
  atomicWriteJson(target, registry, options);
  const receipt = receiptFor(registry, action, repository);
  atomicWriteJson(`${target}.receipt.json`, receipt, options);
  return receipt;
}
function provisionRepository({ registryPath, repository, ownerUid } = {}) {
  const existing = readProvisionedRegistry(registryPath, { ownerUid });
  const entry = preparedEntry(repository, { ownerUid });
  if (existing.repositories.some((item) => item.repositoryId === entry.repositoryId)) throw new Error('repositoryId is already provisioned; use update');
  return writeProvisionedRegistry(registryPath, { schemaVersion: REPOSITORY_REGISTRY_SCHEMA_VERSION, generation: existing.generation + 1, repositories: [...existing.repositories, entry] }, 'added', entry, { ownerUid });
}
function inspectProvisionedRepositories({ registryPath, ownerUid } = {}) {
  const existing = readProvisionedRegistry(registryPath, { ownerUid });
  return Object.freeze({ schemaVersion: 'jarvos-coding-repository-provisioning-inspection/v1', generation: existing.generation, repositories: existing.repositories.map(publicRepository) });
}
function updateProvisionedRepository({ registryPath, repositoryId, repository, ownerUid } = {}) {
  const existing = readProvisionedRegistry(registryPath, { ownerUid });
  const current = existing.repositories.find((item) => item.repositoryId === repositoryId);
  if (!current) throw new Error('unknown repository');
  const entry = preparedEntry({ ...repository, repositoryId: current.repositoryId }, { ownerUid });
  const repositories = existing.repositories.map((item) => item.repositoryId === repositoryId ? entry : item);
  return writeProvisionedRegistry(registryPath, { schemaVersion: REPOSITORY_REGISTRY_SCHEMA_VERSION, generation: existing.generation + 1, repositories }, 'updated', entry, { ownerUid });
}
function revokeProvisionedRepository({ registryPath, repositoryId, ownerUid } = {}) {
  const existing = readProvisionedRegistry(registryPath, { ownerUid });
  const current = existing.repositories.find((item) => item.repositoryId === repositoryId);
  if (!current) throw new Error('unknown repository');
  return writeProvisionedRegistry(registryPath, { schemaVersion: REPOSITORY_REGISTRY_SCHEMA_VERSION, generation: existing.generation + 1, repositories: existing.repositories.filter((item) => item.repositoryId !== repositoryId) }, 'revoked', current, { ownerUid });
}
function recordOwnerAction({ registryPath, repositoryId, action, runId, revision, ownerUid, now = new Date() } = {}) {
  if (!new Set(['accept-plan', 'decline-learning', 'reset-learning-retry']).has(action)) throw new Error('owner action is invalid');
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(runId)) throw new Error('runId is required and must be an opaque identifier');
  if (action === 'accept-plan' && (typeof revision !== 'string' || !revision.trim() || revision.length > 512)) throw new Error('revision is required for accept-plan');
  const loaded = loadRepositoryRegistry(registryTarget(registryPath, { ownerUid }), { ownerUid });
  const repository = loaded.resolve(repositoryId);
  const actionsPath = path.join(repository.stateRoot, 'owner-actions.json');
  let actions = { schemaVersion: OWNER_ACTIONS_SCHEMA_VERSION, generation: loaded.generation, actions: [] };
  if (fs.existsSync(actionsPath)) {
    assertOwner(fs.statSync(actionsPath), 'owner action record', ownerUid);
    actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    if (!isObject(actions) || actions.schemaVersion !== OWNER_ACTIONS_SCHEMA_VERSION || !Array.isArray(actions.actions)) throw new Error('owner action record is invalid');
  }
  const record = { action, repositoryId: repository.repositoryId, runId, generation: loaded.generation, observedAt: now.toISOString() };
  if (revision) record.revision = revision;
  atomicWriteJson(actionsPath, { schemaVersion: OWNER_ACTIONS_SCHEMA_VERSION, generation: loaded.generation, actions: [...actions.actions.filter((item) => !(item.action === action && item.runId === runId)), record] }, { ownerUid });
  return Object.freeze({ schemaVersion: 'jarvos-coding-owner-action-receipt/v1', action, repository: publicRepository(repository), runId, ...(revision ? { revision } : {}) });
}

module.exports = { REPOSITORY_REGISTRY_SCHEMA_VERSION, OWNER_ACTIONS_SCHEMA_VERSION, deriveRepositoryId, loadRepositoryRegistry, publicRepository, validateRepositoryRegistry, provisionRepository, inspectProvisionedRepositories, updateProvisionedRepository, revokeProvisionedRepository, recordOwnerAction };
