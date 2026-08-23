'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { checkRuntime, listRuntimeManifests, validateManifest } = require('../src/index.js');
const { CANONICAL_HARNESS_IDS } = require('../src/managed-activation.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ADAPTER = path.join(ROOT, 'runtimes/grok-bot/adapter.json');
const GATEWAY = path.join(ROOT, 'modules/jarvos-agent-context/scripts/jarvos-mcp-http.js');

test('grok-bot adapter is listed and satisfies the runtime contract', () => {
  const manifests = listRuntimeManifests(ROOT);
  const paths = manifests.map((item) => typeof item === 'string' ? item : (item.path || item.manifest || ''));
  assert.ok(paths.some((item) => String(item).replace(/\\/g, '/').includes('runtimes/grok-bot/adapter.json')));
  const manifest = JSON.parse(fs.readFileSync(ADAPTER, 'utf8'));
  assert.equal(manifest.id, 'grok-bot');
  assert.equal(CANONICAL_HARNESS_IDS.has('grok-bot'), false);
  assert.equal(manifest.managedActivation, undefined);
  assert.equal(manifest.skillProjection, undefined);
  assert.equal(manifest.targets[0].id, 'grok-bot-http');
  assert.equal(manifest.targets[0].mcp.transport, 'http');
  assert.equal(manifest.targets[0].hydration.mode, 'manual');
  assert.equal(manifest.capabilityDescriptor.capabilities.context.startupHydration.status, 'unsupported');
  assert.match(manifest.targets[0].mcp.registration, /Do not register stdio MCP on the Grok Bot disk/);
  const validated = validateManifest(manifest);
  assert.equal(validated.ok, true, validated.errors.join('\n'));
  const checked = checkRuntime(ADAPTER, { root: ROOT });
  assert.equal(checked.ok, true, checked.errors.join('\n'));
});

test('grok-bot docs refuse stdio-on-the-box and require remote HTTP', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'runtimes/grok-bot/README.md'), 'utf8');
  const setup = fs.readFileSync(path.join(ROOT, 'runtimes/grok-bot/setup.sh'), 'utf8');
  for (const text of [readme, setup]) {
    assert.match(text, /vault/i);
    assert.match(text, /URL/);
    assert.match(text, /token/i);
    assert.match(text, /http/i);
    assert.doesNotMatch(text, /claude mcp add --scope user jarvos -- node/);
    assert.match(text, /stdio/i);
    assert.match(text, /wrong machine|separate computer|Do not register/i);
  }
  assert.match(readme, /boot_jarvos/);
  assert.match(readme, /jarvos_hydrate/);
  assert.match(readme, /grok-bot-http/);
  assert.match(readme, /fail open|unreachable/i);
});

test('HTTP/SSE gateway fails closed without a token and rejects bad auth', async () => {
  const missing = spawnSync(process.execPath, [GATEWAY], {
    encoding: 'utf8',
    env: { ...process.env, JARVOS_MCP_HTTP_TOKEN: '', JARVOS_MCP_HTTP_TOKEN_FILE: '' },
    timeout: 5000,
  });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stderr}${missing.stdout}`, /fail-closed|refusing to start/i);

  const token = 'grok-bot-test-token-32chars-min';
  const gateway = require(GATEWAY);
  const bridge = {
    sseClients: new Set(),
    send: async (message) => ({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'jarvos' } } }),
  };
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, bridge });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  try {
    const denied = await httpRequest({ port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' });
    assert.equal(denied.status, 401);

    const ok = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).result.protocolVersion, '2024-11-05');

    const sse = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }, (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes('event: endpoint')) {
            res.destroy();
            resolve({ status: res.statusCode, body });
          }
        });
      });
      req.on('error', (error) => {
        if (error.code === 'ECONNRESET') return;
        reject(error);
      });
      req.end();
    });
    assert.equal(sse.status, 200);
    assert.match(sse.body, /event: endpoint/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public grok-bot tests do not call a live Grok Bot host', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(self, /api\.x\.ai|grok\.x\.ai|cloudagent/i);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-grok-bot-'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function httpRequest({ port, path: urlPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
