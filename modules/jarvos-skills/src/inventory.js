'use strict';

/**
 * Bounded machine-wide skill inventory (U2).
 *
 * Discovers normal skill bundles under registered absolute roots only.
 * Discovery is observation, never authorization or admission.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  SUPPORTED_HARNESSES,
  expandHome,
  collapseHome,
  loadConfig,
  resolveConfigPaths,
  ensureControlPlane,
  atomicWriteJson,
} = require('./config');
const {
  INVENTORY_SCHEMA_VERSION,
  SOURCE_STATES,
  inventoryDigest,
  validateInventoryDocument,
  serializeOutwardStatus,
  serializeOwnerInspect,
  ensureInventoryStateLayout,
  loadExclusionOverlay,
  normalizeInventoryPolicy,
  defaultInventoryPolicy,
} = require('./inventory-contract');
const { computeBundleTree } = require('./catalog');
const { STATE_DIR, readReceipt, validateReceipt } = require('./receipts');
// Lazy: skill-assessment requires inventory helpers; load only when assessing.

const MODULE_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(MODULE_ROOT, '..', '..');
const LOGICAL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_ALLOWLIST = Object.freeze([
  'SKILL.md',
  'scripts/**',
  'assets/**',
  'references/**',
  'templates/**',
]);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowIso(clock = () => new Date()) {
  return clock().toISOString().replace(/\.\d{3}Z$/, '.000Z');
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadHarnessAdapter(id, { repoRoot = REPO_ROOT } = {}) {
  const adapterPath = path.join(repoRoot, 'runtimes', id, 'adapter.json');
  if (!fs.existsSync(adapterPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(adapterPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Adapter skill-projection root declarations.
 * Absolute user/managed roots are inventory-eligible templates.
 * Relative project/workspace roots are visibility metadata only.
 */
