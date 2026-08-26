'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { HARNESSES } = require('./contracts');
const {
  normalizeRelativeTarget,
  normalizeLocalReceipt,
  serializeLocalReceipt,
  receiptRelativePath,
  LOCAL_RECEIPT_SCHEMA_VERSION,
} = require('./receipts');

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,79}$/;

const COMPATIBILITY_VALUES = Object.freeze(['compatible', 'unsupported', 'incompatible']);

const DECLARED_TARGET_KEYS = Object.freeze([
  'id',
  'harness',
  'relativeTarget',
  'content',
  'catalogGeneration',
  'generationDigest',
  'renderedDigest',
  'outputDigest',
  'compatibility',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function normalizeContent(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  throw new Error(`${label} must be a string or Buffer`);
}

function normalizeDeclaredTarget(value, index) {
  const label = `declared target[${index}]`;
  if (!isObject(value)) throw new Error(`${label} must be an object`);

  const keys = Object.keys(value);
  const allowedSet = new Set(DECLARED_TARGET_KEYS);
  const unknown = keys.filter((key) => !allowedSet.has(key));
  const missing = DECLARED_TARGET_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);

  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) throw new Error(`${label}.id must be a canonical id`);
  if (!HARNESSES.includes(value.harness)) throw new Error(`${label}.harness is invalid`);
  const relativeTarget = normalizeRelativeTarget(value.relativeTarget);
  const content = normalizeContent(value.content, `${label}.content`);
  const catalogGeneration = exactDigest(value.catalogGeneration, `${label}.catalogGeneration`);
  const generationDigest = exactDigest(value.generationDigest, `${label}.generationDigest`);
  const renderedDigest = exactDigest(value.renderedDigest, `${label}.renderedDigest`);
  const outputDigest = exactDigest(value.outputDigest, `${label}.outputDigest`);

  const computedDigest = crypto.createHash('sha256').update(content).digest('hex');
  if (outputDigest !== computedDigest) throw new Error(`${label}.outputDigest does not match content`);

  if (!COMPATIBILITY_VALUES.includes(value.compatibility)) {
    throw new Error(`${label}.compatibility must be compatible, unsupported, or incompatible`);
  }

  return {
    id: value.id,
    harness: value.harness,
    relativeTarget,
    content,
    catalogGeneration,
    generationDigest,
    renderedDigest,
    outputDigest,
    compatibility: value.compatibility,
  };
}

function normalizeDeclaredTargets(targets) {
  const label = 'declared targets';
  if (!Array.isArray(targets) || targets.length === 0) throw new Error(`${label} must be a nonempty array`);

  const normalized = targets.map((target, index) => normalizeDeclaredTarget(target, index));

  const seenIds = new Set();
  const seenTargets = new Set();
  for (const target of normalized) {
    if (seenIds.has(target.id)) throw new Error(`${label} contains duplicate id: ${target.id}`);
    seenIds.add(target.id);
    if (seenTargets.has(target.relativeTarget)) {
      throw new Error(`${label} contains duplicate relativeTarget: ${target.relativeTarget}`);
    }
    seenTargets.add(target.relativeTarget);
  }

  return normalized.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const ENTRY_KEYS = Object.freeze([
  'id',
  'harness',
  'relativeTarget',
  'compatibility',
  'status',
  'action',
  'blocked',
  'catalogGeneration',
  'generationDigest',
  'renderedDigest',
  'outputDigest',
  'observedDigest',
  'receiptDigest',
  'raceFence',
]);

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalValueForDigest(value) {
  if (Array.isArray(value)) return value.map(canonicalValueForDigest);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValueForDigest(value[key])]));
}

function stableJsonDigest(value) {
  return sha256Hex(Buffer.from(JSON.stringify(canonicalValueForDigest(value)), 'utf8'));
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertSafeDirStat(stat, label) {
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) throw new Error(`${label} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} must not be group- or world-writable`);
}

function ensureRoot(root, createRoot) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('root must be a nonempty string');
  if (!path.isAbsolute(root)) throw new Error('root must be an absolute path');

  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (!createRoot) throw new Error('root does not exist');

    const parent = path.dirname(root);
    let parentStat;
    try {
      parentStat = fs.lstatSync(parent);
    } catch (parentErr) {
      if (parentErr.code === 'ENOENT') throw new Error('root parent directory does not exist');
      throw parentErr;
    }
    assertSafeDirStat(parentStat, 'root parent directory');

    fs.mkdirSync(root, { recursive: false, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    stat = fs.lstatSync(root);
  }

  assertSafeDirStat(stat, 'root');
  return fs.realpathSync(root);
}

