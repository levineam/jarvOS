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
  assert.match(readme, /JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK/);
  assert.match(readme, /ssh -L|tunnel/i);
  assert.match(readme, /full MCP surface|all registered tools/i);
  assert.doesNotMatch(setup, /Bearer \$\{|Bearer \$\(cat/);
});

test('HTTP gateway fails closed without a token and rejects bad auth', async () => {
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
    health: () => ({ alive: true, restarts: 0 }),
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
    assert.ok(ok.headers['mcp-session-id']);
    assert.doesNotMatch(ok.body, /event: endpoint/);

    const scalar = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '5',
    });
    assert.equal(scalar.status, 400);

    const nulled = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'null',
    });
    assert.equal(nulled.status, 400);

    const sessionId = ok.headers['mcp-session-id'];
    const sse = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': sessionId },
      }, (res) => {
        res.setEncoding('utf8');
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes(': connected')) {
            res.destroy();
            resolve({ status: res.statusCode, body, headers: res.headers });
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
    assert.doesNotMatch(sse.body, /event: endpoint/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('public grok-bot tests do not call a live Grok Bot host', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  const banned = new RegExp(['api\\.x\\.ai', 'grok\\.x\\.ai', 'clou' + 'dagent'].join('|'), 'i');
  assert.doesNotMatch(self, banned);
});

test('stdio bridge isolates JSON-RPC ids across MCP sessions', async () => {
  const gateway = require(GATEWAY);
  const fake = writeFakeMcp();
  let tags = 0;
  const token = 'grok-bot-test-token-32chars-min';
  const createBridge = () => {
    tags += 1;
    const tag = tags === 1 ? 'A' : 'B';
    return gateway.startStdioBridge({
      args: [fake],
      restart: false,
      env: { ...process.env, FAKE_TAG: tag },
    });
  };
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, createBridge, requestTimeoutMs: 3000 });
  await listen(server);
  const { port } = server.address();
  try {
    const [a, b] = await Promise.all([
      httpRequest({
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      }),
      httpRequest({
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const tagA = JSON.parse(a.body).result.tag;
    const tagB = JSON.parse(b.body).result.tag;
    assert.notEqual(a.headers['mcp-session-id'], b.headers['mcp-session-id']);
    assert.deepEqual(new Set([tagA, tagB]), new Set(['A', 'B']));
  } finally {
    disposeServer(server);
  }
});

test('timed-out child replies are tombstoned and not SSE-broadcast', async () => {
  const gateway = require(GATEWAY);
  const fake = writeFakeMcp();
  const token = 'grok-bot-test-token-32chars-min';
  const createBridge = () => gateway.startStdioBridge({ args: [fake], restart: false, env: process.env });
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, createBridge, requestTimeoutMs: 80 });
  await listen(server);
  const { port } = server.address();
  try {
    const init = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    const sessionId = init.headers['mcp-session-id'];
    const sseBody = { text: '' };
    const sseReq = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': sessionId },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { sseBody.text += chunk; });
    });
    sseReq.on('error', () => {});
    sseReq.end();
    await delay(50);

    const timed = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'mcp-session-id': sessionId,
      },
      body: '{"jsonrpc":"2.0","id":9,"method":"slow","params":{}}',
    });
    assert.equal(timed.status, 504);
    await delay(500);
    assert.doesNotMatch(sseBody.text, /SENSITIVE-VAULT-CONTENT/);
    assert.doesNotMatch(sseBody.text, /"id":9/);
    sseReq.destroy();
  } finally {
    disposeServer(server);
  }
});

test('health reports child death after a live stdio session exits', async () => {
  const gateway = require(GATEWAY);
  const fake = writeFakeMcp();
  const token = 'grok-bot-test-token-32chars-min';
  const createBridge = () => gateway.startStdioBridge({ args: [fake], restart: false, env: process.env });
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, createBridge });
  await listen(server);
  const { port } = server.address();
  try {
    const before = await httpRequest({ port, path: '/health', method: 'GET', headers: {} });
    assert.equal(before.status, 200);
    assert.equal(JSON.parse(before.body).ok, true);

    const init = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(init.status, 200);
    const sessionId = init.headers['mcp-session-id'];
    const die = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'mcp-session-id': sessionId,
      },
      body: '{"jsonrpc":"2.0","id":2,"method":"die","params":{}}',
    });
    assert.equal(die.status, 504);
    await delay(150);
    const after = await httpRequest({ port, path: '/health', method: 'GET', headers: {} });
    assert.equal(after.status, 503);
    const payload = JSON.parse(after.body);
    assert.equal(payload.ok, false);
    assert.equal(payload.childDead, 1);
    assert.equal(payload.childAlive, 0);
  } finally {
    disposeServer(server);
  }
});

function writeFakeMcp() {
  const file = path.join(os.tmpdir(), `jarvos-fake-mcp-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(file, `'use strict';
process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'die') {
      process.exit(1);
    }
    if (msg.method === 'slow') {
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tag: 'SENSITIVE-VAULT-CONTENT' } }) + '\\n');
      }, 400);
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tag: process.env.FAKE_TAG || 'ok' } }) + '\\n');
  }
});
`);
  return file;
}

function listen(server) {
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function disposeServer(server) {
  for (const bridge of server.sessions ? server.sessions.values() : []) {
    if (bridge && typeof bridge.dispose === 'function') bridge.dispose();
  }
  return new Promise((resolve) => server.close(resolve));
}

function httpRequest({ port, path: urlPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
