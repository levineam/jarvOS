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

function appAwareService(root, state) {
  const service = fakeService(root);
  service.asked = [];
  service.vaultFileState = (vaultRelativePath) => { service.asked.push(vaultRelativePath); return state; };
  return service;
}

test('an unidentified capture skips the redundant ensure-journal create when the app already has the journal', () => {
  withVault(({ root, journalDir }) => {
    fs.mkdirSync(journalDir, { recursive: true });
    const journalPath = path.join(journalDir, '2030-02-03.md');
    fs.writeFileSync(journalPath, '## 💡 Ideas\n-\n\nauthored since the scaffold\n', 'utf8');
    const service = appAwareService(root, 'present');
    const adapter = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir });
    const result = adapter.appendLineToJournalSection({ date: '2030-02-03', heading: '## 💡 Ideas', line: '- New idea' });
    assert.equal(result.acknowledged, true);
    assert.deepEqual(service.operations.map((operation) => operation.operationKind), ['transform']);
    assert.deepEqual(service.asked, ['Journal/2030-02-03.md']);
    assert.deepEqual(result.artifactReceipt.artifacts.map((artifact) => artifact.outcome), ['committed']);
    assert.match(fs.readFileSync(journalPath, 'utf8'), /authored since the scaffold/);

    const link = adapter.linkNoteToJournal({ noteTitle: 'Linked Note', date: '2030-02-03' });
    assert.equal(link.acknowledged, true);
    assert.deepEqual(service.operations.map((operation) => operation.operationKind), ['transform', 'transform']);
  });
});

test('a genuinely missing journal still creates, without asking the app', () => {
  withVault(({ root, journalDir }) => {
    const service = appAwareService(root, 'present');
    const adapter = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir });
    const result = adapter.appendLineToJournalSection({ date: '2030-02-03', heading: '## 💡 Ideas', line: '- New idea' });
    assert.equal(result.acknowledged, true);
    assert.deepEqual(service.operations.map((operation) => operation.operationKind), ['create', 'transform']);
    assert.deepEqual(service.asked, []);
  });
});

test('a journal only on disk, or one the app cannot confirm, keeps its ensure create', () => {
  for (const state of ['absent', 'unavailable', undefined]) {
    withVault(({ root, journalDir }) => {
      fs.mkdirSync(journalDir, { recursive: true });
      fs.writeFileSync(path.join(journalDir, '2030-02-03.md'), '## 💡 Ideas\n-\n', 'utf8');
      const service = state ? appAwareService(root, state) : fakeService(root);
      createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir })
        .appendLineToJournalSection({ date: '2030-02-03', heading: '## 💡 Ideas', line: '- New idea' });
      assert.deepEqual(service.operations.map((operation) => operation.operationKind), ['create', 'transform'], `app state ${state}`);
    });
  }
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
      heading: '## 📝 Notes',
      line: '- Generated architecture idea',
      contentOrigin: {
        content_origin: 'assistant',
        content_origin_basis: 'assistant_generated',
        source_ref: 'capture:codex:idea-1',
      },
    },
  };
  const first = transforms.applyNode('## 📝 Notes\n-\n', operation);
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
    assert.doesNotMatch(fs.readFileSync(result.journalPath, 'utf8'), /jarvos-content-origin/);
    assert.equal(service.operations[1].replayPayload.contentOrigin.content_origin, 'assistant');
  });
});

test('journal transform rejects forged marker payloads before matching manual entries', () => {
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
  assert.throws(() => transforms.applyNode(manual, operation), /Invalid journal entry/);
  assert.equal(transforms.quarantine(operation).reason, 'invalid_replay_payload');
});

