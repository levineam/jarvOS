#!/usr/bin/env node
/**
 * combined.js — Render all ontology files into a single ONTOLOGY.md.
 *
 * Used during migration: generates a combined file that can be symlinked
 * from the old clawd/ONTOLOGY.md location.
 *
 * Usage: node scripts/combined.js [--ontology-dir DIR] [--output FILE]
 */

import { resolve } from 'path';
import { writeFileSync } from 'fs';
import { renderCombined } from '../src/renderer.js';

const args = process.argv.slice(2);

const dirIdx = args.indexOf('--ontology-dir');
const dir = dirIdx !== -1
  ? args[dirIdx + 1]
  : resolve(new URL('.', import.meta.url).pathname, '..', 'ontology');

const outIdx = args.indexOf('--output');
const output = outIdx !== -1 ? args[outIdx + 1] : null;

const combined = renderCombined(dir);

if (output) {
  writeFileSync(output, combined, 'utf8');
  console.log(`✅ Combined ontology written to ${output} (${combined.length} chars)`);
} else {
  console.log(combined);
}
