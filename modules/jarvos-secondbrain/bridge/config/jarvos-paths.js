#!/usr/bin/env node
/**
 * jarvos-paths.js — shared path/config resolution for all jarvos-secondbrain packages.
 *
 * Canonical env var names (JARVOS_* prefix):
 *   JARVOS_VAULT_DIR   → vault root (default: ~/Documents/Vault v3)
 *   JARVOS_JOURNAL_DIR → journal dir (default: $JARVOS_VAULT_DIR/Journal)
 *   JARVOS_NOTES_DIR   → notes dir   (default: $JARVOS_VAULT_DIR/Notes)
 *   JARVOS_CLAWD_DIR   → clawd/workspace root (default: ~/clawd)
 *
 * Backward-compat aliases (still honored, checked after canonical names):
 *   VAULT_NOTES_DIR    → same as JARVOS_NOTES_DIR
 *   JOURNAL_DIR        → same as JARVOS_JOURNAL_DIR
 *   CLAWD_DIR          → same as JARVOS_CLAWD_DIR
 *
 * Resolution order for each path:
 *   1. Canonical JARVOS_* env var
 *   2. Legacy env var alias
 *   3. jarvos.config.json in JARVOS_CLAWD_DIR (or ~/clawd) → paths.*
 *   4. Default derived from vault root or home dir
 *
 * "Vault v3" as the default vault dir is Andrew's current layout and is preserved
 * for backward compatibility. Override via JARVOS_VAULT_DIR or jarvos.config.json
 * paths.vault to use a different vault root.
 */

'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');

const DEFAULT_CLAWD_DIR = join(os.homedir(), 'clawd');
const DEFAULT_VAULT_DIR = join(os.homedir(), 'Documents', 'Vault v3');

// One shared cache per process lifetime.
let _cachedConfig = null;

/**
 * Expand a leading ~/ to the user's home directory.
 * @param {string} p
 * @returns {string}
 */
function expandTilde(p) {
  if (typeof p === 'string' && p.startsWith('~/')) {
    return join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Load jarvos.config.json from the clawd root.
 * Returns {} if the file doesn't exist or can't be parsed.
 * @returns {object}
 */
function loadConfig() {
  if (_cachedConfig !== null) return _cachedConfig;
  const clawdDir = process.env.JARVOS_CLAWD_DIR || process.env.CLAWD_DIR || DEFAULT_CLAWD_DIR;
  const configPath = join(clawdDir, 'jarvos.config.json');
  if (existsSync(configPath)) {
    try {
      _cachedConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      _cachedConfig = {};
    }
  } else {
    _cachedConfig = {};
  }
  return _cachedConfig;
}

/**
 * Reset the config cache. Useful in tests when env vars change between cases.
 */
function resetConfigCache() {
  _cachedConfig = null;
}

/**
 * Resolve the clawd/workspace root directory.
 * Priority: JARVOS_CLAWD_DIR → CLAWD_DIR → ~/clawd
 * @returns {string}
 */
function getClawdDir() {
  if (process.env.JARVOS_CLAWD_DIR) return expandTilde(process.env.JARVOS_CLAWD_DIR);
  if (process.env.CLAWD_DIR) return expandTilde(process.env.CLAWD_DIR);
  return DEFAULT_CLAWD_DIR;
}

/**
 * Resolve the vault root directory.
 * Priority: JARVOS_VAULT_DIR → config paths.vault → ~/Documents/Vault v3
 * @returns {string}
 */
function getVaultDir() {
  if (process.env.JARVOS_VAULT_DIR) return expandTilde(process.env.JARVOS_VAULT_DIR);
  const cfg = loadConfig();
  if (cfg.paths && cfg.paths.vault) return expandTilde(cfg.paths.vault);
  if (cfg.vaultPath) return expandTilde(cfg.vaultPath);
  return DEFAULT_VAULT_DIR;
}

/**
 * Resolve the notes directory.
 * Priority: JARVOS_NOTES_DIR → VAULT_NOTES_DIR → config paths.notes → $vaultDir/Notes
 * @returns {string}
 */
function getNotesDir() {
  if (process.env.JARVOS_NOTES_DIR) return expandTilde(process.env.JARVOS_NOTES_DIR);
  if (process.env.VAULT_NOTES_DIR) return expandTilde(process.env.VAULT_NOTES_DIR);
  const cfg = loadConfig();
  if (cfg.paths && cfg.paths.notes) return expandTilde(cfg.paths.notes);
  return join(getVaultDir(), 'Notes');
}

/**
 * Resolve the journal directory.
 * Priority: JARVOS_JOURNAL_DIR → JOURNAL_DIR → config paths.journal → $vaultDir/Journal
 * @returns {string}
 */
function getJournalDir() {
  if (process.env.JARVOS_JOURNAL_DIR) return expandTilde(process.env.JARVOS_JOURNAL_DIR);
  if (process.env.JOURNAL_DIR) return expandTilde(process.env.JOURNAL_DIR);
  const cfg = loadConfig();
  if (cfg.paths && cfg.paths.journal) return expandTilde(cfg.paths.journal);
  return join(getVaultDir(), 'Journal');
}

module.exports = {
  expandTilde,
  loadConfig,
  resetConfigCache,
  getClawdDir,
  getVaultDir,
  getNotesDir,
  getJournalDir,
  // Expose defaults for documentation / tests
  DEFAULT_CLAWD_DIR,
  DEFAULT_VAULT_DIR,
};
