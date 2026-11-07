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

for (const mode of [0o644, 0o640]) {
  test(`normal mutations restore mode ${mode.toString(8)} without losing ledger records`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-mode-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      const ledger = createVaultMutationLedger({ filePath, now: () => 100 });
      const first = ledger.planNext(op('op-mode-first')).operation;
      assert.equal(ledger.claim(first, 'owner').granted, true);
      ledger.planNext(op('op-mode-queued'));
      ledger.nextSequence('vault', 'Notes/B.md');
      const before = ledger.read();
      fs.chmodSync(filePath, mode);
      ledger.ensure(op('op-mode-new', 3));
      const after = ledger.read();
      for (const [id, record] of Object.entries(before.operations)) assert.deepEqual(after.operations[id], record);
      assert.equal(Object.keys(after.operations).length, 3);
      assert.deepEqual(after.claims, before.claims);
      assert.deepEqual(after.sequences, before.sequences);
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(`${filePath}.quarantine`), false);
      fs.chmodSync(filePath, mode);
      assert.equal(ledger.planNext(op('op-mode-next')).operation.sequence, 4);
      const planned = ledger.read();
      for (const [id, record] of Object.entries(after.operations)) assert.deepEqual(planned.operations[id], record);
      assert.deepEqual(planned.claims, before.claims);
      assert.equal(planned.sequences['vault\0Notes/B.md'], before.sequences['vault\0Notes/B.md']);
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
      assert.equal(fs.existsSync(`${filePath}.quarantine`), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const failure of ['throws', 'leaves unsafe bits']) {
  test(`permission repair that ${failure} refuses mutation without changing ledger bytes`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-mode-failure-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      const original = createVaultMutationLedger({ filePath });
      original.planNext(op('op-mode-existing'));
      const before = fs.readFileSync(filePath);
      fs.chmodSync(filePath, 0o644);
      const fsImpl = { ...fs, chmodSync(target, mode) {
        if (target !== filePath) return fs.chmodSync(target, mode);
        if (failure === 'throws') throw new Error('synthetic chmod failure');
      } };
      const ledger = createVaultMutationLedger({ filePath, fsImpl });
      assert.throws(() => ledger.ensure(op('op-mode-refused', 2)), /ledger permissions are unsafe and could not be restored to 0600/);
      assert.throws(() => ledger.read(), /ledger permissions are unsafe and could not be restored to 0600/);
      assert.deepEqual(fs.readFileSync(filePath), before);
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(`${filePath}.quarantine`), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const kind of ['directory', 'symlink']) {
  test(`a ${kind} ledger path is refused without deleting or replacing anything`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-path-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      const target = path.join(root, 'target.json');
      fs.writeFileSync(target, 'synthetic target', { mode: 0o644 });
      if (kind === 'directory') fs.mkdirSync(filePath, { mode: 0o700 });
      else fs.symlinkSync(target, filePath);
      const ledger = createVaultMutationLedger({ filePath });
      assert.throws(() => ledger.ensure(op('op-path-refused')), /ledger path must be a regular file/);
      assert.throws(() => ledger.peek(), /ledger path must be a regular file/);
      assert.equal(fs.lstatSync(filePath)[kind === 'directory' ? 'isDirectory' : 'isSymbolicLink'](), true);
      assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic target');
      assert.equal(fs.statSync(target).mode & 0o777, 0o644);
      assert.equal(fs.existsSync(`${filePath}.quarantine`), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

for (const rawText of ['{not-json}', JSON.stringify({ schemaVersion: 99, retained: 'synthetic data' })]) {
  test(`corrupt ledger preserves ${rawText.startsWith('{not') ? 'raw text' : 'parsed data'} in owner-only quarantine`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-quarantine-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      fs.writeFileSync(filePath, rawText, { mode: 0o600 });
      const ledger = createVaultMutationLedger({ filePath });
      assert.deepEqual(ledger.read(), { schemaVersion: 1, operations: {}, claims: {}, sequences: {} });
      const files = fs.readdirSync(`${filePath}.quarantine`);
      assert.equal(files.length, 1);
      const quarantinePath = path.join(`${filePath}.quarantine`, files[0]);
      const quarantined = JSON.parse(fs.readFileSync(quarantinePath, 'utf8'));
      assert.deepEqual(quarantined.record, rawText.startsWith('{not') ? { rawLedger: true, rawText } : JSON.parse(rawText));
      assert.equal(fs.statSync(quarantinePath).mode & 0o777, 0o600);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

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

test('per-file sequence reservations are durable across ledger instances', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-sequence-'));
  try {
    const filePath = path.join(root, 'ledger.json');
    const first = createVaultMutationLedger({ filePath });
    const second = createVaultMutationLedger({ filePath });
    assert.equal(first.nextSequence('vault', 'Notes/A.md'), 1);
    assert.equal(second.nextSequence('vault', 'Notes/A.md'), 2);
    assert.equal(first.nextSequence('vault', 'Notes/B.md'), 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('complete operations are planned atomically in submission order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-plan-'));
  try {
    const ledger = createVaultMutationLedger({ filePath: path.join(root, 'ledger.json') });
    const laterContext = op('op-00000021');
    const earlierContext = op('op-00000020');
    const submittedFirst = ledger.planNext(laterContext).operation;
    const submittedSecond = ledger.planNext(earlierContext).operation;
    assert.equal(submittedFirst.sequence, 1);
    assert.equal(submittedSecond.sequence, 2);
    assert.deepEqual(ledger.planNext({ ...laterContext, sequence: 99 }).operation, submittedFirst);
    assert.equal(Object.keys(ledger.read().operations).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const state of ['planned', 'dispatched', 'local_mutating', 'local_applied', 'unknown_after_dispatch']) {
  test(`quarantine following ${state} ${state === 'planned' ? 'allows' : 'blocks'} later file claims`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-ledger-quarantine-order-'));
    try {
      const ledger = createVaultMutationLedger({ filePath: path.join(root, 'ledger.json') });
      const first = op('op-quarantine-first');
      ledger.ensure(first);
      if (state !== 'planned') {
        const claim = ledger.claim(first, 'owner', { local: state.startsWith('local_') });
        if (['local_applied', 'unknown_after_dispatch'].includes(state)) ledger.transition(first.operationId, state, { ownerId: 'owner', fence: claim.fence });
      }
      ledger.quarantine(first.operationId, 'synthetic rejection');
      const later = op('op-quarantine-later', 2);
      const claim = ledger.claim(later, 'later-owner');
      assert.equal(claim.granted, state === 'planned');
      if (state !== 'planned') {
        assert.equal(claim.reason, 'prior_operation_blocked');
        assert.equal(ledger.active()[0].operation.operationId, first.operationId);
        const { createVaultMutationReconciler } = require('../adapters/obsidian/src/vault-mutation-reconciler');
        const reconciler = createVaultMutationReconciler({ ledger, vaultRoot: root, adapter: { execute() { assert.fail('quarantine after possible mutation must block drain'); } } });
        const summary = reconciler.drain();
        assert.equal(summary.processed, 1);
        assert.equal(summary.blocked, 1);
      }
      assert.equal(ledger.get(first.operationId).status, 'quarantined');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
