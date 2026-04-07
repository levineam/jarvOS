#!/usr/bin/env node
/**
 * validate.js — CLI for running ontology validation checks.
 *
 * Usage: node scripts/validate.js [--ontology-dir DIR] [--json]
 */

import { resolve } from 'path';
import { validate, formatValidation } from '../src/validator.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const dirIdx = args.indexOf('--ontology-dir');
const dir = dirIdx !== -1
  ? args[dirIdx + 1]
  : resolve(new URL('.', import.meta.url).pathname, '..', 'ontology');

const result = validate(dir);

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatValidation(result));
}

process.exit(result.valid ? 0 : 1);
