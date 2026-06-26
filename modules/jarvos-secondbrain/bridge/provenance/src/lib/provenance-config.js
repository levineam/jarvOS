#!/usr/bin/env node
/**
 * provenance-config.js — bridge-owned path/config helpers for note↔journal provenance.
 *
 * Resolution order:
 *   1. env overrides (VAULT_NOTES_DIR / JOURNAL_DIR)
 *   2. jarvos.config.json in CLAWD_DIR / workspace
 *   3. homedir-relative defaults
 */

'use strict';

const { resolveConfig } = require('../../../config');

function loadConfig() {
  return resolveConfig();
}

function getVaultDir() {
  return loadConfig().paths.vault;
}

function getVaultNotesDir() {
  return loadConfig().paths.notes;
}

function getVaultJournalDir() {
  return loadConfig().paths.journal;
}

function getTimeZone() {
  return loadConfig().user.timezone;
}

module.exports = {
  loadConfig,
  getVaultDir,
  getVaultNotesDir,
  getVaultJournalDir,
  getTimeZone,
};
