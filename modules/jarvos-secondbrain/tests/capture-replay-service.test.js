'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

test('identified replay retains the original operation across service restart and rejects changed requests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  const options = { vaultRoot, vaultId: 'fixture', proveObsidianAbsent: () => false,
    adapterOptions: { ledgerPath: path.join(root, 'ledger.json'), probe: () => ({ state: 'app_busy' }) } };
  const submit = (service, requestHash, content, operationKind = 'create') => {
    const context = service.createWriteContext({ vaultRelativePath: 'Notes/A.md', intentId: 'capture:fixture:note', requestHash });
    return context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId,
      sequence: 1, vaultId: 'fixture', vaultRelativePath: 'Notes/A.md', operationKind, content });
  };
  const first = createConfiguredVaultMutationService(options);
  submit(first, 'a'.repeat(64), 'original');
  const original = first.adapter.ledger.get('capture:fixture:note').operation;
  const restarted = createConfiguredVaultMutationService(options);
  assert.doesNotThrow(() => submit(restarted, 'a'.repeat(64), 'regenerated'));
  assert.deepEqual(restarted.adapter.ledger.get('capture:fixture:note').operation, original);
  const changed = submit(restarted, 'b'.repeat(64), 'changed');
  assert.equal(changed.status, 'conflict');
  assert.deepEqual(restarted.adapter.ledger.get('capture:fixture:note').operation, original);
  assert.deepEqual(fs.readdirSync(vaultRoot), []);
});

test('create-only write contexts refuse transforms and cannot replay an original update', () => {
  for (const original of [undefined, { operationKind: 'transform' }]) {
    const service = createConfiguredVaultMutationService({ vaultRoot: path.resolve('fixture-vault'),
      adapter: { ledger: { get: () => original && { operation: original } }, submit: () => assert.fail('must not dispatch an update') },
      reconciler: {},
    });
    const context = service.createWriteContext({ vaultRelativePath: 'Notes/Invented garden.md', createOnly: true });
    const receipt = context.mutationExecutor({ operationKind: original ? 'create' : 'transform' });
    assert.equal(receipt.status, 'conflict');
    assert.equal(receipt.reason, 'note_exists');
  }
});

test('a rejected create replays after restart without app access and preserves request identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-rejected-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { vaultRoot: root, vaultId: 'fixture',
    adapterOptions: { ledgerPath: path.join(root, 'ledger.json'), probe: () => ({ state: 'available' }),
      evaluate: code => code.includes('atob(')
        ? { queued: true, token: 'capture:fixture:note' } : { status: 'error', errorClass: 'note_exists' } } };
  const submit = (service, requestHash = 'a'.repeat(64)) => {
    const context = service.createWriteContext({ vaultRelativePath: 'Notes/Invented garden.md',
      operationId: 'capture:fixture:note', requestHash, createOnly: true });
    return context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId, sequence: 1,
      vaultId: 'fixture', vaultRelativePath: 'Notes/Invented garden.md', operationKind: 'create', content: 'An invented garden.' });
  };
  const first = createConfiguredVaultMutationService(options);
  assert.equal(submit(first).reason, 'note_exists');
  const original = first.adapter.ledger.verify().operations['capture:fixture:note'];
  assert.equal(original.status, 'abandoned');
  const restarted = createConfiguredVaultMutationService({ ...options, adapterOptions: { ...options.adapterOptions,
    probe: () => assert.fail('settled rejection must not probe the app'),
    evaluate: () => assert.fail('settled rejection must never dispatch') } });
  assert.equal(submit(restarted).reason, 'note_exists');
  assert.equal(submit(restarted, 'b'.repeat(64)).reason, 'capture_identity_request_conflict');
  assert.deepEqual(restarted.adapter.ledger.verify().operations['capture:fixture:note'], original);
  assert.equal(restarted.reconciler.drain().processed, 0);
  assert.equal(fs.existsSync(path.join(root, 'Notes/Invented garden.md')), false);
});
