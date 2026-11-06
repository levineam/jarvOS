#!/usr/bin/env node
'use strict';

const { upsertManagedBlock } = require('../../modules/jarvos-instruction-projection/src/managed-block');
const { readCaptureGuideline } = require('../../modules/jarvos-instruction-projection/src/capture-guideline');

try {
  const [file] = process.argv.slice(2);
  if (!file || process.argv.length !== 3) throw new Error('Usage: upsert-capture-guideline.js <Markdown file>');
  const result = upsertManagedBlock(file, 'capture-guideline', `## Keeping things\n\n${readCaptureGuideline()}`);
  if (result.backup) console.log(`Backup: ${result.backup}`);
  console.log(`${result.changed ? 'Updated' : 'Unchanged'} capture guideline: ${file}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
