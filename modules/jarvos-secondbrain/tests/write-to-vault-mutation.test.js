'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createNoteMutationOperation, writeNoteFile } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault');

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
