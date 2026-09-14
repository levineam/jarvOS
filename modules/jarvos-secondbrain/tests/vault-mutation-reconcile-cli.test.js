'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { main } = require('../scripts/vault-mutation-reconcile');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function settled(value) {
  return { then(fn) { try { fn(value); return this; } catch (error) { this.error = error; return this; } }, catch(fn) { if (this.error) fn(this.error); return this; } };
}

test('operator command composes registered transforms and derives the vault identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-reconcile-cli-'));
  try {
    let capabilityState = 'app_stopped';
    const file = { path: 'Notes/Pending.md', content: 'mobile edit\n' };
    const vault = {
      adapter: { getBasePath: () => root },
      getFileByPath: (target) => target === file.path ? file : null,
      process(target, transform) { target.content = transform(target.content); return settled(target); },
      read: (target) => settled(target.content),
      create: () => { throw new Error('not a create test'); },
    };
    const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
    context.globalThis = context;
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      source: 'operator.vault-reconcile',
      adapterOptions: {
        ledgerPath: path.join(root, '.state', 'ledger.json'),
        probe: () => ({ state: capabilityState, vaultId: service?.vaultId }),
        evaluate(code) { const raw = vm.runInNewContext(code, context); return typeof raw === 'string' ? JSON.parse(raw) : raw; },
        maxPollAttempts: 2,
      },
    });
    const pending = {
      schemaVersion: 1,
      operationId: 'retained-transform-operation',
      vaultId: service.vaultId,
      vaultRelativePath: file.path,
      sequence: 1,
      operationKind: 'transform',
      transformName: 'append-line',
      transformVersion: 1,
      replayPayload: { line: '- recovered by operator' },
      source: 'agent.session-thread',
    };
    assert.equal(service.adapter.submit(pending).status, 'unavailable');
    capabilityState = 'available';
    const result = main({ JARVOS_VAULT_ROOT: root }, (options) => {
      assert.equal(options.vaultId, undefined);
      assert.equal(options.vaultRoot, root);
      return service;
    });
    assert.equal(result.acknowledged, 1);
    assert.match(file.content, /mobile edit/);
    assert.match(file.content, /recovered by operator/);
    assert.equal(service.adapter.ledger.get(pending.operationId).status, 'acknowledged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
