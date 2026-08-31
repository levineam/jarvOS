'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'jarvos-codex-hook-feature-receipt/v4';
const OWNED_PATHS = [
  'hooks.SessionStart',
  'hooks.UserPromptSubmit',
  'features.hooks',
  'features.codex_hooks',
  'shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_COMMAND',
  'shell_environment_policy.set.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT',
  'shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE',
];
const PARENT_PATHS = ['hooks', 'features', 'shell_environment_policy', 'shell_environment_policy.set'];
const RECEIPT_KEYS = ['schemaVersion', 'profileDigest', 'configDigest', 'state', 'before', 'after', 'parentBefore'];

function fail(message) {
  const error = new Error(message);
  error.code = 'JARVOS_CODEX_HOOK_FEATURE_RECEIPT_INVALID';
  throw error;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalFile(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) fail('CODEX_CONFIG must be absolute');
  const absolute = path.resolve(configPath);
  const stat = fs.lstatSync(absolute);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('CODEX_CONFIG must be a real file');
  if (uid !== null && stat.uid !== uid) fail('CODEX_CONFIG must be owned by the current user');
  if ((stat.mode & 0o022) !== 0) fail('CODEX_CONFIG must not be group- or world-writable');
  const real = fs.realpathSync(absolute);
  const systemAlias = absolute.startsWith('/tmp/') || absolute.startsWith('/var/') ? `/private${absolute}` : null;
  if (real !== absolute && real !== systemAlias) fail('CODEX_CONFIG must not use a symbolic-link path');
  return real;
}

function profileDirectory(profilePath, { create = false } = {}) {
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
  const systemAlias = absolute === '/tmp' || absolute.startsWith('/tmp/') || absolute === '/var' || absolute.startsWith('/var/') ? `/private${absolute}` : null;
  if (real !== absolute && real !== systemAlias) fail('CODEX_HOME must not use a symbolic-link path');
  return absolute;
}

function context(receiptPath, profilePath, configPath, options = {}) {
  const profile = profileDirectory(profilePath, options);
  const config = canonicalFile(configPath);
  const receipt = path.resolve(receiptPath);
  if (path.dirname(receipt) !== profile) fail('hook-feature receipt must be directly inside CODEX_HOME');
  return { profile, config, receipt, profileDigest: digest(fs.realpathSync(profile)), configDigest: digest(config) };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join('\0') !== [...OWNED_PATHS].sort().join('\0')) {
    fail('hook-feature receipt snapshot has an unsupported shape');
  }
  for (const key of OWNED_PATHS) {
    const item = snapshot[key];
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join('\0') !== 'present\0value'
      || typeof item.present !== 'boolean' || (!item.present && item.value !== null)) {
      fail('hook-feature receipt snapshot is invalid');
    }
  }
  return snapshot;
}

function validateParentPresence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...PARENT_PATHS].sort().join('\0')
    || PARENT_PATHS.some((key) => typeof value[key] !== 'boolean')) {
    fail('hook-feature receipt parent presence has an unsupported shape');
  }
  return value;
}

function validateReceipt(value, profileDigest, configDigest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== [...RECEIPT_KEYS].sort().join('\0')
    || value.schemaVersion !== SCHEMA_VERSION || value.profileDigest !== profileDigest
    || value.configDigest !== configDigest || !['pending', 'active'].includes(value.state)) {
    fail('hook-feature receipt is not a recognized jarvOS ownership record');
  }
  validateSnapshot(value.before);
  validateSnapshot(value.after);
  validateParentPresence(value.parentBefore);
  return value;
}

function readReceipt(receiptPath, profilePath, configPath) {
  const value = context(receiptPath, profilePath, configPath);
  try { fs.lstatSync(value.receipt); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const stat = fs.lstatSync(value.receipt);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (stat.isSymbolicLink() || !stat.isFile()) fail('hook-feature receipt must be a regular file');
  if (uid !== null && stat.uid !== uid) fail('hook-feature receipt must be owned by the current user');
  if ((stat.mode & 0o777) !== 0o600) fail('hook-feature receipt must have mode 0600');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(value.receipt, 'utf8')); } catch (_) { fail('hook-feature receipt is not valid JSON'); }
  return validateReceipt(parsed, value.profileDigest, value.configDigest);
}

function snapshotsEqual(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(validateSnapshot(left))) === JSON.stringify(canonical(validateSnapshot(right)));
}

function writeReceipt(receiptPath, receipt) {
  let fd;
  try {
    fd = fs.openSync(receiptPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function claimReceipt(receiptPath, profilePath, configPath, before, after, parentBefore) {
  validateSnapshot(before); validateSnapshot(after); validateParentPresence(parentBefore);
  const value = context(receiptPath, profilePath, configPath, { create: true });
  if (readReceipt(value.receipt, value.profile, value.config)) fail('hook-feature receipt already exists');
  const receipt = { schemaVersion: SCHEMA_VERSION, profileDigest: value.profileDigest, configDigest: value.configDigest, state: 'pending', before, after, parentBefore };
  writeReceipt(value.receipt, receipt);
  return receipt;
}

function activateReceipt(receiptPath, profilePath, configPath, expectedAfter) {
  const value = context(receiptPath, profilePath, configPath);
  const receipt = readReceipt(value.receipt, value.profile, value.config);
  if (!receipt) fail('hook-feature receipt disappeared before activation');
  if (receipt.state !== 'pending' || !snapshotsEqual(receipt.after, expectedAfter)) fail('hook-feature receipt does not match the completed setup state');
  const temporary = path.join(value.profile, `.${path.basename(value.receipt)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeReceipt(temporary, { ...receipt, state: 'active' });
    fs.renameSync(temporary, value.receipt);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function clearReceipt(receiptPath, profilePath, configPath, expectedAfter) {
  const value = context(receiptPath, profilePath, configPath);
  const receipt = readReceipt(value.receipt, value.profile, value.config);
  if (!receipt) return false;
  if (!snapshotsEqual(receipt.after, expectedAfter)) fail('hook-feature receipt does not match the intended rollback state');
  fs.unlinkSync(value.receipt);
  return true;
}

module.exports = { SCHEMA_VERSION, OWNED_PATHS, PARENT_PATHS, claimReceipt, activateReceipt, clearReceipt, readReceipt, snapshotsEqual, validateSnapshot, validateParentPresence };
