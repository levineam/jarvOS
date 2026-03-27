'use strict';

/**
 * Tests for bridge/config/jarvos-paths.js
 *
 * Each test case isolates env vars and resets the config cache so resolution
 * logic can be exercised cleanly without cross-test pollution.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Path to the module under test (relative to this test file)
const PATHS_MODULE = path.resolve(__dirname, '../bridge/config/jarvos-paths.js');

/**
 * Run fn with specific env vars set, then restore original values.
 * Resets the config cache before and after.
 */
function withEnv(vars, fn) {
  const saved = {};
  const { resetConfigCache } = require(PATHS_MODULE);

  // Save originals
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();

  try {
    return fn();
  } finally {
    // Restore originals
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfigCache();
  }
}

// Clear module cache between test files to get fresh require calls
function freshRequire() {
  delete require.cache[require.resolve(PATHS_MODULE)];
  return require(PATHS_MODULE);
}

// ─── getClawdDir ─────────────────────────────────────────────────────────────

test('getClawdDir: defaults to ~/clawd when no env vars set', () => {
  withEnv({ JARVOS_CLAWD_DIR: undefined, CLAWD_DIR: undefined }, () => {
    const { getClawdDir } = require(PATHS_MODULE);
    assert.equal(getClawdDir(), path.join(os.homedir(), 'clawd'));
  });
});

test('getClawdDir: JARVOS_CLAWD_DIR takes priority over CLAWD_DIR', () => {
  withEnv({ JARVOS_CLAWD_DIR: '/canonical/clawd', CLAWD_DIR: '/legacy/clawd' }, () => {
    const { getClawdDir } = require(PATHS_MODULE);
    assert.equal(getClawdDir(), '/canonical/clawd');
  });
});

test('getClawdDir: CLAWD_DIR used when JARVOS_CLAWD_DIR not set (backward compat)', () => {
  withEnv({ JARVOS_CLAWD_DIR: undefined, CLAWD_DIR: '/legacy/clawd' }, () => {
    const { getClawdDir } = require(PATHS_MODULE);
    assert.equal(getClawdDir(), '/legacy/clawd');
  });
});

test('getClawdDir: tilde expansion works', () => {
  withEnv({ JARVOS_CLAWD_DIR: '~/my-clawd', CLAWD_DIR: undefined }, () => {
    const { getClawdDir } = require(PATHS_MODULE);
    assert.equal(getClawdDir(), path.join(os.homedir(), 'my-clawd'));
  });
});

// ─── getVaultDir ─────────────────────────────────────────────────────────────

test('getVaultDir: defaults to ~/Documents/Vault v3', () => {
  withEnv({ JARVOS_VAULT_DIR: undefined }, () => {
    const { getVaultDir } = require(PATHS_MODULE);
    assert.equal(getVaultDir(), path.join(os.homedir(), 'Documents', 'Vault v3'));
  });
});

test('getVaultDir: JARVOS_VAULT_DIR overrides default', () => {
  withEnv({ JARVOS_VAULT_DIR: '/my/vault' }, () => {
    const { getVaultDir } = require(PATHS_MODULE);
    assert.equal(getVaultDir(), '/my/vault');
  });
});

test('getVaultDir: reads from jarvos.config.json paths.vault', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-paths-test-'));
  const cfgPath = path.join(tmpDir, 'jarvos.config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ paths: { vault: '/config/vault' } }));

  withEnv({ JARVOS_VAULT_DIR: undefined, JARVOS_CLAWD_DIR: tmpDir, CLAWD_DIR: undefined }, () => {
    const { getVaultDir } = require(PATHS_MODULE);
    assert.equal(getVaultDir(), '/config/vault');
  });

  fs.rmSync(tmpDir, { recursive: true });
});

// ─── getNotesDir ─────────────────────────────────────────────────────────────

test('getNotesDir: defaults to $vaultDir/Notes', () => {
  withEnv({ JARVOS_NOTES_DIR: undefined, VAULT_NOTES_DIR: undefined, JARVOS_VAULT_DIR: undefined }, () => {
    const { getNotesDir } = require(PATHS_MODULE);
    assert.equal(getNotesDir(), path.join(os.homedir(), 'Documents', 'Vault v3', 'Notes'));
  });
});

