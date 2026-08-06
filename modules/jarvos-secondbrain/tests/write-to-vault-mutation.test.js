'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createNoteMutationOperation, writeNoteFile } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function withVault(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-note-mutation-'));
  const previous = {
    JARVOS_VAULT_DIR: process.env.JARVOS_VAULT_DIR,
    JARVOS_NOTES_DIR: process.env.JARVOS_NOTES_DIR,
    JARVOS_JOURNAL_DIR: process.env.JARVOS_JOURNAL_DIR,
  };
  process.env.JARVOS_VAULT_DIR = root;
  process.env.JARVOS_NOTES_DIR = path.join(root, 'Notes');
  process.env.JARVOS_JOURNAL_DIR = path.join(root, 'Journal');
  try { return run({ root }); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const options = {
  vaultId: 'vault-a',
  vaultRelativePath: 'Notes/Stable.md',
  title: 'Stable',
  content: 'body',
  frontmatter: { status: 'draft' },
};

test('note mutation factory requires a caller-owned stable operation id', () => {
  assert.throws(() => createNoteMutationOperation(options), /operationId is required/);
  const created = createNoteMutationOperation({ ...options, operationId: 'note-intent-0001', sequence: 7 });
  assert.equal(created.operationId, 'note-intent-0001');
  assert.equal(created.sequence, 7);
  assert.equal(created.operationKind, 'create');
});

test('note mutation factory keeps the supplied operation id for an existing-note retry', () => {
  const existing = '---\njarvos_note_id: "stable-note-id"\n---\n\n# Stable\n\nmobile prose\n';
  const operation = createNoteMutationOperation({ ...options, operationId: 'note-intent-0002', sequence: 8, existingContent: existing, existingFrontmatter: { jarvos_note_id: 'stable-note-id' } });
  assert.equal(operation.operationId, 'note-intent-0002');
  assert.equal(operation.sequence, 8);
  assert.equal(operation.operationKind, 'transform');
  assert.deepEqual(operation.replayPayload, { noteId: 'stable-note-id', body: '# Stable\n\nbody' });
});

test('injected writer reports the identity carried by the submitted operation', () => {
  withVault(({ root }) => {
    let submitted;
    const result = writeNoteFile({
      title: 'Created through Obsidian',
      content: 'Body',
      operationId: 'note-operation-created-identity',
      vaultId: 'vault-test',
      vaultRoot: root,
      mutationExecutor(operation) {
        submitted = operation;
        return { status: 'committed' };
      },
    });
    assert.equal(result.noteId, submitted.noteId);
  });
});

function settled(value) {
  return {
    then(fn) { try { fn(value); return this; } catch (error) { this.error = error; return this; } },
    catch(fn) { if (this.error) fn(this.error); return this; },
  };
}

function fakeObsidianEvaluator(root) {
  const files = new Map();
  const calls = { create: 0, process: 0, read: 0 };
  const vault = {
    getFileByPath(target) { return files.get(target) || null; },
    create(target, content) {
      calls.create += 1;
      const file = { path: target, content };
      files.set(target, file);
      fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
      fs.writeFileSync(path.join(root, target), content, 'utf8');
      return settled(file);
    },
    process(file, transform) {
      calls.process += 1;
      file.content = transform(file.content);
      fs.writeFileSync(path.join(root, file.path), file.content, 'utf8');
      return settled(file);
    },
    read(file) { calls.read += 1; return settled(file.content); },
  };
  const context = { app: { vault }, TextDecoder, Uint8Array, atob: (value) => Buffer.from(value, 'base64').toString('binary'), JSON };
  context.globalThis = context;
  return {
    calls,
    files,
    evaluate(code) {
      const raw = vm.runInNewContext(code, context);
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
  };
}

test('configured composition creates through Obsidian and acknowledges with app-owned readback', () => {
  withVault(({ root }) => {
    const fake = fakeObsidianEvaluator(root);
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-composition',
      source: 'bridge.test-note',
      adapterOptions: {
        ledgerPath: path.join(root, '.state', 'ledger.json'),
        probe: () => ({ state: 'available', vaultId: 'vault-note-composition' }),
        evaluate: fake.evaluate,
        maxPollAttempts: 2,
      },
    });
    const context = service.createWriteContext({ vaultRelativePath: 'Notes/App Owned.md', intentId: 'note-app-owned-intent-0001' });
    const result = writeNoteFile({ title: 'App Owned', content: 'Created through the app.', ...context });
    assert.equal(result.receipt.status, 'committed');
    assert.equal(result.receipt.obsidian, 'acknowledged');
    assert.equal(fake.calls.create, 1);
    assert.ok(fake.calls.read >= 1);
    assert.match(fs.readFileSync(result.path, 'utf8'), /Created through the app\./);
  });
});

test('existing note transform preserves the latest app content and stable identity', () => {
  withVault(({ root }) => {
    const fake = fakeObsidianEvaluator(root);
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-update',
      source: 'bridge.test-note',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'available', vaultId: 'vault-note-update' }), evaluate: fake.evaluate, maxPollAttempts: 2 },
    });
    const first = writeNoteFile({ title: 'Concurrent', content: 'First agent prose.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Concurrent.md', intentId: 'note-concurrent-intent-01' }) });
    const file = fake.files.get('Notes/Concurrent.md');
    file.content = `${file.content.trimEnd()}\n\nMobile prose survives.\n`;
    fs.writeFileSync(first.path, file.content, 'utf8');
    const second = writeNoteFile({ title: 'Concurrent', content: 'Second agent prose.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Concurrent.md', intentId: 'note-concurrent-intent-02' }) });
    assert.equal(second.receipt.status, 'committed');
    assert.equal(fake.calls.process, 1);
    const content = fs.readFileSync(second.path, 'utf8');
    assert.match(content, /Mobile prose survives\./);
    assert.match(content, /Second agent prose\./);
    assert.equal((content.match(/jarvos_note_id:/g) || []).length, 1);
  });
});

