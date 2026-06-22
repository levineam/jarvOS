const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAmbientLocalStorageAdapter,
} = require('../adapters/ambient-local-storage-adapter');
const adaptersIndex = require('../adapters');

test('jarvos-secondbrain ambient local adapter composes injected storage, memory, and Paperclip backends', async () => {
  const calls = [];
  const adapter = createAmbientLocalStorageAdapter({
    backend: 'test-local',
    storageAdapter: {
      appendLineToJournalSection(input) {
        calls.push(['journal', input.heading]);
        return { heading: input.heading, line: input.line, alreadyPresent: false };
      },
      writeNote(input) {
        calls.push(['note', input.title]);
        return { written: true, created: true, path: `/tmp/${input.title}.md` };
      },
    },
    memoryAdapter: {
      createMemoryRecord(input) {
        calls.push(['memory', input.class]);
        return { record: input, written: true, path: '/tmp/MEMORY.md', error: null };
      },
    },
    paperclipClient: {
      async createIssue(input) {
        calls.push(['issue', input.title]);
        return { identifier: 'SUP-1', title: input.title };
      },
    },
  });

  const journal = adapter.appendLineToJournalSection({ heading: '## Ideas', line: '- Extract adapters' });
  const note = adapter.writeNote({ title: 'Adapter Contract', content: 'Plain markdown result.' });
  const memory = adapter.createMemoryRecord({ class: 'decision', content: 'Keep storage behind adapters.' });
  const issue = await adapter.createWorkIntakeIssue({ title: 'Follow-up adapter test' });

  assert.equal(journal.provenance.adapter, 'jarvos-secondbrain-local-storage');
  assert.equal(note.status, 'ok');
  assert.equal(memory.result.written, true);
  assert.equal(issue.result.identifier, 'SUP-1');
  assert.deepEqual(calls.map(([kind]) => kind), ['journal', 'note', 'memory', 'issue']);
});

test('jarvos-secondbrain adapters index exports the ambient local adapter factory', () => {
  assert.equal(adaptersIndex.createAmbientLocalStorageAdapter, createAmbientLocalStorageAdapter);
});

test('default memory adapter is lazy so package import does not require jarvos-memory eagerly', () => {
  const adapter = createAmbientLocalStorageAdapter({
    storageAdapter: {},
    paperclipClient: {},
  });

  assert.equal(adapter.kind, 'local-storage');
  assert.equal(typeof adapter.createMemoryRecord, 'function');
});
