'use strict';

const {
  createVaultStorageAdapter,
  FLAGGED_HEADING,
  IDEAS_HEADING,
  NOTES_HEADING,
} = require('./obsidian/src/vault-storage-adapter.js');
const {
  createAmbientLocalStorageAdapter,
} = require('./ambient-local-storage-adapter.js');
const {
  createSessionSourceAdapter,
  normalizeSessionToCaptureEvents,
} = require('./session-source/session-source-adapter.js');
const {
  createOpenClawSessionAdapter,
} = require('./openclaw');
const {
  createCodexSessionAdapter,
} = require('./codex');
const {
  createClaudeCodeSessionAdapter,
} = require('./claude-code');

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
  createAmbientLocalStorageAdapter,
  createVaultStorageAdapter,
  createSessionSourceAdapter,
  normalizeSessionToCaptureEvents,
  createOpenClawSessionAdapter,
  createCodexSessionAdapter,
  createClaudeCodeSessionAdapter,
  FLAGGED_HEADING,
  IDEAS_HEADING,
  NOTES_HEADING,
};
