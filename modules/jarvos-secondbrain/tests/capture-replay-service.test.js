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
