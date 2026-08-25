#!/usr/bin/env node
'use strict';

/**
 * Public, content-free bridge for the private Active Assistant cycle core.
 *
 * The managed runtime runner supplies the selected immutable runtime root.
 * This file validates only owner-controlled path topology and the versioned
 * cycle contract before loading the private implementation. It never reads
 * or projects private artifacts, provider inputs, or delivery targets.
 */

const fs = require('node:fs');
const path = require('node:path');

const IMPLEMENTATION_RELATIVE_PATH = 'scripts/active-assistant-cycle.js';
const PUBLIC_RELATIVE_PATH = 'repos/jarvOS';
const ROOT_ENV = 'ACTIVE_ASSISTANT_IMPLEMENTATION_ROOT';
const PUBLIC_ROOT_ENV = 'ACTIVE_ASSISTANT_PUBLIC_RUNTIME_ROOT';
const SELECTOR_ENV = 'OPENCLAW_MANAGED_SOFTWARE_RUNTIME_SELECTOR';
const SELECTION_SCHEMA = 'jarvos.managed-software-runtime-selection/v1';
const CYCLE_CONTRACT_VERSION = 'active-assistant-cycle/v1';
// CI qualification receipts contain policy -> checks/issuers arrays -> rows.
// Keep the selector bounded, but admit the versioned receipt shape written by
// the managed-runtime selector instead of rejecting the live authority.
const MAX_SELECTION_DEPTH = 8;

const SELECTION_KEYS = new Set([
  'schema', 'runtimeRoot', 'commit', 'publicCommit', 'reviewedTupleDigest',
  'ciQualification', 'ciPolicy', 'ciQualifiedTupleDigest', 'ciReviewedTupleDigest',
  'selectedAt',
]);

function bridgeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

function validDigest(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function boundedSelectionValue(value, depth = 0) {
  if (depth > MAX_SELECTION_DEPTH) return false;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return value.length <= 512;
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => boundedSelectionValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  const keys = Object.keys(value);
  return keys.length <= 32 && keys.every((key) => key.length <= 128 && boundedSelectionValue(value[key], depth + 1));
}

function readRuntimeSelection({ selectorPath, fsImpl = fs } = {}) {
  if (!selectorPath || !path.isAbsolute(selectorPath)) {
    throw bridgeError('active_assistant_runtime_selector_required');
  }
  const absoluteSelector = path.resolve(selectorPath);
  assertNoSymlinkComponents(absoluteSelector, fsImpl);
  ownerPath(absoluteSelector, { fsImpl });
  let selection;
  try {
    const raw = fsImpl.readFileSync(absoluteSelector, 'utf8');
    if (raw.length > 256 * 1024) throw bridgeError('active_assistant_runtime_selector_invalid');
    selection = JSON.parse(raw);
  } catch {
    throw bridgeError('active_assistant_runtime_selector_invalid');
  }
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || !boundedSelectionValue(selection)
    || Object.keys(selection).some((key) => !SELECTION_KEYS.has(key))
    || selection.schema !== SELECTION_SCHEMA
    || typeof selection.runtimeRoot !== 'string' || !path.isAbsolute(selection.runtimeRoot)
    || !validCommit(selection.commit) || !validCommit(selection.publicCommit)
    || !validDigest(selection.reviewedTupleDigest)
    || !validDigest(selection.ciQualifiedTupleDigest)
    || !validDigest(selection.ciReviewedTupleDigest)
    || !selection.ciQualification || typeof selection.ciQualification !== 'object'
    || Array.isArray(selection.ciQualification)
    || !selection.ciPolicy || typeof selection.ciPolicy !== 'object'
    || Array.isArray(selection.ciPolicy)
    || selection.ciReviewedTupleDigest.toLowerCase() !== String(selection.ciQualification.reviewedTupleDigest || '').toLowerCase()
    || typeof selection.selectedAt !== 'string' || !Number.isFinite(Date.parse(selection.selectedAt))) {
    throw bridgeError('active_assistant_runtime_selector_invalid');
  }
  return Object.freeze({
    schema: SELECTION_SCHEMA,
    selectorPath: absoluteSelector,
    runtimeRoot: path.resolve(selection.runtimeRoot),
    commit: selection.commit.toLowerCase(),
    publicCommit: selection.publicCommit.toLowerCase(),
    reviewedTupleDigest: selection.reviewedTupleDigest.toLowerCase(),
    ciQualifiedTupleDigest: selection.ciQualifiedTupleDigest.toLowerCase(),
    ciReviewedTupleDigest: selection.ciReviewedTupleDigest.toLowerCase(),
    selectedAt: selection.selectedAt,
  });
}

