#!/usr/bin/env node
'use strict';

// Public, read-only provider inspection and proposal surface.  It intentionally
// has no file, credential, scheduler, network, or activation access.  The
// owner-private operator is the only place that may authorize spend or mutate
// selection.
const {
  createFreshProviderView,
  createProviderControl,
  createProviderRegistry,
} = require('../modules/jarvos-runtime-kit/src/index.js');

function usage() {
  return [
    'Usage:',
    '  active-assistant-provider.js list [--json]',
    '  active-assistant-provider.js status [--json]',
    '  active-assistant-provider.js propose-switch <profile-id> --tuple <sha256> [--json]',
    '  active-assistant-provider.js authorize-and-run [--json]  (owner surface required)',
    '  active-assistant-provider.js rollback [--json]             (owner surface required)',
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
  const [command, profileId] = argv;
  const json = hasFlag(argv, '--json');
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const registry = createProviderRegistry();
  const view = createFreshProviderView();
  const control = createProviderControl({ registry, view });

  if (command === 'list') {
    print(control.list(), json);
    return 0;
  }
  if (command === 'status') {
    print(control.status(), json);
    return 0;
  }
  if (command === 'propose-switch') {
    if (!profileId) throw new Error('propose-switch requires <profile-id>');
    const tupleDigest = flagValue(argv, '--tuple');
    if (!tupleDigest) throw new Error('propose-switch requires --tuple <sha256>');
    const result = control.proposeSwitch({ profileId, tupleDigest });
    print(result, json);
    return result.ok ? 0 : 1;
  }
  if (command === 'authorize-and-run' || command === 'rollback') {
    try {
      control[command === 'authorize-and-run' ? 'authorizeAndRun' : 'rollback']();
    } catch (error) {
      const result = { ok: false, code: error.code || 'owner_authorization_required', message: error.message };
      print(result, json);
      return 1;
    }
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
