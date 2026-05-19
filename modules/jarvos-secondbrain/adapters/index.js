'use strict';

const {
  createVaultStorageAdapter,
  FLAGGED_HEADING,
  IDEAS_HEADING,
  NOTES_HEADING,
  NOTES_CREATED_HEADING,
} = require('./obsidian/src/vault-storage-adapter.js');

function createStorageAdapter(options = {}) {
  const kind = String(options.kind || process.env.JARVOS_SECONDBRAIN_ADAPTER || 'obsidian').trim().toLowerCase();

  switch (kind) {
    case 'obsidian':
      return createVaultStorageAdapter(options);
    default:
      throw new Error(`Unknown jarvos-secondbrain adapter: ${kind}`);
  }
}

module.exports = {
  createStorageAdapter,
  createVaultStorageAdapter,
  FLAGGED_HEADING,
  IDEAS_HEADING,
  NOTES_HEADING,
  NOTES_CREATED_HEADING,
};
