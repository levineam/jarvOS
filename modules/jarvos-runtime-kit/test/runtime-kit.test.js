'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  checkRuntime,
  listRuntimeManifests,
  scaffoldRuntime,
  validateManifest,
} = require('../src/index.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('validateManifest accepts the Codex runtime manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes/codex/adapter.json'), 'utf8'));
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('validateManifest rejects missing shared jarvos_hydrate tool', () => {
  const result = validateManifest({
    schemaVersion: 1,
    id: 'bad-runtime',
    displayName: 'Bad Runtime',
    setup: { script: 'setup.sh' },
    sharedAgentContext: {
      mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
      requiredTools: ['jarvos_current_work'],
    },
    targets: [{ id: 'bad-cli', kind: 'cli', mcp: { supported: true }, hydration: { mode: 'manual', reason: 'test' } }],
    configWrites: { backupBeforeWrite: true },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /jarvos_hydrate/);
});

test('validateManifest reports malformed target entries', () => {
  const result = validateManifest({
    schemaVersion: 1,
    id: 'bad-runtime',
    displayName: 'Bad Runtime',
    setup: { script: 'setup.sh' },
    sharedAgentContext: {
      mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
      requiredTools: ['jarvos_hydrate'],
    },
    targets: [null],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /targets\[0\] must be an object/);
});

test('checkRuntime passes every checked-in adapter manifest', () => {
  const manifests = listRuntimeManifests(ROOT);
  assert.ok(manifests.length >= 3);
  for (const manifest of manifests) {
    const result = checkRuntime(manifest, { root: ROOT });
    assert.equal(result.ok, true, `${result.manifest}\n${result.errors.join('\n')}`);
  }
});

test('checkRuntime reports unloadable MCP servers without throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-bad-mcp-'));
  try {
    const runtimeDir = path.join(tmp, 'runtimes/sample-runtime');
    const mcpDir = path.join(tmp, 'modules/jarvos-agent-context/scripts');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'jarvos-mcp.js'), 'throw new Error("boom");\n', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'README.md'), 'Manual hydration is documented for sample-runtime-cli.\n', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, 'setup.sh'), '#!/usr/bin/env bash\ncp "$1" "$1.bak"\n', { encoding: 'utf8', mode: 0o755 });
    const manifestPath = path.join(runtimeDir, 'adapter.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      sharedAgentContext: {
        mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
        requiredTools: ['jarvos_hydrate'],
      },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      configWrites: { backupBeforeWrite: true },
    }, null, 2));

    const result = checkRuntime(manifestPath, { root: tmp });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /shared MCP server could not be loaded: boom/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('checkRuntime reports missing setup scripts without throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-missing-setup-'));
  try {
    const manifestPath = path.join(tmp, 'adapter.json');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'Manual hydration is documented for sample-runtime-cli.\n', 'utf8');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      id: 'sample-runtime',
      displayName: 'Sample Runtime',
      setup: { script: 'setup.sh' },
      sharedAgentContext: {
        mcpServer: 'modules/jarvos-agent-context/scripts/jarvos-mcp.js',
        requiredTools: ['jarvos_hydrate'],
      },
      targets: [{
        id: 'sample-runtime-cli',
        kind: 'cli',
        mcp: { supported: true },
        hydration: { mode: 'manual', reason: 'test' },
      }],
      configWrites: { backupBeforeWrite: true },
    }, null, 2));

    const result = checkRuntime(manifestPath, { root: ROOT });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /setup script missing/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scaffoldRuntime creates a valid starter adapter', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-runtime-kit-'));
  try {
    const result = scaffoldRuntime('sample-runtime', path.join(tmp, 'sample-runtime'));
    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(path.join(result.dir, 'adapter.json')));
    assert.ok(fs.existsSync(path.join(result.dir, 'README.md')));
    assert.ok(fs.existsSync(path.join(result.dir, 'setup.sh')));
    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'adapter.json'), 'utf8'));
    assert.equal(validateManifest(manifest).ok, true);
    assert.equal(checkRuntime(path.join(result.dir, 'adapter.json'), { root: ROOT }).ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
