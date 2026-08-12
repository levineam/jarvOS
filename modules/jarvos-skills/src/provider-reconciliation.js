'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANAGED_PROVIDER_SCHEMA_VERSION = 'jarvos-managed-provider-reconciliation/v1';
const MANAGED_PROVIDER_STATE_VERSION = 'jarvos-managed-provider-state/v1';
const MANAGED_PROVIDER_REVIEW_VERSION = 'jarvos-managed-provider-review/v1';
const MANAGED_PROVIDER_TARGET_KINDS = Object.freeze(['cache', 'harness', 'discovery']);
const SHA256 = /^[a-f0-9]{64}$/i;
const REVISION = /^[a-f0-9]{40}$/i;
const SAFE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const SAFE_RELATIVE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return sha256(typeof value === 'string' ? value : canonicalJson(value));
}

function assertSafeOwnedDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
  return fs.realpathSync(directory);
}

function ensureOwnerOnlyDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const real = assertSafeOwnedDirectory(directory, label);
  fs.chmodSync(real, 0o700);
  return real;
}

function assertSafePathBelow(root, target, label = 'path') {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`${label} escapes its root`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    if (stat.isDirectory()) assertSafeOwnedDirectory(current, `${label} directory`);
  }
  return target;
}

function validateManagedProviderManifest(manifest = {}) {
  const errors = [];
  if (!isObject(manifest)) return { ok: false, errors: ['managed provider manifest must be an object'] };
  if (manifest.schemaVersion !== 'jarvos-managed-workflow-provider/v1') errors.push('provider manifest schemaVersion is invalid');
  if (typeof manifest.id !== 'string' || !SAFE_ID.test(manifest.id)) errors.push('provider manifest id is invalid');
  if (typeof manifest.version !== 'string' || manifest.version.length > 64 || /\s/.test(manifest.version)) errors.push('provider manifest version is invalid');
  if (!isObject(manifest.source)) errors.push('provider manifest source is required');
  else {
    if (typeof manifest.source.repository !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(manifest.source.repository)) errors.push('provider manifest source repository is invalid');
    if (typeof manifest.source.revision !== 'string' || !REVISION.test(manifest.source.revision)) errors.push('provider manifest source revision must be immutable');
    if (typeof manifest.source.contentDigest !== 'string' || !SHA256.test(manifest.source.contentDigest)) errors.push('provider manifest source contentDigest must be SHA-256');
    if (manifest.source.license !== 'MIT') errors.push('provider manifest source license must be MIT');
  }
  if (!Array.isArray(manifest.operations) || !manifest.operations.includes('plan') || !manifest.operations.includes('work') || !manifest.operations.includes('compound')) errors.push('provider manifest operations are incomplete');
  if (!isObject(manifest.harnesses)) errors.push('provider manifest harnesses are required');
  return { ok: errors.length === 0, errors };
}

