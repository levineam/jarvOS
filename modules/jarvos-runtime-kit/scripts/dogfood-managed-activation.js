#!/usr/bin/env node
'use strict';

/**
 * Two-phase disposable-root managed-activation dogfood.
 *
 * prepare — attest a selected tuple, mint an opaque run/correlation, record an
 *           immutable baseline under an explicit owner-only disposable root.
 * verify  — reload that run, re-attest, evaluate with the adapter contract, then
 *           exact-owned rollback inside the disposable root only.
 *
 * Never launches a harness, never mutates a real profile, never prints raw
 * receipt fields or local paths.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectManagedActivationAttestation,
  evaluateManagedActivation,
  loadManagedActivationContractForHarness,
  normalizeHarnessId,
  toPublicActivationStatus,
  validateManagedActivationReceipt,
  repoRootFrom,
} = require('../src/index.js');

const CHALLENGE_SCHEMA = 'jarvos-managed-activation-dogfood-challenge/v1';
const CREATED_SCHEMA = 'jarvos-managed-activation-dogfood-created/v1';
const REDACTED_SCHEMA = 'jarvos-managed-activation-dogfood-redacted/v1';
const RAW_TTL_MS = 24 * 60 * 60 * 1000;
const REDACTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const BROAD_ROOTS = new Set([
  path.resolve('/'),
  path.resolve('/tmp'),
  path.resolve('/var'),
  path.resolve('/var/tmp'),
  path.resolve('/private/tmp'),
  path.resolve('/Users'),
  path.resolve('/home'),
  path.resolve(os.homedir()),
  path.resolve(os.tmpdir()),
]);

function nowMs() {
  const raw = process.env.JARVOS_MANAGED_ACTIVATION_NOW;
  if (raw == null || raw === '') return Date.now();
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(raw);
  return Number.isFinite(asDate) ? asDate : Date.now();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function permissionBits(mode) {
  return mode & 0o777;
}

function isSticky(mode) {
  return (mode & 0o1000) !== 0;
}

function isGroupOrWorldWritable(mode) {
  return (permissionBits(mode) & 0o022) !== 0;
}

function isOwnerOnlyFileMode(mode) {
  return (permissionBits(mode) & 0o077) === 0;
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

function fail(code, message, extra = {}) {
  return {
    ok: false,
    error: code,
    summary: message,
    ...extra,
  };
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isUnsafeAncestorDirectory(stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
  if (isGroupOrWorldWritable(stat.mode) && !isSticky(stat.mode)) return true;
  return false;
}

function inspectSafeRegularFile(absolutePath, { ownerOnly = false } = {}) {
  if (!isAbsolutePath(absolutePath)) return { ok: false, reason: 'unsafe_path' };
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch {
    return { ok: false, reason: 'unsafe_path' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'unsafe_path' };
  if (isGroupOrWorldWritable(stat.mode)) return { ok: false, reason: 'unsafe_path' };
  if (ownerOnly && !isOwnerOnlyFileMode(stat.mode)) return { ok: false, reason: 'unsafe_path' };

  let current = path.dirname(absolutePath);
  for (;;) {
    let parentStat;
    try {
      parentStat = fs.lstatSync(current);
    } catch {
      return { ok: false, reason: 'unsafe_path' };
    }
    if (isUnsafeAncestorDirectory(parentStat)) return { ok: false, reason: 'unsafe_path' };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { ok: true, stat };
}

function readSafeOwnerFile(absolutePath) {
  const inspection = inspectSafeRegularFile(absolutePath, { ownerOnly: true });
  if (!inspection.ok) return inspection;
  try {
    const bytes = fs.readFileSync(absolutePath);
    return { ok: true, bytes, digest: sha256Buffer(bytes), mode: permissionBits(inspection.stat.mode) };
  } catch {
    return { ok: false, reason: 'evidence_unreadable' };
  }
}

function inspectSafeOwnerDirectory(absolutePath, { mustExist = true } = {}) {
  if (!isAbsolutePath(absolutePath)) return { ok: false, reason: 'unsafe_path' };
  const resolved = path.resolve(absolutePath);
  if (BROAD_ROOTS.has(resolved)) return { ok: false, reason: 'broad_root' };
  // Reject single-segment system roots and home itself even if realpath differs.
  if (resolved === path.parse(resolved).root) return { ok: false, reason: 'broad_root' };

  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (!mustExist && error && error.code === 'ENOENT') {
      // Parent must still be a safe owner directory.
      const parent = path.dirname(resolved);
      const parentCheck = inspectSafeOwnerDirectory(parent, { mustExist: true });
      if (!parentCheck.ok) return parentCheck;
      return { ok: true, missing: true, path: resolved };
    }
    return { ok: false, reason: 'unsafe_path' };
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: 'unsafe_path' };
  if (permissionBits(stat.mode) !== 0o700) return { ok: false, reason: 'unsafe_mode' };
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return { ok: false, reason: 'unsafe_owner' };
  }

  let current = path.dirname(resolved);
  for (;;) {
    let parentStat;
    try {
      parentStat = fs.lstatSync(current);
    } catch {
      return { ok: false, reason: 'unsafe_path' };
    }
    if (isUnsafeAncestorDirectory(parentStat)) return { ok: false, reason: 'unsafe_path' };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { ok: true, path: resolved, stat };
}

function ensureOwnerDir(absolutePath, { underRoot = null } = {}) {
  const resolved = path.resolve(absolutePath);
  if (underRoot) {
    const rel = relativeToRoot(underRoot, resolved);
    if (!rel && resolved !== path.resolve(underRoot)) {
      return { ok: false, reason: 'unsafe_path' };
    }
  }

  // Walk up to the nearest existing ancestor; it must be a safe owner directory.
  const missing = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) return { ok: false, reason: 'unsafe_path' };
    cursor = parent;
  }
  const ancestor = inspectSafeOwnerDirectory(cursor, { mustExist: true });
  if (!ancestor.ok) return ancestor;

  missing.reverse();
  for (const segment of missing) {
    try {
      fs.mkdirSync(segment, { recursive: false, mode: 0o700 });
      fs.chmodSync(segment, 0o700);
    } catch (error) {
      if (!(error && error.code === 'EEXIST')) {
        return { ok: false, reason: 'unsafe_path' };
      }
      try { fs.chmodSync(segment, 0o700); } catch { /* ignore */ }
    }
  }
  try {
    fs.chmodSync(resolved, 0o700);
  } catch {
    return { ok: false, reason: 'unsafe_mode' };
  }
  return inspectSafeOwnerDirectory(resolved, { mustExist: true });
}