function declaredAdapterInventoryRoots({ repoRoot = REPO_ROOT } = {}) {
  const declared = [];
  for (const harness of SUPPORTED_HARNESSES) {
    const adapter = loadHarnessAdapter(harness, { repoRoot });
    const projection = adapter?.skillProjection || null;
    if (!projection || typeof projection !== 'object') continue;

    const managedRoot = typeof projection.managedRoot === 'string' ? projection.managedRoot : null;
    const scopeRoots = projection.scopeRoots && typeof projection.scopeRoots === 'object'
      ? projection.scopeRoots
      : {};
    const orderedScopes = Array.isArray(projection.orderedScopes) ? projection.orderedScopes : [];

    const candidates = [];
    if (managedRoot) {
      candidates.push({ scope: 'managed', value: managedRoot });
    }
    for (const scope of orderedScopes) {
      if (scope === 'managed') continue;
      if (typeof scopeRoots[scope] === 'string' && scopeRoots[scope]) {
        candidates.push({ scope, value: scopeRoots[scope] });
      }
    }
    // Include any absolute scope roots not listed in orderedScopes.
    for (const [scope, value] of Object.entries(scopeRoots)) {
      if (typeof value !== 'string' || !value) continue;
      if (candidates.some((entry) => entry.scope === scope && entry.value === value)) continue;
      candidates.push({ scope, value });
    }

    for (const candidate of candidates) {
      const expanded = expandHome(candidate.value);
      const absolute = path.isAbsolute(expanded);
      declared.push({
        harness,
        scope: candidate.scope,
        declaredRoot: candidate.value,
        absolute,
        // Relative roots stay metadata; they are never scan targets.
        root: absolute ? path.resolve(expanded) : candidate.value,
        inventoryEligible: absolute === true,
        rootIdHint: `${harness}-${candidate.scope}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''),
      });
    }
  }
  return declared;
}

function canonicalRootId(harness, scope, used) {
  const base = `${harness}-${scope}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || `${harness}-root`;
  let candidate = base.slice(0, 64);
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `-${index}`;
    candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Build registered-root records from adapter declarations + harness config.
 * Only absolute roots are emitted. Does not enable inventory.
 */
function buildRegisteredRootsFromAdapters({
  config = null,
  repoRoot = REPO_ROOT,
  trustClass = 'markdown-only',
  lifecycle = 'available',
} = {}) {
  const harnessRoots = config?.harnesses || {};
  const declared = declaredAdapterInventoryRoots({ repoRoot });
  const used = new Set();
  const byPath = new Map();

  for (const entry of declared) {
    if (!entry.inventoryEligible) continue;
    const resolved = path.resolve(entry.root);
    if (byPath.has(resolved)) continue;
    byPath.set(resolved, {
      rootId: canonicalRootId(entry.harness, entry.scope, used),
      harness: entry.harness,
      root: collapseHome(resolved),
      trustClass,
      lifecycle,
      scope: entry.scope,
      source: 'adapter-declaration',
    });
  }

  // Harness managed roots from config are always inventory-eligible templates.
  for (const harness of SUPPORTED_HARNESSES) {
    const harnessConfig = harnessRoots[harness];
    if (!harnessConfig || typeof harnessConfig.root !== 'string' || !harnessConfig.root) continue;
    const expanded = expandHome(harnessConfig.root);
    if (!path.isAbsolute(expanded)) continue;
    const resolved = path.resolve(expanded);
    if (byPath.has(resolved)) continue;
    byPath.set(resolved, {
      rootId: canonicalRootId(harness, 'managed', used),
      harness,
      root: collapseHome(resolved),
      trustClass,
      lifecycle,
      scope: 'managed',
      source: 'harness-config',
    });
  }

  return [...byPath.values()].sort((left, right) => left.rootId.localeCompare(right.rootId));
}

function sameRealPath(left, right) {
  try {
    if (!fs.existsSync(left) || !fs.existsSync(right)) {
      return path.resolve(left) === path.resolve(right);
    }
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function sanitizeLogicalId(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  if (LOGICAL_ID_RE.test(name)) return name;
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!normalized || !/^[a-z]/.test(normalized)) return null;
  return LOGICAL_ID_RE.test(normalized) ? normalized : null;
}

function emptyEvidenceFingerprint() {
  return {
    roots: [],
    skills: [],
    completeness: {
      complete: true,
      overflowed: false,
      partial: false,
      reasons: [],
    },
  };
}

function evidenceFingerprint(document, meta) {
  return {
    roots: (document.roots || []).map((root) => ({
      rootId: root.rootId,
      harness: root.harness,
      root: root.root,
      lifecycle: root.lifecycle,
      trustClass: root.trustClass,
      complete: root.complete === true,
    })).sort((a, b) => a.rootId.localeCompare(b.rootId)),
    skills: (document.skills || []).map((skill) => ({
      logicalId: skill.logicalId,
      observedName: skill.observedName,
      treeDigest: skill.treeDigest,
      disposition: skill.disposition,
      attention: skill.attention,
      observations: skill.observations.map((observation) => ({
        rootId: observation.rootId,
        relativePath: observation.relativePath,
        // Fingerprint uses collapsed path form so home moves don't false-churn.
        absolutePath: collapseHome(observation.absolutePath),
      })).sort((a, b) => {
        const byRoot = a.rootId.localeCompare(b.rootId);
        return byRoot !== 0 ? byRoot : a.relativePath.localeCompare(b.relativePath);
      }),
      matrix: skill.matrix,
    })).sort((a, b) => a.logicalId.localeCompare(b.logicalId)),
    completeness: {
      complete: meta.complete === true,
      overflowed: meta.overflowed === true,
      partial: meta.partial === true,
      reasons: [...(meta.reasons || [])].sort(),
    },
  };
}

function loadPreviousObservations(observationsPath) {
  if (!observationsPath || !fs.existsSync(observationsPath)) {
    return { existed: false, document: null, fingerprint: null, raw: null };
  }
  try {
    const stat = fs.lstatSync(observationsPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { existed: true, document: null, fingerprint: null, raw: null, error: 'observations must be a regular file' };
    }
    const raw = JSON.parse(fs.readFileSync(observationsPath, 'utf8'));
    const validated = validateInventoryDocument(raw.document || raw);
    if (validated.status !== 'valid') {
      return { existed: true, document: null, fingerprint: raw.fingerprint || null, raw, error: validated.reason || 'invalid' };
    }
    return {
      existed: true,
      document: validated.document,
      fingerprint: raw.fingerprint || evidenceFingerprint(validated.document, {
        complete: validated.document.roots.every((root) => root.complete === true),
        overflowed: false,
        partial: validated.document.roots.some((root) => root.complete !== true),
        reasons: [],
      }),
      raw,
    };
  } catch (error) {
    return { existed: true, document: null, fingerprint: null, raw: null, error: error.message };
  }
}

function defaultMatrix(sourceHarnesses = []) {
  const present = new Set(sourceHarnesses);
  return SUPPORTED_HARNESSES.map((harness) => ({
    harness,
    projection: present.has(harness) ? 'source_present' : 'missing',
    verification: present.has(harness) ? 'verification_pending' : 'unverifiable',
  }));
}

function observationStateFromPrevious(previousSkill, treeDigest) {
  if (!previousSkill) return 'new';
  if (!previousSkill.treeDigest) return 'changed';
  if (previousSkill.treeDigest === treeDigest) return 'unchanged';
  return 'changed';
}

function listReceiptOwnedNames(rootPath) {
  const stateDir = path.join(rootPath, STATE_DIR);
  if (!fs.existsSync(stateDir)) return new Set();
  try {
    const stat = fs.lstatSync(stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return new Set();
  } catch {
    return new Set();
  }
  const names = new Set();
  for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const effectiveName = entry.name.slice(0, -'.json'.length);
    const receipt = validateReceipt(readReceipt(rootPath, effectiveName));
    if (receipt) names.add(effectiveName);
  }
  return names;
}

function rootLifecycleStatus(registeredRoot, { observedAt }) {
  const expanded = path.resolve(expandHome(registeredRoot.root));
  if (registeredRoot.lifecycle === 'unregistered') {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: 'unregistered',
      trustClass: registeredRoot.trustClass,
      complete: true,
      scannable: false,
      reason: 'unregistered',
      observedAt,
    };
  }

  if (!path.isAbsolute(expanded)) {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: registeredRoot.root,
      lifecycle: 'stale',
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'relative_root',
      observedAt,
    };
  }

  if (!fs.existsSync(expanded)) {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: registeredRoot.lifecycle === 'available' ? 'stale' : registeredRoot.lifecycle,
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'missing_root',
      observedAt,
    };
  }

  let stat;
  try {
    stat = fs.lstatSync(expanded);
  } catch {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: 'stale',
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'unreadable_root',
      observedAt,
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: 'stale',
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'symlink_root',
      observedAt,
    };
  }
  if (!stat.isDirectory()) {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: 'stale',
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'not_directory',
      observedAt,
    };
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: 'stale',
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'unsafe_ownership',
      observedAt,
    };
  }
  if ((stat.mode & 0o022) !== 0) {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: 'stale',
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'unsafe_permissions',
      observedAt,
    };
  }

  let realRoot = expanded;
  try {
    realRoot = fs.realpathSync(expanded);
  } catch {
    return {
      rootId: registeredRoot.rootId,
      harness: registeredRoot.harness,
      root: expanded,
      collapsedRoot: collapseHome(expanded),
      lifecycle: 'stale',
      trustClass: registeredRoot.trustClass,
      complete: false,
      scannable: false,
      reason: 'unreadable_root',
      observedAt,
    };
  }

  return {
    rootId: registeredRoot.rootId,
    harness: registeredRoot.harness,
    root: realRoot,
    collapsedRoot: collapseHome(realRoot),
    lifecycle: registeredRoot.lifecycle === 'stale' ? 'stale' : 'available',
    trustClass: registeredRoot.trustClass,
    complete: false, // filled after scan
    scannable: registeredRoot.lifecycle !== 'stale',
    reason: registeredRoot.lifecycle === 'stale' ? 'registered_stale' : null,
    observedAt,
  };
}

