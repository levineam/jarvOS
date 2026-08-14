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

test('real MCP subprocess binds the owner registry and reaches the default native plan boundary', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coding-mcp-process-'));
  const repository = path.join(temporary, 'repository');
  const stateRoot = path.join(temporary, 'state');
  const worktreeRoot = path.join(temporary, 'worktrees');
  for (const directory of [repository, stateRoot, worktreeRoot]) { fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700); }
  const registryPath = path.join(temporary, 'registry.json');
  const repositoryId = 'repo_process_fixture';
  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 'jarvos-coding-repository-registry/v1', generation: 1,
    repositories: [{ repositoryId, publicLabel: 'Process fixture', agentSelectable: true, root: repository, stateRoot, worktreePolicy: { root: worktreeRoot },
      tracker: { kind: 'fixture' }, acceptancePolicy: { mode: 'human-evidence-required' }, providerEgressPolicy: {}, credentialReferences: {}, learning: { enabled: true }, learningPublicationTarget: 'fixture:learning' }],
  }), { mode: 0o600 });
  fs.chmodSync(registryPath, 0o600);
  const script = path.join(PACKAGE_ROOT, 'scripts', 'jarvos-coding-mcp.js');
  const planDigest = 'b'.repeat(64);
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jarvos_coding_plan', arguments: { repositoryId, subjectKey: 'PROCESS-1', input: { kind: 'issue', digest: planDigest } } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'jarvos_coding_accept_plan', arguments: { repositoryId, subjectKey: 'PROCESS-1', planDigest, packet: { version: 'jarvos-implementation-packet/v1', planDigest, steps: [{ id: 'step_01', description: 'Apply the bounded fixture change.' }] }, artifact: { reference: 'artifact:plan_process_001' } } } },
  ];
  const result = spawnSync(process.execPath, [script], {
    cwd: temporary,
    env: { ...process.env, JARVOS_CODING_REPOSITORY_REGISTRY: registryPath },
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const replies = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  const planned = JSON.parse(byId.get(1).result.content[0].text);
  assert.equal(planned.status, 'succeeded');
  assert.equal(planned.route, 'native-fallback');
  const denied = JSON.parse(byId.get(2).result.content[0].text);
  assert.equal(denied.status, 'awaiting-plan-acceptance');
  assert.equal(byId.get(2).result.isError, true);
});
