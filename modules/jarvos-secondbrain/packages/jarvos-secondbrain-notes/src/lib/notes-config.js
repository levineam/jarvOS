#!/usr/bin/env node
/**
 * notes-config.js — package-owned Notes path/config helpers.
 *
 * Resolution order for the Notes directory:
 *   1. VAULT_NOTES_DIR env var
 *   2. jarvos.config.json in CLAWD_DIR / workspace
 *   3. homedir-relative defaults
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveConfig } = require('../../../../bridge/config');

function loadConfig() {
  return resolveConfig();
}

function getVaultNotesDir() {
  return loadConfig().paths.notes;
}

function getVaultSourceMaterialDir() {
  const config = loadConfig();
  if (config.paths.sourceMaterial) return config.paths.sourceMaterial;
  const plainSourceMaterial = path.join(config.paths.vault, 'Source Material');
  if (fs.existsSync(plainSourceMaterial) && fs.statSync(plainSourceMaterial).isDirectory()) {
    return plainSourceMaterial;
  }
  return path.join(config.paths.vault, '2 - Source Material');
}

module.exports = { loadConfig, getVaultNotesDir, getVaultSourceMaterialDir };
