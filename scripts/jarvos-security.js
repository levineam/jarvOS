#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { canonicalJson } = require('../modules/jarvos-coding/src/features/security/managed-software-activation');
const {
  defaultRoot,
  initializeSecurityVault,
} = require('../modules/jarvos-coding/src/features/security/vault');
const { issueApprovedRequest } = require('../modules/jarvos-coding/src/features/security/approval');
const {
  durableSecurityWrite,
} = require('../modules/jarvos-coding/src/features/security/filesystem');

const HELP = `jarvos security

One jarvOS security setup for managed-software approvals. Normal approvals use
Touch ID (or the Mac login passcode). One recovery passphrase protects both
internal signing identities; save it in your password manager.

Usage:
  jarvos security setup [--root <directory>]
  jarvos security approve --request <file> --output <file> [--root <directory>]
  jarvos security approve --request <file> --output <file> --recovery [--root <directory>]

Requirements:
  macOS with Touch ID or a Secure Enclave, age, and age-plugin-se.`;

function ask(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('jarvOS security approval must be run interactively in a terminal');
  }
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise((resolve, reject) => {
    const interrupted = () => {
      terminal.close();
      reject(new Error('jarvOS security prompt interrupted'));
    };
    terminal.once('SIGINT', interrupted);
    terminal.question(question, (answer) => {
      terminal.removeListener('SIGINT', interrupted);
      terminal.close();
      resolve(answer);
    });
  });
}

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === '--help' || item === '-h') {
      options.help = true;
      continue;
    }
    if (item === '--recovery') {
      options.recovery = true;
      continue;
    }
    if (!item?.startsWith('--')
      || rest[index + 1] === undefined
      || Object.hasOwn(options, item.slice(2))) {
      throw new Error('invalid jarvOS security arguments; run `jarvos security --help`');
    }
    options[item.slice(2)] = rest[index + 1];
    index += 1;
  }
  const allowed = {
    approve: new Set(['help', 'output', 'recovery', 'request', 'root']),
    setup: new Set(['help', 'root']),
  }[command];
  if (allowed) {
    const unsupported = Object.keys(options).find((option) => !allowed.has(option));
    if (unsupported) throw new Error(`unsupported option for ${command}: --${unsupported}`);
  }
  return { command, options };
}

function isWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === ''
    || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function nearestExistingPath(candidate) {
  let current = candidate;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function assertReceiptOutputOutsideVault(output, root) {
  const resolvedOutput = path.resolve(output);
  const resolvedRoot = path.resolve(root);
  if (isWithin(resolvedRoot, resolvedOutput)) {
    throw new Error('receipt output must be outside the jarvOS security vault');
  }
  try {
    const [realRoot, realOutputParent] = await Promise.all([
      fs.realpath(resolvedRoot),
      nearestExistingPath(path.dirname(resolvedOutput)),
    ]);
    if (realOutputParent && isWithin(realRoot, realOutputParent)) {
      throw new Error('receipt output must be outside the jarvOS security vault');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return resolvedOutput;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const confirm = dependencies.ask || ask;
  const initialize = dependencies.initializeSecurityVault || initializeSecurityVault;
  const issue = dependencies.issueApprovedRequest || issueApprovedRequest;
  const write = dependencies.durableSecurityWrite || durableSecurityWrite;
  const { command, options } = parse(argv);
  if (!command || command === 'help' || command === '--help' || command === '-h' || options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const root = options.root || defaultRoot();
  if (command === 'setup') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('jarvOS security setup must be run interactively in a terminal');
    }
    process.stdout.write('Create one recovery passphrase when prompted, then save it in your password manager.\n');
    const result = await initialize({ root });
    process.stdout.write(`jarvOS security is ready. Normal approvals now use Touch ID.\n${JSON.stringify(result)}\n`);
    return 0;
  }
  if (command === 'approve' && options.request && options.output) {
    const request = JSON.parse(await fs.readFile(path.resolve(options.request), 'utf8'));
    const output = await assertReceiptOutputOutsideVault(options.output, root);
    process.stdout.write(`jarvOS is requesting this exact limited approval:\n${canonicalJson(request)}\nReceipt will be written to:\n${output}\n`);
    const unlock = options.recovery ? 'your recovery passphrase' : 'Touch ID';
    if (await confirm(`Type APPROVE to continue with ${unlock}: `) !== 'APPROVE') {
      throw new Error('approval not granted');
    }
    const receipt = await issue({
      root,
      request,
      recovery: options.recovery === true,
    });
    await write(output, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`Approval issued: ${output}\n`);
    return 0;
  }
  throw new Error('invalid jarvOS security command; run `jarvos security --help`');
}

if (require.main === module) {
  main().then(
    (status) => { process.exitCode = status; },
    (error) => {
      process.stderr.write(`jarvos security failed: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = { HELP, assertReceiptOutputOutsideVault, main, parse };