// Bound traversal before digesting bytes.  computeBundleTree remains the
// canonical digest/allowlist primitive, while this guard ensures an untrusted
// bundle cannot make inventory read an unbounded tree first.
function inspectBundleBounds(bundleRoot, limits) {
  let files = 0;
  let directories = 1;
  let bytes = 0;
  const walk = (directory, depth = 0) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return { kind: 'unsafe', reason: 'unreadable_bundle' };
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      let stat;
      try {
        stat = fs.lstatSync(candidate);
      } catch {
        return { kind: 'unsafe', reason: 'unreadable_bundle' };
      }
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) {
        return { kind: 'unsafe', reason: 'unsafe_source' };
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        return { kind: 'unsafe', reason: 'unsafe_source' };
      }
      if ((stat.mode & 0o022) !== 0) return { kind: 'unsafe', reason: 'unsafe_source' };
      if (stat.isDirectory()) {
        directories += 1;
        if (directories > limits.maxBundleDirectories) {
          return { kind: 'overflow', reason: 'max_bundle_directories' };
        }
        if (depth + 1 > limits.maxBundleDepth) {
          return { kind: 'overflow', reason: 'max_bundle_depth' };
        }
        const nested = walk(candidate, depth + 1);
        if (nested) return nested;
        continue;
      }
      // Hard-linked bundle bodies have unstable provenance: fail closed rather
      // than treating an aliased inode as an independent source.
      if (stat.nlink > 1) return { kind: 'unsafe', reason: 'unsafe_source' };
      files += 1;
      bytes += stat.size;
      if (files > limits.maxBundleFiles || bytes > limits.maxBundleBytes) {
        return { kind: 'overflow', reason: files > limits.maxBundleFiles ? 'max_bundle_files' : 'max_bundle_bytes' };
      }
    }
    return null;
  };
  return walk(bundleRoot) || { kind: 'ok', files, directories, bytes };
}

function scanBundleCandidate({
  rootInfo,
  entryName,
  absolutePath,
  limits,
  allowlist,
  receiptOwned,
  excludedRoots,
  previousByKey,
  observedAt,
}) {
  const relativePath = entryName;

  if (entryName === STATE_DIR || entryName.startsWith('.')) {
    return { skip: true, reason: 'hidden_or_state' };
  }
  for (const excluded of excludedRoots) {
    if (sameRealPath(absolutePath, excluded) || isPathInside(excluded, absolutePath)) {
      return { skip: true, reason: 'snapshot_store_exclusion' };
    }
  }
  if (receiptOwned.has(entryName)) {
    return { skip: true, reason: 'receipt_owned' };
  }

  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return {
      skip: false,
      unsafe: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: 'unreadable_entry',
    };
  }

  if (stat.isSymbolicLink()) {
    return {
      skip: false,
      unsafe: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: 'symlink_entry',
    };
  }
  if (!stat.isDirectory()) {
    return { skip: true, reason: 'not_directory' };
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return {
      skip: false,
      unsafe: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: 'unsafe_ownership',
    };
  }
  if ((stat.mode & 0o022) !== 0) {
    return {
      skip: false,
      unsafe: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: 'unsafe_permissions',
    };
  }

  const skillMd = path.join(absolutePath, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    return { skip: true, reason: 'missing_skill_md' };
  }

  const bounded = inspectBundleBounds(absolutePath, limits);
  if (bounded.kind === 'overflow') {
    return {
      skip: false,
      overflow: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: bounded.reason,
      observedName: entryName,
    };
  }
  if (bounded.kind === 'unsafe') {
    return {
      skip: false,
      unsafe: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: bounded.reason,
      observedName: entryName,
    };
  }

  let tree;
  try {
    tree = computeBundleTree(absolutePath, { allowlist });
  } catch (error) {
    return {
      skip: false,
      unsafe: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: error.message || 'attest_failed',
    };
  }

  const totalBytes = tree.entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
  if (tree.entries.length > limits.maxBundleFiles) {
    return {
      skip: false,
      overflow: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: 'oversized_bundle_files',
      treeDigest: tree.treeDigest,
      observedName: entryName,
    };
  }
  if (totalBytes > limits.maxBundleBytes) {
    return {
      skip: false,
      overflow: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: 'oversized_bundle_bytes',
      treeDigest: tree.treeDigest,
      observedName: entryName,
    };
  }

  const logicalId = sanitizeLogicalId(entryName);
  if (!logicalId) {
    return {
      skip: false,
      unsafe: true,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath,
        state: 'unsafe',
        observedAt,
      },
      reason: 'invalid_skill_id',
      treeDigest: tree.treeDigest,
      observedName: entryName,
    };
  }

  let realPath = absolutePath;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    realPath = absolutePath;
  }

  const previous = previousByKey.get(`${rootInfo.rootId}:${relativePath}`)
    || previousByKey.get(realPath)
    || null;
  const state = observationStateFromPrevious(previous, tree.treeDigest);

  return {
    skip: false,
    unsafe: false,
    overflow: false,
    skill: {
      logicalId,
      observedName: entryName,
      treeDigest: tree.treeDigest,
      realPath,
      bytes: totalBytes,
      fileCount: tree.entries.length,
      observation: {
        rootId: rootInfo.rootId,
        relativePath,
        absolutePath: realPath,
        state,
        observedAt,
      },
      harness: rootInfo.harness,
    },
  };
}