// Walks each path component below realRoot for `relativeTarget`, verifying that every
// existing component is safe (no symlinks, current-uid owned, non-final components are
// directories that aren't group/world-writable) before the final component is examined.
function inspectPath(realRoot, relativeTarget) {
  const segments = relativeTarget.split('/');
  const resolved = path.resolve(realRoot, relativeTarget);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (resolved !== realRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`relative path ${relativeTarget} escapes root`);
  }

  const uid = currentUid();
  let current = realRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err.code === 'ENOENT') return { exists: false, absolutePath: resolved };
      throw err;
    }
    assertSafeDirStat(stat, `path component ${current}`);
  }

  const finalPath = path.join(current, segments[segments.length - 1]);
  let finalStat;
  try {
    finalStat = fs.lstatSync(finalPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, absolutePath: finalPath };
    throw err;
  }

  if (finalStat.isSymbolicLink()) throw new Error(`${finalPath} must not be a symlink`);
  if (!finalStat.isFile()) throw new Error(`${finalPath} must be a regular file`);
  if (uid !== null && finalStat.uid !== uid) throw new Error(`${finalPath} must be owned by the current user`);
  if (finalStat.nlink !== 1) throw new Error(`${finalPath} must not be hard-linked`);
  if ((finalStat.mode & 0o077) !== 0) throw new Error(`${finalPath} must not be group- or world-accessible`);

  return { exists: true, absolutePath: finalPath, stat: finalStat };
}

function readReceiptIfPresent(realRoot, id) {
  const relativeReceiptPath = receiptRelativePath(id);
  const inspected = inspectPath(realRoot, relativeReceiptPath);
  if (!inspected.exists) {
    return { relativeReceiptPath, exists: false, valid: false, receipt: null, receiptDigest: null };
  }
  const raw = fs.readFileSync(inspected.absolutePath);
  const receiptDigest = sha256Hex(raw);
  let receipt = null;
  let valid = true;
  try {
    receipt = normalizeLocalReceipt(JSON.parse(raw.toString('utf8')));
  } catch {
    valid = false;
  }
  return { relativeReceiptPath, exists: true, valid, receipt, receiptDigest };
}

function receiptIdentityMatches(receipt, target) {
  return receipt.id === target.id
    && receipt.harness === target.harness
    && receipt.relativeTarget === target.relativeTarget;
}

function desiredLocalReceipt(target) {
  return {
    schemaVersion: LOCAL_RECEIPT_SCHEMA_VERSION,
    id: target.id,
    harness: target.harness,
    relativeTarget: target.relativeTarget,
    catalogGeneration: target.catalogGeneration,
    generationDigest: target.generationDigest,
    renderedDigest: target.renderedDigest,
    outputDigest: target.outputDigest,
  };
}

function receiptsDeepEqual(a, b) {
  return JSON.stringify(canonicalValueForDigest(a)) === JSON.stringify(canonicalValueForDigest(b));
}

function classifyTarget(target, realRoot) {
  if (target.compatibility === 'unsupported' || target.compatibility === 'incompatible') {
    const targetInspected = inspectPath(realRoot, target.relativeTarget);
    const receiptInfo = readReceiptIfPresent(realRoot, target.id);
    return {
      status: target.compatibility,
      action: 'preserve',
      blocked: true,
      observedDigest: targetInspected.exists ? sha256Hex(fs.readFileSync(targetInspected.absolutePath)) : null,
      receiptDigest: receiptInfo.receiptDigest,
    };
  }

  const targetInspected = inspectPath(realRoot, target.relativeTarget);
  const receiptInfo = readReceiptIfPresent(realRoot, target.id);

  const observedDigest = targetInspected.exists ? sha256Hex(fs.readFileSync(targetInspected.absolutePath)) : null;
  const identityMatches = receiptInfo.valid && receiptIdentityMatches(receiptInfo.receipt, target);

  if (!targetInspected.exists) {
    if (!receiptInfo.exists) {
      return { status: 'missing', action: 'create', blocked: false, observedDigest, receiptDigest: receiptInfo.receiptDigest };
    }
    if (identityMatches) {
      return { status: 'missing', action: 'create', blocked: false, observedDigest, receiptDigest: receiptInfo.receiptDigest };
    }
    return { status: 'conflict', action: 'preserve', blocked: true, observedDigest, receiptDigest: receiptInfo.receiptDigest };
  }

  if (!receiptInfo.exists) {
    return { status: 'unknown', action: 'preserve', blocked: true, observedDigest, receiptDigest: receiptInfo.receiptDigest };
  }

  if (!identityMatches) {
    return { status: 'conflict', action: 'preserve', blocked: true, observedDigest, receiptDigest: receiptInfo.receiptDigest };
  }

  if (observedDigest !== receiptInfo.receipt.outputDigest) {
    return { status: 'local_modified', action: 'preserve', blocked: true, observedDigest, receiptDigest: receiptInfo.receiptDigest };
  }

  const desired = desiredLocalReceipt(target);
  if (receiptsDeepEqual(receiptInfo.receipt, desired)) {
    return { status: 'clean', action: 'no-op', blocked: false, observedDigest, receiptDigest: receiptInfo.receiptDigest };
  }
  return { status: 'outdated', action: 'update', blocked: false, observedDigest, receiptDigest: receiptInfo.receiptDigest };
}

