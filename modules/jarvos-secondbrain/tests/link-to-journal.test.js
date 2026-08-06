const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  linkNoteInSection,
  linkNoteToJournal: rawLinkNoteToJournal,
  mutateJournalThroughObsidian,
  normalizeSectionName,
  resolveVaultRootForJournal,
  runObsidianEval,
} = require('../bridge/provenance/src/link-to-journal.js');
const { createJarvosVaultTransforms } = require('../src/vault-transform-registry.js');

function fakeMutationService(vaultRoot, { beforeTransform, failMessage, calls = { create: 0, transform: 0 } } = {}) {
  const transforms = createJarvosVaultTransforms();
  let next = 0;
  return {
    vaultRoot,
    createWriteContext({ vaultRelativePath, intentId, operationSource }) {
      return { vaultId: `test:${vaultRoot}`, vaultRelativePath, operationId: intentId || `test-operation-${++next}`, sequence: 1, source: operationSource };
    },
    execute(operation) {
      if (failMessage) throw new Error(failMessage);
      const target = path.join(vaultRoot, operation.vaultRelativePath);
      if (operation.operationKind === 'create') {
        calls.create += 1;
        if (fs.existsSync(target)) return fs.readFileSync(target, 'utf8') === operation.content ? { status: 'already_satisfied' } : { status: 'conflict' };
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, operation.content, 'utf8'); return { status: 'committed' };
      }
      calls.transform += 1;
      if (beforeTransform) beforeTransform(target, operation);
      if (!fs.existsSync(target)) return { status: 'failed' };
      const current = fs.readFileSync(target, 'utf8');
      if (transforms.isSatisfied(current, operation)) return { status: 'already_satisfied' };
      fs.writeFileSync(target, transforms.applyNode(current, operation), 'utf8'); return { status: 'committed' };
    },
  };
}
function linkNoteToJournal(options = {}) {
  const journalPath = options.journalPath;
  const vaultRoot = options.vaultRoot || process.env.JARVOS_VAULT_DIR || path.dirname(path.dirname(journalPath));
  return rawLinkNoteToJournal({ ...options, mutationService: options.mutationService || fakeMutationService(vaultRoot) });
}

