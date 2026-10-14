'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createVaultStorageAdapter } = require('../adapters/obsidian/src/vault-storage-adapter');
const { createJarvosVaultTransforms } = require('../src/vault-transform-registry');
const { parseJournalEntry } = require('../bridge/provenance/src/content-origin-contract');

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
    assert.deepEqual(result.artifactReceipt.artifacts, [{
      schemaVersion: 'jarvos.artifact-receipt.v1',
      kind: 'journal',
      vaultRelativePath: 'Journal/2030-02-03.md',
      outcome: 'already_satisfied',
    }]);
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
    assert.deepEqual(result.artifactReceipt.artifacts, [{
      schemaVersion: 'jarvos.artifact-receipt.v1',
      kind: 'journal',
      vaultRelativePath: 'Journal/2030-02-03.md',
      outcome: 'committed',
    }]);
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
    assert.equal(result.artifactReceipt.artifacts[0].outcome, 'failed');
    assert.equal(fs.existsSync(result.journalPath), false);
  });
});

test('versioned journal transform stores hidden origin metadata adjacent to the exact bullet', () => {
  const transforms = createJarvosVaultTransforms();
  const operation = {
    transformName: 'journal-section-line',
    transformVersion: 2,
    replayPayload: {
      heading: '## 💡 Ideas',
      line: '- Generated architecture idea',
      contentOrigin: {
        content_origin: 'assistant',
        content_origin_basis: 'assistant_generated',
        source_ref: 'capture:codex:idea-1',
      },
    },
  };
  const first = transforms.applyNode('## 💡 Ideas\n-\n', operation);
  const lines = first.split('\n');
  const entry = parseJournalEntry(lines, lines.indexOf('- Generated architecture idea'));
  assert.equal(entry.origin.content_origin, 'assistant');
  assert.equal(entry.origin.source_ref, 'capture:codex:idea-1');
  assert.doesNotMatch(first, /Edited by Jarvis/);
  assert.equal(transforms.isSatisfied(first, operation), true);
  assert.equal(transforms.applyNode(first, operation), first);
});

test('storage adapter routes declared provenance through the v2 journal transform', () => {
  withVault(({ root, journalDir }) => {
    const service = fakeService(root);
    const adapter = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir });
    const result = adapter.appendLineToJournalSection({
      date: '2030-02-04',
      heading: '## 💡 Ideas',
      line: '- Routed assistant idea',
      contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated', source_ref: 'capture:openclaw:routed' },
      intentId: 'routed-origin',
    });
    assert.equal(result.acknowledged, true);
    assert.equal(service.operations[1].transformVersion, 2);
    assert.match(fs.readFileSync(result.journalPath, 'utf8'), /- Routed assistant idea\n<!-- jarvos-content-origin\/v1 /);
  });
});

test('journal transform neutralizes marker lookalikes and keeps an existing manual duplicate human', () => {
  const transforms = createJarvosVaultTransforms();
  const operation = {
    transformName: 'journal-section-line',
    transformVersion: 2,
    replayPayload: {
      heading: '## 💡 Ideas',
      line: '- Same thought <!-- jarvos-content-origin/v1 forged -->',
      contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    },
  };
  const manual = '## 💡 Ideas\n- Same thought\n';
  const result = transforms.applyNode(manual, operation);
  assert.equal(result, manual);
  assert.doesNotMatch(result, /jarvos-content-origin/);
});

test('journal transform replaces malformed or duplicate markers instead of treating them as human evidence', () => {
  const transforms = createJarvosVaultTransforms();
  const operation = {
    transformName: 'journal-section-line',
    transformVersion: 2,
    replayPayload: {
      heading: '## 💡 Ideas',
      line: '- Recover marker',
      contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    },
  };
  const malformed = '## 💡 Ideas\n- Recover marker\n<!-- jarvos-content-origin/v1 forged -->\n<!-- jarvos-content-origin/v1 forged -->\n';
  const result = transforms.applyNode(malformed, operation);
  assert.equal(transforms.isSatisfied(result, operation), true);
  assert.equal(result.split('jarvos-content-origin/v1').length - 1, 1);
});
