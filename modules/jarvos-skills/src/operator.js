'use strict';

/**
 * Operator API for public shared-skill distribution.
 * Pure library surface used by the jarvos-skills CLI.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  CATALOG_SCHEMA_VERSION,
  OVERLAY_SCHEMA_VERSION,
  computeBundleTree,
  composeEffectiveCatalog,
  validatePublicCatalog,
  validateLocalOverlay,
  redactEffectiveCatalog,
} = require('./catalog');
const {
  loadConfig,
  saveConfig,
  ensureControlPlane,
  ensureDir,
  atomicWriteJson,
  expandHome,
  SUPPORTED_HARNESSES,
  defaultConfig,
} = require('./config');
const { planCatalogReconciliation, applyCatalogReconciliation } = require('./reconciliation');
const { readReceipt } = require('./receipts');
const { verifyHarnessBundle, resolveShadowPaths } = require('./harness-verification');
const { planSchedulerUnits } = require('./scheduler');
const {
  inventoryOperator,
  registerAdapterRootsOperator,
  declaredAdapterInventoryRoots,
} = require('./inventory');

const MODULE_ROOT = path.resolve(__dirname, '..');

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadHarnessAdapter(id) {
  const adapterPath = path.resolve(MODULE_ROOT, '..', '..', 'runtimes', id, 'adapter.json');
  if (!fs.existsSync(adapterPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(adapterPath, 'utf8'));
  } catch {
    return null;
  }
}

function loadEffectiveFromConfig(resolved, { includeDisabled = false, readOnly = false } = {}) {
  if (!readOnly) ensureControlPlane(resolved.config);
  const publicCatalog = readJson(resolved.publicCatalogPath, {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    entries: [],
  });
  const localOverlay = resolved.localOverlayPath
    ? readJson(resolved.localOverlayPath, { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] })
    : { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] };

  const effective = composeEffectiveCatalog({ publicCatalog, localOverlay });
  if (effective.status !== 'valid') {
    return {
      status: effective.status,
      reason: effective.reason,
      publicCatalog,
      localOverlay,
      effective: null,
    };
  }

  const selectedHarnesses = includeDisabled
    ? resolved.allHarnesses.filter((item) => item.enabled)
    : resolved.harnesses;
  const harnesses = selectedHarnesses.map((harness) => ({
    ...harness,
    adapter: loadHarnessAdapter(harness.id),
  }));

  return {
    status: 'valid',
    publicCatalog,
    localOverlay,
    effective,
    harnesses,
    resolved,
  };
}

function requireSourceRoots(resolved, effective) {
  const needsPublic = effective.catalog.entries.some((entry) => entry.sourceKind === 'public-catalog');
  const needsLocal = effective.catalog.entries.some((entry) => entry.sourceKind === 'local-overlay');
  if (needsPublic && !resolved.publicSourceRoot) {
    throw new Error('publicSourceRoot is required when the public catalog has entries');
  }
  if (needsLocal && !resolved.localSourceRoot) {
    throw new Error('localSourceRoot is required when the local overlay has entries');
  }
}

function statusOperator(options = {}) {
  const loaded = loadConfig(options.configPath);
  const state = loadEffectiveFromConfig(loaded.resolved, { readOnly: true });
  if (state.status !== 'valid') {
    return {
      ok: false,
      status: state.status,
      reason: state.reason,
      configPath: loaded.path,
    };
  }
  if (state.effective.catalog.entries.length === 0) {
    return {
      ok: true,
      configPath: loaded.path,
      catalogDigest: state.effective.digest,
      redacted: redactEffectiveCatalog(state.effective),
      pairs: [],
      notices: [],
      harnesses: state.harnesses.map((item) => ({ id: item.id, root: item.root, enabled: true })),
    };
  }
  requireSourceRoots(state.resolved, state.effective);
  const plan = planCatalogReconciliation({
    catalog: state.effective.catalog,
    catalogDigest: state.effective.digest,
    publicSourceRoot: state.resolved.publicSourceRoot,
    localSourceRoot: state.resolved.localSourceRoot,
    harnesses: state.harnesses,
    controlRoot: state.resolved.controlRoot,
    readOnly: true,
  });
  const pairs = plan.pairs.map((pair) => {
    const harness = state.harnesses.find((item) => item.id === pair.harness);
    const adapter = harness?.adapter || null;
    let verification = null;
    if (pair.target && fs.existsSync(pair.target) && pair.effectiveName) {
      const shadowPaths = resolveShadowPaths({ harness, adapter, effectiveName: pair.effectiveName });
      verification = verifyHarnessBundle({
        adapter,
        targetPath: pair.target,
        expectedName: pair.effectiveName,
        expectedTreeDigest: pair.source?.treeDigest || pair.treeDigest || null,
        allowlist: pair.allowlist,
        remoteModelProbe: false,
        shadowPaths: shadowPaths.paths,
        shadowPathsComplete: shadowPaths.complete,
      });
    }
    return {
      id: pair.id,
      harness: pair.harness,
      effectiveName: pair.effectiveName,
      status: pair.status,
      action: pair.action,
      verification: verification ? {
        status: verification.status,
        reason: verification.reason || null,
        tier: verification.tier || null,
      } : null,
      deselected: pair.deselected === true,
    };
  });
  return {
    ok: plan.ok,
    configPath: loaded.path,
    catalogDigest: state.effective.digest,
    aliasRevision: plan.aliasRevision,
    redacted: redactEffectiveCatalog(state.effective),
    notices: plan.notices,
    pairs,
    harnesses: state.harnesses.map((item) => ({ id: item.id, root: item.root, enabled: true })),
  };
}

function planOperator(options = {}) {
  const loaded = loadConfig(options.configPath);
  const state = loadEffectiveFromConfig(loaded.resolved, { readOnly: options.readOnly !== false });
  if (state.status !== 'valid') throw new Error(state.reason || 'catalog is invalid');
  requireSourceRoots(state.resolved, state.effective);
  const plan = planCatalogReconciliation({
    catalog: state.effective.catalog,
    catalogDigest: state.effective.digest,
    publicSourceRoot: state.resolved.publicSourceRoot,
    localSourceRoot: state.resolved.localSourceRoot,
    harnesses: state.harnesses,
    controlRoot: state.resolved.controlRoot,
    reviewer: options.reviewer || null,
    readOnly: options.readOnly !== false,
  });
  return {
    ok: plan.ok,
    configPath: loaded.path,
    catalogDigest: plan.catalogDigest,
    aliasRevision: plan.aliasRevision,
    aliases: plan.aliases,
    notices: plan.notices,
    pairs: plan.pairs.map((pair) => ({
      id: pair.id,
      harness: pair.harness,
      effectiveName: pair.effectiveName,
      status: pair.status,
      action: pair.action,
      reason: pair.reason || null,
      deselected: pair.deselected === true,
    })),
    _plan: plan,
  };
}

function applyOperator(options = {}) {
  const planned = planOperator({ ...options, readOnly: false });
  const result = applyCatalogReconciliation(planned._plan);
  const accepted = result.ok && result.applied.every((item) => ['clean', 'missing', 'outdated', 'retire'].includes(item.status));
  if (accepted) {
    const loaded = loadConfig(planned.configPath);
    saveConfig({
      ...loaded.config,
      acceptedCatalogDigest: planned.catalogDigest,
      acceptedAliasRevision: result.aliasRevision,
    }, planned.configPath);
  }
  return {
    ok: result.ok,
    configPath: planned.configPath,
    catalogDigest: planned.catalogDigest,
    aliasRevision: result.aliasRevision,
    notices: result.notices,
    applied: result.applied,
    acceptedCatalogDigest: accepted ? planned.catalogDigest : null,
    acceptedAliasRevision: accepted ? result.aliasRevision : null,
  };
}

function refreshOperator(options = {}) {
  const loaded = loadConfig(options.configPath);
  const resolved = ensureControlPlane(loaded.resolved.config);
  // Recompute digests for every configured entry against its source root.
  const publicCatalog = readJson(resolved.publicCatalogPath, {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    entries: [],
  });
  const localOverlay = resolved.localOverlayPath
    ? readJson(resolved.localOverlayPath, { schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] })
    : null;

  function refreshEntries(document, sourceRoot, label) {
    if (!document) return { document: null, updated: 0 };
    if (!Array.isArray(document.entries)) throw new Error(`${label} entries must be an array`);
    if (document.entries.length === 0) return { document, updated: 0 };
    if (!sourceRoot) throw new Error(`${label} source root is required to refresh digests`);
    let updated = 0;
    const entries = document.entries.map((entry) => {
      const bundleRoot = path.resolve(sourceRoot, entry.bundle.root);
      const tree = computeBundleTree(bundleRoot, {
        allowlist: entry.bundle.allowlist,
      });
      if (tree.treeDigest !== entry.bundle.treeDigest) updated += 1;
      return {
        ...entry,
        bundle: {
          ...entry.bundle,
          treeDigest: tree.treeDigest,
        },
      };
    });
    return {
      document: { ...document, entries },
      updated,
    };
  }

  const publicRefresh = refreshEntries(publicCatalog, resolved.publicSourceRoot, 'public catalog');
  const localRefresh = refreshEntries(localOverlay, resolved.localSourceRoot, 'local overlay');

  if (publicRefresh.updated > 0) atomicWriteJson(resolved.publicCatalogPath, publicRefresh.document);
  if (localRefresh.document && localRefresh.updated > 0) {
    atomicWriteJson(resolved.localOverlayPath, localRefresh.document);
  }

  const validatedPublic = validatePublicCatalog(publicRefresh.document);
  const validatedLocal = validateLocalOverlay(localRefresh.document);
  if (validatedPublic.status !== 'valid') throw new Error(validatedPublic.reason || 'public catalog invalid after refresh');
  if (validatedLocal.status === 'unsupported') throw new Error(validatedLocal.reason);

  return {
    ok: true,
    configPath: loaded.path,
    publicUpdated: publicRefresh.updated,
    localUpdated: localRefresh.updated,
    publicCatalogDigest: validatedPublic.digest,
    localOverlayDigest: validatedLocal.digest,
  };
}

function shareOperator(options = {}) {
  const {
    id,
    bundlePath,
    scope = 'public',
    harnesses = SUPPORTED_HARNESSES.slice(),
    configPath = null,
  } = options;
  if (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('share requires a canonical skill id');
  if (!bundlePath) throw new Error('share requires --path to a skill bundle');
  if (!['public', 'local'].includes(scope)) throw new Error('share scope must be public or local');

  const loaded = loadConfig(configPath);
  const config = { ...loaded.config };
  const absoluteBundle = path.resolve(expandHome(bundlePath));
  if (!fs.existsSync(path.join(absoluteBundle, 'SKILL.md'))) {
    throw new Error('bundle path must contain SKILL.md');
  }
  const sourceRoot = path.dirname(absoluteBundle);
  const relativeRoot = path.basename(absoluteBundle);
  const tree = computeBundleTree(absoluteBundle, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**', 'references/**', 'templates/**'],
  });

  const entry = {
    id,
    allowedHarnesses: harnesses.slice().sort(),
    bundle: {
      root: relativeRoot,
      allowlist: ['SKILL.md', 'scripts/**', 'assets/**', 'references/**', 'templates/**'],
      treeDigest: tree.treeDigest,
    },
  };

  ensureControlPlane(config);
  const resolved = ensureControlPlane(config);

  if (scope === 'public') {
    config.publicSourceRoot = config.publicSourceRoot || path.resolve(sourceRoot);
    if (path.resolve(expandHome(config.publicSourceRoot)) !== path.resolve(sourceRoot)) {
      // Keep one source root; require the bundle under the configured root.
      const expected = path.resolve(expandHome(config.publicSourceRoot), relativeRoot);
      if (expected !== absoluteBundle) {
        throw new Error(`public bundle must live under publicSourceRoot (${config.publicSourceRoot})`);
      }
    }
    const catalog = readJson(resolved.publicCatalogPath, {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      entries: [],
    });
    if (catalog.entries.some((item) => item.id === id)) {
      throw new Error(`public catalog already contains ${id}`);
    }
    catalog.entries.push(entry);
    catalog.entries.sort((a, b) => a.id.localeCompare(b.id));
    const validated = validatePublicCatalog(catalog);
    if (validated.status !== 'valid') throw new Error(validated.reason || 'public catalog invalid');
    atomicWriteJson(resolved.publicCatalogPath, validated.catalog);
  } else {
    config.localSourceRoot = config.localSourceRoot || path.resolve(sourceRoot);
    if (path.resolve(expandHome(config.localSourceRoot)) !== path.resolve(sourceRoot)) {
      const expected = path.resolve(expandHome(config.localSourceRoot), relativeRoot);
      if (expected !== absoluteBundle) {
        throw new Error(`local bundle must live under localSourceRoot (${config.localSourceRoot})`);
      }
    }
    const overlay = readJson(resolved.localOverlayPath, {
      schemaVersion: OVERLAY_SCHEMA_VERSION,
      entries: [],
    });
    if (overlay.entries.some((item) => item.id === id)) {
      throw new Error(`local overlay already contains ${id}`);
    }
    overlay.entries.push(entry);
    overlay.entries.sort((a, b) => a.id.localeCompare(b.id));
    const validated = validateLocalOverlay(overlay);
    if (validated.status !== 'valid' && validated.status !== 'absent') {
      throw new Error(validated.reason || 'local overlay invalid');
    }
    atomicWriteJson(resolved.localOverlayPath, validated.overlay || overlay);
  }

  const saved = saveConfig(config, loaded.path);
  return {
    ok: true,
    scope,
    id,
    treeDigest: tree.treeDigest,
    configPath: saved.path,
    // Never echo private bodies; only redacted structural facts.
    entry: {
      id: entry.id,
      allowedHarnesses: entry.allowedHarnesses,
      bundle: { root: entry.bundle.root, treeDigest: entry.bundle.treeDigest },
    },
  };
}

function enableHarness(options = {}) {
  return setHarnessEnabled(options, true);
}

function disableHarness(options = {}) {
  return setHarnessEnabled(options, false);
}

function setHarnessEnabled(options, enabled) {
  const harness = options.harness;
  if (!SUPPORTED_HARNESSES.includes(harness)) throw new Error(`unsupported harness: ${harness}`);
  const loaded = loadConfig(options.configPath);
  const config = { ...loaded.config, harnesses: { ...loaded.config.harnesses } };
  config.harnesses[harness] = {
    ...config.harnesses[harness],
    enabled,
  };
  if (options.root) {
    config.harnesses[harness].root = options.root;
  }
  const saved = saveConfig(config, loaded.path);
  return {
    ok: true,
    harness,
    enabled,
    root: saved.config.harnesses[harness].root,
    configPath: saved.path,
  };
}

function renameAlias(options = {}) {
  const { id, name, configPath = null } = options;
  if (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('rename requires canonical id');
  if (!name || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('rename requires a valid effective name');
  const loaded = loadConfig(configPath);
  const resolved = ensureControlPlane(loaded.config);
  for (const harness of resolved.harnesses) {
    if (fs.existsSync(path.join(harness.root, name))) {
      throw new Error(`effective name ${name} is occupied in ${harness.id}`);
    }
    if (readReceipt(harness.root, name)) {
      throw new Error(`effective name ${name} has an existing projection receipt in ${harness.id}`);
    }
  }
  const aliasFile = path.join(resolved.controlRoot, 'shared-skill-aliases.json');
  const current = readJson(aliasFile, { version: 1, revision: 0, aliases: {}, notices: {} });
  if (current.version !== 1 || !Number.isInteger(current.revision)) throw new Error('alias state is invalid');
  // Reject if another skill already owns the name.
  for (const [otherId, otherName] of Object.entries(current.aliases || {})) {
    if (otherId !== id && otherName === name) {
      throw new Error(`effective name ${name} is already bound to ${otherId}`);
    }
  }
  const next = {
    version: 1,
    revision: current.revision + 1,
    aliases: { ...current.aliases, [id]: name },
    notices: {
      ...(current.notices || {}),
      [id]: {
        effectiveName: name,
        source: 'operator-rename',
        message: `operator set durable alias ${name} for ${id}`,
      },
    },
  };
  atomicWriteJson(aliasFile, next);
  return {
    ok: true,
    id,
    effectiveName: name,
    aliasRevision: next.revision,
    configPath: loaded.path,
  };
}

function repairOperator(options = {}) {
  // Repair is plan+apply for missing/outdated only; preserve everything else.
  const loaded = loadConfig(options.configPath);
  const planned = planOperator({ ...options, readOnly: false });
  if (loaded.config.acceptedCatalogDigest !== planned.catalogDigest
    || loaded.config.acceptedAliasRevision !== planned.aliasRevision) {
    throw new Error('repair requires an accepted catalog generation; run apply after reviewing the current catalog');
  }
  const actionable = planned._plan.pairs.filter((pair) => ['missing', 'outdated', 'retire'].includes(pair.status));
  if (actionable.length === 0) {
    return {
      ok: true,
      repaired: false,
      reason: 'nothing_to_repair',
      pairs: planned.pairs,
      configPath: planned.configPath,
    };
  }
  const result = applyCatalogReconciliation(planned._plan);
  return {
    ok: result.ok,
    repaired: true,
    applied: result.applied,
    aliasRevision: result.aliasRevision,
    notices: result.notices,
    configPath: planned.configPath,
  };
}

function schedulerOperator(options = {}) {
  const loaded = loadConfig(options.configPath);
  const config = { ...loaded.config };
  if (options.intervalMinutes) {
    config.scheduler = {
      ...config.scheduler,
      intervalMinutes: options.intervalMinutes,
    };
  }
  if (options.enable === true) config.scheduler = { ...config.scheduler, enabled: true };
  if (options.enable === false) config.scheduler = { ...config.scheduler, enabled: false };
  const saved = options.persist === false ? { path: loaded.path, config } : saveConfig(config, loaded.path);
  const plan = planSchedulerUnits({
    moduleRoot: MODULE_ROOT,
    configPath: saved.path,
    unitName: saved.config.scheduler.unitName,
    intervalMinutes: saved.config.scheduler.intervalMinutes,
    write: options.write === true,
    platform: options.platform,
    home: options.home,
  });
  return {
    ok: true,
    configPath: saved.path,
    scheduler: saved.config.scheduler,
    plan,
  };
}

function initOperator(options = {}) {
  const base = defaultConfig();
  // Prefer an explicit control root. Otherwise isolate beside --config so
  // doctor/preflight never mutate the owner home control plane by accident.
  const controlRoot = options.controlRoot
    || (options.configPath ? path.dirname(path.resolve(expandHome(options.configPath))) : null);
  if (controlRoot) {
    base.controlRoot = controlRoot;
    base.publicCatalogPath = path.join(controlRoot, 'public-catalog.json');
    base.localOverlayPath = path.join(controlRoot, 'local-overlay.json');
  }
  if (options.publicSourceRoot) base.publicSourceRoot = options.publicSourceRoot;
  if (options.localSourceRoot) base.localSourceRoot = options.localSourceRoot;
  const saved = saveConfig(base, options.configPath);
  ensureControlPlane(saved.config);
  ensureDir(saved.resolved.controlRoot, 'control root');
  return {
    ok: true,
    configPath: saved.path,
    controlRoot: saved.resolved.controlRoot,
  };
}

function withMutationLease(configPath, operation, fn, rootOverride = null) {
  // init-config has no persisted config to read yet; its explicit control
  // root is authoritative and must be leased before any state is touched.
  const initRoot = configPath
    ? path.dirname(path.resolve(expandHome(configPath)))
    : defaultConfig().controlRoot;
  const root = rootOverride
    ? path.resolve(expandHome(rootOverride))
    : operation === 'init-config'
      ? path.resolve(expandHome(initRoot))
      : loadConfig(configPath).resolved.controlRoot;
  ensureDir(root, 'control root');
  const lease = path.join(root, '.shared-skill-cli.lock');
  const staleAfterMs = 6 * 60 * 60 * 1000;
  const malformedGraceMs = 60 * 1000;
  const tryAcquire = () => {
    try {
      const fd = fs.openSync(lease, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, operation, startedAt: new Date().toISOString() }));
      return fd;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return null;
    }
  };
  let fd = tryAcquire();
  if (fd === null) {
    let stale = false;
    try {
      const prior = JSON.parse(fs.readFileSync(lease, 'utf8'));
      const startedAt = Date.parse(prior.startedAt);
      const tooOld = Number.isFinite(startedAt) && Date.now() - startedAt > staleAfterMs;
      let alive = typeof prior.pid === 'number' && prior.pid > 0;
      if (alive) {
        try { process.kill(prior.pid, 0); } catch { alive = false; }
      }
      stale = tooOld || !alive;
    } catch {
      try {
        stale = Date.now() - fs.statSync(lease).mtimeMs > malformedGraceMs;
      } catch {
        stale = true;
      }
    }
    if (!stale) throw new Error(`shared skill ${operation} is already running`);
    fs.unlinkSync(lease);
    fd = tryAcquire();
    if (fd === null) throw new Error(`shared skill ${operation} is already running`);
  }
  try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(lease); } catch (_) {} }
}

const _applyOperator = applyOperator;
const _refreshOperator = refreshOperator;
const _shareOperator = shareOperator;
const _enableHarness = enableHarness;
const _disableHarness = disableHarness;
const _renameAlias = renameAlias;
const _repairOperator = repairOperator;
const _schedulerOperator = schedulerOperator;
const _initOperator = initOperator;

function inventoryStatusOperator(options = {}) {
  return inventoryOperator({
    configPath: options.configPath,
    controlRoot: options.controlRoot,
    persist: options.persist !== false,
    inspect: options.inspect === true,
    includeDocument: options.includeDocument === true,
    observedAt: options.observedAt,
  });
}

function inventoryRegisterRootsOperator(options = {}) {
  return registerAdapterRootsOperator({
    configPath: options.configPath,
    trustClass: options.trustClass,
    persist: options.persist !== false,
  });
}

function inventoryDeclaredRootsOperator(options = {}) {
  return {
    ok: true,
    roots: declaredAdapterInventoryRoots({
      repoRoot: options.repoRoot,
    }),
  };
}

function inventoryAssessOperator(options = {}) {
  return withMutationLease(options.configPath, 'inventory-assess', () => {
    const result = inventoryOperator({
      configPath: options.configPath,
      controlRoot: options.controlRoot,
      persist: options.persist !== false,
      assess: true,
      autoAdmit: options.autoAdmit !== false,
      observedAt: options.observedAt,
      reviewer: options.reviewer || null,
      saveConfig: true,
      // Load document in-process for redacted classification summary only.
      includeDocument: true,
    });
    const document = result.document;
    const classifications = (document?.skills || []).map((skill) => ({
      logicalId: skill.logicalId,
      disposition: skill.disposition,
      attention: skill.attention,
      reasonCode: skill.disposition?.reasonCode || null,
    }));
    return {
      ok: true,
      mode: 'assess',
      complete: result.complete,
      generationId: result.generationId,
      digest: result.digest,
      mutate: result.mutate,
      admissions: result.assessment?.admissions || [],
      classifications,
      status: result.status,
      // Never include private document by default.
      document: options.includeDocument === true ? document : undefined,
    };
  });
}

module.exports = {
  MODULE_ROOT,
  statusOperator,
  planOperator,
  applyOperator: (options = {}) => withMutationLease(options.configPath, 'apply', () => _applyOperator(options)),
  refreshOperator: (options = {}) => withMutationLease(options.configPath, 'refresh', () => _refreshOperator(options)),
  shareOperator: (options = {}) => withMutationLease(options.configPath, 'share', () => _shareOperator(options)),
  enableHarness: (options = {}) => withMutationLease(options.configPath, 'enable', () => _enableHarness(options)),
  disableHarness: (options = {}) => withMutationLease(options.configPath, 'disable', () => _disableHarness(options)),
  renameAlias: (options = {}) => withMutationLease(options.configPath, 'rename', () => _renameAlias(options)),
  repairOperator: (options = {}) => withMutationLease(options.configPath, 'repair', () => _repairOperator(options)),
  schedulerOperator: (options = {}) => withMutationLease(options.configPath, 'scheduler', () => _schedulerOperator(options)),
  initOperator: (options = {}) => withMutationLease(options.configPath, 'init-config', () => _initOperator(options), options.controlRoot || null),
  inventoryStatusOperator,
  inventoryRegisterRootsOperator,
  inventoryDeclaredRootsOperator,
  inventoryAssessOperator,
};
