#!/usr/bin/env node
'use strict';

// Operator-only entrypoint. The configured service supplies the same transform
// registry and durable vault identity used by foreground writers.
const path = require('node:path');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

// Flags: --dry-run lists what the stuck-operation resolver would resolve and
// touches nothing (no drain, no ledger write). Without it the command drains the
// ledger, then resolves stuck ensure-exists journal creates whose target exists
// (see the reconciler's resolveSatisfiedEnsureCreates for the exact rule), then
// drains once more so the writes they were blocking can proceed. Resolving is
// opt-in (--resolve-stuck or JARVOS_RECONCILE_RESOLVE_STUCK=1): it edits the
// ledger, so a scheduled drain never does it without an operator choosing to.
function main(env = process.env, serviceFactory = createConfiguredVaultMutationService, argv = process.argv.slice(2)) {
  const unknown = argv.filter((arg) => arg !== '--dry-run' && arg !== '--resolve-stuck');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  const dryRun = argv.includes('--dry-run') || env.JARVOS_RECONCILE_DRY_RUN === '1';
  const vaultRoot = env.JARVOS_VAULT_ROOT;
  if (!vaultRoot || !path.isAbsolute(vaultRoot)) throw new Error('JARVOS_VAULT_ROOT must be an absolute path');
  const service = serviceFactory({
    vaultRoot: path.resolve(vaultRoot),
    ...(env.JARVOS_VAULT_ID ? { vaultId: env.JARVOS_VAULT_ID } : {}),
    source: 'operator.vault-reconcile',
  });
  const resolver = service.reconciler.resolveSatisfiedEnsureCreates;
  if (dryRun) return { dryRun: true, stuckEnsureCreates: typeof resolver === 'function' ? resolver({ dryRun: true }) : null };
  const drainOptions = {
    limit: Number(env.JARVOS_RECONCILE_LIMIT || 8),
    timeMs: Number(env.JARVOS_RECONCILE_TIME_MS || 1000),
  };
  const result = service.reconciler.drain(drainOptions);
  const resolveStuck = argv.includes('--resolve-stuck') || env.JARVOS_RECONCILE_RESOLVE_STUCK === '1';
  if (!resolveStuck || typeof resolver !== 'function') return result;
  const stuckEnsureCreates = resolver();
  if (stuckEnsureCreates.resolved.length) {
    const again = service.reconciler.drain(drainOptions);
    for (const [key, value] of Object.entries(again)) result[key] = (result[key] || 0) + value;
  }
  return { ...result, stuckEnsureCreates };
}

module.exports = { main };

if (require.main === module) process.stdout.write(`${JSON.stringify(main())}\n`);
