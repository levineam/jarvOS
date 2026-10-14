#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const adapterPath = path.join(repoRoot, 'runtimes', 'hermes', 'adapter.json');
const adapter = JSON.parse(fs.readFileSync(adapterPath, 'utf8'));
const binding = adapter.artifactGeneration;

if (!binding || binding.version !== 'jarvos-hermes-artifact-generation.v1' || !Array.isArray(binding.components)) {
  throw new Error('Hermes adapter is missing a valid artifact generation binding');
}

const components = binding.components.map((component) => {
  if (!component || typeof component.name !== 'string' || typeof component.path !== 'string' || !/^[a-f0-9]{64}$/i.test(component.digest || '')) {
    throw new Error('Hermes artifact generation contains an invalid component');
  }
  const source = path.resolve(repoRoot, component.path);
  if (path.relative(repoRoot, source).startsWith('..') || !fs.statSync(source).isFile()) {
    throw new Error(`Hermes artifact component is unavailable: ${component.path}`);
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  if (actual !== component.digest) throw new Error(`Hermes artifact component digest mismatch: ${component.name}`);
  return [component.name, component.digest];
});

const actualGeneration = crypto.createHash('sha256').update(JSON.stringify(components)).digest('hex');
if (actualGeneration !== binding.generationDigest) throw new Error('Hermes artifact generation digest mismatch');

process.stdout.write(`PASS Hermes artifact generation ${binding.generationDigest}\n`);
