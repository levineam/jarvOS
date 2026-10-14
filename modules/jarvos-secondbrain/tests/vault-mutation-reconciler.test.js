'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVaultMutationLedger } = require('../adapters/obsidian/src/vault-mutation-ledger');
const { createVaultMutationReconciler } = require('../adapters/obsidian/src/vault-mutation-reconciler');
const { hashUtf8 } = require('../adapters/obsidian/src/vault-mutation-contract');

const op = (id, sequence = 1, extra = {}) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath: 'Notes/A.md', sequence, operationKind: 'create', content: 'hello', source: 'trusted-offline', ...extra });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-reconcile-'));
  const ledger = createVaultMutationLedger({ filePath: path.join(root, 'ledger.json') });
  let calls = 0;
  const adapter = {
    inspectInvariant: () => ({ status: 'unsatisfied', invariant: false }),
    acknowledgeIfSatisfied(operation) {
      const inspection = this.inspectInvariant(operation);
      if (inspection.status !== 'satisfied' || inspection.invariant !== true) return false;
      const claim = ledger.claim(operation, 'fake-adapter', { allowAmbiguousRetry: true });
      if (!claim.granted) return claim.reason === 'already_acknowledged';
      ledger.transition(operation.operationId, 'acknowledged', { ownerId: 'fake-adapter', fence: claim.fence, evidence: { acknowledgedBy: 'app.vault.read' } });
      return true;
    },
    execute() { calls += 1; return { status: 'committed' }; },
  };
  return { root, ledger, adapter, calls: () => calls };
}

test('reconciler accepts delayed post-timeout commit once without a duplicate dispatch', () => {
  const f = fixture();
  try {
    f.ledger.ensure(op('op-00000011'));
    const claim = f.ledger.claim(op('op-00000011'), 'old'); f.ledger.transition('op-00000011', 'unknown_after_dispatch', { ownerId: 'old', fence: claim.fence });
    fs.mkdirSync(path.join(f.root, 'Notes')); fs.writeFileSync(path.join(f.root, 'Notes/A.md'), 'hello');
    f.adapter.inspectInvariant = () => ({ status: 'satisfied', invariant: true });
    const reconciler = createVaultMutationReconciler({ adapter: f.adapter, ledger: f.ledger, vaultRoot: f.root });
    assert.equal(reconciler.drain().acknowledged, 1);
    assert.equal(f.calls(), 0);
    assert.equal(f.ledger.get('op-00000011').status, 'acknowledged');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('offline fallback only writes an absence-asserted exclusive create', () => {
  const f = fixture();
  try {
    const capability = Object.freeze({});
    const reconciler = createVaultMutationReconciler({ adapter: f.adapter, ledger: f.ledger, vaultRoot: f.root, offlineSourceAllowlist: ['trusted-offline'], proveObsidianAbsent: () => true, offlineWriteCapability: capability });
    assert.equal(reconciler.safeOfflineSave(op('op-00000018', 1, { source: 'trusted-offline', vaultRelativePath: 'Notes/Untrusted.md' }), Object.freeze({})).localMutation, 'queued');
    assert.equal(f.ledger.get('op-00000018'), null);
    assert.equal(fs.existsSync(path.join(f.root, 'Notes/A.md')), false);
    assert.equal(reconciler.safeOfflineSave(op('op-00000012'), capability).localMutation, 'applied');
    assert.equal(fs.readFileSync(path.join(f.root, 'Notes/A.md'), 'utf8'), 'hello');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('existing replace never writes without exclusive proof and mismatched proof conflicts', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'Notes')); fs.writeFileSync(path.join(f.root, 'Notes/A.md'), 'mobile');
    const capability = Object.freeze({});
    const reconciler = createVaultMutationReconciler({ adapter: f.adapter, ledger: f.ledger, vaultRoot: f.root, offlineSourceAllowlist: ['trusted-offline'], proveObsidianAbsent: () => true, offlineWriteCapability: capability });
    const replace = op('op-00000013', 1, { operationKind: 'replace', content: 'agent', expectedHash: hashUtf8('old') });
    const deferred = reconciler.safeOfflineSave(replace, capability);
    assert.equal(deferred.localMutation, 'not_written');
    assert.equal(deferred.status, 'unavailable');
    assert.equal(fs.readFileSync(path.join(f.root, 'Notes/A.md'), 'utf8'), 'mobile');
    const other = op('op-00000014', 1, { vaultRelativePath: 'Notes/B.md', operationKind: 'replace', content: 'agent', expectedHash: hashUtf8('old') });
    fs.writeFileSync(path.join(f.root, 'Notes/B.md'), 'mobile');
    const exclusive = createVaultMutationReconciler({ adapter: f.adapter, ledger: f.ledger, vaultRoot: f.root, offlineSourceAllowlist: ['trusted-offline'], proveObsidianAbsent: () => true, exclusiveWriterCapability: () => true, offlineWriteCapability: capability });
    assert.equal(exclusive.safeOfflineSave(other, capability).status, 'conflict');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('bounded drain preserves head-of-line blocking and avoids unknown transforms', () => {
  const f = fixture();
  try {
    f.ledger.ensure(op('op-00000015', 1, { operationKind: 'transform', transformName: 'gone', transformVersion: 99, replayPayload: { x: 1 } }));
    f.ledger.ensure(op('op-00000016', 2));
    const reconciler = createVaultMutationReconciler({ adapter: f.adapter, ledger: f.ledger, vaultRoot: f.root, transforms: { quarantine: () => ({ reason: 'unknown' }) } });
    const result = reconciler.drain({ limit: 1, timeMs: 100 });
    assert.equal(result.quarantined, 1);
    assert.equal(f.ledger.get('op-00000016').status, 'planned');
    assert.equal(f.calls(), 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('uncomposed operator registry blocks retained transforms without quarantining', () => {
  const f = fixture();
  try {
    f.ledger.ensure(op('op-00000019', 1, { operationKind: 'transform', transformName: 'append-line', transformVersion: 1, replayPayload: { line: '- retained' } }));
    const reconciler = createVaultMutationReconciler({ adapter: f.adapter, ledger: f.ledger, vaultRoot: f.root });
    assert.equal(reconciler.drain().blocked, 1);
    assert.equal(f.ledger.get('op-00000019').status, 'planned');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('disk bytes never acknowledge a stale Obsidian readback', () => {
  const f = fixture();
  try {
    f.ledger.ensure(op('op-00000017'));
    const claim = f.ledger.claim(op('op-00000017'), 'timed-out');
    f.ledger.transition('op-00000017', 'unknown_after_dispatch', { ownerId: 'timed-out', fence: claim.fence });
    fs.mkdirSync(path.join(f.root, 'Notes')); fs.writeFileSync(path.join(f.root, 'Notes/A.md'), 'hello');
    f.adapter.inspectInvariant = () => ({ status: 'unsatisfied', invariant: false });
    const reconciler = createVaultMutationReconciler({ adapter: f.adapter, ledger: f.ledger, vaultRoot: f.root });
    assert.equal(reconciler.drain().blocked, 1);
    assert.equal(f.ledger.get('op-00000017').status, 'unknown_after_dispatch');
    assert.equal(f.calls(), 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
