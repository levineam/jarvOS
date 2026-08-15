'use strict';

/**
 * Immutable owner-local source snapshots for assessed skill bundles.
 *
 * This module deliberately has no projection, interpreter, or network path.
 * It copies an already assessed allowlisted tree with no-follow reads, then
 * re-attests both source and capture before an atomic generation pointer moves.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('./config');
const { computeBundleTree } = require('./catalog');

const ID_RE = /^[a-z][a-z0-9-]{0,63}$/;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertPrivateDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
  return fs.realpathSync(directory);
}

function ensureSourceStore(storeRoot) {
  const root = assertPrivateDirectory(storeRoot, 'source store');
  const snapshots = assertPrivateDirectory(path.join(root, 'snapshots'), 'source snapshots');
  return { root, snapshots };
}

function assertSafeFile(stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0 || stat.nlink > 1) throw new Error(`${label} has unsafe permissions or links`);
}

function copyNoFollow(source, destination) {
  const before = fs.lstatSync(source);
  assertSafeFile(before, 'source file');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(source, flags);
  try {
    const opened = fs.fstatSync(fd);
    assertSafeFile(opened, 'opened source file');
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode || opened.uid !== before.uid) {
      throw new Error('source file changed during capture');
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error('source file changed during capture');
    }
    fs.writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(destination, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

function captureBundle(sourcePath, destination, { expectedDigest, treeDigest, allowlist }) {
  const expected = expectedDigest || treeDigest;
  const sourceTree = computeBundleTree(sourcePath, { allowlist, expectedDigest: expected });
  const preCapture = computeBundleTree(sourceTree.root, { allowlist, expectedDigest: expected });
  if (preCapture.treeDigest !== sourceTree.treeDigest) throw new Error('source tree drift before capture');

  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  fs.chmodSync(destination, 0o700);
  for (const entry of sourceTree.entries) {
    const source = path.join(sourceTree.root, entry.path);
    const target = path.join(destination, entry.path);
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.chmodSync(parent, 0o700);
    copyNoFollow(source, target);
  }

  const captured = computeBundleTree(destination, { allowlist, expectedDigest: expected });
  const postCapture = computeBundleTree(sourceTree.root, { allowlist, expectedDigest: expected });
  if (postCapture.treeDigest !== captured.treeDigest || captured.treeDigest !== expected) {
    throw new Error('source tree drift during capture');
  }
  return captured;
}

function snapshotPath(storeRoot, logicalId, treeDigest) {
  if (!ID_RE.test(logicalId)) throw new Error('logicalId is invalid');
  if (!/^[a-f0-9]{64}$/i.test(treeDigest || '')) throw new Error('expected tree digest is invalid');
  return path.join(storeRoot, 'snapshots', logicalId, treeDigest.toLowerCase());
}

function findSnapshot(storeRoot, logicalId, treeDigest) {
  const candidate = snapshotPath(storeRoot, logicalId, treeDigest);
  if (!fs.existsSync(candidate)) return null;
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
  try {
    const tree = computeBundleTree(candidate, { expectedDigest: treeDigest });
    return { path: candidate, treeDigest: tree.treeDigest };
  } catch {
    return null;
  }
}

function commitSnapshot({ storeRoot, logicalId, sourceBundlePath, expectedTreeDigest, allowlist } = {}) {
  const store = ensureSourceStore(storeRoot);
  if (!ID_RE.test(logicalId || '')) throw new Error('logicalId is invalid');
  const sourceTree = computeBundleTree(sourceBundlePath, { allowlist, expectedDigest: expectedTreeDigest || null });
  const target = snapshotPath(store.root, logicalId, sourceTree.treeDigest);
  const existing = findSnapshot(store.root, logicalId, sourceTree.treeDigest);
  if (existing) return { created: false, ...existing, relativeRoot: path.posix.join('snapshots', logicalId, sourceTree.treeDigest) };
  const parent = assertPrivateDirectory(path.dirname(target), 'snapshot identity directory');
  const staging = path.join(parent, `.${sourceTree.treeDigest}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    captureBundle(sourceTree.root, staging, { allowlist: sourceTree.allowlist, expectedDigest: sourceTree.treeDigest });
    fs.renameSync(staging, target);
    return { created: true, path: target, treeDigest: sourceTree.treeDigest, relativeRoot: path.posix.join('snapshots', logicalId, sourceTree.treeDigest) };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    throw error;
  }
}

function readAcceptedGeneration(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('accepted generation must be an owner-only regular file');
  }
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || value.schemaVersion !== 'jarvos.skill-source-generation/v1' || !Array.isArray(value.entries)) {
    throw new Error('accepted generation is invalid');
  }
  return value;
}

function captureAcceptedGeneration({ sourceStorePath, acceptedGenerationPath, generationId, acceptedAt, candidates }) {
  if (typeof generationId !== 'string' || !/^gen-[a-z0-9-]+$/i.test(generationId)) throw new Error('generationId is invalid');
  if (!Array.isArray(candidates) || candidates.length === 0) return { changed: false, generation: readAcceptedGeneration(acceptedGenerationPath), sourceRoot: null };
  const store = ensureSourceStore(sourceStorePath).root;
  const selected = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set();
  for (const candidate of selected) {
    if (!candidate || !ID_RE.test(candidate.id) || ids.has(candidate.id)) throw new Error('snapshot candidate id is invalid or duplicated');
    if (typeof candidate.sourcePath !== 'string' || !candidate.sourcePath || typeof candidate.treeDigest !== 'string') throw new Error('snapshot candidate is incomplete');
    ids.add(candidate.id);
  }

  const target = path.join(store, generationId);
  const existing = readAcceptedGeneration(acceptedGenerationPath);
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('existing source generation is unsafe');
    const entries = selected.map((candidate) => {
      const tree = computeBundleTree(path.join(target, candidate.id), { allowlist: candidate.allowlist, expectedDigest: candidate.treeDigest });
      return { id: candidate.id, treeDigest: tree.treeDigest, allowlist: tree.allowlist };
    });
    if (existing && existing.generationId === generationId
      && JSON.stringify(existing.entries.map((entry) => ({ id: entry.id, treeDigest: entry.treeDigest }))) === JSON.stringify(entries.map((entry) => ({ id: entry.id, treeDigest: entry.treeDigest })))) {
      return { changed: false, generation: existing, sourceRoot: target };
    }
    throw new Error('existing source generation does not match assessment');
  }

  const staging = path.join(store, `.${generationId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const entries = selected.map((candidate) => {
      const tree = captureBundle(candidate.sourcePath, path.join(staging, candidate.id), candidate);
      return { id: candidate.id, treeDigest: tree.treeDigest, allowlist: tree.allowlist };
    });
    const generation = {
      schemaVersion: 'jarvos.skill-source-generation/v1',
      generationId,
      acceptedAt,
      sourceRoot: target,
      entries,
    };
    // Rename makes every captured tree visible as one immutable generation.
    fs.renameSync(staging, target);
    atomicWriteJson(acceptedGenerationPath, generation);
    return { changed: true, generation, sourceRoot: target };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    throw error;
  }
}

module.exports = {
  ensureSourceStore,
  findSnapshot,
  commitSnapshot,
  captureAcceptedGeneration,
  readAcceptedGeneration,
};