function buildEntry(target, classification) {
  const fields = {
    id: target.id,
    harness: target.harness,
    relativeTarget: target.relativeTarget,
    compatibility: target.compatibility,
    status: classification.status,
    action: classification.action,
    blocked: classification.blocked,
    catalogGeneration: target.catalogGeneration,
    generationDigest: target.generationDigest,
    renderedDigest: target.renderedDigest,
    outputDigest: target.outputDigest,
    observedDigest: classification.observedDigest,
    receiptDigest: classification.receiptDigest,
  };
  const raceFence = stableJsonDigest(fields);
  return { ...fields, raceFence };
}

function planInstructionProjection({ root, targets, createRoot = false } = {}) {
  const normalizedTargets = normalizeDeclaredTargets(targets);
  const realRoot = ensureRoot(root, createRoot === true);

  const entries = normalizedTargets.map((target) => {
    const classification = classifyTarget(target, realRoot);
    return buildEntry(target, classification);
  });

  const ok = entries.every((entry) => entry.blocked === false);
  const planGeneration = stableJsonDigest({ version: 1, entries });

  return {
    version: 1,
    root: realRoot,
    planGeneration,
    entries,
    ok,
  };
}

const STATUS_VALUES = Object.freeze([
  'missing', 'conflict', 'unknown', 'local_modified', 'clean', 'outdated', 'unsupported', 'incompatible',
]);
const ACTION_VALUES = Object.freeze(['create', 'preserve', 'no-op', 'update']);

// (status, action, blocked) triples that classifyTarget can actually produce.
const ALLOWED_STATUS_ACTION_BLOCKED = Object.freeze([
  'missing|create|false',
  'conflict|preserve|true',
  'unknown|preserve|true',
  'local_modified|preserve|true',
  'clean|no-op|false',
  'outdated|update|false',
  'unsupported|preserve|true',
  'incompatible|preserve|true',
]);

function optionalDigest(value, label) {
  if (value === null) return null;
  return exactDigest(value, label);
}