test('getNotesDir: JARVOS_NOTES_DIR takes priority over VAULT_NOTES_DIR', () => {
  withEnv({ JARVOS_NOTES_DIR: '/canonical/notes', VAULT_NOTES_DIR: '/legacy/notes' }, () => {
    const { getNotesDir } = require(PATHS_MODULE);
    assert.equal(getNotesDir(), '/canonical/notes');
  });
});

test('getNotesDir: VAULT_NOTES_DIR honored as backward-compat alias', () => {
  withEnv({ JARVOS_NOTES_DIR: undefined, VAULT_NOTES_DIR: '/legacy/notes' }, () => {
    const { getNotesDir } = require(PATHS_MODULE);
    assert.equal(getNotesDir(), '/legacy/notes');
  });
});

// ─── getJournalDir ────────────────────────────────────────────────────────────

test('getJournalDir: defaults to $vaultDir/Journal', () => {
  withEnv({ JARVOS_JOURNAL_DIR: undefined, JOURNAL_DIR: undefined, JARVOS_VAULT_DIR: undefined }, () => {
    const { getJournalDir } = require(PATHS_MODULE);
    assert.equal(getJournalDir(), path.join(os.homedir(), 'Documents', 'Vault v3', 'Journal'));
  });
});

test('getJournalDir: JARVOS_JOURNAL_DIR takes priority over JOURNAL_DIR', () => {
  withEnv({ JARVOS_JOURNAL_DIR: '/canonical/journal', JOURNAL_DIR: '/legacy/journal' }, () => {
    const { getJournalDir } = require(PATHS_MODULE);
    assert.equal(getJournalDir(), '/canonical/journal');
  });
});

test('getJournalDir: JOURNAL_DIR honored as backward-compat alias', () => {
  withEnv({ JARVOS_JOURNAL_DIR: undefined, JOURNAL_DIR: '/legacy/journal' }, () => {
    const { getJournalDir } = require(PATHS_MODULE);
    assert.equal(getJournalDir(), '/legacy/journal');
  });
});

// ─── config file fallback ────────────────────────────────────────────────────

test('config file: malformed JSON returns {} gracefully', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-paths-test-'));
  const cfgPath = path.join(tmpDir, 'jarvos.config.json');
  fs.writeFileSync(cfgPath, 'THIS IS NOT JSON');

  withEnv({ JARVOS_CLAWD_DIR: tmpDir, CLAWD_DIR: undefined, JARVOS_NOTES_DIR: undefined, VAULT_NOTES_DIR: undefined, JARVOS_VAULT_DIR: undefined }, () => {
    const { getNotesDir } = require(PATHS_MODULE);
    // Should fall back to default without throwing
    assert.equal(getNotesDir(), path.join(os.homedir(), 'Documents', 'Vault v3', 'Notes'));
  });

  fs.rmSync(tmpDir, { recursive: true });
});

test('config file: missing config file returns defaults gracefully', () => {
  withEnv({ JARVOS_CLAWD_DIR: '/nonexistent/dir/that/should/not/exist', CLAWD_DIR: undefined, JARVOS_NOTES_DIR: undefined, VAULT_NOTES_DIR: undefined, JARVOS_VAULT_DIR: undefined }, () => {
    const { getNotesDir } = require(PATHS_MODULE);
    assert.equal(getNotesDir(), path.join(os.homedir(), 'Documents', 'Vault v3', 'Notes'));
  });
});

// ─── tilde expansion ─────────────────────────────────────────────────────────

test('expandTilde: handles strings not starting with ~/', () => {
  withEnv({}, () => {
    const { expandTilde } = require(PATHS_MODULE);
    assert.equal(expandTilde('/absolute/path'), '/absolute/path');
    assert.equal(expandTilde('relative/path'), 'relative/path');
  });
});

test('expandTilde: expands ~/... to homedir', () => {
  withEnv({}, () => {
    const { expandTilde } = require(PATHS_MODULE);
    assert.equal(expandTilde('~/foo/bar'), path.join(os.homedir(), 'foo/bar'));
  });
});