function scanRegisteredRoot(rootInfo, {
  limits,
  allowlist,
  excludedRoots,
  previousByKey,
  observedAt,
}) {
  const result = {
    root: {
      rootId: rootInfo.rootId,
      harness: rootInfo.harness,
      root: rootInfo.collapsedRoot,
      lifecycle: rootInfo.lifecycle,
      trustClass: rootInfo.trustClass,
      complete: false,
    },
    skills: [],
    skipped: [],
    unsafe: [],
    overflowed: false,
    partial: false,
    reasons: [],
  };

  if (!rootInfo.scannable) {
    // A root that cannot be safely scanned is explicitly incomplete.  This
    // prevents a stale, replaced, or unreadable location from retiring a
    // previously observed source.  An operator-declared unregistered root is
    // the sole non-scanning complete lifecycle state.
    result.root.complete = rootInfo.lifecycle === 'unregistered';
    result.partial = result.root.complete !== true;
    if (rootInfo.reason) result.reasons.push(rootInfo.reason);
    return result;
  }

  let entries;
  try {
    entries = fs.readdirSync(rootInfo.root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    result.partial = true;
    result.root.complete = false;
    result.reasons.push('unreadable_root');
    return result;
  }

  const receiptOwned = listReceiptOwnedNames(rootInfo.root);
  let considered = 0;

  for (const entry of entries) {
    if (entry.name === STATE_DIR || entry.name.startsWith('.')) {
      result.skipped.push({ name: entry.name, reason: 'hidden_or_state' });
      continue;
    }
    considered += 1;
    if (considered > limits.maxEntriesPerRoot) {
      result.overflowed = true;
      result.partial = true;
      result.root.complete = false;
      result.reasons.push('max_entries_per_root');
      break;
    }

    const absolutePath = path.join(rootInfo.root, entry.name);
    const scanned = scanBundleCandidate({
      rootInfo,
      entryName: entry.name,
      absolutePath,
      limits,
      allowlist,
      receiptOwned,
      excludedRoots,
      previousByKey,
      observedAt,
    });

    if (scanned.skip) {
      result.skipped.push({ name: entry.name, reason: scanned.reason });
      continue;
    }
    if (scanned.overflow) {
      result.overflowed = true;
      result.unsafe.push(scanned);
      // Overflow fails closed for completeness: do not claim a complete generation.
      result.partial = true;
      result.root.complete = false;
      result.reasons.push(scanned.reason);
      continue;
    }
    if (scanned.unsafe) {
      result.unsafe.push(scanned);
      // A bad individual bundle is a blocked observation, not a failed root
      // listing. Keep unrelated skills eligible for assessment and repair.
      result.reasons.push('unsafe_source');
      continue;
    }
    result.skills.push(scanned.skill);
  }

  if (!result.partial) {
    result.root.complete = true;
  }
  return result;
}

function mergeSkills(skillRecords, { previousSkills, observedAt }) {
  const byLogicalId = new Map();
  const previousByLogicalId = new Map((previousSkills || []).map((skill) => [skill.logicalId, skill]));

  for (const record of skillRecords) {
    const existing = byLogicalId.get(record.logicalId);
    if (!existing) {
      byLogicalId.set(record.logicalId, {
        logicalId: record.logicalId,
        observedName: record.observedName,
        treeDigest: record.treeDigest,
        observations: [record.observation],
        harnesses: new Set([record.harness]),
        realPaths: new Set([record.realPath]),
        unsafe: false,
      });
      continue;
    }

    // Duplicate physical source (hard link / same realpath): keep one observation path set.
    const duplicatePhysical = [...existing.realPaths].some((realPath) => sameRealPath(realPath, record.realPath));
    if (duplicatePhysical && existing.treeDigest === record.treeDigest) {
      const already = existing.observations.some((observation) => (
        observation.rootId === record.observation.rootId
        && observation.relativePath === record.observation.relativePath
      ));
      if (!already) existing.observations.push(record.observation);
      existing.harnesses.add(record.harness);
      existing.realPaths.add(record.realPath);
      continue;
    }

    // Byte-identical copy under another root: one logical skill, multiple observations.
    if (existing.treeDigest === record.treeDigest) {
      existing.observations.push(record.observation);
      existing.harnesses.add(record.harness);
      existing.realPaths.add(record.realPath);
      continue;
    }

    // Same directory name, divergent content: keep first digest and mark needs_input later
    // via disposition; still record the extra observation with its own state.
    existing.observations.push({
      ...record.observation,
      state: 'changed',
    });
    existing.harnesses.add(record.harness);
    existing.realPaths.add(record.realPath);
    existing.divergent = true;
  }

  // Also fold pure-unsafe observations that carried a usable logical id.
  return [...byLogicalId.values()].map((entry) => {
    const previous = previousByLogicalId.get(entry.logicalId);
    const states = entry.observations.map((observation) => observation.state);
    const anyUnsafe = entry.unsafe || states.includes('unsafe') || entry.divergent === true;
    let disposition;
    let attention = 'quiet';
    if (anyUnsafe || entry.divergent) {
      disposition = {
        kind: entry.divergent ? 'needs_input' : 'blocked',
        reasonCode: entry.divergent ? 'ambiguous_identity' : 'unsafe_source',
      };
      attention = 'actionable';
    } else {
      // U2 is observation only — discovery never auto-admits.
      disposition = {
        kind: 'needs_input',
        reasonCode: 'incomplete_observation',
      };
      attention = 'quiet';
    }

    // Prefer unchanged when every observation is unchanged.
    if (!anyUnsafe && states.every((state) => state === 'unchanged') && previous) {
      // keep needs_input incomplete_observation — classification is U3
    }

    return {
      logicalId: entry.logicalId,
      observedName: entry.observedName,
      treeDigest: entry.treeDigest,
      observations: entry.observations,
      disposition,
      matrix: defaultMatrix([...entry.harnesses]),
      attention,
      observedAt,
    };
  });
}

function collectPreviousIndex(previousDocument) {
  const byKey = new Map();
  const skills = previousDocument?.skills || [];
  for (const skill of skills) {
    for (const observation of skill.observations || []) {
      byKey.set(`${observation.rootId}:${observation.relativePath}`, skill);
      byKey.set(observation.absolutePath, skill);
      try {
        byKey.set(path.resolve(expandHome(observation.absolutePath)), skill);
      } catch {
        // ignore
      }
    }
  }
  return byKey;
}

function markMissingObservations(previousDocument, currentSkills, rootInfos, observedAt) {
  if (!previousDocument) return [];
  const currentKeys = new Set();
  for (const skill of currentSkills) {
    for (const observation of skill.observations) {
      currentKeys.add(`${observation.rootId}:${observation.relativePath}`);
    }
  }
  const completeRootIds = new Set(
    rootInfos.filter((root) => root.complete === true && root.lifecycle === 'available').map((root) => root.rootId),
  );
  const extras = [];

  for (const skill of previousDocument.skills || []) {
    for (const observation of skill.observations || []) {
      const key = `${observation.rootId}:${observation.relativePath}`;
      if (currentKeys.has(key)) continue;
      // Only record missing when that root produced a complete observation.
      if (!completeRootIds.has(observation.rootId)) continue;
      extras.push({
        logicalId: skill.logicalId,
        observedName: skill.observedName,
        treeDigest: skill.treeDigest,
        observation: {
          rootId: observation.rootId,
          relativePath: observation.relativePath,
          absolutePath: path.resolve(expandHome(observation.absolutePath)),
          state: 'missing',
          observedAt,
        },
        harness: (rootInfos.find((root) => root.rootId === observation.rootId) || {}).harness,
      });
    }
  }
  return extras;
}

function buildGenerationId(fingerprint, observedAt) {
  return `gen-${digest(JSON.stringify({ fingerprint, observedAt })).slice(0, 16)}`;
}

/**
 * Run a bounded inventory observation over registered roots.
 */
function observeInventory(options = {}) {
  const observedAt = options.observedAt || nowIso(options.clock);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const allowlist = options.allowlist || DEFAULT_ALLOWLIST;

  let config;
  let resolved;
  if (options.config) {
    config = options.config;
    resolved = options.resolved || resolveConfigPaths(config);
  } else if (options.configPath || options.controlRoot) {
    const loaded = loadConfig(options.configPath);
    config = loaded.config;
    if (options.controlRoot) {
      config = { ...config, controlRoot: options.controlRoot };
    }
    resolved = resolveConfigPaths(config);
  } else {
    throw new Error('observeInventory requires config or configPath');
  }

  const inventoryPolicy = normalizeInventoryPolicy(config.inventory || defaultInventoryPolicy());
  const limits = inventoryPolicy.limits;
  const registeredRoots = Array.isArray(options.registeredRoots)
    ? options.registeredRoots
    : inventoryPolicy.registeredRoots;

  if (registeredRoots.length > limits.maxRoots) {
    throw new Error(`registeredRoots exceeds maxRoots (${limits.maxRoots})`);
  }

  // Ensure private layout exists when persistence is requested; read-only scans
  // may pass persist=false and an explicit control root layout.
  let layout = options.layout || null;
  if (!layout && options.persist !== false) {
    layout = ensureInventoryStateLayout({
      controlRoot: resolved.controlRoot,
      inventory: inventoryPolicy,
    });
  } else if (!layout && resolved?.controlRoot) {
    // Soft layout paths without creating when caller only wants in-memory.
    const stateRoot = path.join(resolved.controlRoot, inventoryPolicy.state.stateRootName);
    layout = {
      controlRoot: resolved.controlRoot,
      stateRoot,
      sourceStorePath: path.join(stateRoot, inventoryPolicy.state.sourceStoreName),
      exclusionOverlayPath: inventoryPolicy.exclusionOverlayPath
        ? path.resolve(expandHome(inventoryPolicy.exclusionOverlayPath))
        : path.join(stateRoot, 'exclusions.json'),
      observationsPath: path.join(stateRoot, inventoryPolicy.state.observationsName),
      attentionPath: path.join(stateRoot, inventoryPolicy.state.attentionName),
      leasePath: path.join(stateRoot, inventoryPolicy.state.leaseName),
      acceptedGenerationPath: path.join(stateRoot, inventoryPolicy.state.acceptedGenerationName),
      policy: inventoryPolicy,
    };
  }

  const previous = loadPreviousObservations(layout?.observationsPath);
  const previousByKey = collectPreviousIndex(previous.document);

  const excludedRoots = [];
  if (layout?.sourceStorePath) excludedRoots.push(path.resolve(layout.sourceStorePath));
  if (options.excludePaths) {
    for (const item of options.excludePaths) excludedRoots.push(path.resolve(expandHome(item)));
  }

  const rootInfos = [];
  const scanResults = [];
  const adapterDeclarations = declaredAdapterInventoryRoots({ repoRoot });

  for (const registered of registeredRoots) {
    const info = rootLifecycleStatus(registered, { observedAt });
    // Root replacement detection: previous root path for same rootId differs.
    if (previous.document) {
      const prior = previous.document.roots.find((root) => root.rootId === info.rootId);
      if (prior) {
        const priorPath = path.resolve(expandHome(prior.root));
        if (priorPath !== info.root && info.scannable) {
          info.replaced = true;
          info.reasons = [...(info.reasons || []), 'root_replaced'];
        }
      }
    }
    rootInfos.push(info);
  }

  // Completeness is recorded per root before missing/retirement decisions.
  for (const info of rootInfos) {
    const scanned = scanRegisteredRoot(info, {
      limits,
      allowlist,
      excludedRoots,
      previousByKey,
      observedAt,
    });
    // Carry lifecycle from registration/validation.
    scanned.root.lifecycle = info.lifecycle === 'unregistered'
      ? 'unregistered'
      : (info.scannable ? scanned.root.lifecycle : info.lifecycle);
    if (info.replaced) {
      scanned.reasons.push('root_replaced');
      scanned.partial = true;
      scanned.root.complete = false;
      scanned.root.lifecycle = 'stale';
    }
    info.complete = scanned.root.complete === true;
    scanResults.push(scanned);
  }

  const skillRecords = [];
  const unsafeRecords = [];
  let overflowed = false;
  let partial = false;
  const reasons = new Set();

  for (const scanned of scanResults) {
    if (scanned.overflowed) overflowed = true;
    if (scanned.partial) partial = true;
    for (const reason of scanned.reasons) reasons.add(reason);
    for (const skill of scanned.skills) skillRecords.push(skill);
    for (const unsafe of scanned.unsafe) {
      unsafeRecords.push(unsafe);
      if (unsafe.overflow) overflowed = true;
    }
  }

  // Missing observations only after complete roots are known.
  const documentRoots = scanResults.map((scanned) => scanned.root);
  const missingRecords = markMissingObservations(
    previous.document,
    mergeSkills(skillRecords, { previousSkills: previous.document?.skills, observedAt }),
    documentRoots,
    observedAt,
  );
  for (const missing of missingRecords) {
    skillRecords.push({
      logicalId: missing.logicalId,
      observedName: missing.observedName,
      treeDigest: missing.treeDigest,
      realPath: missing.observation.absolutePath,
      observation: missing.observation,
      harness: missing.harness || 'codex',
    });
  }

  // Materialize unsafe observations that still have identity.
  for (const unsafe of unsafeRecords) {
    const logicalId = sanitizeLogicalId(unsafe.observedName || unsafe.observation?.relativePath);
    if (!logicalId || !unsafe.observation) continue;
    skillRecords.push({
      logicalId,
      observedName: unsafe.observedName || unsafe.observation.relativePath,
      treeDigest: unsafe.treeDigest || digest(`unsafe:${logicalId}:${unsafe.reason || 'unknown'}`),
      realPath: unsafe.observation.absolutePath,
      observation: unsafe.observation,
      harness: (documentRoots.find((root) => root.rootId === unsafe.observation.rootId) || {}).harness || 'codex',
      forceUnsafe: true,
    });
  }

  // Force unsafe disposition for forceUnsafe records via divergent/unsafe marker.
  const preparedRecords = skillRecords.map((record) => {
    if (record.forceUnsafe) {
      return {
        ...record,
        observation: { ...record.observation, state: 'unsafe' },
      };
    }
    return record;
  });

  let skills = mergeSkills(preparedRecords, {
    previousSkills: previous.document?.skills,
    observedAt,
  });

  // Exclusions overlay (owner intent) — observation still lists them but disposition owner_excluded.
  let exclusions = [];
  if (layout?.exclusionOverlayPath) {
    const loadedExclusions = loadExclusionOverlay(layout.exclusionOverlayPath);
    if (loadedExclusions.status === 'valid' || loadedExclusions.status === 'absent') {
      exclusions = loadedExclusions.overlay.entries || [];
      const excludedIds = new Set(exclusions.map((entry) => entry.logicalId));
      skills = skills.map((skill) => {
        if (!excludedIds.has(skill.logicalId)) return skill;
        return {
          ...skill,
          disposition: { kind: 'blocked', reasonCode: 'owner_excluded' },
          attention: 'quiet',
        };
      });
    } else {
      // Owner exclusions are a safety control. An unsupported/corrupt control
      // must fail the generation closed instead of being treated as empty.
      partial = true;
      reasons.add('unsupported_exclusion_overlay');
    }
  }

  const complete = documentRoots.length === 0
    ? true
    : documentRoots.every((root) => root.complete === true) && !overflowed && !partial;

  const document = {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generationId: 'pending',
    acceptedGenerationId: previous.document?.acceptedGenerationId || null,
    acceptedAt: previous.document?.acceptedAt || null,
    observedAt,
    roots: documentRoots,
    skills,
    exclusions,
  };

  const meta = {
    complete,
    overflowed,
    partial: partial || !complete,
    reasons: [...reasons].sort(),
    rootCount: documentRoots.length,
    skillCount: skills.length,
    skippedReceiptOwned: scanResults.reduce(
      (sum, scanned) => sum + scanned.skipped.filter((item) => item.reason === 'receipt_owned').length,
      0,
    ),
    skippedSnapshotStore: scanResults.reduce(
      (sum, scanned) => sum + scanned.skipped.filter((item) => item.reason === 'snapshot_store_exclusion').length,
      0,
    ),
    adapterDeclarationCount: adapterDeclarations.length,
  };

  const fingerprint = evidenceFingerprint(document, meta);
  const fingerprintDigest = digest(JSON.stringify(fingerprint));
  const previousFingerprintDigest = previous.fingerprint
    ? digest(JSON.stringify(previous.fingerprint))
    : null;

  const unchanged = Boolean(
    complete
    && previousFingerprintDigest
    && previousFingerprintDigest === fingerprintDigest,
  );

  document.generationId = unchanged && previous.document
    ? previous.document.generationId
    : buildGenerationId(fingerprint, observedAt);

  const validated = validateInventoryDocument(document);
  if (validated.status !== 'valid') {
    throw new Error(validated.reason || 'inventory document invalid after observation');
  }

  let persisted = false;
  let wrote = false;
  if (options.persist !== false && layout?.observationsPath) {
    const shouldWrite = !unchanged;
    // Persist only for changed, missing, unsafe, incomplete, or overflowed evidence.
    if (shouldWrite) {
      // Ensure parent layout exists with owner-only modes.
      ensureInventoryStateLayout({
        controlRoot: resolved.controlRoot,
        inventory: inventoryPolicy,
      });
      const payload = {
        schemaVersion: 'jarvos.skill-inventory-observations/v1',
        savedAt: observedAt,
        fingerprint,
        fingerprintDigest,
        meta,
        document: validated.document,
      };
      atomicWriteJson(layout.observationsPath, payload);
      persisted = true;
      wrote = true;
    } else {
      persisted = true;
      wrote = false;
    }
  }

  let finalDocument = validated.document;
  let finalDigest = validated.digest;
  let assessment = null;

  // U3: optional classify/auto-admit. Default off for pure observation callers.
  if (options.assess === true && layout?.sourceStorePath && layout?.acceptedGenerationPath) {
    const { assessInventory } = require('./skill-assessment');
    const harnessRoots = Object.entries(config.harnesses || {}).map(([harness, value]) => ({
      harness,
      root: path.resolve(expandHome(value.root)),
    }));
    assessment = assessInventory({
      config,
      resolved,
      document: validated.document,
      sourceStorePath: layout.sourceStorePath,
      acceptedGenerationPath: layout.acceptedGenerationPath,
      acceptedAt: observedAt,
      harnessRoots,
      publicCatalog: readJsonSafe(resolved.publicCatalogPath, null),
      localOverlay: readJsonSafe(resolved.localOverlayPath, null),
      reviewer: options.reviewer || null,
      complete,
      autoAdmit: options.autoAdmit !== false && complete,
      persist: options.persist !== false,
    });
    if (assessment.ok) {
      const revalidated = validateInventoryDocument(assessment.document);
      if (revalidated.status !== 'valid') {
        throw new Error(revalidated.reason || 'inventory document invalid after assessment');
      }
      finalDocument = revalidated.document;
      finalDigest = revalidated.digest;

      if (options.persist !== false && assessment.mutate && assessment.localOverlay) {
        // Point local source root at the immutable generation capture and merge overlay.
        if (assessment.localSourceRoot || assessment.sourceRoot) {
          config.localSourceRoot = assessment.localSourceRoot || assessment.sourceRoot;
        }
        const { validateLocalOverlay } = require('./catalog');
        const validatedOverlay = validateLocalOverlay(assessment.localOverlay);
        if (validatedOverlay.status === 'valid') {
          atomicWriteJson(resolved.localOverlayPath, validatedOverlay.overlay);
        }
        if (options.saveConfig === true) {
          const { saveConfig } = require('./config');
          saveConfig(config, options.configPath || undefined);
        }
      }

      // A healthy repeat must not refresh durable timestamps or receipts.
      // Persist assessment evidence only when this observation or its accepted
      // generation actually changed.
      if (options.persist !== false && layout.observationsPath && (wrote || assessment.mutate)) {
        const payload = {
          schemaVersion: 'jarvos.skill-inventory-observations/v1',
          savedAt: observedAt,
          fingerprint,
          fingerprintDigest,
          meta: {
            ...meta,
            assessedAt: observedAt,
            admissions: (assessment.admissions || []).length,
          },
          document: finalDocument,
        };
        atomicWriteJson(layout.observationsPath, payload);
      }
    }
  }

  const outward = serializeOutwardStatus(finalDocument, {
    counts: {
      skills: finalDocument.skills.length,
      shared: finalDocument.skills.filter((skill) => skill.disposition.kind === 'shared').length,
      already_managed: finalDocument.skills.filter((skill) => skill.disposition.kind === 'already_managed').length,
      harness_local: finalDocument.skills.filter((skill) => skill.disposition.kind === 'harness_local').length,
      blocked: finalDocument.skills.filter((skill) => skill.disposition.kind === 'blocked').length,
      needs_input: finalDocument.skills.filter((skill) => skill.disposition.kind === 'needs_input').length,
      actionable: finalDocument.skills.filter((skill) => skill.attention === 'actionable').length,
      exclusions: finalDocument.exclusions.length,
    },
  });

  return {
    ok: true,
    mutate: wrote || Boolean(assessment?.mutate),
    unchanged: assessment?.mutate ? false : unchanged,
    complete,
    overflowed,
    partial: meta.partial,
    reasons: meta.reasons,
    generationId: finalDocument.generationId,
    digest: finalDigest,
    fingerprintDigest,
    document: finalDocument,
    status: outward,
    assessment,
    meta: {
      ...meta,
      wrote,
      persisted,
      previousGenerationId: previous.document?.generationId || null,
      observationsPath: layout?.observationsPath || null,
      admitted: assessment?.admissions?.length || 0,
    },
    // Owner-local only; CLI must opt in.
    inspect: null,
  };
}

function inventoryOperator(options = {}) {
  if (options.inspect === true) {
    const capabilities = new Set(options.principal?.capabilities || []);
    if (options.principal?.kind !== 'owner' || !capabilities.has('inventory.inspect_private')) {
      throw new Error('owner inspect requires an authorized owner principal');
    }
  }
  const result = observeInventory({
    configPath: options.configPath,
    controlRoot: options.controlRoot,
    persist: options.persist !== false,
    observedAt: options.observedAt,
    registeredRoots: options.registeredRoots,
    // Classification/auto-admit is opt-in (U3). Default inventory status stays
    // observation-first so discovery never silently mutates accepted state.
    assess: options.assess === true,
    autoAdmit: options.autoAdmit !== false,
    reviewer: options.reviewer || null,
    saveConfig: options.saveConfig === true,
  });

  if (options.inspect === true) {
    return {
      ok: true,
      mode: 'inspect',
      ...result,
      inspect: serializeOwnerInspect(result.document, { authorized: true }),
      // Keep document out of default CLI inspect JSON unless explicitly requested.
      document: options.includeDocument === true ? result.document : undefined,
    };
  }

  // Default operator surface is path-redacted outward status only.
  // When assess is requested, include redacted assessment metadata + optional document.
  if (options.assess === true) {
    return {
      ok: true,
      mode: 'assess',
      unchanged: result.unchanged,
      complete: result.complete,
      overflowed: result.overflowed,
      partial: result.partial,
      reasons: result.reasons,
      generationId: result.generationId,
      digest: result.digest,
      mutate: result.mutate,
      status: result.status,
      assessment: result.assessment
        ? {
          ok: result.assessment.ok,
          mutate: result.assessment.mutate,
          admissions: result.assessment.admissions || [],
          // never include sourceRoot/absolute paths here
        }
        : null,
      document: options.includeDocument === true ? result.document : undefined,
      meta: {
        wrote: result.meta.wrote,
        skillCount: result.meta.skillCount,
        rootCount: result.meta.rootCount,
        admitted: result.meta.admitted || 0,
        previousGenerationId: result.meta.previousGenerationId,
      },
    };
  }

  return {
    ok: true,
    mode: 'status',
    unchanged: result.unchanged,
    complete: result.complete,
    overflowed: result.overflowed,
    partial: result.partial,
    reasons: result.reasons,
    generationId: result.generationId,
    digest: result.digest,
    mutate: result.mutate,
    status: result.status,
    meta: {
      wrote: result.meta.wrote,
      skillCount: result.meta.skillCount,
      rootCount: result.meta.rootCount,
      skippedReceiptOwned: result.meta.skippedReceiptOwned,
      skippedSnapshotStore: result.meta.skippedSnapshotStore,
      previousGenerationId: result.meta.previousGenerationId,
    },
  };
}

function registerAdapterRootsOperator(options = {}) {
  const loaded = loadConfig(options.configPath);
  const trustClass = options.trustClass || 'markdown-only';
  const built = buildRegisteredRootsFromAdapters({
    config: loaded.config,
    trustClass,
    lifecycle: 'available',
  });
  // Strip non-contract fields before persistence.
  const registeredRoots = built.map((root) => ({
    rootId: root.rootId,
    harness: root.harness,
    root: root.root,
    trustClass: root.trustClass,
    lifecycle: root.lifecycle,
  }));
  const config = {
    ...loaded.config,
    inventory: {
      ...loaded.config.inventory,
      // Registration only — never auto-enable live inventory.
      enabled: loaded.config.inventory?.enabled === true,
      registeredRoots,
    },
  };
  if (options.persist === false) {
    return {
      ok: true,
      persisted: false,
      registeredRoots,
      config,
    };
  }
  const { saveConfig } = require('./config');
  const saved = saveConfig(config, loaded.path);
  return {
    ok: true,
    persisted: true,
    registeredRoots: saved.config.inventory.registeredRoots,
    configPath: saved.path,
  };
}

module.exports = {
  DEFAULT_ALLOWLIST,
  loadHarnessAdapter,
  declaredAdapterInventoryRoots,
  buildRegisteredRootsFromAdapters,
  observeInventory,
  inventoryOperator,
  registerAdapterRootsOperator,
  sanitizeLogicalId,
  evidenceFingerprint,
};
