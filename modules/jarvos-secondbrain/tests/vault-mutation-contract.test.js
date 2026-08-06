'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const contract = require('../adapters/obsidian/src/vault-mutation-contract');

const operation = () => ({
  schemaVersion: 1,
  operationId: 'op-20260806-contract-test',
  vaultId: 'test-vault',
  vaultRelativePath: 'Notes/Contract.md',
  sequence: 1,
  operationKind: 'transform',
  transformName: 'append-line',
  transformVersion: 1,
  replayPayload: { line: '- hello' },
  source: 'test',
});

test('contract validates normalized vault-relative Markdown paths and operation identity', () => {
  assert.equal(contract.validateVaultRelativeMarkdownPath('Notes/Contract.md'), 'Notes/Contract.md');
  for (const candidate of ['../outside.md', '/tmp/outside.md', 'Notes/../outside.md', 'Notes/Contract.txt', 'Notes\\Contract.md']) {
    assert.throws(() => contract.validateVaultRelativeMarkdownPath(candidate), /vault-relative Markdown path/i);
  }
  for (const candidate of ['Notes/Null\0.md', 'Notes/New\nLine.md']) assert.throws(() => contract.validateVaultRelativeMarkdownPath(candidate), /vault-relative Markdown path/i);
  assert.deepEqual(contract.validateOperation(operation()).vaultRelativePath, 'Notes/Contract.md');
  assert.throws(() => contract.validateOperation({ ...operation(), operationId: '../wrong' }), /operationId/i);
  assert.throws(() => contract.validateOperation({ ...operation(), identityPolicy: 'not-a-hook' }), /identity/i);
  assert.throws(() => contract.validateOperation(operation(), { identityPolicy: () => false }), /identity policy/i);
});

test('contract rejects target and parent symlink escapes before mutation', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-contract-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-outside-'));
  try {
    fs.mkdirSync(path.join(root, 'Notes'));
    assert.equal(contract.resolveVaultTarget({ vaultRoot: root, vaultRelativePath: 'Notes/Good.md' }), path.join(fs.realpathSync(root), 'Notes', 'Good.md'));
    fs.symlinkSync(outside, path.join(root, 'Escape'));
    assert.throws(() => contract.resolveVaultTarget({ vaultRoot: root, vaultRelativePath: 'Escape/Bad.md' }), /symlink/i);
    fs.symlinkSync(path.join(outside, 'x.md'), path.join(root, 'Notes', 'Link.md'));
    assert.throws(() => contract.resolveVaultTarget({ vaultRoot: root, vaultRelativePath: 'Notes/Link.md' }), /symlink/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('internal receipts retain evidence while public results redact private operation data', () => {
  const receipt = contract.createInternalReceipt({
    operation: { ...operation(), expectedHash: 'a'.repeat(64) },
    status: 'committed',
    persistence: 'durable',
    obsidian: 'acknowledged',
    sync: 'unknown',
    hostIdentity: 'private-host',
    adapterEvidence: { path: '/private/vault/Notes/Contract.md', content: 'secret', hash: 'b'.repeat(64) },
    createdAt: '2026-08-06T00:00:00.000Z',
  });
  const projected = contract.projectPublicResult(receipt);
  assert.deepEqual(projected, { schemaVersion: 1, status: 'committed', persistence: 'durable', obsidian: 'acknowledged', sync: 'unknown' });
  const serialized = JSON.stringify(projected);
  for (const forbidden of ['path', 'content', 'hash', 'createdAt', 'operationId', 'private-host', 'record']) {
    assert.equal(serialized.includes(forbidden), false, `public result leaked ${forbidden}`);
  }
});

test('public projection is an allowlist even when an untrusted receipt contains objects or secrets', () => {
  const projected = contract.projectPublicResult({
    status: 'committed',
    persistence: { path: '/vault/secret.md', hash: 'a'.repeat(64) },
    obsidian: 'acknowledged /vault/secret.md',
    sync: { content: 'secret' },
  });
  assert.deepEqual(projected, { schemaVersion: 1, status: 'committed', persistence: 'unknown', obsidian: 'unknown', sync: 'unknown' });
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal(contract.projectPublicResult({ status: 'blocked', persistence: 'pending', obsidian: 'pending', sync: 'unknown' }).status, 'blocked');
  assert.equal(contract.LIFECYCLE_STATES.has('unknown_after_dispatch'), true);
});

test('guarded delete is a distinct validated operation kind', () => {
  const deletion = { ...operation(), operationKind: 'delete', expectedContent: 'fixture', expectedHash: contract.hashUtf8('fixture') };
  assert.equal(contract.validateOperation(deletion).operationKind, 'delete');
});
