'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_STATUSES = new Set(['committed', 'saved_locally_sync_pending', 'already_satisfied', 'conflict', 'blocked', 'unavailable', 'failed']);
const SYNC_STATES = new Set(['disabled', 'converged', 'pending', 'diverged', 'unknown']);
const LIFECYCLE_STATES = new Set(['planned', 'local_mutating', 'local_applied', 'dispatched', 'unknown_after_dispatch', 'acknowledged', 'conflict', 'blocked']);
const PUBLIC_PERSISTENCE = new Set(['durable', 'pending', 'unavailable', 'failed', 'unknown']);
const PUBLIC_OBSIDIAN = new Set(['acknowledged', 'pending', 'unavailable', 'unknown']);

function fail(message) { throw new Error(message); }

function validateVaultRelativeMarkdownPath(value) {
  if (typeof value !== 'string' || !value || /[\0-\x1f\x7f]/.test(value) || value.includes('\\') || path.isAbsolute(value)) fail('Expected a normalized vault-relative Markdown path');
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || !normalized.endsWith('.md')) fail('Expected a normalized vault-relative Markdown path');
  return normalized;
}

function hasSymlinkInExistingPath(root, target, fsImpl) {
  let current = root;
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fsImpl.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
}

function resolveVaultTarget({ vaultRoot, vaultRelativePath, fsImpl = fs } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) fail('vaultRoot must be an absolute path');
  const relative = validateVaultRelativeMarkdownPath(vaultRelativePath);
  const root = fsImpl.realpathSync(vaultRoot);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) fail('Vault target escapes configured root');
  if (hasSymlinkInExistingPath(root, target, fsImpl)) fail('Vault target contains a symlink escape');
  return target;
}

function isHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value); }
function isOperationId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value); }

function validateOperation(input, { identityPolicy } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('operation must be an object');
  if (input.identityPolicy !== undefined) fail('identity policy is a caller hook, not operation data');
  if (input.schemaVersion !== 1) fail('Unsupported operation schemaVersion');
  if (!isOperationId(input.operationId)) fail('Invalid operationId');
  if (typeof input.vaultId !== 'string' || !input.vaultId.trim()) fail('Invalid vaultId');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) fail('Invalid operation sequence');
  if (!['create', 'transform', 'replace', 'delete'].includes(input.operationKind)) fail('Invalid operation kind');
  const operation = { ...input, vaultRelativePath: validateVaultRelativeMarkdownPath(input.vaultRelativePath) };
  if (operation.expectedHash !== undefined && !isHash(operation.expectedHash)) fail('Invalid expectedHash');
  if (operation.intendedHash !== undefined && !isHash(operation.intendedHash)) fail('Invalid intendedHash');
  if (operation.operationKind === 'transform' && (!Number.isSafeInteger(operation.transformVersion) || typeof operation.transformName !== 'string' || !operation.transformName)) fail('Transform operation requires name and version');
  if (operation.operationKind === 'delete' && (typeof operation.expectedContent !== 'string' || !isHash(operation.expectedHash) || hashUtf8(operation.expectedContent) !== operation.expectedHash)) fail('Delete operation requires matching expected content and hash');
  if (identityPolicy !== undefined && typeof identityPolicy !== 'function') fail('identity policy must be a function');
  if (identityPolicy && identityPolicy(operation) !== true) fail('Operation rejected by identity policy');
  return operation;
}

function hashUtf8(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }

function createInternalReceipt({ operation, status, lifecycleState, persistence, obsidian, sync = 'unknown', hostIdentity, adapterEvidence, createdAt = new Date().toISOString() } = {}) {
  const validOperation = validateOperation(operation);
  if (!PUBLIC_STATUSES.has(status) && status !== 'unknown_after_dispatch') fail('Invalid internal mutation status');
  const state = lifecycleState || (status === 'committed' ? 'acknowledged' : status);
  if (!LIFECYCLE_STATES.has(state)) fail('Invalid lifecycle state');
  if (!SYNC_STATES.has(sync)) fail('Invalid sync state');
  return { schemaVersion: 1, operation: validOperation, status, lifecycleState: state, persistence, obsidian, sync, hostIdentity, adapterEvidence, createdAt };
}

function projectPublicResult(receipt) {
  if (!receipt || typeof receipt !== 'object') fail('receipt is required');
  const status = receipt.status === 'unknown_after_dispatch' ? 'unavailable' : receipt.status;
  return {
    schemaVersion: 1,
    status: PUBLIC_STATUSES.has(status) ? status : 'failed',
    persistence: PUBLIC_PERSISTENCE.has(receipt.persistence) ? receipt.persistence : 'unknown',
    obsidian: PUBLIC_OBSIDIAN.has(receipt.obsidian) ? receipt.obsidian : 'unknown',
    sync: SYNC_STATES.has(receipt.sync) ? receipt.sync : 'unknown',
  };
}

module.exports = { LIFECYCLE_STATES, PUBLIC_OBSIDIAN, PUBLIC_PERSISTENCE, PUBLIC_STATUSES, SYNC_STATES, createInternalReceipt, hashUtf8, projectPublicResult, resolveVaultTarget, validateOperation, validateVaultRelativeMarkdownPath };
