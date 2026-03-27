#!/usr/bin/env node
/**
 * bootstrap.js — Initialize a new ontology from templates.
 *
 * Creates ontology/ directory with blank template files.
 * Does NOT overwrite existing files.
 *
 * Usage: node scripts/bootstrap.js [--dir DIR]
 */

import { mkdirSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const targetDir = dirIdx !== -1
  ? args[dirIdx + 1]
  : resolve(new URL('.', import.meta.url).pathname, '..', 'ontology');

const templatesDir = resolve(new URL('.', import.meta.url).pathname, '..', 'schema', 'templates');

if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
  console.log(`📁 Created ${targetDir}`);
}

const templates = readdirSync(templatesDir).filter(f => f.endsWith('.md'));
let created = 0;
let skipped = 0;

for (const file of templates) {
  const dest = join(targetDir, file);
  if (existsSync(dest)) {
    console.log(`  ⏭️  ${file} (already exists)`);
    skipped++;
  } else {
    copyFileSync(join(templatesDir, file), dest);
    console.log(`  ✅ ${file}`);
    created++;
  }
}

console.log(`\n📊 Bootstrap complete: ${created} created, ${skipped} skipped`);
