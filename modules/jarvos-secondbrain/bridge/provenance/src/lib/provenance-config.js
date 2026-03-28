#!/usr/bin/env node
/**
 * provenance-config.js — bridge-owned path/config helpers for note↔journal provenance.
 *
 * Delegates to the shared bridge/config/jarvos-paths module.
 *
 * Resolution order:
 *   1. Canonical JARVOS_* env vars (JARVOS_NOTES_DIR, JARVOS_JOURNAL_DIR, JARVOS_VAULT_DIR)
 *   2. Legacy env var aliases (VAULT_NOTES_DIR, JOURNAL_DIR)
 *   3. jarvos.config.json paths.* in JARVOS_CLAWD_DIR (or CLAWD_DIR or ~/clawd)
 *   4. Defaults derived from vault root (~/Documents/Vault v3)
 */

'use strict';

const {
  getVaultDir,
  getNotesDir,
  getJournalDir,
} = require('../../../config/jarvos-paths.js');

function getVaultNotesDir() {
  return getNotesDir();
}

function getVaultJournalDir() {
  return getJournalDir();
}

module.exports = {
  getVaultDir,
  getVaultNotesDir,
  getVaultJournalDir,
};
