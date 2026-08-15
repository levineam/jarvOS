'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_VERSION = 1;
const STATE_DIR = '.jarvos-projections';
const SHA256_RE = /^[a-f0-9]{64}$/i;

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

function ensureStateDir(skillsRoot) {
  const root = path.resolve(skillsRoot);
  const stateDir = path.join(root, STATE_DIR);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(stateDir);
  assertSafeOwnedDirectory(stat, 'projection state directory');
  return fs.realpathSync(stateDir);
}

function receiptPath(skillsRoot, effectiveName, { create = true } = {}) {
  if (typeof effectiveName !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(effectiveName)) {
    throw new Error('effectiveName is invalid');
  }
  const root = path.resolve(skillsRoot);
  const stateDir = create ? ensureStateDir(root) : path.join(root, STATE_DIR);
  return path.join(stateDir, `${effectiveName}.json`);
}

function readReceipt(skillsRoot, effectiveName) {
  const file = receiptPath(skillsRoot, effectiveName, { create: false });
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('receipt must be a regular file');
  if ((stat.mode & 0o022) !== 0) throw new Error('receipt has unsafe permissions');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('receipt is invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function validateReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  if (receipt.version !== RECEIPT_VERSION) return null;
  if (typeof receipt.id !== 'string' || typeof receipt.effectiveName !== 'string') return null;
  if (typeof receipt.harness !== 'string') return null;
  if (!SHA256_RE.test(receipt.treeDigest || '')) return null;
  if (!SHA256_RE.test(receipt.catalogDigest || '')) return null;
  if (!Number.isInteger(receipt.aliasRevision)) return null;
  const inventoryGenerationId = typeof receipt.inventoryGenerationId === 'string'
    && /^gen-[a-z0-9-]+$/i.test(receipt.inventoryGenerationId.trim())
    ? receipt.inventoryGenerationId.trim()
    : null;
  const sourceIdentity = receipt.sourceIdentity && typeof receipt.sourceIdentity === 'object'
    && !Array.isArray(receipt.sourceIdentity)
    ? {
      logicalId: typeof receipt.sourceIdentity.logicalId === 'string' ? receipt.sourceIdentity.logicalId : null,
      sourceKind: typeof receipt.sourceIdentity.sourceKind === 'string' ? receipt.sourceIdentity.sourceKind : null,
      profileDigest: typeof receipt.sourceIdentity.profileDigest === 'string'
        && SHA256_RE.test(receipt.sourceIdentity.profileDigest)
        ? receipt.sourceIdentity.profileDigest.toLowerCase()
        : null,
    }
    : null;
  return {
    version: RECEIPT_VERSION,
    id: receipt.id,
    effectiveName: receipt.effectiveName,
    harness: receipt.harness,
    treeDigest: receipt.treeDigest.toLowerCase(),
    catalogDigest: receipt.catalogDigest.toLowerCase(),
    aliasRevision: receipt.aliasRevision,
    targetPath: typeof receipt.targetPath === 'string' ? receipt.targetPath : null,
    verificationTier: typeof receipt.verificationTier === 'string' ? receipt.verificationTier : null,
    // Optional inventory provenance (U4). Absent on pre-inventory receipts.
    inventoryGenerationId,
    sourceIdentity,
  };
}

function atomicWriteReceipt(skillsRoot, receipt) {
  const validated = validateReceipt(receipt);
  if (!validated) throw new Error('receipt is incomplete');
  const file = receiptPath(skillsRoot, validated.effectiveName);
  const parent = path.dirname(file);
  const tmp = path.join(parent, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const body = `${JSON.stringify(validated, null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return { path: file, receipt: validated, digest: sha256(body) };
}

function removeReceipt(skillsRoot, effectiveName) {
  const file = receiptPath(skillsRoot, effectiveName);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = {
  RECEIPT_VERSION,
  STATE_DIR,
  receiptPath,
  readReceipt,
  validateReceipt,
  atomicWriteReceipt,
  removeReceipt,
};
