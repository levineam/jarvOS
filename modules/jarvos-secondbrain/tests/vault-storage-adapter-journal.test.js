'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVaultStorageAdapter } = require('../adapters/obsidian/src/vault-storage-adapter');
const { mutateJournalThroughObsidian } = require('../bridge/provenance/src/obsidian-mutation');
const vm = require('node:vm');

function withJournalEnv(journalDir, vaultDir, fn) {
  const keys = ['JARVOS_JOURNAL_DIR', 'JARVOS_VAULT_DIR', 'JARVOS_NOTES_DIR', 'JARVOS_TIMEZONE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.JARVOS_JOURNAL_DIR = journalDir;
  process.env.JARVOS_VAULT_DIR = vaultDir;
  process.env.JARVOS_NOTES_DIR = path.join(vaultDir, 'Notes');
  process.env.JARVOS_TIMEZONE = 'UTC';
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('Obsidian storage adapter delegates creation and active-day append through the lifecycle seams', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-'));
  const journalDir = path.join(vault, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });

  try {
    withJournalEnv(journalDir, vault, () => {
      const adapter = createVaultStorageAdapter({
        ownedJournalMutator: ({ journalPath, mutation, mutationPayload }) => {
          const current = fs.readFileSync(journalPath, 'utf8');
          const result = mutation(current, mutationPayload);
          fs.writeFileSync(journalPath, result.content, 'utf8');
          return { alreadyPresent: result.alreadyPresent, mutationOwner: 'obsidian-vault-process' };
        },
      });

      const first = adapter.ensureJournal({ date });
      assert.equal(first.lifecycle.outcome, 'created');
      const before = fs.readFileSync(first.journalPath, 'utf8');

      const appended = adapter.appendLineToJournalSection({
        heading: '## 📝 Notes',
        line: '- [[Adapter Note]]',
        date,
      });
      assert.equal(appended.alreadyPresent, false);
      assert.equal(appended.mutationOwner, 'obsidian-vault-process');
      assert.notEqual(fs.readFileSync(first.journalPath, 'utf8'), before);
      assert.match(fs.readFileSync(first.journalPath, 'utf8'), /\[\[Adapter Note\]\]/);

      const repeat = adapter.ensureJournal({ date });
      assert.equal(repeat.lifecycle.outcome, 'healthy-existing');
      assert.match(fs.readFileSync(repeat.journalPath, 'utf8'), /\[\[Adapter Note\]\]/);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('Obsidian storage adapter serializes its generic append mutation through the default helper contract', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-obsidian-'));
  const journalDir = path.join(vault, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const now = new Date('2026-08-04T00:00:00.000Z');
  const date = '2026-08-04';
  let editorContent = '';
  let processCalls = 0;
  const file = { path: `Journal/${date}.md` };
  const context = vm.createContext({
    app: {
      vault: {
        getFileByPath: () => (editorContent ? file : null),
        process: (_file, mutate) => {
          processCalls += 1;
          editorContent = mutate(editorContent);
          fs.writeFileSync(path.join(journalDir, `${date}.md`), editorContent, 'utf8');
          return { then: (resolve) => { resolve(); return { catch: () => {} }; } };
        },
      },
    },
    atob,
    TextDecoder,
  });

  try {
    withJournalEnv(journalDir, vault, () => {
      const adapter = createVaultStorageAdapter({
        ownedJournalMutator: (input) => mutateJournalThroughObsidian({
          ...input,
          evaluate: (code) => JSON.parse(vm.runInContext(code, context)),
          pollIntervalMs: 0,
        }),
      });
      const ensured = adapter.ensureJournal({ date, now });
      editorContent = fs.readFileSync(ensured.journalPath, 'utf8');
      const result = adapter.appendLineToJournalSection({
        heading: '## 📝 Notes',
        line: '- [[Default Helper Adapter Note]]',
        date,
        now,
      });

      assert.equal(ensured.lifecycle.date, date);
      assert.equal(processCalls, 1);
      assert.equal(result.mutationOwner, 'obsidian-vault-process');
      assert.match(fs.readFileSync(ensured.journalPath, 'utf8'), /\[\[Default Helper Adapter Note\]\]/);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('filesystem and Obsidian-owned append paths share one canonical transform', () => {
  const leftVault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-parity-left-'));
  const rightVault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-parity-right-'));
  const now = new Date('2026-08-04T00:00:00.000Z');
  const date = '2026-08-04';
  const seed = [
    `# ${date}`,
    '',
    '## 📝 Notes',
    '-',
    '',
    '## 💡 Ideas',
    '- keep authored content',
    '',
    '— Edited by Jarvis',
    '',
  ].join('\n');

  try {
    for (const vault of [leftVault, rightVault]) {
      fs.mkdirSync(path.join(vault, 'Journal'), { recursive: true });
      fs.writeFileSync(path.join(vault, 'Journal', `${date}.md`), seed, 'utf8');
    }

    withJournalEnv(path.join(leftVault, 'Journal'), leftVault, () => {
      const adapter = createVaultStorageAdapter({ allowUnsafeFilesystemWrites: true });
      adapter.appendLineToJournalSection({
        heading: '## 📝 Notes',
        line: '- [[Parity Note]]',
        date,
        now,
      });
    });

    withJournalEnv(path.join(rightVault, 'Journal'), rightVault, () => {
      const adapter = createVaultStorageAdapter({
        ownedJournalMutator: ({ journalPath, mutation, mutationPayload, verifyCommitted }) => {
          const current = fs.readFileSync(journalPath, 'utf8');
          const result = mutation(current, mutationPayload);
          fs.writeFileSync(journalPath, result.content, 'utf8');
          assert.equal(verifyCommitted(fs.readFileSync(journalPath, 'utf8')), true);
          return { alreadyPresent: result.alreadyPresent, mutationOwner: 'obsidian-vault-process' };
        },
      });
      adapter.appendLineToJournalSection({
        heading: '## 📝 Notes',
        line: '- [[Parity Note]]',
        date,
        now,
      });
    });

    assert.equal(
      fs.readFileSync(path.join(leftVault, 'Journal', `${date}.md`), 'utf8'),
      fs.readFileSync(path.join(rightVault, 'Journal', `${date}.md`), 'utf8'),
    );
  } finally {
    fs.rmSync(leftVault, { recursive: true, force: true });
    fs.rmSync(rightVault, { recursive: true, force: true });
  }
});

test('Obsidian storage adapter keeps a supplied operation clock across a date boundary', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-rollover-'));
  const journalDir = path.join(vault, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });
  const now = new Date('2026-08-04T00:00:00.000Z');
  try {
    withJournalEnv(journalDir, vault, () => {
      const adapter = createVaultStorageAdapter({ allowUnsafeFilesystemWrites: true });
      const result = adapter.ensureJournal({ date: '2026-08-04', now });
      assert.equal(result.lifecycle.date, '2026-08-04');
      assert.equal(fs.existsSync(path.join(journalDir, '2026-08-04.md')), true);
      assert.equal(fs.existsSync(path.join(journalDir, '2026-08-03.md')), false);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('past-date append never creates today as a side effect', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-past-date-'));
  const journalDir = path.join(vault, 'Journal');
  const now = new Date('2026-08-04T00:00:00.000Z');
  const pastDate = '2026-08-03';
  try {
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, `${pastDate}.md`), '## 📝 Notes\n-\n', 'utf8');
    withJournalEnv(journalDir, vault, () => {
      const adapter = createVaultStorageAdapter({ allowUnsafeFilesystemWrites: true });
      adapter.appendLineToJournalSection({
        heading: '## 📝 Notes',
        line: '- [[Past Note]]',
        date: pastDate,
        now,
      });
      assert.equal(fs.existsSync(path.join(journalDir, '2026-08-04.md')), false);
      assert.match(fs.readFileSync(path.join(journalDir, `${pastDate}.md`), 'utf8'), /Past Note/);
      assert.throws(
        () => adapter.ensureJournal({ date: pastDate, now }),
        /only the current local date/,
      );
      assert.equal(fs.existsSync(path.join(journalDir, '2026-08-04.md')), false);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('Obsidian storage adapter rejects journal path traversal dates', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-storage-adapter-traversal-'));
  const journalDir = path.join(vault, 'Journal');
  fs.mkdirSync(journalDir, { recursive: true });

  try {
    withJournalEnv(journalDir, vault, () => {
      const adapter = createVaultStorageAdapter({ allowUnsafeFilesystemWrites: true });
      const date = '../../outside/pwn';

      assert.throws(() => adapter.ensureJournal({ date }), /journal date must be ISO format YYYY-MM-DD/);
      assert.throws(
        () => adapter.appendLineToJournalSection({ heading: '## 💡 Ideas', line: '- escaped', date }),
        /journal date must be ISO format YYYY-MM-DD/,
      );
      assert.equal(fs.existsSync(path.join(vault, '..', 'outside', 'pwn.md')), false);
    });
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});
