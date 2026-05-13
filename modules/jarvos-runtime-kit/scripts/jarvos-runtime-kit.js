#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const {
  checkRuntime,
  listRuntimeManifests,
  loadManifest,
  repoRootFrom,
  scaffoldRuntime,
  validateManifest,
} = require('../src/index.js');

function usage() {
  return [
    'Usage:',
    '  jarvos-runtime-kit validate <adapter.json> [--json]',
    '  jarvos-runtime-kit check <runtime|all|adapter.json> [--json]',
    '  jarvos-runtime-kit scaffold <runtime-id> --out <dir>',
  ].join('\n');
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function printResult(result, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (Array.isArray(result.results)) {
    for (const item of result.results) {
      process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'} ${item.manifest}\n`);
      for (const error of item.errors || []) process.stdout.write(`  - ${error}\n`);
      for (const warning of item.warnings || []) process.stdout.write(`  warning: ${warning}\n`);
    }
    return;
  }
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${result.manifest || result.path || ''}\n`);
  for (const error of result.errors || []) process.stdout.write(`  - ${error}\n`);
  for (const warning of result.warnings || []) process.stdout.write(`  warning: ${warning}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const json = hasFlag(args, '--json');
  const root = repoRootFrom(process.cwd());

  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === 'validate') {
    const manifestPath = args[1];
    if (!manifestPath) throw new Error('validate requires <adapter.json>');
    const loaded = loadManifest(manifestPath);
    const result = { path: path.relative(root, loaded.path), ...validateManifest(loaded.manifest) };
    printResult(result, json);
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'check') {
    const runtime = args[1];
    if (!runtime) throw new Error('check requires <runtime|all|adapter.json>');
    const manifests = runtime === 'all'
      ? listRuntimeManifests(root)
      : fs.existsSync(path.resolve(runtime))
        ? [path.resolve(runtime)]
        : [path.join(root, 'runtimes', runtime, 'adapter.json')];
    const results = manifests.map((manifestPath) => checkRuntime(manifestPath, { root }));
    const result = { ok: results.every((item) => item.ok), results };
    printResult(result, json);
    process.exit(result.ok ? 0 : 1);
  }

  if (command === 'scaffold') {
    const runtimeId = args[1];
    const out = flagValue(args, '--out');
    if (!runtimeId) throw new Error('scaffold requires <runtime-id>');
    const result = scaffoldRuntime(runtimeId, out);
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`Scaffolded ${runtimeId}: ${result.dir}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}\n${usage()}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
}
