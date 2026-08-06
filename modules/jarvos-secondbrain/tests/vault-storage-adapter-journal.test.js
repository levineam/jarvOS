'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVaultStorageAdapter } = require('../adapters/obsidian/src/vault-storage-adapter');
const { createJarvosVaultTransforms } = require('../src/vault-transform-registry');

function withVault(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-'));
  const journalDir = path.join(root, 'Journal');
  const previous = Object.fromEntries(['JARVOS_VAULT_DIR', 'JARVOS_JOURNAL_DIR', 'JARVOS_NOTES_DIR'].map((key) => [key, process.env[key]]));
  process.env.JARVOS_VAULT_DIR = root;
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  process.env.JARVOS_NOTES_DIR = path.join(root, 'Notes');
  try { return run({ root, journalDir }); }
  finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fakeService(root, { unavailable = false } = {}) {
  const transforms = createJarvosVaultTransforms();
  const operations = [];
  let sequence = 0;
  return {
    vaultRoot: root,
    operations,
    createWriteContext({ vaultRelativePath, intentId, operationSource }) {
      return { mutationExecutor: (operation) => this.execute(operation), operationId: intentId || `storage-test-${++sequence}`, sequence: ++sequence, source: operationSource, vaultId: 'storage-test-vault', vaultRoot: root, vaultRelativePath };
    },
    execute(operation) {
      operations.push(operation);
      if (unavailable) return { status: 'unavailable' };
      const target = path.join(root, operation.vaultRelativePath);
      if (operation.operationKind === 'create') {
        if (fs.existsSync(target)) return fs.readFileSync(target, 'utf8') === operation.content ? { status: 'already_satisfied' } : { status: 'conflict' };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, operation.content, 'utf8');
        return { status: 'committed' };
      }
      const current = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(target, transforms.applyNode(current, operation), 'utf8');
      return { status: 'committed' };
    },
  };
}

test('existing journal creation is acknowledged without rewriting authored bytes', () => {
  withVault(({ root, journalDir }) => {
    fs.mkdirSync(journalDir, { recursive: true });
    const journalPath = path.join(journalDir, '2030-02-03.md');
    const authored = '## 📝 Notes\n- authored text\n';
    fs.writeFileSync(journalPath, authored, 'utf8');
    const service = fakeService(root);
    const result = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir }).ensureJournal({ date: '2030-02-03' });
    assert.equal(result.existed, true);
    assert.equal(result.receipt.status, 'already_satisfied');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), authored);
    assert.equal(service.operations[0].operationKind, 'create');
  });
});

test('missing journal creates before its acknowledged section transform', () => {
  withVault(({ root, journalDir }) => {
    const service = fakeService(root);
    const adapter = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir });
    const result = adapter.appendLineToJournalSection({ date: '2030-02-03', heading: '## 💡 Ideas', line: '- New idea', intentId: 'idea-intent' });
    assert.equal(result.acknowledged, true);
    assert.deepEqual(service.operations.map((operation) => operation.operationKind), ['create', 'transform']);
    assert.match(fs.readFileSync(result.journalPath, 'utf8'), /## 💡 Ideas[\s\S]*- New idea/);
  });
});

test('unavailable service never falls back to a raw journal write', () => {
  withVault(({ root, journalDir }) => {
    const service = fakeService(root, { unavailable: true });
    const result = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir }).ensureJournal({ date: '2030-02-03' });
    assert.equal(result.acknowledged, false);
    assert.equal(result.receipt.status, 'unavailable');
    assert.equal(fs.existsSync(result.journalPath), false);
  });
});
