#!/usr/bin/env node
'use strict';

const {
  createImportPlan,
  importToBrain,
  syncBrain,
  runRetrievalEval,
  graphRecall,
  doctor,
} = require('../src/index.js');

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function cliConfig() {
  return {
    manifestPath: argValue('--manifest'),
    evalPath: argValue('--eval-file'),
    brainDir: argValue('--brain-dir'),
    gbrainDir: argValue('--gbrain-dir'),
    vaultDir: argValue('--vault-dir'),
    gbrainBin: argValue('--gbrain-bin'),
    qmdBin: argValue('--qmd-bin'),
    qmdMode: argValue('--qmd-mode'),
    qmdCollection: argValue('--qmd-collection'),
    qmdIndex: argValue('--qmd-index'),
    limit: argValue('--limit'),
    retrievalTimeoutMs: argValue('--timeout-ms'),
    seed: argValue('--seed'),
    seeds: argValues('--seed'),
    depth: argValue('--depth'),
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stdout.write(`jarvos-gbrain\n\nCommands:\n  plan [--manifest path]\n  import [--dry-run] [--manifest path] [--brain-dir path] [--vault-dir path]\n  sync [--dry-run] [--brain-dir path] [--gbrain-dir path]\n  eval [--dry-run] [--eval-file path] [--compare-qmd] [--limit n] [--timeout-ms n]\n       [--qmd-bin path] [--qmd-mode search|query|vsearch] [--qmd-collection name] [--qmd-index name]\n  graph [--dry-run] --seed slug [--seed slug] [--depth n] [--timeout-ms n]\n  doctor\n\n`);
}

function main() {
  try {
    const command = process.argv[2] || 'help';
    const config = cliConfig();

    if (command === 'help' || command === '--help' || command === '-h') {
      usage();
      return;
    }

    if (command === 'plan') {
      printJson(createImportPlan(config));
      return;
    }

    if (command === 'import') {
      const plan = createImportPlan(config);
      printJson(importToBrain(plan, { dryRun: hasFlag('--dry-run') }));
      return;
    }

    if (command === 'sync') {
      printJson(syncBrain(config, { dryRun: hasFlag('--dry-run') }));
      return;
    }

    if (command === 'eval') {
      printJson(runRetrievalEval(config, {
        dryRun: hasFlag('--dry-run'),
        compareQmd: hasFlag('--compare-qmd'),
        limit: argValue('--limit'),
      }));
      return;
    }

    if (command === 'graph') {
      printJson(graphRecall(config, {
        dryRun: hasFlag('--dry-run'),
        seeds: argValues('--seed'),
        depth: argValue('--depth'),
      }));
      return;
    }

    if (command === 'doctor') {
      const result = doctor(config);
      printJson(result);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    usage();
    process.exitCode = 1;
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

main();
