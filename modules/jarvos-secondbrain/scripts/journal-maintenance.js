#!/usr/bin/env node
'use strict';

const path = require('node:path');
const maintenance = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function main(argv = process.argv.slice(2)) {
  const config = maintenance.loadConfig();
  const journalDir = maintenance.resolveJournalDir(config);
  const vaultRoot = path.dirname(journalDir);
  const service = createConfiguredVaultMutationService({
    vaultRoot,
    source: 'journal.maintenance',
  });
  const report = maintenance.runMaintenance(argv, {
    applyMarkdownMutation: (input) => service.applyMarkdownMutation(input),
    createMarkdownFile: (input) => service.createMarkdownFile(input),
    mutationExecutor: (operation) => service.execute(operation),
    mutationContext: {
      vaultId: service.vaultId,
      vaultRoot: service.vaultRoot,
      source: service.source,
    },
  });
  console.log(report.output);
  return report;
}

module.exports = { main };

if (require.main === module) {
  const report = main();
  if (report?.status === 'failed') process.exitCode = 1;
}
