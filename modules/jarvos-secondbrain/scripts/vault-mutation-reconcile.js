#!/usr/bin/env node
'use strict';

// Operator-only entrypoint. A host composes its adapter/reconciler explicitly;
// this command intentionally has no agent-facing arbitrary-path arguments.
const path = require('node:path');
const { createVaultMutationAdapter } = require('../adapters/obsidian/src/vault-mutation-adapter');
const { createVaultMutationReconciler } = require('../adapters/obsidian/src/vault-mutation-reconciler');

const vaultRoot = process.env.JARVOS_VAULT_ROOT;
const vaultId = process.env.JARVOS_VAULT_ID;
if (!vaultRoot || !vaultId) throw new Error('JARVOS_VAULT_ROOT and JARVOS_VAULT_ID are required');
const adapter = createVaultMutationAdapter({ vaultRoot: path.resolve(vaultRoot), vaultId });
const reconciler = createVaultMutationReconciler({ adapter, ledger: adapter.ledger, vaultRoot: path.resolve(vaultRoot) });
const result = reconciler.drain({ limit: Number(process.env.JARVOS_RECONCILE_LIMIT || 8), timeMs: Number(process.env.JARVOS_RECONCILE_TIME_MS || 1000) });
process.stdout.write(`${JSON.stringify(result)}\n`);