function atomicWriteOwnerFile(absolutePath, body, created = null) {
  const parent = ensureOwnerDir(path.dirname(absolutePath));
  if (!parent.ok) return parent;
  const payload = Buffer.from(typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  const tmp = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, absolutePath);
    fs.chmodSync(absolutePath, 0o600);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: 'write_failed' };
  }
  const digest = sha256Buffer(payload);
  if (created) {
    created.push({
      relativePath: null, // filled by caller with owner-root relative path
      absolutePath,
      digest,
      mode: 0o600,
    });
  }
  return { ok: true, digest, mode: 0o600, path: absolutePath };
}

function relativeToRoot(ownerRoot, absolutePath) {
  const rel = path.relative(ownerRoot, absolutePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function mintRunIds(harness) {
  const token = crypto.randomBytes(16).toString('hex');
  const run = `df-${harness}-${token}`;
  const correlation = `ch-${harness}-${token}`;
  return { run, correlation };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const flags = {
    json: false,
    harness: null,
    ownerRoot: null,
    generation: null,
    assets: [],
    entrypoint: null,
    configBinding: null,
    run: null,
  };
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    const next = args[i + 1];
    if (arg === '--harness') { flags.harness = next; i += 1; continue; }
    if (arg === '--owner-root') { flags.ownerRoot = next; i += 1; continue; }
    if (arg === '--generation') { flags.generation = next; i += 1; continue; }
    if (arg === '--asset') { flags.assets.push(next); i += 1; continue; }
    if (arg === '--entrypoint') { flags.entrypoint = next; i += 1; continue; }
    if (arg === '--config-binding') { flags.configBinding = next; i += 1; continue; }
    if (arg === '--run') { flags.run = next; i += 1; continue; }
    return { ok: false, error: `unknown argument: ${arg}` };
  }
  return { ok: true, command, flags };
}

function usage() {
  return [
    'Usage:',
    '  dogfood-managed-activation.js prepare --harness <id> --owner-root <absolute-disposable-root> --generation <id> --asset <absolute-file> [--asset ...] --entrypoint <absolute-file> --config-binding <absolute-file> [--json]',
    '  dogfood-managed-activation.js verify --harness <id> --owner-root <same-root> --run <opaque-run-id> [--json]',
  ].join('\n');
}

function publicPrepareResult({ harness, run, correlation, tupleDigest, baselineAt, generationDigest }) {
  return {
    ok: true,
    phase: 'prepare',
    harness,
    run,
    correlation,
    tupleDigest,
    generationDigest: generationDigest || tupleDigest,
    baselineAt,
    dogfood: { outcome: 'prepared' },
  };
}

function publicVerifyResult({
  ok,
  harness,
  run,
  correlation,
  status,
  dogfoodOutcome,
  rollback,
  error,
  summary,
}) {
  const body = {
    ok: ok === true,
    phase: 'verify',
    harness: harness || null,
    run: run || null,
    correlation: correlation || null,
    status: status || null,
    dogfood: { outcome: dogfoodOutcome || (ok ? 'passed' : 'failed') },
    rollback: rollback || { status: 'none' },
  };
  if (error) body.error = error;
  if (summary) body.summary = summary;
  return body;
}

function challengePaths(ownerRoot, run) {
  const runDir = path.join(ownerRoot, 'runs', run);
  return {
    runDir,
    challenge: path.join(runDir, 'challenge.json'),
    created: path.join(runDir, 'created-files.json'),
    receiptsDir: path.join(runDir, 'receipts'),
    redacted: path.join(ownerRoot, 'redacted', `${run}.json`),
  };
}

function sweepExpired(ownerRoot, now) {
  const runsDir = path.join(ownerRoot, 'runs');
  if (fs.existsSync(runsDir)) {
    let names = [];
    try { names = fs.readdirSync(runsDir); } catch { names = []; }
    for (const name of names) {
      const challengePath = path.join(runsDir, name, 'challenge.json');
      const loaded = readSafeOwnerFile(challengePath);
      if (!loaded.ok) continue;
      let challenge;
      try { challenge = JSON.parse(loaded.bytes.toString('utf8')); } catch { continue; }
      const rawExpires = Date.parse(challenge.rawExpiresAt || '');
      if (Number.isFinite(rawExpires) && rawExpires <= now) {
        safeRemoveRawRun(ownerRoot, name, { force: true });
      }
    }
  }
  const redactedDir = path.join(ownerRoot, 'redacted');
  if (fs.existsSync(redactedDir)) {
    let names = [];
    try { names = fs.readdirSync(redactedDir); } catch { names = []; }
    for (const name of names) {
      const filePath = path.join(redactedDir, name);
      const loaded = readSafeOwnerFile(filePath);
      if (!loaded.ok) {
        // Unreadable redacted files older than retention are best-effort removed only when owner-only.
        continue;
      }
      let body;
      try { body = JSON.parse(loaded.bytes.toString('utf8')); } catch { continue; }
      const until = Date.parse(body.retainedUntil || '');
      if (Number.isFinite(until) && until <= now) {
        try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
      }
    }
  }
}

function safeRemoveRawRun(ownerRoot, run, { force = false } = {}) {
  const paths = challengePaths(ownerRoot, run);
  // Only remove known raw locations; never recursive-delete the owner root.
  for (const target of [paths.challenge, paths.created]) {
    try {
      if (!fs.existsSync(target)) continue;
      if (!force) {
        const inspection = inspectSafeRegularFile(target, { ownerOnly: true });
        if (!inspection.ok) continue;
      }
      fs.rmSync(target, { force: true });
    } catch { /* ignore */ }
  }
  if (fs.existsSync(paths.receiptsDir)) {
    let names = [];
    try { names = fs.readdirSync(paths.receiptsDir); } catch { names = []; }
    for (const name of names) {
      const filePath = path.join(paths.receiptsDir, name);
      try {
        const inspection = inspectSafeRegularFile(filePath, { ownerOnly: true });
        if (inspection.ok || force) fs.rmSync(filePath, { force: true });
      } catch { /* ignore */ }
    }
    try { fs.rmdirSync(paths.receiptsDir); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(paths.runDir); } catch { /* ignore */ }
}

function writeRedactedState(ownerRoot, {
  run,
  harness,
  correlation,
  status,
  dogfoodOutcome,
  rollback,
  now,
  createdTracker,
}) {
  const paths = challengePaths(ownerRoot, run);
  const body = {
    schemaVersion: REDACTED_SCHEMA,
    run,
    harness,
    correlation,
    state: status?.state || null,
    generationDigest: status?.generationDigest || null,
    reasons: Array.isArray(status?.reasons) ? status.reasons : [],
    evaluatedAt: status?.evaluatedAt || toIso(now),
    dogfoodOutcome,
    rollbackStatus: rollback?.status || 'none',
    retainedUntil: toIso(now + REDACTED_TTL_MS),
  };
  const written = atomicWriteOwnerFile(paths.redacted, body, createdTracker);
  return written;
}

function loadChallenge(ownerRoot, run) {
  const paths = challengePaths(ownerRoot, run);
  if (!RUN_ID.test(run)) return fail('invalid_run', 'run id is invalid');
  const loaded = readSafeOwnerFile(paths.challenge);
  if (!loaded.ok) return fail('evidence_unreadable', 'challenge material is unreadable or unsafe');
  let challenge;
  try {
    challenge = JSON.parse(loaded.bytes.toString('utf8'));
  } catch {
    return fail('invalid_evidence', 'challenge material is ambiguous or corrupt');
  }
  if (!challenge || challenge.schemaVersion !== CHALLENGE_SCHEMA) {
    return fail('invalid_evidence', 'challenge schema is invalid');
  }
  return {
    ok: true,
    challenge,
    digest: loaded.digest,
    mode: loaded.mode,
    path: paths.challenge,
  };
}

function loadReceipts(receiptsDir) {
  const receipts = [];
  if (!fs.existsSync(receiptsDir)) return { ok: true, receipts };
  let names;
  try {
    names = fs.readdirSync(receiptsDir).sort();
  } catch {
    return { ok: false, reason: 'evidence_unreadable', receipts: [] };
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(receiptsDir, name);
    const loaded = readSafeOwnerFile(filePath);
    if (!loaded.ok) return { ok: false, reason: 'evidence_unreadable', receipts: [] };
    let parsed;
    try {
      parsed = JSON.parse(loaded.bytes.toString('utf8'));
    } catch {
      return { ok: false, reason: 'invalid_evidence', receipts: [] };
    }
    const validated = validateManagedActivationReceipt(parsed);
    if (!validated.ok) {
      // Keep invalid receipts out of evaluation inputs; evaluator still sees empty/invalid via absence.
      continue;
    }
    // Only validated closed receipt fields enter evaluation.
    receipts.push(validated.value);
  }
  return { ok: true, receipts };
}

function loadCreatedInventory(ownerRoot, run) {
  const paths = challengePaths(ownerRoot, run);
  const loaded = readSafeOwnerFile(paths.created);
  if (!loaded.ok) return { ok: false, reason: 'evidence_unreadable' };
  let body;
  try {
    body = JSON.parse(loaded.bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_evidence' };
  }
  if (!body || body.schemaVersion !== CREATED_SCHEMA || !Array.isArray(body.files)) {
    return { ok: false, reason: 'invalid_evidence' };
  }
  return { ok: true, files: body.files, path: paths.created, digest: loaded.digest };
}

function exactOwnedRollback(ownerRoot, inventoryFiles, { alsoRemove = [] } = {}) {
  const refused = [];
  const removed = [];
  const candidates = [];

  for (const entry of inventoryFiles || []) {
    if (!entry || typeof entry.relativePath !== 'string') {
      refused.push('ambiguous-entry');
      continue;
    }
    const absolute = path.join(ownerRoot, entry.relativePath.split('/').join(path.sep));
    const rel = relativeToRoot(ownerRoot, absolute);
    if (!rel || rel !== entry.relativePath) {
      refused.push(entry.relativePath);
      continue;
    }
    candidates.push({ ...entry, absolutePath: absolute });
  }
  for (const absolute of alsoRemove) {
    const rel = relativeToRoot(ownerRoot, absolute);
    if (!rel) continue;
    candidates.push({ relativePath: rel, absolutePath: absolute, digest: null, mode: null, optional: true });
  }

  // Remove deepest paths first so directories can be cleaned afterward.
  candidates.sort((a, b) => b.relativePath.length - a.relativePath.length);

  for (const entry of candidates) {
    if (!fs.existsSync(entry.absolutePath)) {
      removed.push(entry.relativePath);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(entry.absolutePath);
    } catch {
      refused.push(entry.relativePath);
      continue;
    }
    if (stat.isDirectory()) {
      try {
        fs.rmdirSync(entry.absolutePath);
        removed.push(entry.relativePath);
      } catch {
        // Non-empty or busy directory is left; not a hard refusal for optional dirs.
        if (!entry.optional) refused.push(entry.relativePath);
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      refused.push(entry.relativePath);
      continue;
    }
    if (entry.digest) {
      let bytes;
      try {
        bytes = fs.readFileSync(entry.absolutePath);
      } catch {
        refused.push(entry.relativePath);
        continue;
      }
      const digest = sha256Buffer(bytes);
      const mode = permissionBits(stat.mode);
      if (digest !== entry.digest || (entry.mode != null && mode !== entry.mode)) {
        refused.push(entry.relativePath);
        continue;
      }
    } else if (!entry.optional) {
      refused.push(entry.relativePath);
      continue;
    }
    try {
      fs.rmSync(entry.absolutePath, { force: false });
      removed.push(entry.relativePath);
    } catch {
      refused.push(entry.relativePath);
    }
  }

  if (refused.length) {
    return { status: 'rollback_pending', removed, refusedCount: refused.length };
  }
  return { status: 'completed', removed, refusedCount: 0 };
}

function prepareCommand(flags) {
  const now = nowMs();
  const harness = normalizeHarnessId(flags.harness);
  if (!harness) return { result: fail('unknown_harness', 'harness must be a supported harness id'), code: 2 };
  if (!isAbsolutePath(flags.ownerRoot)) {
    return { result: fail('unsafe_path', 'owner-root must be an absolute disposable directory'), code: 2 };
  }
  if (typeof flags.generation !== 'string' || !GENERATION.test(flags.generation)) {
    return { result: fail('invalid_evidence', 'generation is required'), code: 2 };
  }
  if (!Array.isArray(flags.assets) || flags.assets.length === 0) {
    return { result: fail('attestation_unavailable', 'at least one --asset is required'), code: 2 };
  }
  if (!isAbsolutePath(flags.entrypoint) || !isAbsolutePath(flags.configBinding)) {
    return { result: fail('unsafe_path', 'entrypoint and config-binding must be absolute files'), code: 2 };
  }
  for (const asset of flags.assets) {
    if (!isAbsolutePath(asset)) {
      return { result: fail('unsafe_path', 'asset paths must be absolute files'), code: 2 };
    }
  }

  const rootCheck = ensureOwnerDir(path.resolve(flags.ownerRoot));
  if (!rootCheck.ok) {
    return { result: fail(rootCheck.reason || 'unsafe_path', 'owner-root is not a safe disposable directory'), code: 2 };
  }
  const ownerRoot = rootCheck.path;
  sweepExpired(ownerRoot, now);

  const contractLoaded = loadManagedActivationContractForHarness(harness, { root: repoRootFrom() });
  if (!contractLoaded.ok) {
    return { result: fail('invalid_evidence', 'adapter managed activation contract is unavailable'), code: 2 };
  }

  const attestation = collectManagedActivationAttestation({
    harness,
    generation: flags.generation,
    assetPaths: flags.assets,
    entrypointPath: flags.entrypoint,
    configBindingPath: flags.configBinding,
  });
  if (!attestation.ok) {
    return {
      result: fail(attestation.reasonCode || 'attestation_unavailable', 'selected tuple attestation failed'),
      code: 2,
    };
  }

  const { run, correlation } = mintRunIds(harness);
  const paths = challengePaths(ownerRoot, run);
  if (fs.existsSync(paths.runDir)) {
    return { result: fail('ambiguous_run', 'run directory already exists'), code: 2 };
  }

  const createdTracker = [];
  const runDir = ensureOwnerDir(paths.runDir);
  if (!runDir.ok) return { result: fail('unsafe_path', 'could not create run directory'), code: 2 };
  const receiptsDir = ensureOwnerDir(paths.receiptsDir);
  if (!receiptsDir.ok) return { result: fail('unsafe_path', 'could not create receipts directory'), code: 2 };
  const redactedDir = ensureOwnerDir(path.dirname(paths.redacted));
  if (!redactedDir.ok) return { result: fail('unsafe_path', 'could not create redacted directory'), code: 2 };

  // Immutable baseline is recorded strictly before any qualifying receipts exist.
  const baselineAt = toIso(now);
  const challenge = {
    schemaVersion: CHALLENGE_SCHEMA,
    run,
    correlation,
    harness,
    generation: flags.generation,
    tupleDigest: attestation.tupleDigest,
    assetDigest: attestation.assetDigest,
    entrypointDigest: attestation.entrypointDigest,
    configBindingDigest: attestation.configBindingDigest,
    assetPaths: flags.assets.map((value) => path.resolve(value)),
    entrypointPath: path.resolve(flags.entrypoint),
    configBindingPath: path.resolve(flags.configBinding),
    baselineAt,
    createdAt: baselineAt,
    rawExpiresAt: toIso(now + RAW_TTL_MS),
    consumed: false,
  };

  const challengeWrite = atomicWriteOwnerFile(paths.challenge, challenge, createdTracker);
  if (!challengeWrite.ok) {
    safeRemoveRawRun(ownerRoot, run, { force: true });
    return { result: fail('write_failed', 'could not write challenge material'), code: 2 };
  }

  // Record created inventory after challenge so inventory includes itself + challenge.
  const inventoryFiles = [];
  for (const entry of createdTracker) {
    const rel = relativeToRoot(ownerRoot, entry.absolutePath);
    if (!rel) {
      safeRemoveRawRun(ownerRoot, run, { force: true });
      return { result: fail('unsafe_path', 'created path escaped owner-root'), code: 2 };
    }
    inventoryFiles.push({ relativePath: rel, digest: entry.digest, mode: entry.mode });
  }
  const createdRel = relativeToRoot(ownerRoot, paths.created);
  const receiptsRel = relativeToRoot(ownerRoot, paths.receiptsDir);
  const runRel = relativeToRoot(ownerRoot, paths.runDir);
  // Inventory file and directories are optional cleanup targets. Only the
  // challenge (and other attested regular files) require exact digest/mode match.
  const inventoryBody = {
    schemaVersion: CREATED_SCHEMA,
    run,
    harness,
    files: [
      ...inventoryFiles,
      { relativePath: createdRel, digest: null, mode: 0o600, optional: true, kind: 'inventory' },
      { relativePath: receiptsRel, digest: null, mode: 0o700, optional: true, kind: 'directory' },
      { relativePath: runRel, digest: null, mode: 0o700, optional: true, kind: 'directory' },
    ],
  };
  const finalWrite = atomicWriteOwnerFile(paths.created, inventoryBody);
  if (!finalWrite.ok) {
    safeRemoveRawRun(ownerRoot, run, { force: true });
    return { result: fail('write_failed', 'could not write created-files inventory'), code: 2 };
  }

  // Seed redacted prepare state (retained up to 30 days).
  writeRedactedState(ownerRoot, {
    run,
    harness,
    correlation,
    status: {
      state: 'awaiting_live_proof',
      generationDigest: attestation.tupleDigest,
      reasons: ['prepared', 'awaiting_live_proof'],
      evaluatedAt: baselineAt,
    },
    dogfoodOutcome: 'prepared',
    rollback: { status: 'none' },
    now,
  });

  return {
    result: publicPrepareResult({
      harness,
      run,
      correlation,
      tupleDigest: attestation.tupleDigest,
      baselineAt,
    }),
    code: 0,
  };
}

function verifyCommand(flags) {
  const now = nowMs();
  const harness = normalizeHarnessId(flags.harness);
  if (!harness) {
    return {
      result: publicVerifyResult({
        ok: false,
        error: 'unknown_harness',
        summary: 'harness must be a supported harness id',
        dogfoodOutcome: 'failed',
      }),
      code: 2,
    };
  }
  if (!isAbsolutePath(flags.ownerRoot)) {
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        error: 'unsafe_path',
        summary: 'owner-root must be absolute',
        dogfoodOutcome: 'failed',
      }),
      code: 2,
    };
  }
  if (typeof flags.run !== 'string' || !RUN_ID.test(flags.run)) {
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        error: 'invalid_run',
        summary: 'run id is invalid',
        dogfoodOutcome: 'failed',
      }),
      code: 2,
    };
  }

  const rootCheck = inspectSafeOwnerDirectory(path.resolve(flags.ownerRoot), { mustExist: true });
  if (!rootCheck.ok) {
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        error: rootCheck.reason || 'unsafe_path',
        summary: 'owner-root is not a safe disposable directory',
        dogfoodOutcome: 'failed',
      }),
      code: 2,
    };
  }
  const ownerRoot = rootCheck.path;

  const loaded = loadChallenge(ownerRoot, flags.run);
  if (!loaded.ok) {
    const expiredProbe = !fs.existsSync(challengePaths(ownerRoot, flags.run).challenge);
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        error: loaded.error,
        summary: loaded.summary,
        dogfoodOutcome: expiredProbe ? 'expired' : 'failed',
        status: toPublicActivationStatus({
          state: 'unconfigured',
          harness,
          reasons: ['invalid_evidence'],
          evaluatedAt: toIso(now),
        }),
      }),
      code: 1,
    };
  }

  const challenge = loaded.challenge;
  if (challenge.harness !== harness) {
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        error: 'challenge_mismatch',
        summary: 'challenge harness does not match',
        dogfoodOutcome: 'failed',
        status: toPublicActivationStatus({
          state: 'degraded',
          harness,
          reasons: ['challenge_mismatch'],
          evaluatedAt: toIso(now),
        }),
      }),
      code: 1,
    };
  }

  const rawExpires = Date.parse(challenge.rawExpiresAt || '');
  if (Number.isFinite(rawExpires) && rawExpires <= now) {
    safeRemoveRawRun(ownerRoot, flags.run, { force: true });
    // Also drop expired redacted peer if present.
    try { fs.rmSync(challengePaths(ownerRoot, flags.run).redacted, { force: true }); } catch { /* ignore */ }
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        error: 'expired',
        summary: 'raw challenge material expired',
        dogfoodOutcome: 'expired',
        status: toPublicActivationStatus({
          state: 'unconfigured',
          harness,
          reasons: ['invalid_evidence'],
          evaluatedAt: toIso(now),
        }),
      }),
      code: 1,
    };
  }

  if (challenge.consumed === true) {
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        error: 'receipt_replay',
        summary: 'challenge already consumed',
        dogfoodOutcome: 'failed',
        status: toPublicActivationStatus({
          state: 'degraded',
          harness,
          generationDigest: challenge.tupleDigest,
          reasons: ['receipt_replay'],
          evaluatedAt: toIso(now),
        }),
      }),
      code: 1,
    };
  }

  const contractLoaded = loadManagedActivationContractForHarness(harness, { root: repoRootFrom() });
  if (!contractLoaded.ok) {
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        error: 'invalid_evidence',
        summary: 'adapter contract unavailable',
        dogfoodOutcome: 'failed',
      }),
      code: 2,
    };
  }

  // Re-attest the exact selected tuple from the stored absolute inputs.
  const attestation = collectManagedActivationAttestation({
    harness,
    generation: challenge.generation,
    assetPaths: challenge.assetPaths,
    entrypointPath: challenge.entrypointPath,
    configBindingPath: challenge.configBindingPath,
    expected: {
      assetDigest: challenge.assetDigest,
      entrypointDigest: challenge.entrypointDigest,
      configBindingDigest: challenge.configBindingDigest,
    },
  });
  if (!attestation.ok || attestation.tupleDigest !== challenge.tupleDigest) {
    const status = toPublicActivationStatus({
      state: 'degraded',
      harness,
      generationDigest: challenge.tupleDigest,
      reasons: [attestation.reasonCode || 'selected_tuple_mismatch'],
      evaluatedAt: toIso(now),
    });
    writeRedactedState(ownerRoot, {
      run: flags.run,
      harness,
      correlation: challenge.correlation,
      status,
      dogfoodOutcome: 'failed',
      rollback: { status: 'none' },
      now,
    });
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        status,
        dogfoodOutcome: 'failed',
        error: attestation.reasonCode || 'selected_tuple_mismatch',
        summary: 'selected tuple re-attestation failed',
      }),
      code: 1,
    };
  }

  const paths = challengePaths(ownerRoot, flags.run);
  const receiptLoad = loadReceipts(paths.receiptsDir);
  if (!receiptLoad.ok) {
    const status = toPublicActivationStatus({
      state: 'degraded',
      harness,
      generationDigest: challenge.tupleDigest,
      reasons: ['evidence_unreadable'],
      evaluatedAt: toIso(now),
    });
    writeRedactedState(ownerRoot, {
      run: flags.run,
      harness,
      correlation: challenge.correlation,
      status,
      dogfoodOutcome: 'failed',
      rollback: { status: 'none' },
      now,
    });
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        status,
        dogfoodOutcome: 'failed',
        error: 'evidence_unreadable',
        summary: 'receipt material is unreadable or unsafe',
      }),
      code: 1,
    };
  }

  const evidence = {
    configured: true,
    prepared: true,
    attestation: {
      ok: true,
      harness: attestation.harness,
      generation: attestation.generation,
      assetDigest: attestation.assetDigest,
      entrypointDigest: attestation.entrypointDigest,
      configBindingDigest: attestation.configBindingDigest,
      tupleDigest: attestation.tupleDigest,
    },
    challenges: [{
      correlation: challenge.correlation,
      harness,
      baselineAt: challenge.baselineAt,
    }],
    receipts: receiptLoad.receipts,
    health: { available: false },
    rollback: { status: 'none' },
    consumedCorrelations: [],
  };

  const evaluated = evaluateManagedActivation({
    contract: contractLoaded.contract,
    evidence,
    now,
  });
  const status = toPublicActivationStatus(evaluated);

  if (status.state !== 'active') {
    const pending = status.state === 'awaiting_live_proof' || status.reasons.includes('no_live_receipt');
    writeRedactedState(ownerRoot, {
      run: flags.run,
      harness,
      correlation: challenge.correlation,
      status,
      dogfoodOutcome: pending ? 'pending' : 'failed',
      rollback: { status: 'none' },
      now,
    });
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        status,
        dogfoodOutcome: pending ? 'pending' : 'failed',
        summary: pending ? 'awaiting live proof receipts' : 'activation evaluation did not reach active',
      }),
      code: 1,
    };
  }

  // Success path: consume challenge, exact-owned rollback of this run's created files,
  // delete raw receipt/challenge material, retain only redacted state.
  const inventory = loadCreatedInventory(ownerRoot, flags.run);
  if (!inventory.ok) {
    const rollbackStatus = { status: 'rollback_pending' };
    const blocked = toPublicActivationStatus({
      ...status,
      state: 'rollback_pending',
      reasons: ['rollback_refused_modified', 'rollback_pending'],
      evidenceClasses: ['rollback'],
    });
    writeRedactedState(ownerRoot, {
      run: flags.run,
      harness,
      correlation: challenge.correlation,
      status: blocked,
      dogfoodOutcome: 'rollback_pending',
      rollback: rollbackStatus,
      now,
    });
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        status: blocked,
        dogfoodOutcome: 'rollback_pending',
        rollback: rollbackStatus,
        error: 'rollback_refused_modified',
        summary: 'created-files inventory is unreadable or ambiguous',
      }),
      code: 1,
    };
  }

  // Mark consumed in memory; physical challenge removal is part of rollback.
  // If any inventory entry was modified (digest/mode mismatch), refuse deletion.
  const rollback = exactOwnedRollback(ownerRoot, inventory.files, {
    alsoRemove: [
      // Receipts planted after prepare are not in the prepare inventory; remove only
      // owner-only regular files under the receipts dir without inventory match by
      // treating the receipts directory cleanup as best-effort after exact files.
    ],
  });

  if (rollback.status !== 'completed') {
    // Leave modified material in place; never overwrite.
    const blocked = toPublicActivationStatus({
      state: 'rollback_pending',
      harness,
      generationDigest: status.generationDigest,
      evidenceClasses: ['rollback'],
      reasons: ['rollback_refused_modified', 'rollback_pending'],
      evaluatedAt: toIso(now),
    });
    writeRedactedState(ownerRoot, {
      run: flags.run,
      harness,
      correlation: challenge.correlation,
      status: blocked,
      dogfoodOutcome: 'rollback_pending',
      rollback,
      now,
    });
    return {
      result: publicVerifyResult({
        ok: false,
        harness,
        run: flags.run,
        correlation: challenge.correlation,
        status: blocked,
        dogfoodOutcome: 'rollback_pending',
        rollback,
        error: 'rollback_refused_modified',
        summary: 'exact-owned rollback refused because files were modified or ambiguous',
      }),
      code: 1,
    };
  }

  // Remove any residual raw receipt files that were planted after prepare (not in inventory).
  // Only owner-only regular files under the run receipts dir; never broad recursion beyond that dir.
  if (fs.existsSync(paths.receiptsDir)) {
    let names = [];
    try { names = fs.readdirSync(paths.receiptsDir); } catch { names = []; }
    for (const name of names) {
      const filePath = path.join(paths.receiptsDir, name);
      const inspection = inspectSafeRegularFile(filePath, { ownerOnly: true });
      if (!inspection.ok) continue;
      try { fs.rmSync(filePath, { force: true }); } catch { /* ignore */ }
    }
    try { fs.rmdirSync(paths.receiptsDir); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(paths.runDir); } catch { /* ignore */ }

  writeRedactedState(ownerRoot, {
    run: flags.run,
    harness,
    correlation: challenge.correlation,
    status,
    dogfoodOutcome: 'passed',
    rollback,
    now,
  });

  return {
    result: publicVerifyResult({
      ok: true,
      harness,
      run: flags.run,
      correlation: challenge.correlation,
      status,
      dogfoodOutcome: 'passed',
      rollback,
      summary: 'managed activation dogfood passed with exact-owned rollback',
    }),
    code: 0,
  };
}

function main() {
  const parsed = parseArgs(process.argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${usage()}\n`);
    process.exit(2);
  }
  const { command, flags } = parsed;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  let outcome;
  if (command === 'prepare') {
    outcome = prepareCommand(flags);
  } else if (command === 'verify') {
    outcome = verifyCommand(flags);
  } else {
    process.stderr.write(`unknown command: ${command}\n${usage()}\n`);
    process.exit(2);
  }

  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  process.exit(outcome.code);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify(fail('invalid_evidence', 'dogfood failed closed'))}\n`);
    process.exit(2);
  }
}

module.exports = {
  prepareCommand,
  verifyCommand,
  CHALLENGE_SCHEMA,
  RAW_TTL_MS,
  REDACTED_TTL_MS,
};
