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

test('a changed request cannot reach an unused sibling stage of an identified capture', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-replay-family-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  const service = createConfiguredVaultMutationService({ vaultRoot, vaultId: 'fixture', proveObsidianAbsent: () => false,
    adapterOptions: { ledgerPath: path.join(root, 'ledger.json'), probe: () => ({ state: 'app_busy' }) } });
  const submit = (intentId, vaultRelativePath, requestHash) => {
    const context = service.createWriteContext({ vaultRelativePath, intentId, requestHash });
    return context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId,
      sequence: 1, vaultId: 'fixture', vaultRelativePath, operationKind: 'create', content: 'synthetic' });
  };
  submit('capture:fixture-family:note', 'Notes/A.md', 'a'.repeat(64));
  const sibling = submit('capture:fixture-family:journal:create', 'Journal/2030-02-03.md', 'b'.repeat(64));
  assert.equal(sibling.status, 'conflict');
  assert.equal(sibling.reason, 'capture_identity_request_conflict');
  assert.equal(service.adapter.ledger.get('capture:fixture-family:journal:create'), null);
  submit('capture:fixture-reverse:journal:create', 'Journal/2030-02-04.md', 'a'.repeat(64));
  const reverse = submit('capture:fixture-reverse:note', 'Notes/B.md', 'b'.repeat(64));
  assert.equal(reverse.status, 'conflict');
  assert.equal(service.adapter.ledger.get('capture:fixture-reverse:note'), null);
  assert.notEqual(submit('capture:fixture-family:journal:create', 'Journal/2030-02-03.md', 'a'.repeat(64)).status, 'conflict');
  assert.deepEqual(fs.readdirSync(vaultRoot), []);
});

test('an equal request hash from another configured source cannot reach an unused sibling', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-replay-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  const configured = (source) => createConfiguredVaultMutationService({ vaultRoot, vaultId: 'fixture', source, proveObsidianAbsent: () => false,
    adapterOptions: { ledgerPath: path.join(root, 'ledger.json'), probe: () => ({ state: 'app_busy' }) } });
  const submit = (service, intentId, vaultRelativePath) => {
    const context = service.createWriteContext({ vaultRelativePath, intentId, requestHash: 'a'.repeat(64) });
    return context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId,
      sequence: 1, vaultId: 'fixture', vaultRelativePath, operationKind: 'create', content: 'synthetic' });
  };
  const alpha = configured('alpha.capture-source');
  const beta = configured('beta.capture-source');
  submit(alpha, 'capture:fixture-source:note', 'Notes/A.md');
  const sibling = submit(beta, 'capture:fixture-source:journal:create', 'Journal/2030-02-03.md');
  assert.equal(sibling.status, 'conflict');
  assert.equal(sibling.reason, 'capture_identity_request_conflict');
  assert.equal(beta.adapter.ledger.get('capture:fixture-source:journal:create'), null);
  assert.notEqual(submit(alpha, 'capture:fixture-source:journal:create', 'Journal/2030-02-03.md').status, 'conflict');
  assert.deepEqual(fs.readdirSync(vaultRoot), []);
});

test('P1 configured-service replay refuses a damaged ledger before any probe, plan or effect', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-replay-damaged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot);
  const ledgerPath = path.join(root, 'ledger.json');
  const configured = (probe) => createConfiguredVaultMutationService({ vaultRoot, vaultId: 'fixture', proveObsidianAbsent: () => false,
    adapterOptions: { ledgerPath, probe } });
  const submit = (service, intentId, vaultRelativePath, requestHash) => {
    const context = service.createWriteContext({ vaultRelativePath, intentId, requestHash });
    return context.mutationExecutor({ schemaVersion: 1, operationId: context.operationId,
      sequence: 1, vaultId: 'fixture', vaultRelativePath, operationKind: 'create', content: 'synthetic' });
  };
  submit(configured(() => ({ state: 'app_busy' })), 'capture:p1-service:note', 'Notes/A.md', 'a'.repeat(64));
  const original = fs.readFileSync(ledgerPath, 'utf8');
  fs.writeFileSync(ledgerPath, original.slice(0, Math.floor(original.length / 2)));
  const damaged = fs.readFileSync(ledgerPath);
  let probes = 0;
  const spiedProbe = () => { probes += 1; throw new Error('probe must not run on uncertain ledger state'); };
  for (const [intentId, vaultRelativePath, requestHash] of [
    ['capture:p1-service:note', 'Notes/A.md', 'a'.repeat(64)],
    ['capture:p1-service:journal:section', 'Journal/2030-02-03.md', 'b'.repeat(64)],
  ]) {
    assert.throws(() => submit(configured(spiedProbe), intentId, vaultRelativePath, requestHash),
      (error) => error.code === 'vault_mutation_ledger_uncertain', intentId);
  }
  assert.equal(probes, 0);
  assert.deepEqual(fs.readFileSync(ledgerPath), damaged);
  assert.equal(fs.existsSync(`${ledgerPath}.quarantine`), false);
  assert.deepEqual(fs.readdirSync(vaultRoot), []);
});