function withVaultEnv(root, fn) {
  const keys = ['JARVOS_VAULT_DIR', 'JARVOS_JOURNAL_DIR', 'JARVOS_NOTES_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.JARVOS_VAULT_DIR = root;
  process.env.JARVOS_JOURNAL_DIR = path.join(root, 'Journal');
  process.env.JARVOS_NOTES_DIR = path.join(root, 'Notes');
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('linkNoteInSection adds durable note link under canonical Notes section and is idempotent', () => {
  const original = [
    '---',
    'journal: Journal',
    'journal-date: 2026-05-14',
    '---',
    '',
    '## 📝 Notes',
    '-',
    '',
    '## 💡 Ideas',
    '-',
    '',
  ].join('\n');

  const first = linkNoteInSection(original, 'Child Education - Daily Capsule - 2026-05-14');
  const second = linkNoteInSection(first.content, 'Child Education - Daily Capsule - 2026-05-14');

  assert.equal(first.alreadyPresent, false);
  assert.equal(second.alreadyPresent, true);
  assert.equal(second.content, first.content);
  assert.match(first.content, /## 📝 Notes\n- \[\[Child Education - Daily Capsule - 2026-05-14\]\]/);
  assert.doesNotMatch(first.content, /## 📝 Notes\n-\n/);
});

test('linkNoteInSection canonicalizes deprecated Notes Created section requests', () => {
  const original = [
    '## 📝 Notes',
    '-',
    '',
    '## 🗂️ Notes Created',
    '- [[Old Note]]',
    '',
  ].join('\n');

  const { content } = linkNoteInSection(original, 'Updated Durable Note', '🗂️ Notes Created');

  assert.equal(normalizeSectionName('🗂️ Notes Created'), '📝 Notes');
  assert.match(content, /## 📝 Notes\n- \[\[Updated Durable Note\]\]/);
  assert.doesNotMatch(content, /## 🗂️ Notes Created\n- \[\[Updated Durable Note\]\]/);
});

test('linkNoteInSection keeps exactly one bullet link when duplicates exist', () => {
  const original = [
    '## 📝 Notes',
    '- [[Duplicate Note]]',
    '- [[Duplicate Note]]',
    '',
    '## 🗂️ Notes Created',
    '- [[Duplicate Note]]',
    '',
  ].join('\n');

  const { content, alreadyPresent } = linkNoteInSection(original, 'Duplicate Note');
  const matches = content.match(/- \[\[Duplicate Note\]\]/g) || [];

  assert.equal(alreadyPresent, true);
  assert.equal(matches.length, 1);
  assert.match(content, /## 📝 Notes\n- \[\[Duplicate Note\]\]/);
});

test('linkNoteInSection creates canonical Notes section and removes duplicate legacy bullet', () => {
  const original = [
    '## 🗂️ Notes Created',
    '- [[Legacy Duplicate]]',
    '',
  ].join('\n');

  const { content } = linkNoteInSection(original, 'Legacy Duplicate');
  const matches = content.match(/- \[\[Legacy Duplicate\]\]/g) || [];

  assert.equal(matches.length, 1);
  assert.match(content, /## 📝 Notes\n- \[\[Legacy Duplicate\]\]/);
  assert.doesNotMatch(content, /## 🗂️ Notes Created\n- \[\[Legacy Duplicate\]\]/);
});

test('linkNoteToJournal creates a missing journal from the configured template and links the note once', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-link-to-journal-'));
  const journalPath = path.join(tmpDir, '2030-02-03.md');

  try {
    const first = linkNoteToJournal({ noteTitle: 'Fresh Durable Note', journalPath });
    const second = linkNoteToJournal({ noteTitle: 'Fresh Durable Note', journalPath });
    const content = fs.readFileSync(journalPath, 'utf8');
    const matches = content.match(/- \[\[Fresh Durable Note\]\]/g) || [];

    assert.equal(first.alreadyPresent, false);
    assert.equal(second.alreadyPresent, true);
    assert.equal(matches.length, 1);
    assert.match(content, /journal-date: 2030-02-03/);
    assert.match(content, /## 📝 Notes\n- \[\[Fresh Durable Note\]\]/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('journal mutation applies to the latest app-owned content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-owned-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  fs.writeFileSync(journalPath, '## 📝 Notes\n-\n', 'utf8');
  let injected = false;

  try {
    const mutationService = fakeMutationService(root, { beforeTransform(target) {
      if (injected) return;
      injected = true;
      fs.appendFileSync(target, '\n## Scratch\n- Mobile edit before owned mutation\n', 'utf8');
    } });
    const result = withVaultEnv(root, () => linkNoteToJournal({
      noteTitle: 'Obsidian Owned Backlink',
      journalPath,
      mutationService,
    }));

    assert.equal(injected, true);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    const written = fs.readFileSync(journalPath, 'utf8');
    assert.match(written, /\[\[Obsidian Owned Backlink\]\]/);
    assert.match(written, /Mobile edit before owned mutation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing journal is created then linked through separate owned operations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-owned-journal-create-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  const calls = { create: 0, transform: 0 };

  try {
    const result = withVaultEnv(root, () => linkNoteToJournal({
      noteTitle: 'Owned Creation Backlink',
      journalPath,
      mutationService: fakeMutationService(root, { calls }),
    }));

    assert.equal(calls.create, 1);
    assert.equal(calls.transform, 1);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    const written = fs.readFileSync(journalPath, 'utf8');
    assert.match(written, /\[\[Owned Creation Backlink\]\]/);
    assert.match(written, /journal-date:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing backlink is re-acknowledged through the mutation owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-existing-owned-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  const original = '## 📝 Notes\n- [[Existing Backlink]]\n';
  fs.writeFileSync(journalPath, original, 'utf8');
  try {
    const result = withVaultEnv(root, () => linkNoteToJournal({
      noteTitle: 'Existing Backlink',
      journalPath,
    }));

    assert.equal(result.alreadyPresent, true);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disk-only journal bytes are registered through create before backlink transform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-disk-only-journal-'));
  const journalDir = path.join(root, 'Journal');
  const journalPath = path.join(journalDir, '2030-02-03.md');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(journalPath, '## 📝 Notes\n-\n\nOffline prose\n', 'utf8');
  const transforms = createJarvosVaultTransforms();
  const order = [];
  let appContent = null;
  let sequence = 0;
  const mutationService = {
    vaultRoot: root,
    createWriteContext({ vaultRelativePath, intentId, operationSource }) { return { vaultId: 'disk-only-test', vaultRelativePath, operationId: intentId, sequence: ++sequence, source: operationSource }; },
    execute(operation) {
      order.push(operation.operationKind);
      if (operation.operationKind === 'create') {
        assert.equal(operation.content, fs.readFileSync(journalPath, 'utf8'));
        appContent = operation.content;
        return { status: 'committed' };
      }
      assert.notEqual(appContent, null, 'transform must not run before app-owned create');
      appContent = transforms.applyNode(appContent, operation);
      fs.writeFileSync(journalPath, appContent, 'utf8');
      return { status: 'committed' };
    },
  };
  try {
    const result = linkNoteToJournal({ journalPath, noteTitle: 'Recovered Registration', mutationService, vaultRoot: root });
    assert.deepEqual(order, ['create', 'transform']);
    assert.equal(result.linked, true);
    assert.match(appContent, /Offline prose/);
    assert.match(appContent, /\[\[Recovered Registration\]\]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('canonical transform preserves the latest editor content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-eval-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  fs.writeFileSync(journalPath, '## 📝 Notes\n-\n', 'utf8');
  const calls = { create: 0, transform: 0 };

  try {
    const result = withVaultEnv(root, () => linkNoteToJournal({
      journalPath,
      noteTitle: 'Verified Obsidian Backlink',
      section: '📝 Notes',
      mutationService: fakeMutationService(root, { calls, beforeTransform(target) { fs.appendFileSync(target, '\n## Scratch\n- Mobile edit before Vault.process callback\n', 'utf8'); } }),
    }));

    assert.equal(calls.transform, 1);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    const written = fs.readFileSync(journalPath, 'utf8');
    assert.match(written, /\[\[Verified Obsidian Backlink\]\]/);
    assert.match(written, /Mobile edit before Vault\.process callback/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing journal dispatches create before backlink transform', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-create-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  const calls = { create: 0, transform: 0 };

  try {
    const result = withVaultEnv(root, () => linkNoteToJournal({
      journalPath,
      noteTitle: 'Created By Obsidian',
      section: '📝 Notes',
      mutationService: fakeMutationService(root, { calls }),
    }));

    assert.equal(calls.create, 1);
    assert.equal(calls.transform, 1);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    assert.match(fs.readFileSync(journalPath, 'utf8'), /\[\[Created By Obsidian\]\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy direct Obsidian evaluator is retired fail-closed', () => {
  assert.throws(() => runObsidianEval('JSON.stringify({ok:true})'), /retired/);
});

test('journal-only configuration infers the Obsidian vault root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-only-vault-'));
  const journalDir = path.join(root, 'Journal');
  const journalPath = path.join(journalDir, '2030-02-03.md');
  fs.mkdirSync(journalDir, { recursive: true });
  const previous = {
    JARVOS_VAULT_DIR: process.env.JARVOS_VAULT_DIR,
    JARVOS_JOURNAL_DIR: process.env.JARVOS_JOURNAL_DIR,
    JOURNAL_DIR: process.env.JOURNAL_DIR,
  };
  delete process.env.JARVOS_VAULT_DIR;
  delete process.env.JARVOS_JOURNAL_DIR;
  process.env.JOURNAL_DIR = journalDir;

  try {
    assert.equal(resolveVaultRootForJournal(journalPath), root);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('linking never raw-deletes duplicate notes from either configured vault', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-legacy-repair-root-'));
  const wrongRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-wrong-repair-root-'));
  const journalDir = path.join(root, 'Journal');
  const notesDir = path.join(root, 'Notes');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  fs.writeFileSync(journalPath, '## 📝 Notes\n-\n', 'utf8');
  fs.writeFileSync(path.join(notesDir, 'Legacy Repair Note.md'), '# Populated note\n', 'utf8');
  fs.writeFileSync(path.join(root, 'Legacy Repair Note.md'), '', 'utf8');
  fs.writeFileSync(path.join(wrongRoot, 'Legacy Repair Note.md'), '', 'utf8');
  const keys = ['JARVOS_VAULT_DIR', 'JARVOS_JOURNAL_DIR', 'JOURNAL_DIR', 'JARVOS_NOTES_DIR'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.JARVOS_VAULT_DIR = wrongRoot;
  delete process.env.JARVOS_JOURNAL_DIR;
  process.env.JOURNAL_DIR = journalDir;
  process.env.JARVOS_NOTES_DIR = notesDir;

  try {
    const result = linkNoteToJournal({
      noteTitle: 'Legacy Repair Note',
      journalPath,
      vaultRoot: root,
      mutationService: fakeMutationService(root),
    });
    assert.equal(result.vaultRootDuplicate.repaired, false);
    assert.equal(fs.existsSync(path.join(root, 'Legacy Repair Note.md')), true);
    assert.equal(fs.existsSync(path.join(wrongRoot, 'Legacy Repair Note.md')), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wrongRoot, { recursive: true, force: true });
  }
});

test('Obsidian failure leaves journal untouched and queues recovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-failure-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  const original = '## 📝 Notes\n-\n\n## Scratch\n- Active mobile draft\n';
  fs.writeFileSync(journalPath, original, 'utf8');

  try {
    assert.throws(
      () => withVaultEnv(root, () => linkNoteToJournal({
        noteTitle: 'Queued After Obsidian Failure',
        journalPath,
        mutationService: fakeMutationService(root, { failMessage: 'Obsidian unavailable' }),
      })),
      /Obsidian unavailable; backlink queued/,
    );
    assert.equal(fs.readFileSync(journalPath, 'utf8'), original);
    const queuePath = path.join(root, '.jarvos', 'journal-maintenance', 'deferred-backlinks.json');
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    assert.equal(Object.values(queue.entries)[0].reason, 'journal-mutation-failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt deferred queue is preserved instead of being replaced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-corrupt-backlink-queue-'));
  const journalDir = path.join(root, 'Journal');
  const stateDir = path.join(root, '.jarvos', 'journal-maintenance');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  const queuePath = path.join(stateDir, 'deferred-backlinks.json');
  const originalJournal = '## 📝 Notes\n-\n';
  const corruptQueue = '{"version":1,"entries":';
  fs.writeFileSync(journalPath, originalJournal, 'utf8');
  fs.writeFileSync(queuePath, corruptQueue, 'utf8');

  try {
    assert.throws(() => withVaultEnv(root, () => linkNoteToJournal({
      noteTitle: 'Do Not Erase Recovery',
      journalPath,
      mutationService: fakeMutationService(root, { failMessage: 'Obsidian unavailable' }),
    })), SyntaxError);
    assert.equal(fs.readFileSync(journalPath, 'utf8'), originalJournal);
    assert.equal(fs.readFileSync(queuePath, 'utf8'), corruptQueue);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [name, queueContent] of [
  ['array root', '[]'],
  ['array entries', '{"version":1,"entries":[]}'],
  ['string entries', '{"version":1,"entries":"corrupt"}'],
]) {
  test(`a parseable deferred queue with an invalid ${name} is preserved`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-invalid-backlink-queue-'));
    const journalDir = path.join(root, 'Journal');
    const stateDir = path.join(root, '.jarvos', 'journal-maintenance');
    fs.mkdirSync(journalDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const journalPath = path.join(journalDir, `${today}.md`);
    const queuePath = path.join(stateDir, 'deferred-backlinks.json');
    const originalJournal = '## 📝 Notes\n-\n';
    fs.writeFileSync(journalPath, originalJournal, 'utf8');
    fs.writeFileSync(queuePath, queueContent, 'utf8');

    try {
      assert.throws(() => withVaultEnv(root, () => linkNoteToJournal({
        noteTitle: 'Do Not Replace Invalid Queue',
        journalPath,
        mutationService: fakeMutationService(root, { failMessage: 'Obsidian unavailable' }),
      })), /Invalid deferred backlink queue/);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), originalJournal);
      assert.equal(fs.readFileSync(queuePath, 'utf8'), queueContent);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
