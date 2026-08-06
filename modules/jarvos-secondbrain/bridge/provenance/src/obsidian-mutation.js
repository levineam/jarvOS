'use strict';

// Temporary bridge compatibility seam. Journal callers may import this module while
// U4 migrates them; all new dispatch flows from bridge to the canonical adapter.
const { createVaultMutationAdapter } = require('../../../adapters/obsidian/src/vault-mutation-adapter');
const { createConfiguredVaultMutationService } = require('../../../src/vault-mutation-service');
const { getVaultDir } = require('./lib/provenance-config');

function createObsidianMutationTransport(options) {
  const adapter = createVaultMutationAdapter(options);
  return Object.freeze({ execute: (operation) => adapter.execute(operation), capability: () => adapter.capability() });
}

function createObsidianOwnedMutationService(options = {}) {
  return createConfiguredVaultMutationService({
    vaultRoot: options.vaultRoot || getVaultDir(),
    ...options,
  });
}

module.exports = { createObsidianMutationTransport, createObsidianOwnedMutationService };
