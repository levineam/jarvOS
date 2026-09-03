'use strict';

/**
 * Public catalog + local-overlay contracts for portable skill distribution.
 *
 * This module is a validation boundary, not a workspace scanner. Ambient
 * directories never become catalog entries. Private overlay bodies stay out of
 * public package artifacts via redacted identities.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CATALOG_SCHEMA_VERSION = 'jarvos.shared-skill-catalog/v1';
const OVERLAY_SCHEMA_VERSION = 'jarvos.shared-skill-local-overlay/v1';
const EFFECTIVE_CATALOG_SCHEMA_VERSION = 'jarvos.shared-skill-effective-catalog/v1';

const PUBLIC_SOURCE_KIND = 'public-catalog';
const LOCAL_OVERLAY_SOURCE_KIND = 'local-overlay';

const SUPPORTED_HARNESSES = Object.freeze(['codex', 'claude', 'openclaw', 'hermes']);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const SKILL_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const RELATIVE_PATH_RE = /^(?!\.)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const DEFAULT_ALLOWED_BUNDLE_GLOBS = Object.freeze([
  'SKILL.md',
  'scripts/**',
  'assets/**',
  'references/**',
  'templates/**',
]);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function catalogDigest(value) {
  return digest(JSON.stringify(canonical(value)));
}

function exactDigest(value, field) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${field} must be an exact SHA-256 digest`);
  }
  return value.toLowerCase();
}

function nonEmptyObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function assertSkillId(value, field) {
  if (typeof value !== 'string' || !SKILL_ID_RE.test(value)) {
    throw new Error(`${field} must be a canonical skill id`);
  }
  return value;
}

function containedRelativePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\\')) {
    throw new Error(`${field} must be a contained relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || !RELATIVE_PATH_RE.test(normalized)) {
    throw new Error(`${field} must be a contained relative path`);
  }
  return normalized;
}

function normalizeHarnesses(value, field, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (!allowEmpty && value.length === 0) throw new Error(`${field} must name at least one harness`);
  const seen = new Set();
  const harnesses = value.map((harness) => {
    if (!SUPPORTED_HARNESSES.includes(harness)) {
      throw new Error(`${field} names an unsupported harness: ${harness}`);
    }
    if (seen.has(harness)) throw new Error(`${field} duplicates harness: ${harness}`);
    seen.add(harness);
    return harness;
  });
  return harnesses.slice().sort();
}

function normalizeAllowlist(value, field) {
  if (value === undefined) return [...DEFAULT_ALLOWED_BUNDLE_GLOBS];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array of relative paths or globs`);
  }
  const seen = new Set();
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\\') || path.isAbsolute(entry)) {
      throw new Error(`${field}[${index}] must be a relative path or glob`);
    }
    const normalized = path.posix.normalize(entry);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`${field}[${index}] escapes the bundle root`);
    }
    if (seen.has(normalized)) throw new Error(`${field} duplicates ${normalized}`);
    seen.add(normalized);
    return normalized;
  }).sort();
}

function matchAllowlist(relativePath, allowlist) {
  return allowlist.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
    }
    if (pattern.includes('*')) {
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*');
      return new RegExp(`^${escaped}$`).test(relativePath);
    }
    return relativePath === pattern;
  });
}

function assertSafeOwnedNode(stat, label, { directory = false, file = false } = {}) {
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (directory && !stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (file && !stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(`${label} must not be group- or world-writable`);
  }
}

function assertSafePathBelow(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its root`);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    if (stat.isDirectory()) assertSafeOwnedNode(stat, `${label} directory`, { directory: true });
    if (current !== root && typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${label} has unsafe ownership`);
    }
    if (current !== root && (stat.mode & 0o022) !== 0) {
      throw new Error(`${label} has unsafe permissions`);
    }
  }
  return target;
}

function listBundleFiles(bundleRoot) {
  const files = [];
  function walk(directory, prefix = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`bundle contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) {
        assertSafeOwnedNode(stat, `bundle directory ${relative}`, { directory: true });
        walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`bundle entry must be a regular file: ${relative}`);
      assertSafeOwnedNode(stat, `bundle file ${relative}`, { file: true });
      files.push({ relativePath: relative.split(path.sep).join('/'), absolutePath: absolute });
    }
  }
  walk(bundleRoot);
  return files;
}

function computeBundleTree(bundleRoot, { allowlist = DEFAULT_ALLOWED_BUNDLE_GLOBS, expectedDigest = null } = {}) {
  if (!bundleRoot) throw new Error('bundleRoot is required');
  const rootCandidate = path.resolve(bundleRoot);
  if (!fs.existsSync(rootCandidate)) throw new Error('bundleRoot does not exist');
  const rootStat = fs.lstatSync(rootCandidate);
  assertSafeOwnedNode(rootStat, 'bundleRoot', { directory: true });
  const root = fs.realpathSync(rootCandidate);
  const skillMd = assertSafePathBelow(root, path.join(root, 'SKILL.md'), 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new Error('bundle must contain SKILL.md');
  const skillStat = fs.lstatSync(skillMd);
  assertSafeOwnedNode(skillStat, 'SKILL.md', { file: true });

  const normalizedAllowlist = normalizeAllowlist(allowlist, 'allowlist');
  const files = listBundleFiles(root);
  if (files.length === 0) throw new Error('bundle contains no files');
  if (!files.some((file) => file.relativePath === 'SKILL.md')) {
    throw new Error('bundle must contain SKILL.md');
  }

  const entries = files.map((file) => {
    if (!matchAllowlist(file.relativePath, normalizedAllowlist)) {
      throw new Error(`bundle contains unexpected path outside allowlist: ${file.relativePath}`);
    }
    const bytes = fs.readFileSync(file.absolutePath);
    return {
      path: file.relativePath,
      digest: digest(bytes),
      bytes: bytes.length,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const treeDigest = digest(JSON.stringify(entries.map((entry) => ({ path: entry.path, digest: entry.digest }))));
  if (expectedDigest !== null && expectedDigest !== undefined) {
    const expected = exactDigest(expectedDigest, 'expected tree digest');
    if (expected !== treeDigest) throw new Error('bundle tree digest drift');
  }

  return {
    root,
    allowlist: normalizedAllowlist,
    entries: entries.map(({ path: entryPath, digest: entryDigest, bytes }) => ({
      path: entryPath,
      digest: entryDigest,
      bytes,
    })),
    treeDigest,
  };
}

function normalizeVerificationPolicy(value, field, allowedHarnesses) {
  if (value === undefined || value === null) {
    return Object.fromEntries(allowedHarnesses.map((harness) => [harness, {
      tier: 'adapter-declared',
      remoteModelProbe: false,
    }]));
  }
  const source = nonEmptyObject(value, field);
  const normalized = {};
  for (const harness of allowedHarnesses) {
    const policy = source[harness];
    if (policy === undefined) {
      normalized[harness] = { tier: 'adapter-declared', remoteModelProbe: false };
      continue;
    }
    const item = nonEmptyObject(policy, `${field}.${harness}`);
    const tier = item.tier || 'adapter-declared';
    if (typeof tier !== 'string' || tier.length === 0) {
      throw new Error(`${field}.${harness}.tier is required`);
    }
    if (item.remoteModelProbe !== undefined && typeof item.remoteModelProbe !== 'boolean') {
      throw new Error(`${field}.${harness}.remoteModelProbe must be boolean`);
    }
    normalized[harness] = {
      tier,
      remoteModelProbe: item.remoteModelProbe === true,
    };
  }
  for (const harness of Object.keys(source)) {
    if (!allowedHarnesses.includes(harness)) {
      throw new Error(`${field} declares unallowed harness: ${harness}`);
    }
  }
  return normalized;
}

// These are jarvOS distribution facts.  In particular, do not infer either
// from a skill's prose or from the older `requires` field: that field belongs
// to the skill itself and may describe something quite different.
function normalizeSkillDependencies(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set();
  return value.map((dependency, index) => {
    const id = assertSkillId(dependency, `${field}[${index}]`);
    if (seen.has(id)) throw new Error(`${field} duplicates ${id}`);
    seen.add(id);
    return id;
  }).sort();
}

function normalizeRuntimePrerequisites(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const seen = new Set();
  return value.map((prerequisite, index) => {
    // Keep the portable contract deliberately small: a prerequisite is an
    // opaque, stable identifier. Harness adapters provide the evidence.
    if (typeof prerequisite !== 'string' || !/^[a-z][a-z0-9._:-]{0,127}$/i.test(prerequisite)) {
      throw new Error(`${field}[${index}] must be a stable prerequisite id`);
    }
    if (seen.has(prerequisite)) throw new Error(`${field} duplicates ${prerequisite}`);
    seen.add(prerequisite);
    return prerequisite;
  }).sort();
}

function normalizePublicEntry(entry) {
  const source = nonEmptyObject(entry, 'public catalog entry');
  const id = assertSkillId(source.id || source.name, 'public catalog entry id');
  const allowedHarnesses = normalizeHarnesses(
    source.allowedHarnesses || SUPPORTED_HARNESSES.slice(),
    `allowedHarnesses for ${id}`,
  );
  const bundle = nonEmptyObject(source.bundle || source, `bundle for ${id}`);
  const relativeRoot = containedRelativePath(
    bundle.root || bundle.path || source.path,
    `bundle root for ${id}`,
  );
  const allowlist = normalizeAllowlist(bundle.allowlist || source.allowlist, `allowlist for ${id}`);
  const treeDigest = exactDigest(bundle.treeDigest || source.treeDigest || source.digest, `tree digest for ${id}`);
  const requiredTools = Array.isArray(source.requiredTools)
    ? source.requiredTools.map((tool, index) => {
      if (typeof tool !== 'string' || !tool.trim()) throw new Error(`requiredTools[${index}] for ${id} is invalid`);
      return tool.trim();
    }).sort()
    : [];
  const renderer = typeof source.renderer === 'string' && source.renderer
    ? source.renderer
    : 'raw-skill-bundle';
  return {
    id,
    sourceKind: PUBLIC_SOURCE_KIND,
    allowedHarnesses,
    skillDependencies: normalizeSkillDependencies(source.skillDependencies, `skillDependencies for ${id}`),
    runtimePrerequisites: normalizeRuntimePrerequisites(source.runtimePrerequisites, `runtimePrerequisites for ${id}`),
    requiredTools,
    renderer,
    verification: normalizeVerificationPolicy(source.verification, `verification for ${id}`, allowedHarnesses),
    bundle: {
      root: relativeRoot,
      allowlist,
      treeDigest,
    },
  };
}

function normalizeOverlayEntry(entry) {
  const source = nonEmptyObject(entry, 'local overlay entry');
  const id = assertSkillId(source.id || source.name, 'local overlay entry id');
  const allowedHarnesses = normalizeHarnesses(
    source.allowedHarnesses || SUPPORTED_HARNESSES.slice(),
    `allowedHarnesses for ${id}`,
  );
  const bundle = nonEmptyObject(source.bundle || source, `bundle for ${id}`);
  const relativeRoot = containedRelativePath(
    bundle.root || bundle.path || source.path,
    `bundle root for ${id}`,
  );
  const allowlist = normalizeAllowlist(bundle.allowlist || source.allowlist, `allowlist for ${id}`);
  const treeDigest = exactDigest(bundle.treeDigest || source.treeDigest || source.digest, `tree digest for ${id}`);
  const verification = normalizeVerificationPolicy(source.verification, `verification for ${id}`, allowedHarnesses);
  // Overlay admission authorizes installation/use. Remote model probes need an
  // explicit per-harness flag and default to false.
  return {
    id,
    sourceKind: LOCAL_OVERLAY_SOURCE_KIND,
    allowedHarnesses,
    skillDependencies: normalizeSkillDependencies(source.skillDependencies, `skillDependencies for ${id}`),
    runtimePrerequisites: normalizeRuntimePrerequisites(source.runtimePrerequisites, `runtimePrerequisites for ${id}`),
    requiredTools: Array.isArray(source.requiredTools)
      ? source.requiredTools.map((tool, index) => {
        if (typeof tool !== 'string' || !tool.trim()) throw new Error(`requiredTools[${index}] for ${id} is invalid`);
        return tool.trim();
      }).sort()
      : [],
    renderer: typeof source.renderer === 'string' && source.renderer ? source.renderer : 'raw-skill-bundle',
    verification,
    bundle: {
      root: relativeRoot,
      allowlist,
      treeDigest,
    },
  };
}

function validatePublicCatalog(catalog) {
  const source = nonEmptyObject(catalog, 'public catalog');
  if (source.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    return {
      status: 'unsupported',
      mutate: false,
      reason: `unsupported public catalog schemaVersion: ${source.schemaVersion || 'missing'}`,
    };
  }
  if (!Array.isArray(source.entries)) throw new Error('public catalog must contain an explicit entries array');
  const entries = source.entries.map(normalizePublicEntry);
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`public catalog entry is duplicated: ${entry.id}`);
    seen.add(entry.id);
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  const normalized = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    entries,
  };
  return {
    status: 'valid',
    mutate: false,
    catalog: normalized,
    digest: catalogDigest(normalized),
  };
}

function validateLocalOverlay(overlay) {
  if (overlay === undefined || overlay === null) {
    return {
      status: 'absent',
      mutate: false,
      overlay: {
        schemaVersion: OVERLAY_SCHEMA_VERSION,
        entries: [],
      },
      digest: catalogDigest({ schemaVersion: OVERLAY_SCHEMA_VERSION, entries: [] }),
    };
  }
  const source = nonEmptyObject(overlay, 'local overlay');
  if (source.schemaVersion !== OVERLAY_SCHEMA_VERSION) {
    return {
      status: 'unsupported',
      mutate: false,
      reason: `unsupported local overlay schemaVersion: ${source.schemaVersion || 'missing'}`,
    };
  }
  if (!Array.isArray(source.entries)) throw new Error('local overlay must contain an explicit entries array');
  const entries = source.entries.map(normalizeOverlayEntry);
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`local overlay entry is duplicated: ${entry.id}`);
    seen.add(entry.id);
  }
  entries.sort((left, right) => left.id.localeCompare(right.id));
  const normalized = {
    schemaVersion: OVERLAY_SCHEMA_VERSION,
    entries,
  };
  return {
    status: 'valid',
    mutate: false,
    overlay: normalized,
    digest: catalogDigest(normalized),
  };
}

function composeEffectiveCatalog({ publicCatalog, localOverlay } = {}) {
  const publicResult = validatePublicCatalog(publicCatalog);
  if (publicResult.status !== 'valid') {
    return {
      status: publicResult.status,
      mutate: false,
      reason: publicResult.reason,
    };
  }
  const overlayResult = validateLocalOverlay(localOverlay);
  if (overlayResult.status === 'unsupported') {
    return {
      status: 'unsupported',
      mutate: false,
      reason: overlayResult.reason,
    };
  }

  const publicIds = new Set(publicResult.catalog.entries.map((entry) => entry.id));
  for (const entry of overlayResult.overlay.entries) {
    if (publicIds.has(entry.id)) {
      throw new Error(`local overlay cannot override public canonical id: ${entry.id}`);
    }
  }

  const entries = [
    ...publicResult.catalog.entries.map((entry) => ({ ...entry })),
    ...overlayResult.overlay.entries.map((entry) => ({ ...entry })),
  ].sort((left, right) => left.id.localeCompare(right.id));

  const pairs = entries.flatMap((entry) => entry.allowedHarnesses.map((harness) => ({
    id: entry.id,
    harness,
    sourceKind: entry.sourceKind,
    treeDigest: entry.bundle.treeDigest,
    remoteModelProbe: entry.verification[harness]?.remoteModelProbe === true,
  }))).sort((left, right) => `${left.id}:${left.harness}`.localeCompare(`${right.id}:${right.harness}`));

  const effective = {
    schemaVersion: EFFECTIVE_CATALOG_SCHEMA_VERSION,
    publicCatalogDigest: publicResult.digest,
    localOverlayDigest: overlayResult.digest,
    entries,
    pairs,
  };

  return {
    status: 'valid',
    mutate: false,
    catalog: effective,
    digest: catalogDigest(effective),
    pairs,
  };
}

function attestCatalogBundle(entry, { sourceRoot, expectedTreeDigest = null } = {}) {
  if (!entry || !entry.bundle) throw new Error('catalog entry with bundle is required');
  if (!sourceRoot) throw new Error('sourceRoot is required');
  const rootCandidate = path.resolve(sourceRoot);
  if (!fs.existsSync(rootCandidate)) throw new Error('sourceRoot does not exist');
  const rootStat = fs.lstatSync(rootCandidate);
  assertSafeOwnedNode(rootStat, 'sourceRoot', { directory: true });
  const root = fs.realpathSync(rootCandidate);
  const bundleRoot = assertSafePathBelow(root, path.resolve(root, entry.bundle.root), `bundle root for ${entry.id}`);
  const tree = computeBundleTree(bundleRoot, {
    allowlist: entry.bundle.allowlist,
    expectedDigest: expectedTreeDigest || entry.bundle.treeDigest,
  });
  return {
    id: entry.id,
    sourceKind: entry.sourceKind,
    root: tree.root,
    treeDigest: tree.treeDigest,
    entries: tree.entries,
  };
}

function redactEffectiveCatalog(result) {
  const catalog = result?.catalog || result;
  if (!catalog || typeof catalog !== 'object') return null;
  return {
    schemaVersion: catalog.schemaVersion,
    digest: result?.digest || catalogDigest(catalog),
    publicCatalogDigest: catalog.publicCatalogDigest || null,
    localOverlayDigest: catalog.localOverlayDigest || null,
    entries: (catalog.entries || []).map((entry) => ({
      id: entry.id,
      sourceKind: entry.sourceKind,
      allowedHarnesses: entry.allowedHarnesses,
      skillDependencies: entry.skillDependencies || [],
      runtimePrerequisites: entry.runtimePrerequisites || [],
      requiredTools: entry.requiredTools || [],
      renderer: entry.renderer,
      verification: entry.verification,
      bundle: {
        treeDigest: entry.bundle.treeDigest,
        // Keep only redacted structural facts. Never serialize absolute roots or bodies.
        fileCount: Array.isArray(entry.bundle.entries) ? entry.bundle.entries.length : undefined,
      },
    })),
    pairs: catalog.pairs || [],
  };
}

function assertPublicOnlyCatalog(catalog) {
  const validated = validatePublicCatalog(catalog);
  if (validated.status !== 'valid') {
    throw new Error(validated.reason || 'public catalog is invalid');
  }
  return validated.catalog;
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  OVERLAY_SCHEMA_VERSION,
  EFFECTIVE_CATALOG_SCHEMA_VERSION,
  PUBLIC_SOURCE_KIND,
  LOCAL_OVERLAY_SOURCE_KIND,
  SUPPORTED_HARNESSES,
  DEFAULT_ALLOWED_BUNDLE_GLOBS,
  catalogDigest,
  computeBundleTree,
  validatePublicCatalog,
  validateLocalOverlay,
  composeEffectiveCatalog,
  attestCatalogBundle,
  redactEffectiveCatalog,
  assertPublicOnlyCatalog,
};
