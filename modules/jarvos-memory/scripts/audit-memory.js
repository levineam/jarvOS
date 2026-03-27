#!/usr/bin/env node
'use strict';

const { auditMemory, formatAudit } = require('../src/lib/audit-memory');

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') {
      args.json = true;
    } else if (token === '-h' || token === '--help') {
      console.log(`audit-memory.js\n\nUsage:\n  node jarvos-memory/scripts/audit-memory.js [--json]\n\nChecks the current clawd durable-memory surfaces for lightweight schema and provenance compliance.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err.message || err}`);
    process.exit(1);
  }

  const result = auditMemory();
  if (args.json) {
    console.log(JSON.stringify({ summary: result.summary, violations: result.violations }, null, 2));
  } else {
    console.log(formatAudit(result));
  }

  process.exit(result.violations.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}
