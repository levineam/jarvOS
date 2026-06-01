const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  repairZeroByteVaultRootDuplicate,
} = require('../packages/jarvos-secondbrain-notes/src/lib/vault-root-duplicate-guard.js');

function makeVault() {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-root-duplicate-'));
  const notesDir = path.join(vaultRoot, 'Notes');
  const journalDir = path.join(vaultRoot, 'Journal');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  return { vaultRoot, notesDir, journalDir };
}

function withEnv(nextEnv, fn) {
  const keys = Object.keys(nextEnv);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(nextEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('guard removes zero-byte vault-root duplicate only when matching Notes note is populated', () => {
  const vault = makeVault();
  const title = 'Populated Durable Note';
  const notesPath = path.join(vault.notesDir, `${title}.md`);
  const rootPath = path.join(vault.vaultRoot, `${title}.md`);
  fs.writeFileSync(notesPath, '# Populated Durable Note\n\nBody.\n');
  fs.closeSync(fs.openSync(rootPath, 'w'));

  const result = repairZeroByteVaultRootDuplicate({
    noteTitle: title,
    notesDir: vault.notesDir,
    notesFilePath: notesPath,
  });

  assert.equal(result.repaired, true);
  assert.equal(fs.existsSync(rootPath), false);
  assert.equal(fs.readFileSync(notesPath, 'utf8'), '# Populated Durable Note\n\nBody.\n');
});

test('guard leaves zero-byte vault-root orphan untouched', () => {
  const vault = makeVault();
  const rootPath = path.join(vault.vaultRoot, 'Orphan.md');
  fs.closeSync(fs.openSync(rootPath, 'w'));

  const result = repairZeroByteVaultRootDuplicate({
    noteTitle: 'Orphan',
    notesDir: vault.notesDir,
  });

  assert.equal(result.repaired, false);
  assert.match(result.reason, /matching populated Notes file not found/);
  assert.equal(fs.existsSync(rootPath), true);
});

test('canonical writer repairs matching zero-byte vault-root duplicate after writing note', () => {
  const vault = makeVault();
  const title = 'Canonical Durable Note';
  const rootPath = path.join(vault.vaultRoot, `${title}.md`);
  fs.closeSync(fs.openSync(rootPath, 'w'));

  withEnv({
    JARVOS_VAULT_DIR: vault.vaultRoot,
    JARVOS_NOTES_DIR: vault.notesDir,
    JARVOS_JOURNAL_DIR: vault.journalDir,
    JARVOS_JOURNAL_BACKLINK: '0',
    JARVOS_NOTE_OPTIMIZATION: '0',
  }, () => {
    const { writeNoteFile } = require('../packages/jarvos-secondbrain-notes/src/write-to-vault.js');
    const result = writeNoteFile({ title, content: 'Canonical body.' });
    assert.equal(result.vaultRootDuplicate.repaired, true);
    assert.equal(fs.existsSync(rootPath), false);
    assert.match(fs.readFileSync(result.path, 'utf8'), /Canonical body\./);
  });
});

test('journal backlink repairs matching zero-byte vault-root duplicate without deleting orphans', () => {
  const vault = makeVault();
  const title = 'Backlinked Durable Note';
  const notesPath = path.join(vault.notesDir, `${title}.md`);
  const rootPath = path.join(vault.vaultRoot, `${title}.md`);
  fs.writeFileSync(notesPath, '# Backlinked Durable Note\n\nBody.\n');
  fs.closeSync(fs.openSync(rootPath, 'w'));

  withEnv({
    JARVOS_VAULT_DIR: vault.vaultRoot,
    JARVOS_NOTES_DIR: vault.notesDir,
    JARVOS_JOURNAL_DIR: vault.journalDir,
  }, () => {
    const { linkNoteToJournal } = require('../bridge/provenance/src/link-to-journal.js');
    const journalPath = path.join(vault.journalDir, '2030-02-03.md');
    const result = linkNoteToJournal({ noteTitle: title, journalPath });
    assert.equal(result.vaultRootDuplicate.repaired, true);
    assert.equal(fs.existsSync(rootPath), false);
    assert.match(fs.readFileSync(journalPath, 'utf8'), /\[\[Backlinked Durable Note\]\]/);
  });
});

test('guard treats unlink failures as non-fatal', () => {
  const vault = makeVault();
  const title = 'Locked Durable Note';
  const notesPath = path.join(vault.notesDir, `${title}.md`);
  const rootPath = path.join(vault.vaultRoot, `${title}.md`);
  fs.writeFileSync(notesPath, '# Locked Durable Note\n\nBody.\n');
  fs.closeSync(fs.openSync(rootPath, 'w'));

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (target === rootPath) throw new Error('permission denied');
    return originalUnlinkSync(target);
  };
  try {
    const result = repairZeroByteVaultRootDuplicate({
      noteTitle: title,
      notesDir: vault.notesDir,
      notesFilePath: notesPath,
    });

    assert.equal(result.repaired, false);
    assert.match(result.reason, /could not remove zero-byte vault-root duplicate: permission denied/);
    assert.equal(fs.existsSync(rootPath), true);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
});