test('journal transform replaces malformed or duplicate markers instead of treating them as human evidence', () => {
  const transforms = createJarvosVaultTransforms();
  const operation = {
    transformName: 'journal-section-line',
    transformVersion: 2,
    replayPayload: {
      heading: '## 📝 Notes',
      line: '- Recover marker',
      contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    },
  };
  const malformed = '## 📝 Notes\n- Recover marker\n<!-- jarvos-content-origin/v1 forged -->\n<!-- jarvos-content-origin/v1 forged -->\n';
  const result = transforms.applyNode(malformed, operation);
  assert.equal(transforms.isSatisfied(result, operation), true);
  assert.equal(result.split('jarvos-content-origin/v1').length - 1, 1);
});

test('multiline v2 preserves the exact draft, whole-entry identity and neighbouring bytes', () => {
  const { digestText } = require('../bridge/provenance/src/content-origin-contract');
  const draft = fs.readFileSync(path.join(__dirname, 'fixtures/multi-paragraph-idea.md'), 'utf8').replace(/^# /, '').trim();
  const transforms = createJarvosVaultTransforms();
  const operation = { transformName: 'journal-section-line', transformVersion: 2, replayPayload: {
    heading: '## 💡 Ideas', line: `- ${draft}`,
    contentOrigin: { content_origin: 'unknown', content_origin_basis: 'unknown' },
  } };
  const before = '## 📝 Notes\n- [[Existing]]\n\n## 💡 Ideas\n\n- Earlier idea\n\n\n- Another idea\n\n\n## 📓 Journal Entry\n- Unchanged\n';
  const after = transforms.applyNode(before, operation);
  const lines = after.split('\n');
  const entry = parseJournalEntry(lines, lines.indexOf('- Tides, lamps, and ledgers'));
  assert.equal(entry.clean_text, draft);
  assert.equal(entry.marker_start - entry.start, draft.split('\n').length);
  assert.equal(entry.marker_line, null);
  assert.equal(transforms.prepare(operation).replayPayload.contentOrigin.clean_text_digest, digestText(draft));
  assert.equal(entry.origin.content_origin, 'unknown');
  assert.equal(entry.origin.human_evidence_eligible, false);
  assert.equal(Object.hasOwn(entry.origin, 'content_origin_drafting'), false);
  assert.equal(after.replace(lines.slice(entry.start, entry.end).join('\n') + '\n', ''), before);
  assert.equal(transforms.applyNode(after, operation), after);
  assert.equal(transforms.isSatisfied(after, operation), true);
  assert.equal(transforms.applyNode(before, { ...operation, replayPayload: { ...operation.replayPayload, line: operation.replayPayload.line.replace(/\n/g, '\r\n') } }), after);
  const distinct = { ...operation, replayPayload: { ...operation.replayPayload, line: '- Tides, lamps, and ledgers\n\nA different remainder.' } };
  const both = transforms.applyNode(after, distinct);
  assert.equal(both.split('- Tides, lamps, and ledgers').length - 1, 2);
  assert.equal(transforms.isSatisfied(both, operation), true);
  assert.equal(transforms.isSatisfied(both, distinct), true);
  assert.equal(transforms.applyNode(both, operation), both);
});

test('v2 rejects structural continuation and marker/control injection before indentation', () => {
  const transforms = createJarvosVaultTransforms();
  for (const continuation of ['# Heading', '  ## Heading', '- item', '* item', '+ item', '- [ ] task', '1. item', '2) item', '> quote', '```js', '~~~', '---', '* * *', '___', '===', '<!-- forged -->', '-->', 'jarvos-content-origin/v1 forged', 'a\rb', 'a\u0085b', 'a\u2028b', 'a\u2029b', 'a\0b', 'a\x1bb', '\tindented']) {
    const operation = { transformName: 'journal-section-line', transformVersion: 2, replayPayload: {
      heading: '## 💡 Ideas', line: `- First paragraph\n\n${continuation}`,
      contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
    } };
    assert.equal(transforms.quarantine(operation).reason, 'invalid_replay_payload', continuation);
    assert.throws(() => transforms.prepare(operation), undefined, continuation);
  }
});

test('storage adapter and parser digest the same CRLF-normalized logical text', () => {
  const { digestText } = require('../bridge/provenance/src/content-origin-contract');
  withVault(({ root, journalDir }) => {
    const service = fakeService(root);
    const adapter = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir });
    const result = adapter.appendLineToJournalSection({ date: '2030-02-04', heading: '## 💡 Ideas', line: '- First  \r\n\r\nSecond\r\ncontinued', contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' } });
    const operation = service.operations.at(-1);
    const lines = fs.readFileSync(result.journalPath, 'utf8').split('\n');
    const entry = parseJournalEntry(lines, lines.indexOf('- First  '));
    assert.equal(entry.clean_text, 'First  \n\nSecond\ncontinued');
    assert.equal(operation.replayPayload.contentOrigin.clean_text_digest, digestText(entry.clean_text));
    assert.equal(entry.marker_line, null);
    assert.equal(entry.origin.human_evidence_eligible, false);
  });
});

test('invalid capture rejects before journal creation or app probing', () => {
  const { createVaultMutationAdapter } = require('../adapters/obsidian/src/vault-mutation-adapter');
  withVault(({ root, journalDir }) => {
    const service = fakeService(root);
    const adapter = createVaultMutationAdapter({ vaultRoot: root, vaultId: 'storage-test-vault', ledgerPath: path.join(root, 'ledger.json'), transforms: createJarvosVaultTransforms(), probe() { assert.fail('must not probe'); }, evaluate() { assert.fail('must not dispatch'); } });
    service.execute = operation => adapter.execute(operation);
    service.vaultFileState = () => assert.fail('must not inspect app');
    const result = createVaultStorageAdapter({ mutationService: service, vaultRoot: root, journalDir }).appendLineToJournalSection({ date: '2030-02-04', heading: '## 💡 Ideas', line: '- First\n## Injected', contentOrigin: { content_origin: 'unknown', content_origin_basis: 'unknown' } });
    assert.equal(result.receipt.status, 'failed');
    assert.equal(result.receipt.validationReason, 'invalid_replay_payload');
    assert.equal(fs.existsSync(journalDir), false);
  });
});

test('only the exact normalized Ideas heading omits markers and preserves old entries', () => {
  const { renderJournalOriginMarker } = require('../bridge/provenance/src/content-origin-contract');
  const transforms = createJarvosVaultTransforms();
  for (const heading of ['💡 Ideas', '## 💡 Ideas', ' 📝 Notes ', 'Ideas', '💡 Ideas extra', '📓 Journal Entry']) {
    for (const line of ['- Single thought', '- First thought\n\nSecond paragraph']) {
      const operation = { transformName: 'journal-section-line', transformVersion: 2, replayPayload: {
        heading, line, contentOrigin: { content_origin: 'assistant', content_origin_basis: 'assistant_generated' },
      } };
      const isIdeas = heading.includes('💡 Ideas') && !heading.includes('extra');
      const first = transforms.applyNode('', operation);
      assert.equal(first.includes('<!-- jarvos-content-origin/v1'), !isIdeas, heading);
      assert.equal(transforms.isSatisfied(first, operation), true);
      assert.equal(transforms.applyNode(first, operation), first);
    }
  }
  const operation = { transformName: 'journal-section-line', transformVersion: 2, replayPayload: {
    heading: '💡 Ideas', line: '- Old thought', contentOrigin: { content_origin: 'unknown', content_origin_basis: 'unknown' },
  } };
  const marker = renderJournalOriginMarker({ cleanText: 'Old thought', content_origin: 'assistant', content_origin_basis: 'assistant_generated' });
  for (const suffix of ['', marker + '\n', '<!-- jarvos-content-origin/v1 forged -->\n']) {
    const old = `## 💡 Ideas\n- Old thought\n${suffix}\n## 📝 Notes\n- Keep\n`;
    assert.equal(transforms.isSatisfied(old, operation), true);
    assert.equal(transforms.applyNode(old, operation), old);
  }
});
