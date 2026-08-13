'use strict';

// This boundary is intentionally host-owned: an agent can ask for Projects
// context, but it cannot choose a module, paths, capability, or secret.
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_ENV = 'JARVOS_PROJECTS_CONTEXT_CONFIG';

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function trusted(stat) {
  if ((stat.mode & 0o022) !== 0 && !(stat.isDirectory() && (stat.mode & 0o1000) !== 0)) return false;
  return stat.uid === 0 || (typeof process.getuid === 'function' && stat.uid === process.getuid());
}

function trustedAncestry(dir) {
  for (;;) {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory() || !trusted(stat)) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
}

function resolveAbsoluteFile(value, root, { ownerOnly = false } = {}) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  let real;
  try {
    if (fs.lstatSync(value).isSymbolicLink()) return null;
    real = fs.realpathSync(value);
    const stat = fs.statSync(real);
    if (!stat.isFile() || !trusted(stat) || (ownerOnly && (stat.mode & 0o077) !== 0)) return null;
    if (root && !inside(root, real)) return null;
    if (!trustedAncestry(path.dirname(real))) return null;
  } catch {
    return null;
  }
  return real;
}

function resolveTrustedDirectory(value, parent) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    if (fs.lstatSync(value).isSymbolicLink()) return null;
    const real = fs.realpathSync(value);
    const stat = fs.statSync(real);
    if (!stat.isDirectory() || !trusted(stat) || (parent && !inside(parent, real)) || !trustedAncestry(real)) return null;
    return real;
  } catch {
    return null;
  }
}

function readPrivate(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').replace(/\r?\n$/, ''); } catch { return null; }
}

function readPrivateJson(filePath) {
  const contents = readPrivate(filePath);
  if (contents === null) return null;
  try {
    const value = JSON.parse(contents);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function createHostProjectsContextProvider(env = process.env) {
  const configPath = env && env[CONFIG_ENV];
  if (typeof configPath !== 'string' || configPath.length === 0) return null;
  // The configuration is not itself a secret. Ownership, trusted ancestry,
  // and the absence of group/world write bits are the integrity boundary;
  // readable mode 0644 is valid when the containing host directory is trusted.
  const trustedConfig = resolveAbsoluteFile(configPath, null);
  if (!trustedConfig) return null;

  let config;
  try { config = JSON.parse(fs.readFileSync(trustedConfig, 'utf8')); } catch { return null; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;

  const workspaceRoot = resolveTrustedDirectory(config.workspaceRoot);
  const repositoryRoot = workspaceRoot && resolveTrustedDirectory(config.repositoryRoot, workspaceRoot);
  const stateRoot = workspaceRoot && resolveTrustedDirectory(config.stateRoot, workspaceRoot);
  if (!workspaceRoot || !repositoryRoot || !stateRoot) return null;
  // The provider is a host-owned adapter. It may live beside the repository
  // (as the private clawd provider does), but never outside the host workspace.
  const providerModule = resolveAbsoluteFile(config.providerModule, workspaceRoot);
  // The current host contract passes protected state directories and private
  // file contents. The short names remain a bounded compatibility alias for
  // older host configs, never model-supplied input.
  const registryStateDir = config.registryStateDir === undefined ? null : resolveTrustedDirectory(config.registryStateDir, stateRoot);
  const projectionStateDir = config.projectionStateDir === undefined ? null : resolveTrustedDirectory(config.projectionStateDir, stateRoot);
  const releaseProviderStateDir = config.releaseProviderStateDir === undefined ? null : resolveTrustedDirectory(config.releaseProviderStateDir, stateRoot);
  const registry = config.registryStateDir === undefined ? resolveAbsoluteFile(config.registry, stateRoot) : null;
  const projection = config.projectionStateDir === undefined && config.releaseProviderStateDir === undefined
    ? resolveAbsoluteFile(config.projection, stateRoot)
    : null;
  const capabilityReceiptValue = config.capabilityReceiptPath === undefined ? null : config.capabilityReceiptPath;
  const capabilitySecretValue = config.capabilitySecret === undefined ? config.capability : config.capabilitySecret;
  const hostSecretValue = config.hostSecretFile === undefined
    ? (config.hostSecret === undefined ? config.secret : config.hostSecret)
    : config.hostSecretFile;
  const capabilityReceiptPath = capabilityReceiptValue === null
    ? null
    : resolveAbsoluteFile(capabilityReceiptValue, stateRoot, { ownerOnly: true });
  const capabilitySecretPath = capabilitySecretValue === undefined
    ? null
    : resolveAbsoluteFile(capabilitySecretValue, stateRoot, { ownerOnly: true });
  const hostSecretPath = hostSecretValue === undefined
    ? null
    : resolveAbsoluteFile(hostSecretValue, stateRoot, { ownerOnly: true });
  if (!providerModule || (!registryStateDir && !registry) || (!releaseProviderStateDir && !projection && !projectionStateDir)
    || (capabilityReceiptValue !== null && !capabilityReceiptPath)
    || (capabilitySecretValue !== undefined && !capabilitySecretPath)
    || (hostSecretValue !== undefined && !hostSecretPath)) return null;

  let provider;
  try { provider = require(providerModule); } catch { return null; }
  if (!provider || typeof provider.read !== 'function') return null;

  return {
    defaultQuery: config.query && typeof config.query === 'object' && !Array.isArray(config.query)
      ? JSON.parse(JSON.stringify(config.query))
      : null,
    async read(request) {
      // Values from the host binding win over all model-visible request keys.
      const capabilityReceipt = capabilityReceiptPath ? readPrivateJson(capabilityReceiptPath) : null;
      const capabilitySecret = capabilitySecretPath ? readPrivate(capabilitySecretPath) : null;
      const hostSecret = hostSecretPath ? readPrivate(hostSecretPath) : null;
      return provider.read({
        ...request,
        workspaceRoot,
        repositoryRoot,
        stateRoot,
        registryStateDir,
        projectionStateDir,
        releaseProviderStateDir,
        registry,
        projection,
        // These values are selected solely from the validated host binding;
        // request fields cannot smuggle in a capability, secret, or query.
        capability: capabilityReceipt,
        capabilitySecret,
        hostSecret,
        releaseProviderSecret: hostSecret,
        hostId: typeof config.hostId === 'string' && config.hostId.trim() ? config.hostId.trim() : request.hostId,
        subject: typeof config.subject === 'string' && config.subject.trim() ? config.subject.trim() : request.subject,
        query: !request.profile && config.query && typeof config.query === 'object' && !Array.isArray(config.query)
          ? JSON.parse(JSON.stringify(config.query))
          : request.query,
        releaseProducerId: typeof config.releaseProducerId === 'string' && config.releaseProducerId.trim()
          ? config.releaseProducerId.trim()
          : undefined,
      });
    },
  };
}

module.exports = { CONFIG_ENV, createHostProjectsContextProvider };
