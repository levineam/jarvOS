'use strict';

// Verifies the published npm tarball actually ships the files an install needs
// to run every advertised runtime and the runtime-kit verifier. Regression
// guard for the omitted `runtimes/` and `modules/jarvos-runtime-kit/` entries
// that left an npm install without adapters/setup/verifier assets.
const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function packedFiles() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // npm may print notices before the JSON payload; parse from the first bracket.
  const start = result.stdout.indexOf('[');
  const parsed = JSON.parse(result.stdout.slice(start));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return new Set((entry.files || []).map((file) => file.path.replace(/\\/g, '/')));
}

function advertisedRuntimeAssets() {
  const runtimesDir = path.join(ROOT, 'runtimes');
  const required = [
    'modules/jarvos-runtime-kit/package.json',
    'modules/jarvos-runtime-kit/src/index.js',
    'modules/jarvos-runtime-kit/scripts/jarvos-runtime-kit.js',
    'modules/jarvos-runtime-kit/README.md',
    'modules/jarvos-control-plane/scripts/jarvos-manager.js',
    'profiles/minimal.json',
  ];
  for (const name of fs.readdirSync(runtimesDir)) {
    const adapter = path.join(runtimesDir, name, 'adapter.json');
    if (!fs.existsSync(adapter)) continue;
    required.push(`runtimes/${name}/adapter.json`);
    const setup = path.join(runtimesDir, name, 'setup.sh');
    if (fs.existsSync(setup)) required.push(`runtimes/${name}/setup.sh`);
    const readme = path.join(runtimesDir, name, 'README.md');
    if (fs.existsSync(readme)) required.push(`runtimes/${name}/README.md`);
  }
  return required;
}

test('published tarball includes every advertised runtime and runtime-kit asset', () => {
  const files = packedFiles();
  const required = advertisedRuntimeAssets();
  const missing = required.filter((file) => !files.has(file));
  assert.deepEqual(missing, [], `published tarball is missing required files: ${missing.join(', ')}`);
});
