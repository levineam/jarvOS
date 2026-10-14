'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('Hermes descriptor pins skills, U2 context plugin, and coding entrypoint together', () => {
  const verifier = path.resolve(__dirname, '..', 'scripts', 'verify-artifact-generation.js');
  const result = spawnSync(process.execPath, [verifier], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS Hermes artifact generation/);
  const adapter = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'adapter.json'), 'utf8'));
  assert.equal(adapter.capabilityDescriptor.capabilities.codingEntrypoint.invoke.status, 'supported');
  assert.match(adapter.capabilityDescriptor.capabilities.codingEntrypoint.invoke.evidence, /createHermesHostAdapter/);
});

test('Hermes setup falls back when the installed CLI rejects the guarded plugin flag', () => {
  const setup = fs.readFileSync(path.resolve(__dirname, '..', 'setup.sh'), 'utf8');
  assert.match(setup, /unknown option\|unrecognized option\|unrecognized arguments\|no such option\|unexpected argument/);
});