function assertValidEntry(entry, index) {
  const label = `plan.entries[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(entry);
  const allowedSet = new Set(ENTRY_KEYS);
  const unknown = keys.filter((key) => !allowedSet.has(key));
  const missing = ENTRY_KEYS.filter((key) => !Object.hasOwn(entry, key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  if (missing.length) throw new Error(`${label} is missing required fields: ${missing.join(', ')}`);

  if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) throw new Error(`${label}.id must be a canonical id`);
  if (!HARNESSES.includes(entry.harness)) throw new Error(`${label}.harness is invalid`);
  const relativeTarget = normalizeRelativeTarget(entry.relativeTarget);
  if (!COMPATIBILITY_VALUES.includes(entry.compatibility)) throw new Error(`${label}.compatibility is invalid`);
  if (!STATUS_VALUES.includes(entry.status)) throw new Error(`${label}.status is invalid`);
  if (!ACTION_VALUES.includes(entry.action)) throw new Error(`${label}.action is invalid`);
  if (typeof entry.blocked !== 'boolean') throw new Error(`${label}.blocked must be a boolean`);

  const combo = `${entry.status}|${entry.action}|${entry.blocked}`;
  if (!ALLOWED_STATUS_ACTION_BLOCKED.includes(combo)) {
    throw new Error(`${label} has an invalid status/action/blocked combination`);
  }

  exactDigest(entry.catalogGeneration, `${label}.catalogGeneration`);
  exactDigest(entry.generationDigest, `${label}.generationDigest`);
  exactDigest(entry.renderedDigest, `${label}.renderedDigest`);
  exactDigest(entry.outputDigest, `${label}.outputDigest`);
  optionalDigest(entry.observedDigest, `${label}.observedDigest`);
  optionalDigest(entry.receiptDigest, `${label}.receiptDigest`);

  if (typeof entry.raceFence !== 'string' || !SHA256_RE.test(entry.raceFence)) {
    throw new Error(`${label}.raceFence must be a lowercase SHA-256 digest`);
  }

  const fields = {
    id: entry.id,
    harness: entry.harness,
    relativeTarget,
    compatibility: entry.compatibility,
    status: entry.status,
    action: entry.action,
    blocked: entry.blocked,
    catalogGeneration: entry.catalogGeneration,
    generationDigest: entry.generationDigest,
    renderedDigest: entry.renderedDigest,
    outputDigest: entry.outputDigest,
    observedDigest: entry.observedDigest,
    receiptDigest: entry.receiptDigest,
  };
  const expectedRaceFence = stableJsonDigest(fields);
  if (entry.raceFence !== expectedRaceFence) throw new Error(`${label}.raceFence does not match its fields`);

  return entry;
}

function assertValidPlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan must be an object');
  if (plan.version !== 1) throw new Error('plan.version is unsupported');
  if (typeof plan.root !== 'string' || plan.root.length === 0 || !path.isAbsolute(plan.root)) {
    throw new Error('plan.root must be a nonempty absolute path');
  }
  if (typeof plan.planGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(plan.planGeneration)) {
    throw new Error('plan.planGeneration must be a lowercase SHA-256 digest');
  }
  if (!Array.isArray(plan.entries)) throw new Error('plan.entries must be an array');
  if (typeof plan.ok !== 'boolean') throw new Error('plan.ok must be a boolean');

  plan.entries.forEach((entry, index) => assertValidEntry(entry, index));

  const seenIds = new Set();
  const seenTargets = new Set();
  let previousId = null;
  for (const entry of plan.entries) {
    if (seenIds.has(entry.id)) throw new Error(`plan.entries contains duplicate id: ${entry.id}`);
    seenIds.add(entry.id);
    if (seenTargets.has(entry.relativeTarget)) {
      throw new Error(`plan.entries contains duplicate relativeTarget: ${entry.relativeTarget}`);
    }
    seenTargets.add(entry.relativeTarget);
    if (previousId !== null && previousId > entry.id) {
      throw new Error('plan.entries must be sorted by id');
    }
    previousId = entry.id;
  }

  const expectedOk = plan.entries.every((entry) => entry.blocked === false);
  if (plan.ok !== expectedOk) throw new Error('plan.ok does not match entries');

  const expectedPlanGeneration = stableJsonDigest({ version: plan.version, entries: plan.entries });
  if (plan.planGeneration !== expectedPlanGeneration) throw new Error('plan.planGeneration does not match entries');
}

function summarizeProjectionPlan(plan) {
  assertValidPlan(plan);
  const entries = plan.entries.map((entry) => {
    const copy = {};
    for (const key of ENTRY_KEYS) copy[key] = entry[key];
    return copy;
  });
  return {
    version: plan.version,
    planGeneration: plan.planGeneration,
    entries,
    ok: plan.ok,
  };
}

// -- applyInstructionProjection ------------------------------------------------------------

const FAULT_STAGES = Object.freeze([
  'before-target-replace',
  'after-target-replace',
  'before-receipt-replace',
  'after-receipt-replace',
  // Fixed internal stages fired from inside atomicReplace itself, strictly after the rename has
  // landed and the *Written bookkeeping callback has run, but before post-write capture/
  // verification. They exist to deterministically exercise the rollback path for failures in
  // that narrow window; their faultInjector context stays the same content-free {id,
  // relativeTarget} shape as every other stage.
  'after-target-rename-before-verify',
  'after-receipt-rename-before-verify',
]);

function invokeFaultInjector(faultInjector, stage, entry) {
  if (typeof faultInjector !== 'function') return;
  faultInjector(stage, { id: entry.id, relativeTarget: entry.relativeTarget });
}

// Enforces the same final-file safety as inspectPath (regular non-symlink file, current-uid
// ownership when available, single hard link, no group/world permission bits) so a snapshot can
// never be captured from (or compared against) a file an attacker has swapped for something unsafe.
function captureFileSnapshot(absPath) {
  let stat;
  try {
    stat = fs.lstatSync(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false };
    throw err;
  }
  if (stat.isSymbolicLink()) throw new Error(`${absPath} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${absPath} must be a regular file`);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) throw new Error(`${absPath} must be owned by the current user`);
  if (stat.nlink !== 1) throw new Error(`${absPath} must not be hard-linked`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${absPath} must not be group- or world-accessible`);
  const bytes = fs.readFileSync(absPath);
  return {
    exists: true, bytes, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino,
  };
}

function fileSnapshotMatches(current, snapshot) {
  if (current.exists !== snapshot.exists) return false;
  if (!current.exists) return true;
  return current.dev === snapshot.dev
    && current.ino === snapshot.ino
    && current.mode === snapshot.mode
    && Buffer.compare(current.bytes, snapshot.bytes) === 0;
}

function randomTempName(dir) {
  return path.join(dir, `.jarvos-instruction-projection-tmp-${crypto.randomBytes(16).toString('hex')}`);
}

function writeTempFile(tmpName, bytes, mode) {
  const fd = fs.openSync(tmpName, 'wx', mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmpName, mode);
}

