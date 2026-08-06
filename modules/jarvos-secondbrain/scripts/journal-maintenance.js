#!/usr/bin/env node
'use strict';

const path = require('node:path');
const maintenance = require('../packages/jarvos-secondbrain-journal/src/journal-maintenance');
const { createConfiguredVaultMutationService } = require('../src/vault-mutation-service');

function createMarkdownFile(service, { filePath, nextContent, source }) {
  const vaultRelativePath = path.relative(service.vaultRoot, filePath).split(path.sep).join('/');
  const context = service.createWriteContext({ vaultRelativePath, operationSource: source });
  return context.mutationExecutor({
    schemaVersion: 1,
    operationId: context.operationId,
    vaultId: context.vaultId,
    vaultRelativePath,
    sequence: context.sequence,
    operationKind: 'create',
    content: nextContent,
    source: context.source,
  });
}

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
    createMarkdownFile: (input) => createMarkdownFile(service, input),
    mutationExecutor: (operation) => service.execute(operation),
    mutationContext: {
      vaultId: service.vaultId,
      vaultRoot: service.vaultRoot,
      source: 'journal.lifecycle',
    },
  });
  console.log(report.output);
  return report;
}

module.exports = { createMarkdownFile, main };

if (require.main === module) {
  const report = main();
  if (report?.status === 'failed') process.exitCode = 1;
}
