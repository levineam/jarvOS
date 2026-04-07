#!/usr/bin/env node
/**
 * render.js — CLI for rendering ontology visualizations.
 *
 * Usage:
 *   node scripts/render.js [--mermaid] [--summary] [--ontology-dir DIR]
 */

import { resolve } from 'path';
import { loadOntology } from '../src/reader.js';
import { renderMermaid, renderSummary } from '../src/renderer.js';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--ontology-dir');
const dir = dirIdx !== -1
  ? args[dirIdx + 1]
  : resolve(new URL('.', import.meta.url).pathname, '..', 'ontology');

const ontology = loadOntology(dir);

if (args.includes('--summary')) {
  console.log(renderSummary(ontology));
} else {
  console.log(renderMermaid(ontology));
}
