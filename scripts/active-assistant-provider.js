#!/usr/bin/env node
'use strict';

// Public, read-only provider catalog inspection and proposal surface.  It
// intentionally has no file, credential, scheduler, network, or activation
// access.  It runs every command against a fresh in-memory catalog and
// preference, so it never inspects or mutates an installed owner's provider
// configuration.  Only a private owner-side operator may select a paid
// provider or deliver a message.
const {
  createInitialProviderPreference,
  createProviderCatalog,
  createProviderSelectionControl,
} = require('../modules/jarvos-runtime-kit/src/provider-selection.js');

function usage() {
  return [
    'Usage:',
    '  active-assistant-provider.js catalog [--json]',
    '  active-assistant-provider.js status [--json]',
    '  active-assistant-provider.js propose <entry-id> [--json]',
    '  active-assistant-provider.js preview <entry-id> --result <passed|failed> [--json]',
  ].join('\n');
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(argv = process.argv.slice(2)) {
  const [command, entryId] = argv;
  const json = hasFlag(argv, '--json');
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const catalog = createProviderCatalog();
  const preference = createInitialProviderPreference();
  const control = createProviderSelectionControl({ catalog, preference });

  if (command === 'catalog') {
    print(control.catalog(), json);
    return 0;
  }
  if (command === 'status') {
    print(control.status(), json);
    return 0;
  }
  if (command === 'propose') {
    if (!entryId) throw new Error('propose requires <entry-id>');
    const result = control.propose({ entryId });
    print(result, json);
    return result.ok ? 0 : 1;
  }
  if (command === 'preview') {
    if (!entryId) throw new Error('preview requires <entry-id>');
    const result = flagValue(argv, '--result');
    if (!result) throw new Error('preview requires --result <passed|failed>');
    const outcome = control.preview({ entryId, result });
    print(outcome, json);
    return outcome.ok ? 0 : 1;
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`active-assistant-provider: ${error.message || String(error)}\n`);
    process.exitCode = 2;
  }
}

module.exports = { main, usage };
