#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  flushDeferredBacklinks,
  reconcileDeferredBacklink,
  supersedeDeferredBacklink,
} = require('../bridge/provenance/src/link-to-journal.js');
const { getVaultJournalDir, getVaultDir, getVaultNotesDir } = require('../bridge/provenance/src/lib/provenance-config');

function usage() {
  return [
    'Usage: journal-backlink-recovery [--dry-run|--apply] [--key <key>] [--note-path <vault-relative-path> | --supersede --reason <reason> --evidence <evidence>] [--journal-dir <path>] [--json]',
    '',
    'Defaults to a non-mutating JSON dry run. --apply is required to update the queue or journal.',
    '--key with --note-path manually reconciles one entry and reopens it as pending; it does not erase history.',
    '--key with --supersede records an evidence-backed terminal disposition; --reason and --evidence are required.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { dryRun: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--apply') args.dryRun = false;
    else if (arg === '--json') {
      // JSON is the sole output format; retain this explicit flag for stable
      // operational transcripts and backwards-compatible examples.
    }
    else if (arg === '--supersede') args.supersede = true;
    else if (arg === '--key' || arg === '--note-path' || arg === '--journal-dir' || arg === '--reason' || arg === '--evidence') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      args[{ '--key': 'key', '--note-path': 'notePath', '--journal-dir': 'journalDir', '--reason': 'reason', '--evidence': 'evidence' }[arg]] = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.notePath && !args.key) throw new Error('--note-path requires --key');
  if (args.supersede && (!args.key || !args.reason || !args.evidence)) throw new Error('--supersede requires --key, --reason, and --evidence');
  if (!args.supersede && (args.reason || args.evidence)) throw new Error('--reason and --evidence require --supersede');
  if (args.supersede && args.notePath) throw new Error('--supersede cannot be combined with --note-path');
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return { help: true };
  }
  const journalDir = args.journalDir ? path.resolve(args.journalDir) : getVaultJournalDir();
  const vaultRoot = args.journalDir ? path.dirname(journalDir) : getVaultDir();
  const options = {
    journalDir,
    key: args.key,
    dryRun: args.dryRun,
    vaultRoot,
    notesDir: args.journalDir ? path.join(vaultRoot, 'Notes') : getVaultNotesDir(),
  };
  const result = args.supersede
    ? supersedeDeferredBacklink({ ...options, reason: args.reason, evidence: args.evidence })
    : (args.notePath
      ? reconcileDeferredBacklink({ ...options, notePath: args.notePath })
      : flushDeferredBacklinks(options));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, usage };
