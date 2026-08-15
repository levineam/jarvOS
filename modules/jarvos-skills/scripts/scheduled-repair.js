#!/usr/bin/env node
'use strict';

const { runScheduledRepair } = require('../src/scheduled-repair');

function parseArgs(argv) {
  const options = { configPath: undefined, announceConvergence: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      if (!argv[index + 1]) throw new Error('--config requires a path');
      options.configPath = argv[++index];
    } else if (arg === '--announce-convergence') {
      options.announceConvergence = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      process.stdout.write('Usage: scheduled-repair.js [--config PATH] [--announce-convergence]\n');
      return 0;
    }
    const { message, result } = runScheduledRepair(options);
    process.stdout.write(`${message}\n`);
    return result?.ok ? 0 : 1;
  } catch {
    process.stdout.write('jarvOS skill sync needs attention: scheduled repair failed safely.\n');
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { parseArgs, main };
