#!/usr/bin/env node
'use strict';

const {
  CassTranscriptAdapter,
  TRANSCRIPT_PACKET_SCHEMA,
  TRANSCRIPT_STATUS,
} = require('../src/lib/transcript-retrieval.js');

function usageError(message) {
  const packet = {
    schema: TRANSCRIPT_PACKET_SCHEMA,
    requestId: 'cli-error',
    queryDigest: null,
    destinationClass: 'on_demand_agent',
    mode: 'lexical',
    status: TRANSCRIPT_STATUS.UNAVAILABLE,
    requestedConnectors: [],
    searchedConnectors: [],
    connectorOutcomes: [],
    evidence: [],
    truncated: false,
    omissions: [`invalid_cli:${message}`],
    warnings: [],
    renderedTokenCount: 0,
  };
  process.stdout.write(`${JSON.stringify(packet)}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const input = { connectors: [], sessionRefs: [] };
  const adapterOptions = {};
  const queryParts = [];

  const valueFor = (args, index, flag) => {
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
    return args[index + 1];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      // Output is always JSON; retain the flag for CASS-compatible callers.
    } else if (arg === '--strict') {
      input.freshness = 'strict';
    } else if (arg === '--connector') {
      input.connectors.push(valueFor(argv, index, arg));
      index += 1;
    } else if (arg === '--session-ref') {
      input.sessionRefs.push(valueFor(argv, index, arg));
      index += 1;
    } else if (arg === '--cass-bin') {
      adapterOptions.cassBin = valueFor(argv, index, arg);
      index += 1;
    } else if (arg === '--data-dir') {
      adapterOptions.dataDir = valueFor(argv, index, arg);
      index += 1;
    } else if (arg === '--source-root') {
      if (!adapterOptions.sourceRoots) adapterOptions.sourceRoots = [];
      adapterOptions.sourceRoots.push(valueFor(argv, index, arg));
      index += 1;
    } else if (arg === '--since' || arg === '--until' || arg === '--request-id') {
      input[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = valueFor(argv, index, arg);
      index += 1;
    } else if (['--max-tokens', '--max-evidence', '--max-sessions', '--max-excerpt-chars'].includes(arg)) {
      input[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = Number(valueFor(argv, index, arg));
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unsupported option: ${arg}`);
    } else {
      queryParts.push(arg);
    }
  }

  if (input.connectors.length === 0) delete input.connectors;
  if (input.sessionRefs.length === 0) delete input.sessionRefs;
  input.query = queryParts.join(' ').trim();
  if (!input.query) throw new Error('a query is required');
  return { input, adapterOptions };
}

function main() {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const adapter = new CassTranscriptAdapter(parsed.adapterOptions);
    const packet = adapter.retrieve(parsed.input);
    if (packet.omissions?.some((item) => String(item).startsWith('invalid_request:'))) process.exitCode = 2;
    // `--json` is intentionally accepted for symmetry with cass. This CLI is
    // always JSON so callers never need a second output parser.
    process.stdout.write(`${JSON.stringify(packet)}\n`);
  } catch (error) {
    usageError(error instanceof Error ? error.message : 'invalid arguments');
  }
}

main();
