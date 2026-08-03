'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createVaultStorageAdapter } = require('../adapters/obsidian/src/vault-storage-adapter');

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