function readJsonIfPresent(filePath, label) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isObject(parsed)) throw new Error('must be an object');
    return parsed;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function atomicWriteJson(filePath, value) {
  const requestedPath = path.resolve(filePath);
  const directory = ensureOwnerOnlyDirectory(path.dirname(requestedPath), 'provider state/config parent');
  const safePath = assertSafePathBelow(directory, path.join(directory, path.basename(requestedPath)), 'provider state/config path');
  const temporary = path.join(directory, `.${path.basename(safePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, safePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function normalizeEntries(root, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('provider staging entries are required');
  const seen = new Set();
  return entries.map((entry) => {
    if (!isObject(entry) || typeof entry.path !== 'string' || !SAFE_RELATIVE_PATH.test(entry.path)) throw new Error('provider staging entry path is unsafe');
    if (!SHA256.test(entry.digest || '')) throw new Error(`provider staging entry ${entry.path} digest is invalid`);
    if (seen.has(entry.path)) throw new Error(`duplicate provider staging entry: ${entry.path}`);
    seen.add(entry.path);
    const source = path.resolve(root, entry.path);
    assertSafePathBelow(root, source, 'provider staging source');
    return { path: entry.path, digest: entry.digest.toLowerCase(), source };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function computeProviderTreeDigest(root, entries) {
  const normalized = normalizeEntries(root, entries);
  return digest(normalized.map((entry) => `${entry.path}\0${entry.digest}`).join('\n'));
}

function stageManagedProvider(options = {}) {
  const validation = validateManagedProviderManifest(options.manifest);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (typeof options.sourceRoot !== 'string' || typeof options.stagingRoot !== 'string') throw new Error('sourceRoot and stagingRoot are required');
  const sourceRoot = assertSafeOwnedDirectory(path.resolve(options.sourceRoot), 'provider sourceRoot');
  const stagingRoot = ensureOwnerOnlyDirectory(path.resolve(options.stagingRoot), 'provider stagingRoot');
  const entries = normalizeEntries(sourceRoot, options.entries);
  const treeDigest = computeProviderTreeDigest(sourceRoot, entries);
  if (options.expectedTreeDigest && options.expectedTreeDigest !== treeDigest) throw new Error('provider tree digest does not match the approved fixture');
  if (options.artifactDigest !== options.manifest.source.contentDigest) throw new Error('provider artifact digest does not match the approved pin');
  const stagePath = fs.mkdtempSync(path.join(stagingRoot, 'jarvos-provider-'));
  fs.chmodSync(stagePath, 0o700);
  try {
    for (const entry of entries) {
      const stat = fs.lstatSync(entry.source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`provider staging entry is not a regular file: ${entry.path}`);
      if ((stat.mode & 0o111) !== 0) throw new Error(`provider staging entry must not be executable: ${entry.path}`);
      const content = fs.readFileSync(entry.source);
      if (sha256(content) !== entry.digest) throw new Error(`provider staging entry digest mismatch: ${entry.path}`);
      const target = path.resolve(stagePath, entry.path);
      assertSafePathBelow(stagePath, target, 'provider staging target');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    fs.rmSync(stagePath, { recursive: true, force: true });
    throw error;
  }
  return {
    schemaVersion: MANAGED_PROVIDER_SCHEMA_VERSION,
    providerId: options.manifest.id,
    version: options.manifest.version,
    revision: options.manifest.source.revision,
    artifactDigest: options.artifactDigest,
    treeDigest,
    entries: entries.map(({ path: entryPath, digest: entryDigest }) => ({ path: entryPath, digest: entryDigest })),
    stagePath,
  };
}

function providerEntry(config, providerId) {
  return config?.plugins?.entries?.[providerId] || null;
}

function targetDigest(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('provider harness target must be a regular file');
  return sha256(fs.readFileSync(targetPath));
}

function providerTargetStatus({ config, state, manifest, targetPath, harnessStatus }) {
  if (harnessStatus === 'unsupported' || harnessStatus === 'disabled') return 'unsupported';
  const entry = providerEntry(config, manifest.id);
  if (!entry) return 'not-installed';
  if (entry.jarvosManaged !== true) return 'unknown';
  if (!state || state.providerId !== manifest.id || !SHA256.test(state.targetDigest || '')) return 'conflict';
  const observed = targetDigest(targetPath);
  if (observed !== state.targetDigest) return 'local-modified';
  if (entry.version !== manifest.version || entry.pinDigest !== manifest.source.contentDigest || entry.enabled !== true) return 'outdated';
  return 'installed';
}

function planManagedProviderReconciliation(options = {}) {
  const validation = validateManagedProviderManifest(options.manifest);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (typeof options.harness !== 'string' || !isObject(options.harnessConfig)) throw new Error('harness and harnessConfig are required');
  if (typeof options.targetPath !== 'string' || !path.isAbsolute(options.targetPath)) throw new Error('targetPath must be absolute');
  const targetPath = path.resolve(options.targetPath);
  const observedConfig = readJsonIfPresent(targetPath, 'provider harness config');
  const harnessConfig = observedConfig || options.harnessConfig;
  const state = options.statePath ? readJsonIfPresent(options.statePath, 'provider state') : options.state || null;
  const harnessStatus = options.manifest.harnesses?.[options.harness]?.status || 'unsupported';
  const status = providerTargetStatus({ config: harnessConfig, state, manifest: options.manifest, targetPath, harnessStatus });
  const action = status === 'not-installed' || status === 'outdated' ? 'apply' : 'preserve';
  const configDigest = digest(harnessConfig);
  const generation = digest({
    schemaVersion: MANAGED_PROVIDER_SCHEMA_VERSION,
    providerId: options.manifest.id,
    manifestRevision: options.manifest.source.revision,
    manifestDigest: options.manifest.source.contentDigest,
    harness: options.harness,
    targetPath,
    configDigest,
    stateDigest: state ? digest(state) : null,
  });
  return {
    schemaVersion: MANAGED_PROVIDER_SCHEMA_VERSION,
    generation,
    provider: { id: options.manifest.id, version: options.manifest.version, pinDigest: options.manifest.source.contentDigest },
    harness: options.harness,
    harnessStatus,
    status,
    action,
    targetPath,
    statePath: options.statePath || null,
    configDigest,
    stateDigest: state ? digest(state) : null,
    approvedAge: options.approvedAt ? Math.max(0, Date.parse(options.now || new Date().toISOString()) - Date.parse(options.approvedAt)) : null,
  };
}

function assertPlanCurrent(plan, options) {
  const current = planManagedProviderReconciliation({
    manifest: options.manifest,
    harness: plan.harness,
    harnessConfig: options.harnessConfig,
    targetPath: plan.targetPath,
    statePath: plan.statePath,
    state: options.state,
  });
  if (current.generation !== plan.generation) throw new Error('provider reconciliation plan changed since planning');
  return current;
}

function managedEntry(manifest, harness, adapter) {
  return {
    jarvosManaged: true,
    providerId: manifest.id,
    version: manifest.version,
    pinDigest: manifest.source.contentDigest,
    revision: manifest.source.revision,
    harness,
    adapter: adapter || manifest.harnesses?.[harness]?.adapter || null,
    enabled: true,
  };
}

function applyManagedProviderReconciliation(plan, options = {}) {
  if (!isObject(plan) || plan.schemaVersion !== MANAGED_PROVIDER_SCHEMA_VERSION) throw new Error('provider reconciliation plan is invalid');
  if (!isObject(options.manifest) || !isObject(options.harnessConfig)) throw new Error('manifest and harnessConfig are required');
  const current = assertPlanCurrent(plan, options);
  if (current.action !== 'apply') return { ok: true, status: current.status, applied: false, provider: current.provider };
  if (current.harnessStatus !== 'supported') return { ok: false, status: 'unsupported', applied: false, provider: current.provider };
  const config = clone(readJsonIfPresent(plan.targetPath, 'provider harness config') || options.harnessConfig);
  config.plugins = isObject(config.plugins) ? config.plugins : {};
  config.plugins.entries = isObject(config.plugins.entries) ? config.plugins.entries : {};
  const previous = config.plugins.entries[options.manifest.id] || null;
  const entry = managedEntry(options.manifest, plan.harness, options.adapter);
  config.plugins.entries[options.manifest.id] = entry;
  atomicWriteJson(plan.targetPath, config);
  const targetDigestValue = sha256(fs.readFileSync(plan.targetPath));
  const state = {
    schemaVersion: MANAGED_PROVIDER_STATE_VERSION,
    providerId: options.manifest.id,
    version: options.manifest.version,
    pinDigest: options.manifest.source.contentDigest,
    revision: options.manifest.source.revision,
    harness: plan.harness,
    targetDigest: targetDigestValue,
    previousOwnedEntry: previous && previous.jarvosManaged === true ? previous : null,
    generation: plan.generation,
    active: true,
  };
  if (plan.statePath) atomicWriteJson(plan.statePath, state);
  return {
    ok: true,
    status: 'installed',
    applied: true,
    provider: { id: options.manifest.id, version: options.manifest.version, pinDigest: options.manifest.source.contentDigest },
    targetDigest: targetDigestValue,
    stateDigest: digest(state),
  };
}

function disableManagedProvider(options = {}) {
  if (!isObject(options.manifest) || !isObject(options.harnessConfig)) throw new Error('manifest and harnessConfig are required');
  if (typeof options.targetPath !== 'string' || !path.isAbsolute(options.targetPath)) throw new Error('targetPath must be absolute');
  const actualConfig = readJsonIfPresent(options.targetPath, 'provider harness config');
  if (!actualConfig) return { ok: true, status: 'not-installed', applied: false };
  const entry = providerEntry(actualConfig, options.manifest.id);
  if (!entry || entry.jarvosManaged !== true) return { ok: true, status: entry ? 'unknown' : 'not-installed', applied: false };
  const observed = targetDigest(options.targetPath);
  const state = options.statePath ? readJsonIfPresent(options.statePath, 'provider state') : options.state;
  if (!state || state.targetDigest !== observed) return { ok: false, status: 'local-modified', applied: false };
  const config = clone(actualConfig);
  delete config.plugins.entries[options.manifest.id];
  atomicWriteJson(options.targetPath, config);
  if (options.statePath) atomicWriteJson(options.statePath, { ...state, active: false, disabledAt: new Date().toISOString() });
  return { ok: true, status: 'disabled', applied: true, provider: { id: options.manifest.id, version: options.manifest.version, pinDigest: options.manifest.source.contentDigest } };
}

function discoverManagedProviderCandidate(options = {}) {
  const approvedValidation = validateManagedProviderManifest(options.approvedManifest);
  if (!approvedValidation.ok) throw new Error(approvedValidation.errors.join('; '));
  const candidateValidation = validateManagedProviderManifest(options.candidateManifest);
  if (!candidateValidation.ok) throw new Error(candidateValidation.errors.join('; '));
  if (options.candidateManifest.id !== options.approvedManifest.id) throw new Error('candidate provider id differs from approved provider');
  const now = options.now || new Date().toISOString();
  const candidate = options.candidateManifest;
  const changed = candidate.version !== options.approvedManifest.version || candidate.source.revision !== options.approvedManifest.source.revision || candidate.source.contentDigest !== options.approvedManifest.source.contentDigest;
  if (!changed) return { ok: true, status: 'no-candidate', candidate: null, review: null };
  const review = {
    version: MANAGED_PROVIDER_REVIEW_VERSION,
    reviewKey: `managed-provider:${candidate.id}`,
    providerId: candidate.id,
    approvedVersion: options.approvedManifest.version,
    approvedRevision: options.approvedManifest.source.revision,
    candidateVersion: candidate.version,
    candidateRevision: candidate.source.revision,
    candidateDigest: candidate.source.contentDigest,
    discoveredAt: now,
    status: 'candidate',
  };
  let persisted = review;
  if (options.reviewStore && typeof options.reviewStore.upsert === 'function') persisted = options.reviewStore.upsert(review.reviewKey, review) || review;
  return { ok: true, status: 'candidate', candidate: { id: candidate.id, version: candidate.version, revision: candidate.source.revision, pinDigest: candidate.source.contentDigest }, review: clone(persisted) };
}

function managedProviderHealth(plan = {}) {
  const status = plan.status;
  const doctor = status === 'installed' && plan.harnessStatus === 'supported' ? 'ok'
    : status === 'unsupported' ? 'skipped'
      : ['local-modified', 'unknown', 'conflict'].includes(status) ? 'warn' : 'warn';
  return { doctor, status, provider: plan.provider || null, action: plan.action || 'preserve' };
}

module.exports = {
  MANAGED_PROVIDER_REVIEW_VERSION,
  MANAGED_PROVIDER_SCHEMA_VERSION,
  MANAGED_PROVIDER_STATE_VERSION,
  MANAGED_PROVIDER_TARGET_KINDS,
  applyManagedProviderReconciliation,
  computeProviderTreeDigest,
  discoverManagedProviderCandidate,
  disableManagedProvider,
  managedProviderHealth,
  planManagedProviderReconciliation,
  stageManagedProvider,
  validateManagedProviderManifest,
};