// Writes bytes to a fresh temp file, verifies the destination has not moved since it was
// snapshotted, renames into place, and re-reads the destination to return the exact safe
// post-write snapshot (including dev/ino) that callers can later use to detect replacement.
// The temp file is removed on every failure path.
//
// `onRenamed` is invoked synchronously immediately after the rename (and temp-file bookkeeping
// update) succeeds, before any subsequent operation that can throw (the internal post-rename
// fault hook, and post-write capture/verification). It receives the exact snapshot of the fully
// written temp file taken just before the rename — since rename preserves inode identity, that
// snapshot is already the correct post-rename identity of absPath. Callers use this to update
// rollback bookkeeping (the *Written flag and *PostWrite snapshot) so a failure afterward is
// still correctly recognized as "this artifact was written" and gets rolled back.
function atomicReplace(absPath, bytes, mode, priorSnapshot, tempFiles, onRenamed, postRenameFault) {
  const dir = path.dirname(absPath);
  const tmpName = randomTempName(dir);
  tempFiles.add(tmpName);

  let renamed = false;
  let preparedSnapshot;
  try {
    writeTempFile(tmpName, bytes, mode);

    const current = captureFileSnapshot(absPath);
    if (!fileSnapshotMatches(current, priorSnapshot)) {
      throw new Error(`${path.basename(absPath)} changed unexpectedly before write`);
    }

    preparedSnapshot = captureFileSnapshot(tmpName);

    fs.renameSync(tmpName, absPath);
    renamed = true;
    tempFiles.delete(tmpName);
  } finally {
    if (!renamed) {
      tempFiles.delete(tmpName);
      try {
        fs.unlinkSync(tmpName);
      } catch (err) {
        if (err.code !== 'ENOENT') { /* best effort cleanup */ }
      }
    }
  }

  if (typeof onRenamed === 'function') onRenamed(preparedSnapshot);
  if (typeof postRenameFault === 'function') postRenameFault();

  const postWrite = captureFileSnapshot(absPath);
  if (!postWrite.exists || Buffer.compare(postWrite.bytes, bytes) !== 0 || postWrite.mode !== mode) {
    throw new Error(`${path.basename(absPath)} failed post-write verification`);
  }
  return postWrite;
}

function restoreFileSnapshot(absPath, snapshot, tempFiles) {
  if (!snapshot.exists) {
    try {
      fs.unlinkSync(absPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return;
  }
  const dir = path.dirname(absPath);
  const tmpName = randomTempName(dir);
  tempFiles.add(tmpName);
  writeTempFile(tmpName, snapshot.bytes, snapshot.mode);
  fs.renameSync(tmpName, absPath);
  tempFiles.delete(tmpName);
  fs.chmodSync(absPath, snapshot.mode);
}

function ensureDirsForRelativeFile(realRoot, relativeFilePath, createdDirs) {
  const segments = relativeFilePath.split('/');
  let current = realRoot;
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
      createdDirs.push(current);
      stat = fs.lstatSync(current);
      assertSafeDirStat(stat, `path component ${current}`);
      continue;
    }
    assertSafeDirStat(stat, `path component ${current}`);
  }
}

// Restores absPath to priorSnapshot only if its current contents still exactly match the
// snapshot captured immediately after this call wrote it. If the file was replaced by someone
// else in the meantime (different inode/device, different bytes, different mode), the concurrent
// edit is preserved and an error is thrown instead of clobbering it.
function restoreIfUnchangedSincePostWrite(absPath, postWriteSnapshot, priorSnapshot, tempFiles) {
  const current = captureFileSnapshot(absPath);
  if (!fileSnapshotMatches(current, postWriteSnapshot)) {
    throw new Error(`${path.basename(absPath)} was modified after write; preserving concurrent edit instead of rolling back`);
  }
  restoreFileSnapshot(absPath, priorSnapshot, tempFiles);
}

function rollbackApply(snapshots, createdDirs, tempFiles) {
  const errors = [];
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const snap = snapshots[i];
    // Only artifacts this call actually replaced are eligible for rollback; anything never
    // written must be left with its original inode and bytes untouched.
    if (snap.targetWritten) {
      try {
        restoreIfUnchangedSincePostWrite(snap.targetPath, snap.targetPostWrite, snap.targetSnapshot, tempFiles);
      } catch (err) {
        errors.push(err);
      }
    }
    if (snap.receiptWritten) {
      try {
        restoreIfUnchangedSincePostWrite(snap.receiptPath, snap.receiptPostWrite, snap.receiptSnapshot, tempFiles);
      } catch (err) {
        errors.push(err);
      }
    }
  }
  for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
    try {
      fs.rmdirSync(createdDirs[i]);
    } catch (err) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT') errors.push(err);
    }
  }
  for (const tmpName of tempFiles) {
    try {
      fs.unlinkSync(tmpName);
    } catch {
      // best effort
    }
  }
  return errors;
}

function assertTargetsMatchPlan(normalizedTargets, plan) {
  if (normalizedTargets.length !== plan.entries.length) {
    throw new Error('supplied targets do not match plan entries');
  }
  for (let i = 0; i < plan.entries.length; i += 1) {
    if (normalizedTargets[i].id !== plan.entries[i].id) {
      throw new Error('supplied targets do not match plan entries');
    }
  }
}

