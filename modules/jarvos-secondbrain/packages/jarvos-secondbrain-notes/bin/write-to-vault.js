#!/usr/bin/env node
// Package executable compatibility entrypoint. Markdown mutation is composed
// by the bridge-owned Obsidian service; this file never writes the vault.

'use strict';

const { writeNoteThroughContract } = require('../../../bridge/provenance/src/note-journal-contract.js');

function main() {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const parsed = JSON.parse(input.trim() || '{}');
      const result = writeNoteThroughContract({ ...parsed, personality: parsed.personality || 'codex' });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ error: error.message, failures: error.verification?.failures || [] }, null, 2)}\n`);
      process.exit(1);
    }
  });
}

module.exports = { main };

if (require.main === module) main();
