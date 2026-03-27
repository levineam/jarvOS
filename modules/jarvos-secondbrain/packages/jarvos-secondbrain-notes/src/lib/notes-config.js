#!/usr/bin/env node
/**
 * notes-config.js — package-owned Notes path/config helpers.
 *
 * Delegates to the shared bridge/config/jarvos-paths module.
 *
 * Resolution order for the Notes directory:
 *   1. JARVOS_NOTES_DIR env var
 *   2. VAULT_NOTES_DIR env var (backward compat)
 *   3. jarvos.config.json paths.notes in JARVOS_CLAWD_DIR (or CLAWD_DIR or ~/clawd)
 *   4. $JARVOS_VAULT_DIR/Notes (default: ~/Documents/Vault v3/Notes)
 */

'use strict';

const { getNotesDir } = require('../../../../bridge/config/jarvos-paths.js');

function getVaultNotesDir() {
  return getNotesDir();
}

module.exports = { getVaultNotesDir };
