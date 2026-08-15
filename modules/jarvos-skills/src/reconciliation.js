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
const { resolveCollisionAlias } = require('./collision-alias');
const {
  STATE_DIR,
  readReceipt,
  validateReceipt,
  atomicWriteReceipt,
  removeReceipt,
} = require('./receipts');

const ALIAS_FILE = 'shared-skill-aliases.json';
const ALIAS_STATE_VERSION = 1;
const JOURNAL_FILE = 'shared-skill-reconcile.journal.json';

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
  if (!fs.existsSync(root)) throw new Error(`root does not exist: ${root}`);
  const stat = fs.lstatSync(root);
  assertSafeOwnedDirectory(stat, 'managed skill root');
  return fs.realpathSync(root);
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

function controlPaths(controlRoot) {
  const root = safeRoot(controlRoot);
  return {
    root,
    aliasFile: path.join(root, ALIAS_FILE),
    journalFile: path.join(root, JOURNAL_FILE),
  };
}

function readAliasState(controlRoot) {
  const paths = controlPaths(controlRoot);
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

function sourceRootFor(entry, { publicSourceRoot, localSourceRoot }) {
  if (entry.sourceKind === LOCAL_OVERLAY_SOURCE_KIND) {
    if (!localSourceRoot) throw new Error(`localSourceRoot is required for ${entry.id}`);
    return localSourceRoot;
  }
  if (!publicSourceRoot) throw new Error(`publicSourceRoot is required for ${entry.id}`);
  return publicSourceRoot;
}

function classifyPair({ entry, harness, effectiveName, sourceRoot, catalogDigest, aliasRevision }) {
  const target = targetDir(harness.root, effectiveName);
  const receiptRaw = readReceipt(harness.root, effectiveName);
  const receipt = validateReceipt(receiptRaw);
  const source = attestCatalogBundle(entry, { sourceRoot });

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
    // Unmanaged incumbent at the effective name. Never overwrite.
    return {
      status: 'unmanaged',
      action: 'preserve',
      target,
      receipt: null,
      source,
      observed,
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

function resolveAliasesForCatalog({ catalog, harnesses, aliasState, reviewer = null }) {
  const aliases = { ...aliasState.data.aliases };
  const notices = [];
  const occupiedByHarness = Object.fromEntries(
    harnesses.map((harness) => [harness.id, new Set(listOccupiedNames(harness.root))]),
  );

  for (const entry of catalog.entries) {
    if (aliases[entry.id]) continue;
    const enrolled = harnesses.filter((harness) => entry.allowedHarnesses.includes(harness.id));
    // Names occupied by unmanaged targets on any enrolled harness block the
    // canonical id and any candidate that is already present somewhere.
    const occupied = new Set();
    for (const harness of enrolled) {
      for (const name of occupiedByHarness[harness.id] || []) occupied.add(name);
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
      forceAlias: occupied.has(entry.id),
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

  const harnesses = options.harnesses.map((harness) => {
    if (!harness || typeof harness.id !== 'string') throw new Error('harness id is required');
    return {
      id: harness.id,
      root: safeRoot(harness.root),
      adapter: harness.adapter || null,
    };
  });

  const aliasState = readAliasState(options.controlRoot);
  // Recover incomplete journals before planning new work.
  recoverJournal(aliasState);

  const { aliases, notices } = resolveAliasesForCatalog({
    catalog,
    harnesses,
    aliasState,
    reviewer: options.reviewer || null,
  });

  const catalogDigest = options.catalogDigest || catalog.digest || sha256(JSON.stringify(catalog));
  const pairs = [];

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

    for (const harness of harnesses.filter((item) => entry.allowedHarnesses.includes(item.id))) {
      const classified = classifyPair({
        entry,
        harness,
        effectiveName,
        sourceRoot,
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
        ...classified,
      };
      pair.generation = pairGeneration(pair);
      pairs.push(pair);
    }
  }

  // De-selection: receipt-owned targets for ids no longer in the catalog.
  const selectedIds = new Set(catalog.entries.map((entry) => entry.id));
  for (const harness of harnesses) {
    const stateDir = path.join(harness.root, STATE_DIR);
    if (!fs.existsSync(stateDir)) continue;
    for (const file of fs.readdirSync(stateDir)) {
      if (!file.endsWith('.json')) continue;
      const receipt = validateReceipt(readJsonIfPresent(path.join(stateDir, file), null));
      if (!receipt || selectedIds.has(receipt.id)) continue;
      if (receipt.harness && receipt.harness !== harness.id) continue;
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
    ok: pairs.every((pair) => ['clean', 'missing', 'outdated', 'retire'].includes(pair.status)
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
    if (fs.existsSync(target)) {
      const backup = `${target}.jarvos-bak-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      fs.renameSync(target, backup);
      try {
        fs.renameSync(staging, target);
        fs.rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        try {
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
          fs.renameSync(backup, target);
        } catch {
          // Preserve backup path in the thrown error context.
        }
        throw error;
      }
    } else {
      fs.renameSync(staging, target);
    }
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
  // Incomplete apply: never delete local edits. Drop the journal so the next
  // plan re-observes live targets and receipts.
  clearJournal(aliasState.journalFile);
  return { recovered: true, journal };
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

function applyCatalogReconciliation(plan, options = {}) {
  if (!plan || !Array.isArray(plan.pairs) || !plan.aliasFile || !plan.journalFile) {
    throw new Error('catalog reconciliation plan is required');
  }

  const aliasCommit = commitAliasesIfNeeded(plan);
  const aliasRevision = aliasCommit.revision;

  writeJournal(plan.journalFile, {
    version: 1,
    phase: 'applying',
    catalogDigest: plan.catalogDigest,
    aliasRevision,
    pairIds: plan.pairs.map((pair) => `${pair.id}:${pair.harness}`),
  });

  const applied = [];
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
          fs.rmSync(pair.target, { recursive: true, force: false });
        }
        removeReceipt(path.dirname(pair.target), pair.effectiveName);
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

      stageBundleCopy(freshSource, pair.target);
      atomicWriteReceipt(path.dirname(pair.target), {
        version: 1,
        id: pair.id,
        effectiveName: pair.effectiveName,
        harness: pair.harness,
        treeDigest: freshSource.treeDigest,
        catalogDigest: plan.catalogDigest,
        aliasRevision,
        targetPath: pair.target,
        verificationTier: options.verificationTier || 'receipt-owned',
      });

      applied.push({
        id: pair.id,
        harness: pair.harness,
        effectiveName: pair.effectiveName,
        status: pair.status,
        applied: true,
        target: pair.target,
      });
    }

    clearJournal(plan.journalFile);
    return {
      ok: true,
      applied,
      aliasRevision,
      notices: plan.notices || [],
    };
  } catch (error) {
    writeJournal(plan.journalFile, {
      version: 1,
      phase: 'failed',
      catalogDigest: plan.catalogDigest,
      aliasRevision,
      error: error.message,
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
