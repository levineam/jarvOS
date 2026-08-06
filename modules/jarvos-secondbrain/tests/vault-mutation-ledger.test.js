'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVaultMutationLedger } = require('../adapters/obsidian/src/vault-mutation-ledger');

const op = (id, sequence = 1) => ({ schemaVersion: 1, operationId: id, vaultId: 'vault', vaultRelativePath: 'Notes/A.md', sequence, operationKind: 'create' });

test('ledger durably creates intent before granting FIFO fenced claims', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-'));
  try {
    let now = 100;
    const filePath = path.join(root, 'ledger.json');
    const ledger = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 20 });
    const first = ledger.claim(op('op-00000001'), 'owner-a'); assert.equal(first.granted, true);
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(ledger.claim(op('op-00000002', 2), 'owner-b').reason, 'prior_operation_pending');
    ledger.transition('op-00000001', 'unknown_after_dispatch', { ownerId: 'owner-a', fence: first.fence });
    now = 1000;
    assert.equal(ledger.claim(op('op-00000002', 2), 'owner-b').reason, 'prior_operation_blocked');
    const restarted = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 20 });
    assert.equal(restarted.get('op-00000001').status, 'unknown_after_dispatch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('separate ledger instances fence stale claim owners and reject sequence collisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-fence-'));
  try {
    let now = 1; const filePath = path.join(root, 'ledger.json');
    const a = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 10 });
    const b = createVaultMutationLedger({ filePath, now: () => now, leaseMs: 10 });
    const first = a.claim(op('op-00000003'), 'a'); assert.equal(first.granted, true);
    assert.equal(b.claim(op('op-00000003'), 'b').reason, 'claim_active');
    assert.equal(a.claim(op('op-00000003'), 'a').reason, 'claim_active');
    assert.throws(() => b.claim(op('op-00000005'), 'b'), /Duplicate same-file operation sequence/);
    now = 100; const takeover = b.claim(op('op-00000003'), 'b'); assert.equal(takeover.granted, true);
    assert.throws(() => a.transition('op-00000003', 'acknowledged', { ownerId: 'a', fence: first.fence }), /fence/);
    assert.doesNotThrow(() => b.transition('op-00000003', 'acknowledged', { ownerId: 'b', fence: takeover.fence }));
    assert.equal(a.claim(op('op-00000003'), 'a').reason, 'already_acknowledged');
    assert.throws(() => a.transition('op-00000003', 'not-a-state', { ownerId: 'a', fence: 1 }), /Invalid ledger transition/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed and permission-unsafe ledgers are quarantined fail-closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-quarantine-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    fs.writeFileSync(filePath, '{not-json}', { mode: 0o600 });
    const ledger = createVaultMutationLedger({ filePath });
    assert.deepEqual(ledger.read().operations, {});
    assert.equal(fs.readdirSync(`${filePath}.quarantine`).length, 1);
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, operations: {}, claims: {} }), { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);
    assert.deepEqual(ledger.read().operations, {});
    assert.equal(fs.readdirSync(`${filePath}.quarantine`).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('local write-ahead states and auditable operator resolution survive restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-local-'));
  try {
    const filePath = path.join(root, 'ledger.json'); const ledger = createVaultMutationLedger({ filePath });
    const claim = ledger.claim(op('op-00000006'), 'offline', { local: true });
    assert.equal(ledger.get('op-00000006').status, 'local_mutating');
    ledger.transition('op-00000006', 'local_applied', { ownerId: 'offline', fence: claim.fence });
    const restarted = createVaultMutationLedger({ filePath });
    assert.equal(restarted.get('op-00000006').status, 'local_applied');
    restarted.resolve('operator', 'op-00000006', 'abandoned', 'user selected recovery');
    assert.equal(restarted.get('op-00000006').history.at(-1).evidence.reason, 'user selected recovery');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