test('wrong-vault capability retains a durable plan and never raw-writes', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-unavailable',
      source: 'bridge.test-note',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'wrong_vault' }) },
    });
    const result = writeNoteFile({ title: 'Offline', content: 'Must not bypass Obsidian.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Offline.md', intentId: 'note-unavailable-intent' }) });
    assert.equal(result.written, false);
    assert.equal(result.receipt.status, 'unavailable');
    assert.equal(fs.existsSync(result.path), false);
    assert.equal(service.adapter.ledger.get('note-unavailable-intent').status, 'planned');
  });
});

test('host-owned absence proof permits only a durable offline create pending reconciliation', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-note-offline',
      source: 'bridge.test-note',
      proveObsidianAbsent: () => true,
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'wrong_vault' }) },
    });
    const result = writeNoteFile({ title: 'Offline Create', content: 'Queue this for Sync.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Offline Create.md', intentId: 'note-offline-create-01' }) });
    assert.equal(result.written, false);
    assert.equal(result.savedLocally, true);
    assert.equal(result.receipt.status, 'saved_locally_sync_pending');
    assert.equal(service.adapter.ledger.get('note-offline-create-01').status, 'local_applied');
    assert.match(fs.readFileSync(result.path, 'utf8'), /Queue this for Sync\./);
  });
});

test('caller source text cannot grant offline-write authority', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-source-boundary',
      source: 'bridge.trusted-source',
      proveObsidianAbsent: () => true,
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'app_stopped' }) },
    });
    assert.throws(() => service.execute({
      schemaVersion: 1,
      operationId: 'forged-source-operation',
      vaultId: service.vaultId,
      vaultRelativePath: 'Notes/Forged.md',
      sequence: 1,
      operationKind: 'create',
      content: 'must not write',
      source: 'forged.offline-authority',
    }), /cannot override/);
    assert.throws(() => service.createWriteContext({
      vaultRelativePath: 'Notes/Forged Context.md',
      intentId: 'forged-context-operation',
      operationSource: 'forged.offline-authority',
    }), /cannot override/);
    assert.throws(() => service.createMarkdownFile({
      vaultRelativePath: 'Notes/Forged High Level.md',
      nextContent: 'must not write',
      operationId: 'forged-high-level-operation',
      source: 'forged.offline-authority',
    }), /cannot override/);
    assert.equal(fs.existsSync(path.join(root, 'Notes', 'Forged.md')), false);
    assert.equal(fs.existsSync(path.join(root, 'Notes', 'Forged High Level.md')), false);
    assert.equal(service.adapter.ledger.get('forged-source-operation'), null);
    assert.equal(service.adapter.ledger.get('forged-context-operation'), null);
    assert.equal(service.adapter.ledger.get('forged-high-level-operation'), null);
  });
});

test('a busy or timed-out Obsidian path queues without opening a disk writer', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-busy-boundary',
      source: 'bridge.busy-boundary',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'app_busy' }) },
    });
    const result = writeNoteFile({ title: 'Busy', content: 'Do not raw write.', ...service.createWriteContext({ vaultRelativePath: 'Notes/Busy.md', intentId: 'busy-timeout-operation' }) });
    assert.equal(result.receipt.status, 'unavailable');
    assert.equal(result.savedLocally, false);
    assert.equal(fs.existsSync(result.path), false);
    assert.equal(service.adapter.ledger.get('busy-timeout-operation').status, 'planned');
  });
});

test('write contexts do not reserve empty FIFO slots before full submission', () => {
  withVault(({ root }) => {
    const service = createConfiguredVaultMutationService({
      vaultRoot: root,
      vaultId: 'vault-atomic-submission',
      source: 'bridge.atomic-submission',
      adapterOptions: { ledgerPath: path.join(root, '.state', 'ledger.json'), probe: () => ({ state: 'wrong_vault' }) },
    });
    const firstContext = service.createWriteContext({ vaultRelativePath: 'Notes/Ordered.md', operationId: 'ordered-context-first' });
    const secondContext = service.createWriteContext({ vaultRelativePath: 'Notes/Ordered.md', operationId: 'ordered-context-second' });
    assert.equal(Object.keys(service.adapter.ledger.read().operations).length, 0);
    const operation = (context, content) => ({ schemaVersion: 1, operationId: context.operationId, vaultId: context.vaultId, vaultRelativePath: 'Notes/Ordered.md', sequence: context.sequence, operationKind: 'create', content, source: context.source });
    secondContext.mutationExecutor(operation(secondContext, 'submitted first'));
    firstContext.mutationExecutor(operation(firstContext, 'submitted second'));
    assert.equal(service.adapter.ledger.get('ordered-context-second').operation.sequence, 1);
    assert.equal(service.adapter.ledger.get('ordered-context-first').operation.sequence, 2);
  });
});

test('package note writer contains no direct Markdown write primitive', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'jarvos-secondbrain-notes', 'src', 'write-to-vault.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(/);
});