function applyInstructionProjection(plan, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('options must be an object');
  }
  const { targets, faultInjector } = options;
  if (faultInjector !== undefined && typeof faultInjector !== 'function') {
    throw new Error('faultInjector must be a function');
  }

  assertValidPlan(plan);
  if (plan.ok !== true) throw new Error('plan is not ok; apply aborted before mutation');

  const normalizedTargets = normalizeDeclaredTargets(targets);
  assertTargetsMatchPlan(normalizedTargets, plan);

  const freshPlan = planInstructionProjection({ root: plan.root, targets, createRoot: false });
  if (freshPlan.planGeneration !== plan.planGeneration) {
    throw new Error('plan generation changed since planning; apply aborted before mutation');
  }
  if (freshPlan.entries.length !== plan.entries.length) {
    throw new Error('plan entries changed since planning; apply aborted before mutation');
  }
  for (let i = 0; i < plan.entries.length; i += 1) {
    if (freshPlan.entries[i].id !== plan.entries[i].id) {
      throw new Error('plan entries changed since planning; apply aborted before mutation');
    }
    if (freshPlan.entries[i].raceFence !== plan.entries[i].raceFence) {
      throw new Error(`entry ${plan.entries[i].id} raceFence changed since planning; apply aborted before mutation`);
    }
  }
  if (freshPlan.ok !== true) throw new Error('plan is not ok; apply aborted before mutation');

  const realRoot = plan.root;
  const createdDirs = [];
  const snapshots = [];
  const tempFiles = new Set();
  const resultEntries = [];

  try {
    for (let i = 0; i < plan.entries.length; i += 1) {
      const entry = plan.entries[i];
      const target = normalizedTargets[i];

      if (entry.action === 'no-op') {
        resultEntries.push({
          id: entry.id,
          status: entry.status,
          action: entry.action,
          applied: false,
          outputDigest: entry.outputDigest,
        });
        continue;
      }

      const singlePlan = planInstructionProjection({ root: realRoot, targets: [target], createRoot: false });
      const singleEntry = singlePlan.entries[0];
      if (singleEntry.raceFence !== entry.raceFence) {
        throw new Error(`entry ${entry.id} raceFence changed since planning; aborting before mutation`);
      }

      const targetPath = path.join(realRoot, entry.relativeTarget);
      const relativeReceiptPath = receiptRelativePath(entry.id);
      const receiptPath = path.join(realRoot, relativeReceiptPath);

      const targetSnapshot = captureFileSnapshot(targetPath);
      const receiptSnapshot = captureFileSnapshot(receiptPath);
      const snapshotRecord = {
        targetPath,
        targetSnapshot,
        targetWritten: false,
        targetPostWrite: null,
        receiptPath,
        receiptSnapshot,
        receiptWritten: false,
        receiptPostWrite: null,
      };
      snapshots.push(snapshotRecord);

      ensureDirsForRelativeFile(realRoot, entry.relativeTarget, createdDirs);
      ensureDirsForRelativeFile(realRoot, relativeReceiptPath, createdDirs);

      const receiptBytes = Buffer.from(serializeLocalReceipt(desiredLocalReceipt(target)), 'utf8');

      invokeFaultInjector(faultInjector, 'before-target-replace', entry);
      atomicReplace(targetPath, target.content, 0o600, targetSnapshot, tempFiles, (snap) => {
        // Runs immediately after the rename lands, before post-write capture/verification can
        // throw, so rollback always recognizes this artifact as written even if verification fails.
        snapshotRecord.targetWritten = true;
        snapshotRecord.targetPostWrite = snap;
      }, () => invokeFaultInjector(faultInjector, 'after-target-rename-before-verify', entry));
      invokeFaultInjector(faultInjector, 'after-target-replace', entry);

      invokeFaultInjector(faultInjector, 'before-receipt-replace', entry);
      atomicReplace(receiptPath, receiptBytes, 0o600, receiptSnapshot, tempFiles, (snap) => {
        snapshotRecord.receiptWritten = true;
        snapshotRecord.receiptPostWrite = snap;
      }, () => invokeFaultInjector(faultInjector, 'after-receipt-rename-before-verify', entry));
      invokeFaultInjector(faultInjector, 'after-receipt-replace', entry);

      resultEntries.push({
        id: entry.id,
        status: entry.status,
        action: entry.action,
        applied: true,
        outputDigest: entry.outputDigest,
      });
    }
  } catch (err) {
    const rollbackErrors = rollbackApply(snapshots, createdDirs, tempFiles);
    if (rollbackErrors.length > 0) {
      // Deliberately omits file content and the underlying rollback error messages, which may
      // reference concurrently-written bytes; only the original failure is retained as `cause`.
      const aggregate = new Error('apply failed and rollback failed');
      aggregate.cause = err;
      aggregate.rollbackErrorCount = rollbackErrors.length;
      throw aggregate;
    }
    throw err;
  }

  return {
    version: 1,
    planGeneration: plan.planGeneration,
    ok: true,
    entries: resultEntries,
  };
}

