'use strict';

// Temporary bridge compatibility seam. Journal callers may import this module while
// U4 migrates them; all new dispatch flows from bridge to the canonical adapter.
const { createVaultMutationAdapter } = require('../../../adapters/obsidian/src/vault-mutation-adapter');

function createObsidianMutationTransport(options) {
  const adapter = createVaultMutationAdapter(options);
  return Object.freeze({ execute: (operation) => adapter.execute(operation), capability: () => adapter.capability() });
}

module.exports = { createObsidianMutationTransport };
