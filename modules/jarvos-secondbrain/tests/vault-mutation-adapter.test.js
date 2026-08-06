'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createVaultMutationAdapter } = require('../adapters/obsidian/src/vault-mutation-adapter');
const { buildObsidianMutationProgram } = require('../adapters/obsidian/src/vault-mutation-adapter');

const operation = () => ({ schemaVersion: 1, operationId: 'op-20260806-adapter-test', vaultId: 'vault-a', vaultRelativePath: 'Notes/A.md', sequence: 1, operationKind: 'create', content: 'hello' });
const ledgerPath = () => path.join(os.tmpdir(), `jarvos-adapter-${Math.random()}.json`);

test('a queued response without a terminal app token is never committed', () => {
  const states = [{ queued: true, token: 'op-20260806-adapter-test' }, { status: 'pending' }];
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => states.shift(), maxPollAttempts: 1 });
  const result = adapter.execute(operation());
  assert.equal(result.status, 'unknown_after_dispatch');
  assert.equal(result.obsidian, 'unacknowledged');
});

test('only app.vault.read acknowledgement can commit a create', () => {
  const states = [{ queued: true, token: 'op-20260806-adapter-test' }, { status: 'done', invariant: false, readback: 'stale' }];
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => states.shift(), maxPollAttempts: 1 });
  assert.equal(adapter.execute(operation()).status, 'failed');
});

test('serialized payload does not become executable source', () => {
  let program = '';
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: (code) => { program = code; return { queued: true, token: 'op-20260806-adapter-test' }; }, maxPollAttempts: 0 });
  adapter.execute({ ...operation(), content: "x'); globalThis.pwned = true; ('" });
  assert.equal(program.includes('globalThis.pwned = true'), false);
  assert.match(program, /atob/);
});

test('capability failures are explicit and do not dispatch', () => {
  let dispatched = false;
  for (const state of ['cli_missing', 'app_stopped', 'cli_disabled', 'cli_unsupported', 'wrong_vault', 'api_incompatible']) {
    const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state }), evaluate: () => { dispatched = true; } });
    assert.equal(adapter.execute(operation()).obsidian, state);
  }
  assert.equal(dispatched, false);
});

test('unavailable capability retains planned intent for reconciliation', () => {
  const adapter = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: ledgerPath(), probe: () => ({ state: 'app_stopped' }) });
  assert.equal(adapter.execute(operation()).status, 'unavailable');
  assert.equal(adapter.ledger.get(operation().operationId).status, 'planned');
});

test('default durable ledger path follows XDG state and stays outside the vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-xdg-'));
  const previous = process.env.XDG_STATE_HOME;
  try {
    process.env.XDG_STATE_HOME = root;
    const adapter = createVaultMutationAdapter({ vaultRoot: '/configured-vault', vaultId: 'vault-a', probe: () => ({ state: 'app_stopped' }) });
    assert.equal(adapter.ledger.filePath.startsWith(`${root}${path.sep}`), true);
    assert.equal(adapter.ledger.filePath.startsWith('/configured-vault/'), false);
    adapter.execute(operation());
    assert.equal(fs.existsSync(adapter.ledger.filePath), true);
  } finally { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); }
});

test('acknowledged operation is already satisfied without a second evaluate', () => {
  const filePath = ledgerPath(); let calls = 0;
  const first = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: filePath, probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => { calls += 1; return calls === 1 ? { queued: true, token: operation().operationId } : { status: 'done', invariant: true, readback: 'hello' }; }, maxPollAttempts: 1 });
  assert.equal(first.execute(operation()).status, 'committed');
  const second = createVaultMutationAdapter({ vaultRoot: '/vault', vaultId: 'vault-a', ledgerPath: filePath, probe: () => ({ state: 'available', vaultId: 'vault-a' }), evaluate: () => { throw new Error('must not dispatch'); } });
  assert.equal(second.execute(operation()).status, 'already_satisfied');
});

test('fixed program uses create, process, and app-owned readback in their respective modes', () => {
  const create = buildObsidianMutationProgram(operation());
  const transform = buildObsidianMutationProgram({ ...operation(), operationKind: 'transform', transformName: 'append-line', transformVersion: 1, replayPayload: { line: '- one' } });
  const replace = buildObsidianMutationProgram({ ...operation(), operationKind: 'replace', expectedHash: 'a'.repeat(64), expectedContent: 'old' });
  assert.match(create, /app\.vault\.create/);
  assert.match(transform, /app\.vault\.process/);
  assert.match(replace, /current === input\.expectedContent/);
  for (const program of [create, transform, replace]) assert.match(program, /app\.vault\.read/);
});

function settled(value) { return { then(fn) { try { fn(value); return this; } catch (error) { this.error = error; return this; } }, catch(fn) { if (this.error) fn(this.error); return this; } }; }
function runInFakeObsidian(operation, { initial, readback } = {}) {
  const files = initial === undefined ? new Map() : new Map([[operation.vaultRelativePath, { path: operation.vaultRelativePath, content: initial }]]);
  const vault = { getFileByPath: (target) => files.get(target) || null, create: (target, content) => { files.set(target, { path: target, content }); return settled(); }, process: (file, transform) => { file.content = transform(file.content); return settled(); }, read: (file) => settled(readback === undefined ? file.content : readback) };
  const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
  context.globalThis = context; vm.runInNewContext(buildObsidianMutationProgram(operation), context);
  return { result: context.__jarvosVaultMutationResults[operation.operationId], content: files.get(operation.vaultRelativePath)?.content };
}

test('fixed program handles collision identity, latest-content transforms, and stale app readback', () => {
  const create = operation();
  assert.equal(runInFakeObsidian(create, { initial: 'hello' }).result.status, 'done');
  assert.equal(runInFakeObsidian(create, { initial: 'different' }).result.status, 'error');
  const transform = { ...create, operationKind: 'transform', transformName: 'append-line', transformVersion: 1, replayPayload: { line: '- agent' } };
  const latest = runInFakeObsidian(transform, { initial: 'mobile edit\n' });
  assert.equal(latest.result.status, 'done'); assert.match(latest.content, /mobile edit/); assert.match(latest.content, /- agent/);
  assert.equal(runInFakeObsidian(create, { readback: 'stale tracked content' }).result.status, 'error');
});