// -- disableInstructionProjection ----------------------------------------------------------

const DISABLE_FAULT_STAGES = Object.freeze([
  'before-target-remove',
  'after-target-remove',
  'before-receipt-remove',
  'after-receipt-remove',
]);

const DISABLE_OK_STATUSES = Object.freeze(new Set(['missing', 'owned']));

function normalizeDisableIds(ids, normalizedTargets) {
  if (ids === undefined) return normalizedTargets.map((target) => target.id);

  const label = 'ids';
  if (!Array.isArray(ids) || ids.length === 0) throw new Error(`${label} must be a nonempty array`);

  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`${label} must contain canonical ids`);
    if (seen.has(id)) throw new Error(`${label} must not contain duplicates`);
    seen.add(id);
  }

  const targetIds = new Set(normalizedTargets.map((target) => target.id));
  for (const id of seen) {
    if (!targetIds.has(id)) throw new Error(`${label} contains an id not present in targets: ${id}`);
  }

  return normalizedTargets.map((target) => target.id).filter((id) => seen.has(id));
}

// Classifies a single target for disable without any mutation. Ownership authority comes only
// from a valid local receipt whose id/harness/relativeTarget exactly match the declared target;
// the receipt's outputDigest (not the declared target's, which may reflect a newer desired
// generation) is the ownership fence against the bytes actually on disk.
function classifyForDisable(target, realRoot) {
  const targetInspected = inspectPath(realRoot, target.relativeTarget);
  const receiptInfo = readReceiptIfPresent(realRoot, target.id);
  const identityMatches = receiptInfo.valid && receiptIdentityMatches(receiptInfo.receipt, target);

  if (!targetInspected.exists) {
    if (!receiptInfo.exists) return { status: 'missing', action: 'no-op', receiptInfo };
    if (!identityMatches) return { status: 'conflict', action: 'preserve', receiptInfo };
    return { status: 'missing', action: 'remove-receipt', receiptInfo };
  }

  if (!receiptInfo.exists) return { status: 'unknown', action: 'preserve', receiptInfo };
  if (!identityMatches) return { status: 'conflict', action: 'preserve', receiptInfo };

  const observedDigest = sha256Hex(fs.readFileSync(targetInspected.absolutePath));
  if (observedDigest !== receiptInfo.receipt.outputDigest) {
    return { status: 'local_modified', action: 'preserve', receiptInfo };
  }
  return { status: 'owned', action: 'remove', receiptInfo };
}

function invokeDisableFaultInjector(faultInjector, stage, target) {
  if (typeof faultInjector !== 'function') return;
  faultInjector(stage, { id: target.id, relativeTarget: target.relativeTarget });
}

// Restores every artifact this call removed, in reverse removal order, but only if its path is
// still absent; a concurrently recreated path is preserved untouched and reported as an error so
// the caller raises a sanitized aggregate rather than clobbering someone else's file.
function rollbackDisable(removedSnapshots, tempFiles) {
  const errors = [];
  try {
    for (let i = removedSnapshots.length - 1; i >= 0; i -= 1) {
      const item = removedSnapshots[i];
      let stillAbsent;
      try {
        fs.lstatSync(item.path);
        stillAbsent = false;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          errors.push(err);
          continue;
        }
        stillAbsent = true;
      }
      if (!stillAbsent) {
        errors.push(new Error(`${path.basename(item.path)} was recreated concurrently; preserving it instead of restoring`));
        continue;
      }
      try {
        restoreFileSnapshot(item.path, item.snapshot, tempFiles);
      } catch (err) {
        errors.push(err);
      }
    }
  } finally {
    for (const tmpName of tempFiles) {
      try {
        fs.unlinkSync(tmpName);
      } catch (err) {
        if (err.code !== 'ENOENT') errors.push(err);
      }
    }
  }
  return errors;
}

