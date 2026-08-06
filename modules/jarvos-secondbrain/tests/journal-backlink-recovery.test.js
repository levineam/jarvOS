const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJarvosVaultTransforms } = require('../src/vault-transform-registry.js');

const {
  classifyDeferredBacklink,
  deferredQueuePathForJournalDir,
  flushDeferredBacklinks,
  reconcileDeferredBacklink,
  recordDeferredBacklink,
  linkNoteToJournal,
} = require('../bridge/provenance/src/link-to-journal.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-backlink-recovery-'));
  const journalDir = path.join(root, 'Journal');
  const notesDir = path.join(root, 'Notes');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  const journalPath = path.join(journalDir, '2030-02-03.md');
  fs.writeFileSync(journalPath, '## 📝 Notes\n-\n', 'utf8');
  return { root, journalDir, notesDir, journalPath };
}

function note(root, relativePath, noteId) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `---\njarvos_note_id: ${noteId}\n---\n\n# Note\n`, 'utf8');
  return target;
}

function fakeMutationService(state, { failMessage, onExecute } = {}) {
  const transforms = createJarvosVaultTransforms();
  let sequence = 0;
  return {
    vaultRoot: state.root,
    createWriteContext({ vaultRelativePath, intentId, operationSource }) {
      return { vaultId: 'backlink-recovery-test', vaultRelativePath, operationId: intentId || `backlink-test-${++sequence}`, sequence: ++sequence, source: operationSource };
    },
    execute(operation) {
      if (onExecute) onExecute(operation);
      if (failMessage) throw new Error(failMessage);
      const target = path.join(state.root, operation.vaultRelativePath);
      if (operation.operationKind === 'create') {
        if (fs.existsSync(target)) return fs.readFileSync(target, 'utf8') === operation.content ? { status: 'already_satisfied' } : { status: 'conflict' };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, operation.content, 'utf8');
        return { status: 'committed' };
      }
      const current = fs.readFileSync(target, 'utf8');
      if (transforms.isSatisfied(current, operation)) return { status: 'already_satisfied' };
      fs.writeFileSync(target, transforms.applyNode(current, operation), 'utf8');
      return { status: 'committed' };
    },
  };
}

