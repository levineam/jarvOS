#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createObsidianSyncInspector } = require('../adapters/obsidian/src/obsidian-sync-inspector');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function main(env = process.env, serviceFactory = createConfiguredVaultMutationService) {
  const vaultRoot = env.JARVOS_VAULT_ROOT;
  if (!vaultRoot) throw new Error('JARVOS_VAULT_ROOT is required');
  const service = serviceFactory({ vaultRoot: path.resolve(vaultRoot), source: 'operator.vault-health' });
  const mutations = service.reconciler.health();
  const result = {
    mutations: {
      ...mutations,
      stalePlanned: mutations.stalePlanned ?? 0,
      oldestPlannedAgeMs: mutations.oldestPlannedAgeMs ?? null,
    },
  };

  const sampleModule = env.JARVOS_PRIVATE_SYNC_SAMPLE_MODULE;
  if (sampleModule) {
    if (!path.isAbsolute(sampleModule)) throw new Error('JARVOS_PRIVATE_SYNC_SAMPLE_MODULE must be absolute');
    const reader = require(fs.realpathSync(sampleModule)).readPrivateSyncState;
    const vaultRelativePath = env.JARVOS_SYNC_VAULT_RELATIVE_PATH;
    const expectedHash = env.JARVOS_SYNC_EXPECTED_HASH;
    const inspector = createObsidianSyncInspector({
      vaultId: service.vaultId,
      vaultRelativePath,
      readPrivateSyncState: reader,
    });
    result.sync = inspector.inspect({ expectedHash });
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

module.exports = { main };
if (require.main === module) main();
