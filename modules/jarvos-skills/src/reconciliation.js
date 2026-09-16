'use strict';

/**
 * Transactional multi-skill / multi-harness reconciliation.
 *
 * Catalog-level alias bindings are serialized through one compare-and-set
 * revision file. Pair writes stage complete skill bundles and only replace
 * receipt-owned targets. Unmanaged, locally modified, unsafe, and native
 * targets are preserved.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { attestCatalogBundle, computeBundleTree, LOCAL_OVERLAY_SOURCE_KIND } = require('./catalog');
const { expandHome } = require('./config');
const { resolveCollisionAlias } = require('./collision-alias');
const { verifyHarnessBundle, resolveShadowPaths } = require('./harness-verification');
const {
  STATE_DIR,
  RECEIPT_VERSION,
  readReceipt,
  validateReceipt,
  atomicWriteReceipt,
  removeReceipt,
} = require('./receipts');

const ALIAS_FILE = 'shared-skill-aliases.json';
const ALIAS_STATE_VERSION = 1;
const JOURNAL_FILE = 'shared-skill-reconcile.journal.json';
const SHA256_RE = /^[a-f0-9]{64}$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertSafeOwnedDirectory(stat, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
}

function safeRoot(value, { create = true } = {}) {
  if (!value) throw new Error('root is required');
  const root = path.resolve(value);
  if (create) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(root)) {
    if (!create) return root;
    throw new Error(`root does not exist: ${root}`);
  }
  const stat = fs.lstatSync(root);
  assertSafeOwnedDirectory(stat, 'managed skill root');
  return fs.realpathSync(root);
}

function rootIdentity(root) {
  if (!fs.existsSync(root)) return null;
  const resolved = safeRoot(root, { create: false });
  const stat = fs.lstatSync(resolved);
  return { path: resolved, dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid };
}

function sameRootIdentity(left, right) {
  return left && right && left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function assertTargetBelowRoot(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('target is outside enrolled managed skill root');
  }
  // Check every existing ancestor without following a link.  This protects
  // both the planned target and a parent substituted before apply.
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('target contains a symbolic link');
    if (current !== target) assertSafeOwnedDirectory(stat, 'managed skill target ancestor');
  }
  return relative.split(path.sep).join('/');
}

function desiredTupleDigest(entries, catalogRelease) {
  return sha256(JSON.stringify(entries
    .map((entry) => ({ id: entry.id, catalogRelease, treeDigest: entry.bundle.treeDigest }))
    .sort((left, right) => left.id.localeCompare(right.id))));
}

function observedTupleDigest(tuples) {
  if (!Array.isArray(tuples)) return null;
  const normalized = tuples.map((tuple) => ({
    id: tuple?.id,
    catalogRelease: tuple?.catalogRelease,
    treeDigest: tuple?.treeDigest,
  }));
  if (normalized.some((tuple) => typeof tuple.id !== 'string'
    || typeof tuple.catalogRelease !== 'string' || !SHA256_RE.test(tuple.treeDigest || ''))) return null;
  return sha256(JSON.stringify(normalized.sort((left, right) => left.id.localeCompare(right.id))));
}

function receiptNeedsRefresh(receipt, pair) {
  return !receipt || receipt.version !== RECEIPT_VERSION
    || receipt.catalogRelease !== pair.catalogRelease
    || receipt.manifestDigest !== pair.manifestDigest
    || receipt.dependencyComplete !== true
    || !sameRootIdentity(receipt.enrolledRoot, pair.enrolledRoot)
    || receipt.desiredSetDigest !== pair.desiredSetDigest
    || !receipt.discovery
    || !receipt.observedSetDigest;
}

function desiredIdsForHarness(options, harnessId, catalog) {
  const configured = options.desiredSkillIds || options.desiredSkills || null;
  if (!configured) return catalog.entries.filter((entry) => entry.allowedHarnesses.includes(harnessId)).map((entry) => entry.id);
  const values = Array.isArray(configured) ? configured : configured[harnessId];
  if (!Array.isArray(values)) return [];
  return values.slice();
}

function resolveDependencyClosure({ catalog, harnessId, desiredIds, excludedSkillIds }) {
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const excluded = new Set(Array.isArray(excludedSkillIds) ? excludedSkillIds : (excludedSkillIds?.[harnessId] || []));
  const resolved = new Map();
  const visiting = new Set();
  const visit = (id, chain = []) => {
    if (visiting.has(id)) throw new Error(`dependency_cycle:${[...chain, id].join('->')}`);
    const entry = byId.get(id);
    if (!entry) throw new Error(`dependency_missing:${id}`);
    if (excluded.has(id)) throw new Error(`dependency_excluded:${id}`);
    if (!entry.allowedHarnesses.includes(harnessId)) throw new Error(`dependency_incompatible:${id}`);
    if (resolved.has(id)) return;
    visiting.add(id);
    for (const dependency of entry.skillDependencies || []) visit(dependency, [...chain, id]);
    visiting.delete(id);
    resolved.set(id, entry);
  };
  for (const id of desiredIds) visit(id);
  return [...resolved.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function runtimePrerequisiteStatus(entry, harness, verifier) {
  const statuses = {};
  for (const prerequisite of entry.runtimePrerequisites || []) {
    const result = typeof verifier === 'function' ? verifier({ entry, harness, prerequisite }) : null;
    const available = result === true || result?.available === true || result?.status === 'available';
    statuses[prerequisite] = { available, reason: available ? null : (result?.reason || 'runtime_prerequisite_unavailable') };
  }
  return { complete: Object.values(statuses).every((status) => status.available), statuses };
}

function atomicWriteJson(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  assertSafeOwnedDirectory(parentStat, 'state parent');
  const tmp = path.join(parent, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, filePath);
  return body;
}

function readJsonIfPresent(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`state file must be a regular file: ${filePath}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`state file has unsafe permissions: ${filePath}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`state file is invalid JSON: ${filePath}`);
  }
}

function controlPaths(controlRoot, { create = true } = {}) {
  const root = safeRoot(controlRoot, { create });
  return {
    root,
    aliasFile: path.join(root, ALIAS_FILE),
    journalFile: path.join(root, JOURNAL_FILE),
  };
}

function readAliasState(controlRoot, { create = true } = {}) {
  const paths = controlPaths(controlRoot, { create });
  const raw = readJsonIfPresent(paths.aliasFile, {
    version: ALIAS_STATE_VERSION,
    revision: 0,
    aliases: {},
    notices: {},
  });
  if (raw.version !== ALIAS_STATE_VERSION || !Number.isInteger(raw.revision) || raw.revision < 0) {
    throw new Error('shared alias state is invalid');
  }
  if (!raw.aliases || typeof raw.aliases !== 'object' || Array.isArray(raw.aliases)) {
    throw new Error('shared alias map is invalid');
  }
  return {
    ...paths,
    data: {
      version: ALIAS_STATE_VERSION,
      revision: raw.revision,
      aliases: { ...raw.aliases },
      notices: raw.notices && typeof raw.notices === 'object' ? { ...raw.notices } : {},
    },
  };
}

function targetDir(harnessRoot, effectiveName) {
  if (typeof effectiveName !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(effectiveName)) {
    throw new Error('effective name is invalid');
  }
  return path.join(harnessRoot, effectiveName);
}

function listOccupiedNames(harnessRoot) {
  if (!fs.existsSync(harnessRoot)) return [];
  return fs.readdirSync(harnessRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== STATE_DIR)
    .map((entry) => entry.name);
}

function listHigherPrecedenceNames(harness) {
  const scopes = harness.adapter?.skillProjection?.orderedScopes;
  if (!Array.isArray(scopes)) return [];
  const configured = harness.scopeRoots || {};
  const managedRoot = path.resolve(harness.root);
  const names = new Set();
  for (const scope of scopes.slice(0, -1)) {
    if (!configured[scope]) continue;
    const configuredRoot = configured[scope] ? expandHome(configured[scope]) : null;
    if (!configuredRoot || !path.isAbsolute(configuredRoot)) continue;
    const root = path.resolve(configuredRoot);
    if (root === managedRoot) continue;
    for (const name of listOccupiedNames(root)) names.add(name);
  }
  return [...names];
}

function sourceRootFor(entry, { publicSourceRoot, localSourceRoot }) {
  if (entry.sourceKind === LOCAL_OVERLAY_SOURCE_KIND) {
    if (!localSourceRoot) throw new Error(`localSourceRoot is required for ${entry.id}`);
    return localSourceRoot;
  }
  if (!publicSourceRoot) throw new Error(`publicSourceRoot is required for ${entry.id}`);
  return publicSourceRoot;
}

function classifyPair({ entry, harness, effectiveName, sourceRoot, sourceAttestation = null, catalogDigest, aliasRevision }) {
  const target = targetDir(harness.root, effectiveName);
  const receiptRaw = readReceipt(harness.root, effectiveName);
  const receipt = validateReceipt(receiptRaw);
  const source = sourceAttestation || attestCatalogBundle(entry, { sourceRoot });

  if (!fs.existsSync(target)) {
    if (receipt && receipt.id === entry.id && receipt.treeDigest === source.treeDigest) {
      return {
        status: 'missing',
        action: 'install',
        target,
        receipt,
        source,
        reason: 'receipt_owned_missing_target',
      };
    }
    if (receipt) {
      return {
        status: 'conflict',
        action: 'preserve',
        target,
        receipt,
        source,
        reason: 'orphan_or_mismatched_receipt',
      };
    }
    return {
      status: 'missing',
      action: 'install',
      target,
      receipt: null,
      source,
    };
  }

  let observed = null;
  try {
    observed = computeBundleTree(target, { allowlist: entry.bundle.allowlist }).treeDigest;
  } catch (error) {
    return {
      status: 'unsafe',
      action: 'preserve',
      target,
      receipt,
      source,
      reason: error.message,
    };
  }

  if (!receipt) {
    // Exact-digest unmanaged copy: adopt in place (ownership evidence only).
    // Divergent unmanaged copy remains preserved with pair-scoped attention.
    if (observed === source.treeDigest) {
      return {
        status: 'unmanaged_exact',
        action: 'adopt',
        target,
        receipt: null,
        source,
        observed,
        reason: 'exact_digest_unmanaged_adopt',
      };
    }
    return {
      status: 'unmanaged',
      action: 'preserve',
      target,
      receipt: null,
      source,
      observed,
      reason: 'divergent_unmanaged_preserve',
    };
  }

  if (receipt.id !== entry.id || receipt.effectiveName !== effectiveName) {
    return {
      status: 'conflict',
      action: 'preserve',
      target,
      receipt,
      source,
      observed,
      reason: 'receipt_identity_mismatch',
    };
  }

  if (receipt.treeDigest !== observed) {
    return {
      status: 'local_modified',
      action: 'preserve',
      target,
      receipt,
      source,
      observed,
    };
  }

  if (observed === source.treeDigest) {
    return {
      status: 'clean',
      action: 'preserve',
      target,
      receipt,
      source,
      observed,
      catalogDigest,
      aliasRevision,
    };
  }

  return {
    status: 'outdated',
    action: 'install',
    target,
    receipt,
    source,
    observed,
  };
}

function pairGeneration(pair) {
  return sha256(JSON.stringify({
    id: pair.id,
    harness: pair.harness,
    effectiveName: pair.effectiveName,
    status: pair.status,
    action: pair.action,
    sourceDigest: pair.source?.treeDigest || null,
    observed: pair.observed || null,
    receiptDigest: pair.receipt?.treeDigest || null,
    target: pair.target,
  }));
}

function exactDigestAtName(harnessRoot, name, entry) {
  const target = targetDir(harnessRoot, name);
  if (!fs.existsSync(target)) return false;
  // Receipt-owned targets are not "exact unmanaged" candidates.
  if (validateReceipt(readReceipt(harnessRoot, name))) return false;
  try {
    const observed = computeBundleTree(target, { allowlist: entry.bundle.allowlist }).treeDigest;
    return observed === entry.bundle.treeDigest;
  } catch {
    return false;
  }
}

function resolveAliasesForCatalog({ catalog, harnesses, aliasState, reviewer = null }) {
  const aliases = { ...aliasState.data.aliases };
  const notices = [];
  const occupiedByHarness = Object.fromEntries(
    harnesses.map((harness) => [
      harness.id,
      new Set([...listOccupiedNames(harness.root), ...listHigherPrecedenceNames(harness)]),
    ]),
  );

  for (const entry of catalog.entries) {
    if (aliases[entry.id]) continue;
    const enrolled = harnesses.filter((harness) => entry.allowedHarnesses.includes(harness.id));
    // Exact-digest unmanaged copies of this entry can keep the canonical name
    // (U4 adopt-in-place). Only divergent/unsafe occupants force an alias.
    const exactCanonicalOnAll = enrolled.length > 0 && enrolled.every((harness) => (
      !occupiedByHarness[harness.id]?.has(entry.id)
      || exactDigestAtName(harness.root, entry.id, entry)
    ));
    // Names occupied by unmanaged targets on any enrolled harness block the
    // canonical id and any candidate that is already present somewhere.
    const occupied = new Set();
    for (const harness of enrolled) {
      for (const name of occupiedByHarness[harness.id] || []) {
        if (name === entry.id && exactDigestAtName(harness.root, name, entry)) continue;
        occupied.add(name);
      }
    }
    // Existing durable aliases for other skills also reserve names.
    for (const [otherId, otherName] of Object.entries(aliases)) {
      if (otherId !== entry.id) occupied.add(otherName);
    }

    const resolution = resolveCollisionAlias({
      canonicalId: entry.id,
      occupiedNames: [...occupied],
      reviewer,
      untrustedSummary: {
        id: entry.id,
        sourceKind: entry.sourceKind,
        harnesses: enrolled.map((harness) => harness.id),
      },
      forceAlias: occupied.has(entry.id) && !exactCanonicalOnAll,
    });

    if (!resolution.effectiveName) {
      notices.push({
        id: entry.id,
        level: 'conflict',
        message: resolution.notice || `no safe alias for ${entry.id}`,
      });
      aliases[entry.id] = null;
      continue;
    }

    aliases[entry.id] = resolution.effectiveName;
    if (resolution.source !== 'canonical' && resolution.notice) {
      notices.push({
        id: entry.id,
        level: 'info',
        source: resolution.source,
        message: resolution.notice,
        effectiveName: resolution.effectiveName,
      });
    }
  }

  return { aliases, notices };
}

function planCatalogReconciliation(options = {}) {
  const catalog = options.catalog;
  if (!catalog || !Array.isArray(catalog.entries)) throw new Error('effective catalog is required');
  if (!Array.isArray(options.harnesses) || options.harnesses.length === 0) {
    throw new Error('harnesses are required');
  }

  // U4: incomplete inventory generations may observe but never mutate.
  if (options.incompleteGeneration === true && options.allowIncompleteMutation !== true) {
    return {
      version: 1,
      catalogDigest: options.catalogDigest || (catalog.digest || null),
      aliasRevision: null,
      aliases: {},
      aliasFile: null,
      journalFile: null,
      controlRoot: options.controlRoot || null,
      harnesses: options.harnesses || [],
      notices: [{
        id: '*',
        level: 'blocked',
        message: 'incomplete inventory generation refuses admission/update/retirement mutations',
      }],
      pairs: [],
      ok: false,
      incompleteGeneration: true,
      inventoryGenerationId: options.inventoryGenerationId || null,
      mutate: false,
    };
  }

  const readOnly = options.readOnly === true;
  const harnesses = options.harnesses.map((harness) => {
    if (!harness || typeof harness.id !== 'string') throw new Error('harness id is required');
    const root = safeRoot(harness.root, { create: !readOnly });
    return {
      id: harness.id,
      root,
      enrolledRoot: rootIdentity(root),
      adapter: harness.adapter || null,
      scopeRoots: harness.scopeRoots || {},
      scopeRootsComplete: harness.scopeRootsComplete !== false,
    };
  });

  const aliasState = readAliasState(options.controlRoot, { create: !readOnly });
  // Recover incomplete journals before planning new work.
  if (!readOnly) recoverJournal(aliasState);

  const { aliases, notices } = resolveAliasesForCatalog({
    catalog,
    harnesses,
    aliasState,
    reviewer: options.reviewer || null,
  });

  const catalogDigest = options.catalogDigest || catalog.digest || sha256(JSON.stringify(catalog));
  const pairs = [];

  const closureByHarness = new Map();
  const closureFailures = new Map();
  for (const harness of harnesses) {
    try {
      closureByHarness.set(harness.id, resolveDependencyClosure({
        catalog,
        harnessId: harness.id,
        desiredIds: desiredIdsForHarness(options, harness.id, catalog),
        excludedSkillIds: options.excludedSkillIds,
      }));
    } catch (error) {
      closureFailures.set(harness.id, error.message);
      closureByHarness.set(harness.id, []);
    }
  }

  for (const entry of catalog.entries) {
    const effectiveName = aliases[entry.id];
    if (!effectiveName) {
      for (const harness of harnesses.filter((item) => entry.allowedHarnesses.includes(item.id))) {
        pairs.push({
          id: entry.id,
          harness: harness.id,
          effectiveName: null,
          status: 'conflict',
          action: 'preserve',
          reason: 'no_safe_alias',
          generation: sha256(`${entry.id}:${harness.id}:no-alias`),
        });
      }
      continue;
    }

    const sourceRoot = sourceRootFor(entry, {
      publicSourceRoot: options.publicSourceRoot,
      localSourceRoot: options.localSourceRoot,
    });

    const enrolled = harnesses.filter((item) => closureByHarness.get(item.id)?.some((candidate) => candidate.id === entry.id));
    if (enrolled.length === 0) continue;
    // The source bundle is immutable for the duration of planning. Attest it
    // once per catalog entry, then retain a fresh attestation in apply.
    const sourceAttestation = (options.attestCatalogBundle || attestCatalogBundle)(entry, { sourceRoot });
    for (const harness of enrolled) {
      const prerequisiteStatus = runtimePrerequisiteStatus(entry, harness, options.verifyRuntimePrerequisite);
      const classified = classifyPair({
        entry,
        harness,
        effectiveName,
        sourceRoot,
        sourceAttestation,
        catalogDigest,
        aliasRevision: aliasState.data.revision,
      });
      const pair = {
        id: entry.id,
        harness: harness.id,
        effectiveName,
        sourceRoot,
        sourceKind: entry.sourceKind,
        bundleRoot: entry.bundle.root,
        allowlist: entry.bundle.allowlist,
        treeDigest: entry.bundle.treeDigest,
        catalogDigest,
        aliasRevision: aliasState.data.revision,
        inventoryGenerationId: options.inventoryGenerationId || null,
        catalogRelease: options.catalogRelease || catalog.release || catalog.publicCatalogDigest || catalogDigest,
        manifestDigest: options.manifestDigest || catalogDigest,
        enrolledRoot: harness.enrolledRoot,
        desiredSetDigest: desiredTupleDigest(closureByHarness.get(harness.id), options.catalogRelease || catalog.release || catalog.publicCatalogDigest || catalogDigest),
        dependencyComplete: prerequisiteStatus.complete,
        runtimePrerequisites: prerequisiteStatus.statuses,
        sourceIdentity: options.sourceIdentities?.[entry.id] || {
          logicalId: entry.id,
          sourceKind: entry.sourceKind,
          profileDigest: null,
        },
        ...classified,
      };
      pair.targetRelativePath = assertTargetBelowRoot(harness.root, pair.target);
      if (!prerequisiteStatus.complete) {
        pair.status = 'verification_failed';
        pair.action = 'preserve';
        pair.reason = 'runtime_prerequisite_unavailable';
      } else if (options.refreshVerification === true && pair.status === 'clean' && receiptNeedsRefresh(pair.receipt, pair)) {
        // A v1 receipt, or a v2 receipt without the complete discovery tuple,
        // remains ownership evidence only. Refresh it without replacing bytes.
        pair.status = 'verification_stale';
        pair.action = 'refresh';
        pair.reason = 'receipt_verification_stale';
      }
      pair.generation = pairGeneration(pair);
      pairs.push(pair);
    }
  }

  for (const [harnessId, reason] of closureFailures) {
    const harness = harnesses.find((item) => item.id === harnessId);
    for (const id of desiredIdsForHarness(options, harnessId, catalog)) {
      pairs.push({
        id,
        harness: harnessId,
        effectiveName: null,
        status: 'verification_failed',
        action: 'preserve',
        reason,
        enrolledRoot: harness.enrolledRoot,
        dependencyComplete: false,
        generation: sha256(`${id}:${harnessId}:${reason}`),
      });
    }
  }

  // De-selection also retires a receipt-owned previous alias after an explicit
  // rename. Locally modified and unsafe copies remain preserved.
  for (const harness of harnesses) {
    // A failed dependency closure is not a de-selection. Preserve existing
    // receipt-owned targets until the closure can be evaluated safely.
    if (closureFailures.has(harness.id)) continue;
    // The root's desired closure, not catalog membership elsewhere, owns
    // cleanup. This preserves a dependency needed by any retained wrapper.
    const selectedIds = new Set((closureByHarness.get(harness.id) || []).map((entry) => entry.id));
    const stateDir = path.join(harness.root, STATE_DIR);
    if (!fs.existsSync(stateDir)) continue;
    for (const file of fs.readdirSync(stateDir)) {
      if (!file.endsWith('.json')) continue;
      const receipt = validateReceipt(readJsonIfPresent(path.join(stateDir, file), null));
      const desiredName = aliases[receipt?.id];
      if (!receipt || (selectedIds.has(receipt.id) && (!desiredName || desiredName === receipt.effectiveName))) continue;
      if (receipt.harness && receipt.harness !== harness.id) continue;
      const replacement = pairs.find((pair) => pair.id === receipt.id
        && pair.harness === harness.id
        && pair.effectiveName === desiredName);
      if (selectedIds.has(receipt.id) && (!replacement || !['clean', 'missing', 'outdated'].includes(replacement.status))) {
        continue;
      }
      const target = targetDir(harness.root, receipt.effectiveName);
      let observed = null;
      let status = 'retire';
      let action = 'retire';
      if (fs.existsSync(target)) {
        try {
          observed = computeBundleTree(target, {
            allowlist: options.defaultAllowlist || ['SKILL.md', 'scripts/**', 'assets/**', 'references/**', 'templates/**'],
          }).treeDigest;
          if (observed !== receipt.treeDigest) {
            status = 'local_modified';
            action = 'preserve';
          }
        } catch {
          status = 'unsafe';
          action = 'preserve';
        }
      }
      const pair = {
        id: receipt.id,
        harness: harness.id,
        effectiveName: receipt.effectiveName,
        status,
        action,
        target,
        targetRelativePath: assertTargetBelowRoot(harness.root, target),
        receipt,
        observed,
        catalogDigest,
        aliasRevision: aliasState.data.revision,
        deselected: true,
      };
      pair.generation = pairGeneration(pair);
      pairs.push(pair);
    }
  }

  pairs.sort((left, right) => `${left.id}:${left.harness}`.localeCompare(`${right.id}:${right.harness}`));

  return {
    version: 1,
    catalogDigest,
    aliasRevision: aliasState.data.revision,
    aliases,
    aliasFile: aliasState.aliasFile,
    journalFile: aliasState.journalFile,
    controlRoot: aliasState.root,
    harnesses,
    notices,
    pairs,
    inventoryGenerationId: options.inventoryGenerationId || null,
    incompleteGeneration: false,
    mutate: pairs.some((pair) => ['install', 'retire', 'adopt', 'refresh'].includes(pair.action)),
    ok: pairs.every((pair) => ['clean', 'missing', 'outdated', 'retire', 'unmanaged_exact', 'verification_stale'].includes(pair.status)
      || (pair.action === 'preserve' && ['unmanaged', 'local_modified', 'unsafe', 'conflict'].includes(pair.status))),
  };
}

function stageBundleCopy(source, target) {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  assertSafeOwnedDirectory(parentStat, 'target parent');

  if (fs.existsSync(target)) {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink()) throw new Error('destination is a symbolic link');
  }

  const staging = path.join(
    parent,
    `.${path.basename(target)}.jarvos-stage-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const entry of source.entries) {
      const from = path.join(source.root, entry.path);
      const to = path.join(staging, entry.path);
      const relative = path.relative(staging, to);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`bundle entry escapes staging: ${entry.path}`);
      }
      const fromStat = fs.lstatSync(from);
      if (fromStat.isSymbolicLink() || !fromStat.isFile()) {
        throw new Error(`bundle entry must be a regular file: ${entry.path}`);
      }
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o600);
      const copiedDigest = sha256(fs.readFileSync(to));
      if (copiedDigest !== entry.digest) throw new Error(`staged digest mismatch: ${entry.path}`);
    }
    // Replace target only after the complete staged tree is verified.
    let backup = null;
    if (fs.existsSync(target)) {
      // A leftover backup must never be discovered as a second harness skill.
      backup = path.join(parent, `.${path.basename(target)}.jarvos-bak-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      fs.renameSync(target, backup);
      try {
        fs.renameSync(staging, target);
      } catch (error) {
        let restored = false;
        try {
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
          fs.renameSync(backup, target);
          restored = true;
        } catch {
          // Preserve the only recovery pointer for the next leased plan.
        }
        if (!restored) error.jarvosRecovery = { target, backup };
        throw error;
      }
    } else {
      fs.renameSync(staging, target);
    }
    return { backup };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function writeJournal(journalFile, journal) {
  atomicWriteJson(journalFile, journal);
}

function clearJournal(journalFile) {
  if (fs.existsSync(journalFile)) fs.unlinkSync(journalFile);
}

function recoverJournal(aliasState) {
  const journal = readJsonIfPresent(aliasState.journalFile, null);
  if (!journal) return { recovered: false };
  if (journal.phase === 'retirements_committed') {
    for (const retirement of journal.retirements || []) {
      const target = path.resolve(retirement.target || '');
      const backup = retirement.backup ? path.resolve(retirement.backup) : null;
      const receipt = validateReceipt(retirement.receipt);
      const expectedPrefix = `.${path.basename(target)}.jarvos-retire-`;
      if (!receipt
        || target !== targetDir(path.dirname(target), receipt.effectiveName)
        || (backup && (path.dirname(target) !== path.dirname(backup)
          || !path.basename(backup).startsWith(expectedPrefix)))) {
        throw new Error('committed retirement journal is unsafe');
      }
      if (fs.existsSync(target) || validateReceipt(readReceipt(path.dirname(target), receipt.effectiveName))) {
        throw new Error('committed retirement cleanup requires owner attention');
      }
      if (backup && fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    }
    clearJournal(aliasState.journalFile);
    return { recovered: true, journal };
  }
  if (journal.phase === 'failed' && journal.recovery?.target && journal.recovery?.backup) {
    const target = path.resolve(journal.recovery.target || '');
    const backup = path.resolve(journal.recovery.backup || '');
    const expectedPrefix = `.${path.basename(target)}.jarvos-bak-`;
    if (path.dirname(target) !== path.dirname(backup) || !path.basename(backup).startsWith(expectedPrefix)) {
      throw new Error('reconciliation recovery journal is unsafe');
    }
    if (!fs.existsSync(target) && fs.existsSync(backup)) {
      fs.renameSync(backup, target);
    } else if (!fs.existsSync(target)) {
      throw new Error('reconciliation backup recovery is unavailable');
    } else if (fs.existsSync(backup)) {
      throw new Error('reconciliation backup recovery requires owner attention');
    }
  }
  const retirements = Array.isArray(journal.recovery?.retirements)
    ? journal.recovery.retirements
    : (Array.isArray(journal.retirements) ? journal.retirements : []);
  for (const retirement of retirements) {
    const target = path.resolve(retirement.target || '');
    const backup = retirement.backup ? path.resolve(retirement.backup) : null;
    const receipt = validateReceipt(retirement.receipt);
    if (!receipt || target !== targetDir(path.dirname(target), receipt.effectiveName)) {
      throw new Error('retirement recovery journal is invalid');
    }
    if (backup) {
      const expectedPrefix = `.${path.basename(target)}.jarvos-retire-`;
      if (path.dirname(target) !== path.dirname(backup) || !path.basename(backup).startsWith(expectedPrefix)) {
        throw new Error('retirement recovery journal is unsafe');
      }
      if (!fs.existsSync(target) && fs.existsSync(backup)) {
        fs.renameSync(backup, target);
      } else if (fs.existsSync(target) && fs.existsSync(backup)) {
        throw new Error('retirement recovery requires owner attention');
      } else if (!fs.existsSync(target)) {
        throw new Error('retirement backup recovery is unavailable');
      }
    }
    const root = path.dirname(target);
    const liveReceipt = validateReceipt(readReceipt(root, receipt.effectiveName));
    if (liveReceipt) {
      if (liveReceipt.id !== receipt.id || liveReceipt.treeDigest !== receipt.treeDigest) {
        throw new Error('retirement receipt recovery requires owner attention');
      }
    } else {
      atomicWriteReceipt(root, receipt);
    }
  }
  // Re-observe live targets and receipts after any completed recovery.
  clearJournal(aliasState.journalFile);
  return { recovered: true, journal };
}

function rollbackRetirements(retirements, io) {
  let failed = false;
  for (const retirement of [...retirements].reverse()) {
    try {
      if (retirement.backup && fs.existsSync(retirement.backup)) {
        if (fs.existsSync(retirement.target)) throw new Error('retirement rollback target already exists');
        io.rollbackRenameSync(retirement.backup, retirement.target);
      }
      const root = path.dirname(retirement.target);
      const liveReceipt = validateReceipt(readReceipt(root, retirement.receipt.effectiveName));
      if (!liveReceipt) io.writeReceipt(root, retirement.receipt);
      else if (liveReceipt.id !== retirement.receipt.id || liveReceipt.treeDigest !== retirement.receipt.treeDigest) {
        throw new Error('retirement rollback receipt changed');
      }
    } catch {
      failed = true;
    }
  }
  return !failed;
}

function commitAliasesIfNeeded(plan) {
  const current = readJsonIfPresent(plan.aliasFile, {
    version: ALIAS_STATE_VERSION,
    revision: 0,
    aliases: {},
    notices: {},
  });
  if (current.revision !== plan.aliasRevision) {
    throw new Error('catalog aliases changed since planning');
  }
  const nextAliases = { ...plan.aliases };
  const changed = JSON.stringify(current.aliases) !== JSON.stringify(nextAliases);
  if (!changed) {
    return { revision: current.revision, changed: false };
  }
  const nextRevision = current.revision + 1;
  atomicWriteJson(plan.aliasFile, {
    version: ALIAS_STATE_VERSION,
    revision: nextRevision,
    aliases: nextAliases,
    notices: Object.fromEntries(
      (plan.notices || [])
        .filter((notice) => notice.effectiveName)
        .map((notice) => [notice.id, {
          effectiveName: notice.effectiveName,
          source: notice.source || null,
          message: notice.message,
        }]),
    ),
  });
  return { revision: nextRevision, changed: true };
}

function assertLivePairRoot(plan, pair) {
  const harness = (plan.harnesses || []).find((item) => item.id === pair.harness);
  if (!harness || !pair.target) throw new Error(`enrolled root is unavailable: ${pair.id}/${pair.harness}`);
  const live = rootIdentity(harness.root);
  if (!sameRootIdentity(live, pair.enrolledRoot || harness.enrolledRoot)) {
    throw new Error(`enrolled root changed since planning: ${pair.id}/${pair.harness}`);
  }
  const relativePath = assertTargetBelowRoot(live.path, pair.target);
  if (pair.targetRelativePath && pair.targetRelativePath !== relativePath) {
    throw new Error(`target path changed since planning: ${pair.id}/${pair.harness}`);
  }
  return { live, relativePath };
}

function writeVerificationReceipt(pair, targetAttestation, io, outcome) {
  io.writeReceipt(path.dirname(pair.target), {
    version: RECEIPT_VERSION,
    id: pair.id,
    effectiveName: pair.effectiveName,
    harness: pair.harness,
    treeDigest: pair.source.treeDigest,
    catalogDigest: pair.catalogDigest,
    aliasRevision: pair.aliasRevision,
    targetPath: pair.target,
    verificationTier: outcome.verificationTier || 'receipt-owned',
    inventoryGenerationId: pair.inventoryGenerationId || null,
    sourceIdentity: pair.sourceIdentity || null,
    catalogRelease: pair.catalogRelease,
    manifestDigest: pair.manifestDigest,
    dependencyComplete: pair.dependencyComplete === true,
    runtimePrerequisites: pair.runtimePrerequisites || {},
    enrolledRoot: targetAttestation.live,
    desiredSetDigest: pair.desiredSetDigest || null,
    observedSetDigest: outcome.observedSetDigest || null,
    discovery: outcome.discovery || null,
    status: outcome.status || 'verification_pending',
  });
}

function verificationOutcome(plan, pair, targetAttestation, options) {
  const harness = plan.harnesses.find((item) => item.id === pair.harness);
  const activation = typeof options.activationReceipt === 'function'
    ? options.activationReceipt({ harness, pair }) : null;
  if (activation?.active === false || activation?.status === 'activation_pending') {
    return { status: 'activation_pending', verificationTier: 'activation-receipt', discovery: { activationDependency: activation.dependency || 'harness_activation' } };
  }
  const observed = typeof options.freshDiscovery === 'function'
    ? options.freshDiscovery({ harness, pair, desiredSetDigest: pair.desiredSetDigest }) : null;
  if (!observed || observed.fresh !== true) return { status: 'verification_pending', verificationTier: 'receipt-owned' };
  const observedSetDigest = observedTupleDigest(observed.tuples);
  if (!observedSetDigest || observedSetDigest !== pair.desiredSetDigest) {
    return { status: 'verification_failed', verificationTier: 'native-discovery', discovery: { fresh: true, source: observed.source || 'native' } };
  }
  const shadows = resolveShadowPaths({ harness, adapter: harness.adapter, effectiveName: pair.effectiveName });
  const proof = verifyHarnessBundle({ adapter: harness.adapter, targetPath: pair.target, expectedName: pair.effectiveName,
    expectedTreeDigest: pair.source.treeDigest, allowlist: pair.allowlist, shadowPaths: shadows.paths, shadowPathsComplete: shadows.complete });
  if (proof.status !== 'model_visible') return { status: 'verification_failed', verificationTier: proof.tier, discovery: { fresh: true, source: observed.source || 'native', reason: proof.reason } };
  return { status: 'model_visible', verificationTier: proof.tier, observedSetDigest, discovery: { fresh: true, source: observed.source || 'native', observedAt: observed.observedAt || null } };
}

function applyCatalogReconciliation(plan, options = {}) {
  if (!plan || !Array.isArray(plan.pairs)) {
    throw new Error('catalog reconciliation plan is required');
  }

  if (plan.incompleteGeneration === true) {
    return {
      ok: false,
      noop: true,
      applied: [],
      aliasRevision: plan.aliasRevision || null,
      notices: plan.notices || [],
      reason: 'incomplete_generation',
    };
  }

  if (!plan.aliasFile || !plan.journalFile) {
    throw new Error('catalog reconciliation plan is required');
  }

  const aliasCommit = commitAliasesIfNeeded(plan);
  const aliasRevision = aliasCommit.revision;
  const io = {
    writeReceipt: options.io?.writeReceipt || atomicWriteReceipt,
    removeReceipt: options.io?.removeReceipt || removeReceipt,
    rollbackRenameSync: options.io?.rollbackRenameSync || fs.renameSync,
    cleanupRetirementBackup: options.io?.cleanupRetirementBackup
      || ((backup) => fs.rmSync(backup, { recursive: true, force: true })),
  };

  const hasActionablePairs = plan.pairs.some((pair) => (
    pair.action === 'install' || pair.action === 'retire' || pair.action === 'adopt' || pair.action === 'refresh'
  ));
  if (!aliasCommit.changed && !hasActionablePairs) {
    return {
      ok: true,
      noop: true,
      applied: [],
      aliasRevision,
      notices: plan.notices || [],
    };
  }

  writeJournal(plan.journalFile, {
    version: 1,
    phase: 'applying',
    catalogDigest: plan.catalogDigest,
    aliasRevision,
    pairIds: plan.pairs.map((pair) => `${pair.id}:${pair.harness}`),
    retirements: [],
  });

  const applied = [];
  const retirements = [];
  let retirementsCommitted = false;
  try {
    for (const pair of plan.pairs) {
      if (pair.action === 'preserve' || pair.status === 'clean') {
        applied.push({
          id: pair.id,
          harness: pair.harness,
          effectiveName: pair.effectiveName,
          status: pair.status,
          applied: false,
        });
        continue;
      }

      // The root is a security boundary, not a convenient parent directory.
      // Re-attest just before every mutation/adoption/retirement.
      const targetAttestation = assertLivePairRoot(plan, pair);

      if (pair.action === 'refresh' && pair.status === 'verification_stale') {
        writeVerificationReceipt(pair, targetAttestation, io, verificationOutcome(plan, pair, targetAttestation, options));
        applied.push({ id: pair.id, harness: pair.harness, effectiveName: pair.effectiveName, status: 'verification_stale', applied: true, reason: 'receipt_refreshed' });
        continue;
      }

      if (pair.action === 'adopt' && pair.status === 'unmanaged_exact') {
        // Ownership evidence only — never rewrite matching bytes.
        let observed;
        try {
          observed = computeBundleTree(pair.target, { allowlist: pair.allowlist }).treeDigest;
        } catch (error) {
          applied.push({
            id: pair.id,
            harness: pair.harness,
            effectiveName: pair.effectiveName,
            status: 'unsafe',
            applied: false,
            reason: error.message,
          });
          continue;
        }
        if (observed !== pair.treeDigest) {
          applied.push({
            id: pair.id,
            harness: pair.harness,
            effectiveName: pair.effectiveName,
            status: 'unmanaged',
            applied: false,
            reason: 'adopt_aborted_digest_drift',
          });
          continue;
        }
        writeVerificationReceipt(pair, targetAttestation, io, verificationOutcome(plan, pair, targetAttestation, options));
        applied.push({
          id: pair.id,
          harness: pair.harness,
          effectiveName: pair.effectiveName,
          status: 'adopted',
          applied: true,
          reason: 'exact_digest_unmanaged_adopt',
        });
        continue;
      }

      if (pair.action === 'retire') {
        const liveReceipt = validateReceipt(readReceipt(path.dirname(pair.target), pair.effectiveName));
        if (!liveReceipt || liveReceipt.treeDigest !== pair.receipt.treeDigest) {
          applied.push({
            id: pair.id,
            harness: pair.harness,
            effectiveName: pair.effectiveName,
            status: 'local_modified',
            applied: false,
            reason: 'retire_aborted_modified',
          });
          continue;
        }
        let backup = null;
        if (fs.existsSync(pair.target)) {
          let observed;
          try {
            observed = computeBundleTree(pair.target, {
              allowlist: options.defaultAllowlist || ['SKILL.md', 'scripts/**', 'assets/**', 'references/**', 'templates/**'],
            }).treeDigest;
          } catch {
            applied.push({
              id: pair.id,
              harness: pair.harness,
              effectiveName: pair.effectiveName,
              status: 'unsafe',
              applied: false,
            });
            continue;
          }
          if (observed !== pair.receipt.treeDigest) {
            applied.push({
              id: pair.id,
              harness: pair.harness,
              effectiveName: pair.effectiveName,
              status: 'local_modified',
              applied: false,
              reason: 'retire_aborted_modified',
            });
            continue;
          }
          backup = path.join(
            path.dirname(pair.target),
            `.${path.basename(pair.target)}.jarvos-retire-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
          );
        }
        const retirement = { target: pair.target, backup, receipt: liveReceipt };
        // Record the rollback pointer before moving the only managed copy.
        writeJournal(plan.journalFile, {
          version: RECEIPT_VERSION,
          phase: 'applying',
          catalogDigest: plan.catalogDigest,
          aliasRevision,
          pairIds: plan.pairs.map((item) => `${item.id}:${item.harness}`),
          retirements: [...retirements, retirement],
        });
        if (backup) fs.renameSync(pair.target, backup);
        retirements.push(retirement);
        io.removeReceipt(path.dirname(pair.target), pair.effectiveName);
        applied.push({
          id: pair.id,
          harness: pair.harness,
          effectiveName: pair.effectiveName,
          status: 'retire',
          applied: true,
        });
        continue;
      }

      if (!['missing', 'outdated'].includes(pair.status) || pair.action !== 'install') {
        applied.push({
          id: pair.id,
          harness: pair.harness,
          effectiveName: pair.effectiveName,
          status: pair.status,
          applied: false,
        });
        continue;
      }

      // Revalidate generation immediately before write.
      const currentObserved = fs.existsSync(pair.target)
        ? (() => {
          try {
            return computeBundleTree(pair.target, { allowlist: pair.allowlist }).treeDigest;
          } catch {
            return 'unsafe';
          }
        })()
        : null;
      if (pair.status === 'missing' && currentObserved !== null) {
        throw new Error(`target appeared since planning: ${pair.id}/${pair.harness}`);
      }
      if (pair.status === 'outdated') {
        const liveReceipt = validateReceipt(readReceipt(path.dirname(pair.target), pair.effectiveName));
        if (!liveReceipt || liveReceipt.treeDigest !== pair.receipt.treeDigest) {
          throw new Error(`receipt changed since planning: ${pair.id}/${pair.harness}`);
        }
        if (currentObserved !== pair.observed) {
          throw new Error(`target changed since planning: ${pair.id}/${pair.harness}`);
        }
      }

      // Fresh attestation at apply time (bundle root is relative to sourceRoot).
      const freshSource = attestCatalogBundle({
        id: pair.id,
        sourceKind: pair.sourceKind,
        bundle: {
          root: pair.bundleRoot,
          allowlist: pair.allowlist,
          treeDigest: pair.treeDigest,
        },
      }, {
        sourceRoot: pair.sourceRoot,
        expectedTreeDigest: pair.treeDigest,
      });

      const staged = stageBundleCopy(freshSource, pair.target);
      try {
        pair.source.treeDigest = freshSource.treeDigest;
        writeVerificationReceipt(pair, targetAttestation, io, verificationOutcome(plan, pair, targetAttestation, options));
      } catch (error) {
        // A receipt is the ownership boundary. Roll back the replacement when
        // it cannot be committed, preserving the prior target for retry.
        if (staged.backup && fs.existsSync(staged.backup)) {
          try {
            if (fs.existsSync(pair.target)) fs.rmSync(pair.target, { recursive: true, force: true });
            io.rollbackRenameSync(staged.backup, pair.target);
          } catch {
            error.jarvosRecovery = { target: pair.target, backup: staged.backup };
          }
        } else if (!pair.receipt && fs.existsSync(pair.target)) {
          fs.rmSync(pair.target, { recursive: true, force: true });
        }
        throw error;
      }
      if (staged.backup && fs.existsSync(staged.backup)) fs.rmSync(staged.backup, { recursive: true, force: true });

      applied.push({
        id: pair.id,
        harness: pair.harness,
        effectiveName: pair.effectiveName,
        status: pair.status,
        applied: true,
        target: pair.target,
      });
    }

    if (retirements.length > 0) {
      writeJournal(plan.journalFile, {
        version: 1,
        phase: 'retirements_committed',
        catalogDigest: plan.catalogDigest,
        aliasRevision,
        retirements,
      });
      // Past this durable boundary, target and receipt removal is committed.
      // Backup cleanup is replayable housekeeping and must never roll back.
      retirementsCommitted = true;
    }
    for (const retirement of retirements) {
      if (retirement.backup && fs.existsSync(retirement.backup)) {
        io.cleanupRetirementBackup(retirement.backup);
      }
    }
    clearJournal(plan.journalFile);
    return {
      ok: true,
      applied,
      aliasRevision,
      notices: plan.notices || [],
    };
  } catch (error) {
    if (retirementsCommitted) {
      // The committed journal already contains every cleanup pointer. Leave it
      // intact so the next leased recovery deletes only remaining backups.
      throw error;
    }
    const retiredRollbackOk = rollbackRetirements(retirements, io);
    if (!retiredRollbackOk) {
      error.jarvosRecovery = {
        ...(error.jarvosRecovery || {}),
        retirements,
      };
    }
    writeJournal(plan.journalFile, {
      version: 1,
      phase: 'failed',
      catalogDigest: plan.catalogDigest,
      aliasRevision,
      error: error.message,
      ...(retirements.length > 0 ? { retirements } : {}),
      ...(error.jarvosRecovery ? { recovery: error.jarvosRecovery } : {}),
    });
    throw error;
  }
}

module.exports = {
  ALIAS_FILE,
  planCatalogReconciliation,
  applyCatalogReconciliation,
  recoverJournal,
};
