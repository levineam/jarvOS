'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PATHS_MODULE = path.resolve(__dirname, '../bridge/config/jarvos-paths.js');
const JOURNAL_MODULE = path.resolve(
  __dirname,
  '../packages/jarvos-secondbrain-journal/src/journal-maintenance.js'
);

function withEnv(vars, fn) {
  const saved = {};
  const { resetConfigCache } = require(PATHS_MODULE);

  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  }
}

function resolveJournalDir(config) {
  delete require.cache[require.resolve(JOURNAL_MODULE)];
  return require(JOURNAL_MODULE).resolveJournalDir(config);
}

test('resolveJournalDir: JARVOS_VAULT_DIR-derived path wins over legacy journal-module fallback', () => {
  withEnv(
    {
      JARVOS_JOURNAL_DIR: undefined,
      JOURNAL_DIR: undefined,
      JARVOS_VAULT_DIR: '/shared/vault',
      JARVOS_CLAWD_DIR: '/missing/clawd',
      CLAWD_DIR: undefined,
    },
    () => {
      assert.equal(
        resolveJournalDir({ vault: { journalDir: '/legacy/journal' } }),
        '/shared/vault/Journal'
      );
    }
  );
});

test('resolveJournalDir: jarvos.config.json paths.journal wins over legacy journal-module fallback', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-maintenance-paths-'));
  fs.writeFileSync(
    path.join(tmpDir, 'jarvos.config.json'),
    JSON.stringify({ paths: { journal: '/config/journal' } })
  );

  try {
    withEnv(
      {
        JARVOS_JOURNAL_DIR: undefined,
        JOURNAL_DIR: undefined,
        JARVOS_VAULT_DIR: undefined,
        JARVOS_CLAWD_DIR: tmpDir,
        CLAWD_DIR: undefined,
      },
      () => {
        assert.equal(
          resolveJournalDir({ vault: { journalDir: '/legacy/journal' } }),
          '/config/journal'
        );
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveJournalDir: jarvos.config.json paths.vault wins over legacy journal-module fallback', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-maintenance-paths-'));
  fs.writeFileSync(
    path.join(tmpDir, 'jarvos.config.json'),
    JSON.stringify({ paths: { vault: '/config/vault' } })
  );

  try {
    withEnv(
      {
        JARVOS_JOURNAL_DIR: undefined,
        JOURNAL_DIR: undefined,
        JARVOS_VAULT_DIR: undefined,
        JARVOS_CLAWD_DIR: tmpDir,
        CLAWD_DIR: undefined,
      },
      () => {
        assert.equal(
          resolveJournalDir({ vault: { journalDir: '/legacy/journal' } }),
          '/config/vault/Journal'
        );
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveJournalDir: legacy journal-module fallback is used when no shared path input is configured', () => {
  withEnv(
    {
      JARVOS_JOURNAL_DIR: undefined,
      JOURNAL_DIR: undefined,
      JARVOS_VAULT_DIR: undefined,
      JARVOS_CLAWD_DIR: '/missing/clawd',
      CLAWD_DIR: undefined,
    },
    () => {
      assert.equal(
        resolveJournalDir({ vault: { journalDir: '/legacy/journal' } }),
        '/legacy/journal'
      );
    }
  );
});
