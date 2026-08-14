'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

test('packed coding MCP starts from an unpacked tarball without checkout-relative loading', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coding-pack-'));
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', temporary], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const tarball = path.join(temporary, JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0].filename);
  const extracted = path.join(temporary, 'unpacked'); fs.mkdirSync(extracted);
  const untar = spawnSync('tar', ['-xf', tarball, '-C', extracted], { encoding: 'utf8' });
  assert.equal(untar.status, 0, untar.stderr);
  const script = path.join(extracted, 'package', 'scripts', 'jarvos-coding-mcp.js');
  assert.ok(fs.existsSync(script));
  const started = spawnSync(process.execPath, [script], {
    cwd: temporary,
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const reply = JSON.parse(started.stdout.trim());
  assert.equal(reply.result.serverInfo.name, 'jarvos-coding');
});
