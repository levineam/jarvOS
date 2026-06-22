'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADAPTER_RESULT_SCHEMA_VERSION,
  createLocalStorageAdapter,
  createUnsupportedAdapterResult,
  isAdapterResult,
} = require('../src/adapters');

test('local storage wrapper normalizes journal and note writes with provenance', () => {
  const calls = [];
  const adapter = createLocalStorageAdapter({
    backend: 'mock-local',
    storageAdapter: {
      appendLineToJournalSection(input) {
        calls.push(['journal', input]);
        return { journalPath: '/tmp/journal.md', heading: input.heading, line: input.line, alreadyPresent: true };
      },
      writeNote(input) {
        calls.push(['note', input]);
        return { written: true, created: true, path: '/tmp/note.md', title: input.title };
      },
    },
  });

  const journal = adapter.appendLineToJournalSection({
    heading: '## Ideas',
    line: '- Keep adapters replaceable',
    date: '2026-05-19',
  });
  const note = adapter.writeNote({ title: 'Ambient adapters', content: 'Keep storage out of classifiers.' });

  assert.equal(journal.status, 'noop');
  assert.equal(journal.idempotent, true);
  assert.equal(journal.provenance.backend, 'mock-local');
  assert.deepEqual(journal.target, {
    kind: 'journal-section',
    date: '2026-05-19',
    heading: '## Ideas',
  });
  assert.equal(note.status, 'ok');
  assert.equal(note.result.path, '/tmp/note.md');
  assert.deepEqual(calls.map(([kind]) => kind), ['journal', 'note']);
});

test('local storage wrapper normalizes memory duplicate as idempotent noop', () => {
  const adapter = createLocalStorageAdapter({
    memoryAdapter: {
      createMemoryRecord(input) {
        return {
          record: { class: input.class, content: input.content },
          written: false,
          path: '/tmp/MEMORY.md',
          error: 'Duplicate content already exists in MEMORY.md',
        };
      },
    },
  });

  const result = adapter.createMemoryRecord({
    class: 'preference',
    content: 'Andrew prefers portable adapter contracts.',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'noop');
  assert.equal(result.idempotent, true);
  assert.equal(result.operation, 'createMemoryRecord');
  assert.equal(result.target.kind, 'memory');
});

test('unsupported local backends return explicit adapter results instead of throwing', () => {
  const adapter = createLocalStorageAdapter({ backend: 'missing-backend' });
  const result = adapter.writeNote({ title: 'No backend', content: 'This should not throw.' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.error.code, 'UNSUPPORTED_ADAPTER_OPERATION');
  assert.equal(result.provenance.backend, 'missing-backend');
  assert.equal(isAdapterResult(result), true);
});

test('Paperclip work-intake wrapper supports async clients and required input errors', async () => {
  const adapter = createLocalStorageAdapter({
    backend: 'paperclip-mock',
    paperclipClient: {
      async createIssue(input) {
        return { identifier: 'SUP-1', title: input.title, status: input.status || 'todo' };
      },
      async addComment(issueRef, body) {
        return { issueRef, body };
      },
    },
  });

  const issue = await adapter.createWorkIntakeIssue({ title: 'Extract adapter contract' });
  const comment = await adapter.addWorkIntakeComment({ issueRef: 'SUP-1', comment: 'Adapter result captured.' });
  const missing = adapter.updateWorkIntakeIssue({ updates: { status: 'in_review' } });

  assert.equal(issue.status, 'ok');
  assert.equal(issue.result.identifier, 'SUP-1');
  assert.equal(comment.result.issueRef, 'SUP-1');
  assert.equal(missing.status, 'error');
  assert.equal(missing.error.code, 'INVALID_ADAPTER_INPUT');
});

test('contract helpers produce stable adapter result objects', () => {
  const unsupported = createUnsupportedAdapterResult({
    backend: 'plain-markdown',
    operation: 'createWorkIntakeIssue',
  });

  assert.equal(unsupported.schemaVersion, ADAPTER_RESULT_SCHEMA_VERSION);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.idempotent, true);
  assert.equal(unsupported.provenance.operation, 'createWorkIntakeIssue');
});
