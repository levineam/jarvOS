#!/usr/bin/env node
'use strict';

// Operator-only entrypoint. The configured service supplies the same transform
// registry and durable vault identity used by foreground writers.
const path = require('node:path');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function main(env = process.env, serviceFactory = createConfiguredVaultMutationService) {
  const vaultRoot = env.JARVOS_VAULT_ROOT;
  if (!vaultRoot || !path.isAbsolute(vaultRoot)) throw new Error('JARVOS_VAULT_ROOT must be an absolute path');
  const service = serviceFactory({
    vaultRoot: path.resolve(vaultRoot),
    ...(env.JARVOS_VAULT_ID ? { vaultId: env.JARVOS_VAULT_ID } : {}),
    source: 'operator.vault-reconcile',
  });
  const result = service.reconciler.drain({
    limit: Number(env.JARVOS_RECONCILE_LIMIT || 8),
    timeMs: Number(env.JARVOS_RECONCILE_TIME_MS || 1000),
  });
  return result;
}

module.exports = { main };

if (require.main === module) process.stdout.write(`${JSON.stringify(main())}\n`);
