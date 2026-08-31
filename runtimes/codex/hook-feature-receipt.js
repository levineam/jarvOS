'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'jarvos-codex-hook-feature-receipt/v1';
const SECTION_KEYS = ['hooks', 'features', 'shellEnvironmentPolicy', 'shellEnvironmentPolicySet'];
const RECEIPT_KEYS = ['schemaVersion', 'profileDigest', 'before', 'after'];

function fail(message) {
  const error = new Error(message);
  error.code = 'JARVOS_CODEX_HOOK_FEATURE_RECEIPT_INVALID';
  throw error;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertProfileDirectory(profilePath, { create = false } = {}) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) fail('CODEX_HOME must be absolute');
  const absolute = path.resolve(profilePath);
  if (!fs.existsSync(absolute)) {
    if (!create) fail('CODEX_HOME does not exist');
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(absolute);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('CODEX_HOME must be a real directory');
  if (uid !== null && stat.uid !== uid) fail('CODEX_HOME must be owned by the current user');
  if ((stat.mode & 0o022) !== 0) fail('CODEX_HOME must not be group- or world-writable');
  const real = fs.realpathSync(absolute);
  const systemAlias = absolute === '/tmp' || absolute.startsWith('/tmp/')
    ? `/private${absolute}`
    : (absolute === '/var' || absolute.startsWith('/var/')) ? `/private${absolute}` : null;
  if (real !== absolute && real !== systemAlias) fail('CODEX_HOME must not use a symbolic-link path');
  return absolute;
}

function context(receiptPath, profilePath, options = {}) {
  const profile = assertProfileDirectory(profilePath, options);
  const receipt = path.resolve(receiptPath);
  if (path.dirname(receipt) !== profile) fail('hook-feature receipt must be directly inside CODEX_HOME');
  return { profile, receipt, profileDigest: digest(fs.realpathSync(profile)) };
}

function assertReceiptFile(receiptPath) {
  const stat = fs.lstatSync(receiptPath);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('hook-feature receipt must be a regular file');
  if (uid !== null && stat.uid !== uid) fail('hook-feature receipt must be owned by the current user');
  if ((stat.mode & 0o777) !== 0o600) fail('hook-feature receipt must have mode 0600');
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join('\0') !== [...SECTION_KEYS].sort().join('\0')) {
    fail('hook-feature receipt snapshot has an unsupported shape');
  }
  for (const key of SECTION_KEYS) {
    if (snapshot[key] !== null && typeof snapshot[key] !== 'string') fail('hook-feature receipt snapshot is invalid');
  }
  return snapshot;
}

function validateReceipt(value, profileDigest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...RECEIPT_KEYS].sort().join('\0')
    || value.schemaVersion !== SCHEMA_VERSION || value.profileDigest !== profileDigest) {
    fail('hook-feature receipt is not a recognized jarvOS ownership record');
  }
  validateSnapshot(value.before);
  validateSnapshot(value.after);
  return value;
}

function readReceipt(receiptPath, profilePath) {
  const value = context(receiptPath, profilePath);
  try { fs.lstatSync(value.receipt); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  assertReceiptFile(value.receipt);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(value.receipt, 'utf8')); } catch (_) { fail('hook-feature receipt is not valid JSON'); }
  return validateReceipt(parsed, value.profileDigest);
}

function snapshotsEqual(left, right) {
  return JSON.stringify(validateSnapshot(left)) === JSON.stringify(validateSnapshot(right));
}

function claimReceipt(receiptPath, profilePath, before, after) {
  validateSnapshot(before);
  validateSnapshot(after);
  const value = context(receiptPath, profilePath, { create: true });
  if (readReceipt(value.receipt, value.profile)) fail('hook-feature receipt already exists');
  const receipt = { schemaVersion: SCHEMA_VERSION, profileDigest: value.profileDigest, before, after };
  let fd;
  try {
    fd = fs.openSync(value.receipt, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return receipt;
}

function clearReceipt(receiptPath, profilePath, expectedAfter) {
  const value = context(receiptPath, profilePath);
  const receipt = readReceipt(value.receipt, value.profile);
  if (!receipt) return false;
  if (!snapshotsEqual(receipt.after, expectedAfter)) fail('hook-feature receipt does not match the intended rollback state');
  fs.unlinkSync(value.receipt);
  return true;
}

module.exports = { SCHEMA_VERSION, claimReceipt, clearReceipt, readReceipt, snapshotsEqual, validateSnapshot };
