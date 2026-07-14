const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  linkNoteInSection,
  linkNoteToJournal,
  mutateJournalThroughObsidian,
  normalizeSectionName,
  resolveVaultRootForJournal,
  runObsidianEval,
} = require('../bridge/provenance/src/link-to-journal.js');

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

test('today journal mutations run through Obsidian-owned current content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-owned-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  fs.writeFileSync(journalPath, '## 📝 Notes\n-\n', 'utf8');
  let calls = 0;

  try {
    const result = withVaultEnv(root, () => linkNoteToJournal({
      noteTitle: 'Obsidian Owned Backlink',
      journalPath,
      ownedJournalMutator: ({ journalPath: target, noteTitle, section }) => {
        calls += 1;
        fs.appendFileSync(target, '\n## Scratch\n- Mobile edit before owned mutation\n', 'utf8');
        const current = fs.readFileSync(target, 'utf8');
        const mutation = linkNoteInSection(current, noteTitle, section);
        fs.writeFileSync(target, mutation.content, 'utf8');
        return { ...mutation, mutationOwner: 'obsidian-vault-process' };
      },
    }));

    assert.equal(calls, 1);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    const written = fs.readFileSync(journalPath, 'utf8');
    assert.match(written, /\[\[Obsidian Owned Backlink\]\]/);
    assert.match(written, /Mobile edit before owned mutation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a missing today journal is created inside the owned mutation without overwriting concurrent content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-owned-journal-create-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  let calls = 0;

  try {
    const result = withVaultEnv(root, () => linkNoteToJournal({
      noteTitle: 'Owned Creation Backlink',
      journalPath,
      ownedJournalMutator: ({ journalPath: target, noteTitle, section, initialContent }) => {
        calls += 1;
        assert.equal(fs.existsSync(target), false);
        assert.match(initialContent, /journal-date:/);
        const concurrentlyCreated = '## 📝 Notes\n-\n\n## Scratch\n- Concurrent mobile creation\n';
        fs.writeFileSync(target, concurrentlyCreated, 'utf8');
        const mutation = linkNoteInSection(fs.readFileSync(target, 'utf8'), noteTitle, section);
        fs.writeFileSync(target, mutation.content, 'utf8');
        return { ...mutation, mutationOwner: 'obsidian-vault-process' };
      },
    }));

    assert.equal(calls, 1);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    const written = fs.readFileSync(journalPath, 'utf8');
    assert.match(written, /\[\[Owned Creation Backlink\]\]/);
    assert.match(written, /Concurrent mobile creation/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing backlink succeeds without requiring Obsidian', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-existing-owned-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  const original = '## 📝 Notes\n- [[Existing Backlink]]\n';
  fs.writeFileSync(journalPath, original, 'utf8');
  let calls = 0;

  try {
    const result = withVaultEnv(root, () => linkNoteToJournal({
      noteTitle: 'Existing Backlink',
      journalPath,
      ownedJournalMutator: () => {
        calls += 1;
        throw new Error('Obsidian unavailable');
      },
    }));

    assert.equal(calls, 0);
    assert.equal(result.alreadyPresent, true);
    assert.equal(result.mutationOwner, 'existing-journal-content');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generated Vault.process mutation preserves the latest editor content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-eval-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  fs.writeFileSync(journalPath, '## 📝 Notes\n-\n', 'utf8');
  let editorContent = fs.readFileSync(journalPath, 'utf8');
  let processCalls = 0;
  const context = vm.createContext({
    app: {
      vault: {
        getFileByPath: (relativePath) => ({ path: relativePath }),
        process: (_file, mutate) => {
          processCalls += 1;
          editorContent += '\n## Scratch\n- Mobile edit before Vault.process callback\n';
          editorContent = mutate(editorContent);
          fs.writeFileSync(journalPath, editorContent, 'utf8');
          return {
            then: (resolve) => {
              resolve();
              return { catch: () => {} };
            },
          };
        },
      },
    },
    atob,
    TextDecoder,
  });

  try {
    const result = withVaultEnv(root, () => mutateJournalThroughObsidian({
      journalPath,
      noteTitle: 'Verified Obsidian Backlink',
      section: '📝 Notes',
      pollIntervalMs: 0,
      evaluate: (code) => JSON.parse(vm.runInContext(code, context)),
    }));

    assert.equal(processCalls, 1);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    const written = fs.readFileSync(journalPath, 'utf8');
    assert.match(written, /\[\[Verified Obsidian Backlink\]\]/);
    assert.match(written, /Mobile edit before Vault\.process callback/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generated mutation creates a missing journal through Obsidian before Vault.process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-create-journal-'));
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const journalPath = path.join(journalDir, `${today}.md`);
  let editorContent = '';
  let createCalls = 0;
  let processCalls = 0;
  const file = { path: `Journal/${today}.md` };
  const context = vm.createContext({
    app: {
      vault: {
        getFileByPath: () => (createCalls ? file : null),
        create: (_relativePath, initialContent) => {
          createCalls += 1;
          editorContent = `${initialContent}\n## Scratch\n- Created inside Obsidian\n`;
          return {
            then: (resolve) => {
              resolve(file);
              return { catch: () => {} };
            },
          };
        },
        process: (_file, mutate) => {
          processCalls += 1;
          editorContent = mutate(editorContent);
          fs.writeFileSync(journalPath, editorContent, 'utf8');
          return {
            then: (resolve) => {
              resolve();
              return { catch: () => {} };
            },
          };
        },
      },
    },
    atob,
    TextDecoder,
  });

  try {
    const result = withVaultEnv(root, () => mutateJournalThroughObsidian({
      journalPath,
      noteTitle: 'Created By Obsidian',
      section: '📝 Notes',
      initialContent: `---\njournal: Journal\njournal-date: ${today}\n---\n\n## 📝 Notes\n-\n`,
      pollIntervalMs: 1,
      evaluate: (code) => JSON.parse(vm.runInContext(code, context)),
    }));

    assert.equal(createCalls, 1);
    assert.equal(processCalls, 1);
    assert.equal(result.mutationOwner, 'obsidian-vault-process');
    assert.match(editorContent, /\[\[Created By Obsidian\]\]/);
    assert.match(editorContent, /Created inside Obsidian/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runObsidianEval targets the vault before eval', () => {
  let invocation;
  const result = runObsidianEval('JSON.stringify({ok:true})', {
    vaultName: 'Test Vault',
    command: '/test/obsidian',
    execute: (command, args, options) => {
      invocation = { command, args, options };
      return 'diagnostic\n=> {"ok":true}\n';
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(invocation, {
    command: '/test/obsidian',
    args: ['vault=Test Vault', 'eval', 'code=JSON.stringify({ok:true})'],
    options: { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
  });
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

test('legacy configuration repairs duplicate notes only inside the journal vault', () => {
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
      ownedJournalMutator: ({ journalPath: target, noteTitle, section }) => {
        const mutation = linkNoteInSection(fs.readFileSync(target, 'utf8'), noteTitle, section);
        fs.writeFileSync(target, mutation.content, 'utf8');
        return { ...mutation, mutationOwner: 'obsidian-vault-process' };
      },
    });
    assert.equal(result.vaultRootDuplicate.repaired, true);
    assert.equal(fs.existsSync(path.join(root, 'Legacy Repair Note.md')), false);
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
        ownedJournalMutator: () => {
          throw new Error('Obsidian unavailable');
        },
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
      ownedJournalMutator: () => {
        throw new Error('Obsidian unavailable');
      },
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
        ownedJournalMutator: () => {
          throw new Error('Obsidian unavailable');
        },
      })), /Invalid deferred backlink queue/);
      assert.equal(fs.readFileSync(journalPath, 'utf8'), originalJournal);
      assert.equal(fs.readFileSync(queuePath, 'utf8'), queueContent);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