test('v2 recovery validates identity and derives the journal target from the validated path', () => {
  const state = fixture();
  try {
    note(state.root, 'Notes/Projects/Actual Name.md', 'note-1');
    const deferred = recordDeferredBacklink({
      journalPath: state.journalPath,
      noteTitle: 'Stale queued title',
      noteId: 'note-1',
      notePath: 'Notes/Projects/Actual Name.md',
      section: '📝 Notes',
      reason: 'journal-mutation-failed',
      auditState: 'created',
    });
    const flushed = flushDeferredBacklinks({
      journalDir: state.journalDir,
      vaultRoot: state.root,
      notesDir: state.notesDir,
      mutationService: fakeMutationService(state),
    });
    assert.equal(flushed.linked, 1);
    assert.match(fs.readFileSync(state.journalPath, 'utf8'), /\[\[Notes\/Projects\/Actual Name\]\]/);
    assert.doesNotMatch(fs.readFileSync(state.journalPath, 'utf8'), /Stale queued title/);
    const entry = JSON.parse(fs.readFileSync(deferred.deferredPath, 'utf8')).entries[deferred.key];
    assert.equal(entry.status, 'linked');
    assert.equal(entry.noteId, 'note-1');
    assert.equal(entry.notePath, 'Notes/Projects/Actual Name.md');
    assert.equal(entry.auditState, 'created');
    assert.equal(entry.events.at(-1).type, 'linked');
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('v2 identity mismatch is unresolved and never changes the journal', () => {
  const state = fixture();
  try {
    note(state.root, 'Notes/Exact.md', 'wrong-id');
    const deferred = recordDeferredBacklink({ journalPath: state.journalPath, noteTitle: 'Exact', noteId: 'right-id', notePath: 'Notes/Exact.md', section: '📝 Notes', reason: 'failed' });
    const original = fs.readFileSync(state.journalPath, 'utf8');
    const flush = flushDeferredBacklinks({ journalDir: state.journalDir, vaultRoot: state.root, notesDir: state.notesDir });
    assert.equal(flush.unresolved, 1);
    assert.equal(fs.readFileSync(state.journalPath, 'utf8'), original);
    const entry = JSON.parse(fs.readFileSync(deferred.deferredPath, 'utf8')).entries[deferred.key];
    assert.equal(entry.status, 'unresolved');
    assert.equal(entry.terminalReason, 'v2-note-identity-mismatch');
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('missing v2 path is superseded only for one moved identity and conflicts stay unresolved', () => {
  const state = fixture();
  try {
    note(state.root, 'Notes/Moved.md', 'move-id');
    const moved = classifyDeferredBacklink({ journalPath: state.journalPath, noteId: 'move-id', notePath: 'Notes/Missing.md' }, { vaultRoot: state.root, notesDir: state.notesDir });
    assert.deepEqual(moved, { status: 'superseded', reason: 'v2-note-moved', notePath: 'Notes/Moved.md' });
    note(state.root, 'Notes/Second.md', 'move-id');
    const conflict = classifyDeferredBacklink({ journalPath: state.journalPath, noteId: 'move-id', notePath: 'Notes/Missing.md' }, { vaultRoot: state.root, notesDir: state.notesDir });
    assert.equal(conflict.status, 'unresolved');
    assert.equal(conflict.reason, 'v2-note-identity-conflict');
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('legacy entries use only exact title evidence and do not fuzzy-match notes', () => {
  const state = fixture();
  try {
    note(state.root, 'Notes/Similar Legacy Title.md', 'legacy-id');
    const classification = classifyDeferredBacklink({ journalPath: state.journalPath, noteTitle: 'Legacy Title', section: '📝 Notes' }, { vaultRoot: state.root, notesDir: state.notesDir });
    assert.deepEqual(classification, { status: 'unresolved', reason: 'legacy-exact-note-missing' });
    note(state.root, 'Notes/Legacy Title.md', 'exact-legacy-id');
    const exactNote = classifyDeferredBacklink({ journalPath: state.journalPath, noteTitle: 'Legacy Title', section: '📝 Notes' }, { vaultRoot: state.root, notesDir: state.notesDir });
    assert.equal(exactNote.status, 'retry');
    fs.writeFileSync(state.journalPath, '## 📝 Notes\n- [[Legacy Title]]\n', 'utf8');
    const exactLink = classifyDeferredBacklink({ journalPath: state.journalPath, noteTitle: 'Legacy Title', section: '📝 Notes' }, { vaultRoot: state.root, notesDir: state.notesDir });
    assert.equal(exactLink.status, 'linked');
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('dry runs classify without mutating while an empty apply records freshness metadata', () => {
  const state = fixture();
  try {
    note(state.root, 'Notes/Dry.md', 'dry-id');
    const deferred = recordDeferredBacklink({ journalPath: state.journalPath, noteTitle: 'Dry', noteId: 'dry-id', notePath: 'Notes/Dry.md', section: '📝 Notes', reason: 'failed' });
    const queueBefore = fs.readFileSync(deferred.deferredPath, 'utf8');
    const journalBefore = fs.readFileSync(state.journalPath, 'utf8');
    const dry = flushDeferredBacklinks({ journalDir: state.journalDir, vaultRoot: state.root, notesDir: state.notesDir, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(fs.readFileSync(deferred.deferredPath, 'utf8'), queueBefore);
    assert.equal(fs.readFileSync(state.journalPath, 'utf8'), journalBefore);
    const emptyRoot = fixture();
    try {
      const empty = flushDeferredBacklinks({ journalDir: emptyRoot.journalDir, vaultRoot: emptyRoot.root, notesDir: emptyRoot.notesDir });
      assert.equal(empty.checked, 0);
      const queue = JSON.parse(fs.readFileSync(deferredQueuePathForJournalDir(emptyRoot.journalDir), 'utf8'));
      assert.ok(queue.lastFlushAt);
      assert.equal(queue.lastFlushSummary.checked, 0);
    } finally {
      fs.rmSync(emptyRoot.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('linker accepts optional v2 identity fields and records them on deferred mutation failure', () => {
  const state = fixture();
  try {
    const todayJournal = path.join(state.journalDir, `${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}.md`);
    fs.writeFileSync(todayJournal, '## 📝 Notes\n-\n', 'utf8');
    const notePath = note(state.root, 'Notes/Identity Failure.md', 'identity-failure-id');
    assert.throws(() => linkNoteToJournal({
      journalPath: todayJournal,
      noteTitle: 'Identity Failure',
      noteId: 'identity-failure-id',
      notePath,
      mutationService: fakeMutationService(state, { failMessage: 'Obsidian unavailable' }),
    }));
    const entry = Object.values(JSON.parse(fs.readFileSync(deferredQueuePathForJournalDir(state.journalDir), 'utf8')).entries)[0];
    assert.equal(entry.noteId, 'identity-failure-id');
    assert.equal(entry.notePath, 'Notes/Identity Failure.md');
    assert.equal(entry.auditState, 'recorded');
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('failed retry stays pending with attempt audit', () => {
  const state = fixture();
  try {
    const todayJournal = path.join(state.journalDir, `${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}.md`);
    fs.writeFileSync(todayJournal, '## 📝 Notes\n-\n', 'utf8');
    note(state.root, 'Notes/Retry.md', 'retry-id');
    const deferred = recordDeferredBacklink({ journalPath: todayJournal, noteTitle: 'Retry', noteId: 'retry-id', notePath: 'Notes/Retry.md', section: '📝 Notes', reason: 'failed' });
    const result = flushDeferredBacklinks({
      journalDir: state.journalDir,
      vaultRoot: state.root,
      notesDir: state.notesDir,
      mutationService: fakeMutationService(state, { failMessage: 'Obsidian unavailable' }),
    });
    assert.equal(result.pending, 1);
    const queuePath = deferredQueuePathForJournalDir(state.journalDir);
    const entry = JSON.parse(fs.readFileSync(queuePath, 'utf8')).entries[deferred.key];
    assert.equal(entry.status, 'pending');
    assert.equal(entry.attempts, 1);
    assert.match(entry.lastError, /Obsidian unavailable/);
    assert.equal(entry.events.at(-1).type, 'retry-failed');
    assert.match(entry.events.at(-1).error, /Obsidian unavailable/);
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('an entry added during a flush remains pending after the locked latest-state merge', () => {
  const state = fixture();
  try {
    const todayJournal = path.join(state.journalDir, `${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}.md`);
    fs.writeFileSync(todayJournal, '## 📝 Notes\n-\n', 'utf8');
    note(state.root, 'Notes/First.md', 'first-id');
    note(state.root, 'Notes/Second.md', 'second-id');
    recordDeferredBacklink({ journalPath: todayJournal, noteTitle: 'First', noteId: 'first-id', notePath: 'Notes/First.md', section: '📝 Notes', reason: 'failed' });
    let added = false;
    const flush = flushDeferredBacklinks({
      journalDir: state.journalDir,
      vaultRoot: state.root,
      notesDir: state.notesDir,
      mutationService: fakeMutationService(state, { onExecute: (operation) => {
        if (!added) {
          added = true;
          recordDeferredBacklink({ journalPath: state.journalPath, noteTitle: 'Second', noteId: 'second-id', notePath: 'Notes/Second.md', section: '📝 Notes', reason: 'failed' });
        }
        assert.equal(operation.transformName, 'journal-backlink');
      } }),
    });
    assert.equal(flush.linked, 1);
    const entries = Object.values(JSON.parse(fs.readFileSync(deferredQueuePathForJournalDir(state.journalDir), 'utf8')).entries);
    assert.equal(entries.find((entry) => entry.noteId === 'second-id').status, 'pending');
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});

test('manual reconciliation adopts a legacy identity and reopens, rather than deleting, the record', () => {
  const state = fixture();
  try {
    note(state.root, 'Notes/Recovered.md', 'recovered-id');
    const deferred = recordDeferredBacklink({ journalPath: state.journalPath, noteTitle: 'Missing Legacy', section: '📝 Notes', reason: 'failed' });
    const queuePath = deferred.deferredPath;
    const before = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    before.entries[deferred.key].status = 'unresolved';
    fs.writeFileSync(queuePath, `${JSON.stringify(before)}\n`, 'utf8');
    const result = reconcileDeferredBacklink({ journalDir: state.journalDir, key: deferred.key, notePath: 'Notes/Recovered.md', vaultRoot: state.root, notesDir: state.notesDir });
    assert.equal(result.adoptedIdentity, true);
    const entry = JSON.parse(fs.readFileSync(queuePath, 'utf8')).entries[deferred.key];
    assert.equal(entry.status, 'pending');
    assert.equal(entry.noteId, 'recovered-id');
    assert.equal(entry.events.at(-1).type, 'manual-reconciliation');
    assert.equal(entry.events.at(-1).previousStatus, 'unresolved');
  } finally {
    fs.rmSync(state.root, { recursive: true, force: true });
  }
});
