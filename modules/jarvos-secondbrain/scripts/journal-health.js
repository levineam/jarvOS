#!/usr/bin/env node
'use strict';

const { healthToday } = require('../packages/jarvos-secondbrain-journal/src/journal-lifecycle.js');

function parseArgs(argv) {
  const args = { json: false, date: 'today' };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg.startsWith('--date=')) {
      args.date = arg.slice('--date='.length);
      if (args.date !== 'today') throw new Error('--date only supports today');
    }
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = healthToday({});
  const output = args.json ? JSON.stringify(result) : `canonical=${result.canonical?.status || result.outcome} derived-index=${result.derivedIndex?.status || 'unavailable'}`;
  console.log(output);
  return result;
}

module.exports = { main, parseArgs };
if (require.main === module) {
  const result = main();
  if (result?.ok === false || result?.canonical?.status !== 'healthy') process.exitCode = 1;
}