function ownerPath(target, { directory, fsImpl = fs } = {}) {
  let stat;
  try { stat = fsImpl.lstatSync(target); }
  catch { throw bridgeError('active_assistant_runtime_path_invalid'); }
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()) {
    throw bridgeError('active_assistant_runtime_path_invalid');
  }
  if ((stat.mode & 0o022) !== 0) throw bridgeError('active_assistant_runtime_permissions');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid != null && stat.uid !== uid) throw bridgeError('active_assistant_runtime_owner_mismatch');
  return stat;
}

function assertNoSymlinkComponents(target, fsImpl = fs) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = fsImpl.lstatSync(current); }
    catch { throw bridgeError('active_assistant_runtime_path_invalid'); }
    // macOS exposes /var through the system /private symlink. It is the only
    // ambient system alias accepted; selected runtime components remain exact.
    if (stat.isSymbolicLink() && current !== '/var') {
      throw bridgeError('active_assistant_runtime_path_invalid');
    }
  }
}

function exactRealPath(target, options = {}) {
  const { fsImpl = fs } = options;
  const requested = path.resolve(target);
  assertNoSymlinkComponents(requested, fsImpl);
  ownerPath(requested, options);
  let resolved;
  try { resolved = fsImpl.realpathSync(requested); }
  catch { throw bridgeError('active_assistant_runtime_path_invalid'); }
  return resolved;
}

function resolveImplementationEntrypoint({
  runtimeRoot,
  publicRoot = path.resolve(__dirname, '..'),
  selectorPath,
  selection,
  fsImpl = fs,
} = {}) {
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw bridgeError('active_assistant_runtime_root_required');
  }

  const resolvedRuntime = exactRealPath(runtimeRoot, { directory: true, fsImpl });
  const selected = selection || readRuntimeSelection({ selectorPath, fsImpl });
  const selectedRuntime = exactRealPath(selected.runtimeRoot, { directory: true, fsImpl });
  if (selectedRuntime !== resolvedRuntime) throw bridgeError('active_assistant_runtime_selector_mismatch');
  const resolvedPublic = exactRealPath(publicRoot, { directory: true, fsImpl });
  const derivedRuntime = path.resolve(resolvedPublic, '..', '..');
  if (resolvedRuntime !== derivedRuntime) throw bridgeError('active_assistant_public_runtime_mismatch');

  const expectedPublic = path.resolve(resolvedRuntime, PUBLIC_RELATIVE_PATH);
  if (resolvedPublic !== expectedPublic) throw bridgeError('active_assistant_public_runtime_mismatch');

  const entrypoint = path.resolve(resolvedRuntime, IMPLEMENTATION_RELATIVE_PATH);
  const resolvedEntrypoint = exactRealPath(entrypoint, { directory: false, fsImpl });
  if (resolvedEntrypoint === fsImpl.realpathSync(__filename)) {
    throw bridgeError('active_assistant_runtime_recursion');
  }
  return resolvedEntrypoint;
}

function loadImplementation({ env = process.env, fsImpl = fs, publicRoot, selectorPath, selection } = {}) {
  const selected = selection || readRuntimeSelection({
    selectorPath: selectorPath || env[SELECTOR_ENV],
    fsImpl,
  });
  const entrypoint = resolveImplementationEntrypoint({
    runtimeRoot: env[ROOT_ENV],
    publicRoot: publicRoot || env[PUBLIC_ROOT_ENV] || path.resolve(__dirname, '..'),
    selection: selected,
    fsImpl,
  });
  // The resolved file is owner-controlled and pinned inside the verified
  // managed runtime; caller input never supplies a module path directly.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const implementation = require(entrypoint);
  if (!implementation || typeof implementation.main !== 'function') {
    throw bridgeError('active_assistant_runtime_contract_invalid');
  }
  if (implementation.cycleContractVersion !== CYCLE_CONTRACT_VERSION) {
    throw bridgeError('active_assistant_cycle_contract_mismatch');
  }
  return implementation;
}

function safeRuntimeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^active_assistant_[a-z0-9_]+$/.test(code) ? code : 'active_assistant_runtime_failure';
}

function main(argv = process.argv.slice(2), options = {}) {
  const implementation = options.implementation || loadImplementation(options);
  return implementation.main(argv);
}

module.exports = {
  IMPLEMENTATION_RELATIVE_PATH,
  PUBLIC_RELATIVE_PATH,
  ROOT_ENV,
  PUBLIC_ROOT_ENV,
  SELECTOR_ENV,
  SELECTION_SCHEMA,
  CYCLE_CONTRACT_VERSION,
  bridgeError,
  exactRealPath,
  loadImplementation,
  readRuntimeSelection,
  main,
  ownerPath,
  assertNoSymlinkComponents,
  resolveImplementationEntrypoint,
  safeRuntimeErrorCode,
};

if (require.main === module) {
  Promise.resolve()
    .then(() => main())
    .catch((error) => {
      process.stderr.write(`Active Assistant cycle unavailable: ${safeRuntimeErrorCode(error)}\n`);
      process.exitCode = 1;
    });
}