function disableInstructionProjection({
  root, targets, ids, faultInjector,
} = {}) {
  if (faultInjector !== undefined && typeof faultInjector !== 'function') {
    throw new Error('faultInjector must be a function');
  }

  const normalizedTargets = normalizeDeclaredTargets(targets);
  const realRoot = ensureRoot(root, false);
  const selectedIds = normalizeDisableIds(ids, normalizedTargets);
  const targetById = new Map(normalizedTargets.map((target) => [target.id, target]));

  const removedSnapshots = [];
  const entries = [];

  try {
    for (const id of selectedIds) {
      const target = targetById.get(id);
      const classification = classifyForDisable(target, realRoot);

      if (classification.action === 'no-op') {
        entries.push({ id, status: classification.status, action: 'no-op' });
        continue;
      }

      if (classification.action === 'preserve') {
        entries.push({ id, status: classification.status, action: 'preserve' });
        continue;
      }

      const relativeReceiptPath = receiptRelativePath(id);
      const receiptPath = path.join(realRoot, relativeReceiptPath);
      const receiptOutputDigest = classification.receiptInfo.receipt.outputDigest;

      if (classification.action === 'remove-receipt') {
        const receiptSnapshot = captureFileSnapshot(receiptPath);
        if (!receiptSnapshot.exists) throw new Error(`receipt for ${id} changed unexpectedly before removal`);
        if (sha256Hex(receiptSnapshot.bytes) !== classification.receiptInfo.receiptDigest) {
          throw new Error(`receipt for ${id} changed unexpectedly before removal`);
        }

        invokeDisableFaultInjector(faultInjector, 'before-receipt-remove', target);
        const recheck = captureFileSnapshot(receiptPath);
        if (!fileSnapshotMatches(recheck, receiptSnapshot)) {
          throw new Error(`receipt for ${id} changed unexpectedly before removal`);
        }
        fs.unlinkSync(receiptPath);
        removedSnapshots.push({ path: receiptPath, snapshot: receiptSnapshot });
        invokeDisableFaultInjector(faultInjector, 'after-receipt-remove', target);

        entries.push({
          id, status: 'missing', action: 'remove-receipt', removedReceipt: true, receiptOutputDigest,
        });
        continue;
      }

      // classification.action === 'remove' (owned)
      const targetPath = path.join(realRoot, target.relativeTarget);
      const targetSnapshot = captureFileSnapshot(targetPath);
      const receiptSnapshot = captureFileSnapshot(receiptPath);
      if (!targetSnapshot.exists || !receiptSnapshot.exists) {
        throw new Error(`artifact for ${id} changed unexpectedly before removal`);
      }
      if (sha256Hex(receiptSnapshot.bytes) !== classification.receiptInfo.receiptDigest) {
        throw new Error(`artifact for ${id} changed unexpectedly before removal`);
      }
      if (sha256Hex(targetSnapshot.bytes) !== classification.receiptInfo.receipt.outputDigest) {
        throw new Error(`artifact for ${id} changed unexpectedly before removal`);
      }

      invokeDisableFaultInjector(faultInjector, 'before-target-remove', target);
      const targetRecheck = captureFileSnapshot(targetPath);
      if (!fileSnapshotMatches(targetRecheck, targetSnapshot)) {
        throw new Error(`target for ${id} changed unexpectedly before removal`);
      }
      const receiptRecheckBeforeTargetRemove = captureFileSnapshot(receiptPath);
      if (!fileSnapshotMatches(receiptRecheckBeforeTargetRemove, receiptSnapshot)) {
        throw new Error(`receipt for ${id} changed unexpectedly before removal`);
      }
      fs.unlinkSync(targetPath);
      removedSnapshots.push({ path: targetPath, snapshot: targetSnapshot });
      invokeDisableFaultInjector(faultInjector, 'after-target-remove', target);

      invokeDisableFaultInjector(faultInjector, 'before-receipt-remove', target);
      const receiptRecheck = captureFileSnapshot(receiptPath);
      if (!fileSnapshotMatches(receiptRecheck, receiptSnapshot)) {
        throw new Error(`receipt for ${id} changed unexpectedly before removal`);
      }
      fs.unlinkSync(receiptPath);
      removedSnapshots.push({ path: receiptPath, snapshot: receiptSnapshot });
      invokeDisableFaultInjector(faultInjector, 'after-receipt-remove', target);

      entries.push({
        id, status: 'owned', action: 'remove', removedTarget: true, removedReceipt: true, receiptOutputDigest,
      });
    }
  } catch (err) {
    const tempFiles = new Set();
    const rollbackErrors = rollbackDisable(removedSnapshots, tempFiles);
    if (rollbackErrors.length > 0) {
      // Deliberately omits file content and the underlying rollback error messages, which may
      // reference concurrently-written bytes; only the original failure is retained as `cause`.
      const aggregate = new Error('disable failed and rollback failed');
      aggregate.cause = err;
      aggregate.rollbackErrorCount = rollbackErrors.length;
      throw aggregate;
    }
    throw err;
  }

  const ok = entries.every((entry) => DISABLE_OK_STATUSES.has(entry.status));

  return { version: 1, ok, entries };
}

module.exports = {
  normalizeDeclaredTargets,
  planInstructionProjection,
  summarizeProjectionPlan,
  applyInstructionProjection,
  disableInstructionProjection,
  FAULT_STAGES,
  DISABLE_FAULT_STAGES,
};
