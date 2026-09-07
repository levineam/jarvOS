'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

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
    send: async (message) => ({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'jarvos' } } }),
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
    assert.equal(JSON.parse(ok.body).result.protocolVersion, '2025-06-18');
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
    assert.equal(JSON.parse(a.body).result.protocolVersion, '2025-06-18');
    assert.equal(JSON.parse(b.body).result.protocolVersion, '2025-06-18');
    assert.notEqual(a.headers['mcp-session-id'], b.headers['mcp-session-id']);
    assert.deepEqual(new Set([tagA, tagB]), new Set(['A', 'B']));
  } finally {
    await disposeServer(server);
  }
});

test('timed-out child replies are tombstoned and not SSE-broadcast', async () => {
  const gateway = require(GATEWAY);
  const fake = writeFakeMcp();
  const token = 'grok-bot-test-token-32chars-min';
  const createBridge = () => gateway.startStdioBridge({ args: [fake], restart: false, env: process.env });
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, createBridge, requestTimeoutMs: 700 });
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
    await disposeServer(server);
  }
});

test('health reports child death after a live stdio session exits', async () => {
  const gateway = require(GATEWAY);
  const fake = writeFakeMcp();
  const token = 'grok-bot-test-token-32chars-min';
  const createBridge = () => gateway.startStdioBridge({ args: [fake], restart: false, env: process.env });
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, createBridge, maxSessions: 1 });
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
    const replacement = await httpRequest({
      port,
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}',
    });
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.headers['mcp-session-id'], sessionId);
  } finally {
    await disposeServer(server);
  }
});

test('gateway gives same-client-id retries distinct child ids and ignores the late first reply', async () => {
  const gateway = require(GATEWAY);
  const child = fakeChild();
  const childIds = [];
  const responseOrder = [];
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.trim().split('\n')) {
      if (!line) continue;
      const message = JSON.parse(line);
      childIds.push(message.id);
      const isFirst = childIds.length === 1;
      setTimeout(() => {
        responseOrder.push(isFirst ? 'first' : 'second');
        child.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { tag: isFirst ? 'first-late' : 'second-early' },
        })}\n`);
      }, isFirst ? 80 : 5);
    }
  });
  const bridge = gateway.startStdioBridge({ spawn: () => child, restart: false, tombstoneTtlMs: 20 });
  try {
    await assert.rejects(
      bridge.send({ jsonrpc: '2.0', id: 9, method: 'retry', params: {} }, 20),
      /timed out/,
    );
    const retry = await bridge.send({ jsonrpc: '2.0', id: 9, method: 'retry', params: {} }, 120);
    assert.equal(retry.id, 9);
    assert.equal(retry.result.tag, 'second-early');
    assert.notEqual(childIds[0], childIds[1]);
    await delay(100);
    assert.deepEqual(responseOrder, ['second', 'first']);
  } finally {
    bridge.dispose();
  }
});

test('tombstones expire without later child output', async () => {
  const gateway = require(GATEWAY);
  const child = fakeChild();
  const bridge = gateway.startStdioBridge({ spawn: () => child, restart: false, tombstoneTtlMs: 20 });
  try {
    await assert.rejects(
      bridge.send({ jsonrpc: '2.0', id: 9, method: 'never-reply', params: {} }, 5),
      /timed out/,
    );
    assert.equal(bridge.health().tombstones, 1);
    await delay(30);
    assert.equal(bridge.health().tombstones, 0);
  } finally {
    bridge.dispose();
  }
});

test('gateway routes notifications and child server requests to one SSE stream', () => {
  const gateway = require(GATEWAY);
  const child = fakeChild();
  const bridge = gateway.startStdioBridge({ spawn: () => child, restart: false });
  const firstStream = { messages: [], write(value) { this.messages.push(value); } };
  const secondStream = { messages: [], write(value) { this.messages.push(value); } };
  bridge.sseClients.add(firstStream);
  bridge.sseClients.add(secondStream);
  try {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n`);
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'child-request-1', method: 'roots/list', params: {} })}\n`);
    const messages = [...firstStream.messages, ...secondStream.messages];
    assert.equal(messages.length, 2);
    assert.equal(firstStream.messages.length, 0);
    assert.equal(secondStream.messages.length, 2);
    assert.ok(messages.some((message) => message.includes('child-request-1')));
    assert.ok(messages.some((message) => message.includes('roots/list')));

    let activityCount = 0;
    const stalledStream = {
      messages: [],
      destroyedByPolicy: false,
      write(value) { this.messages.push(value); return false; },
      destroy() { this.destroyedByPolicy = true; },
    };
    bridge.sseClients.clear();
    bridge.sseClients.add(stalledStream);
    bridge.setSseActivityHandler(() => { activityCount += 1; });
    child.stdout.write('{"jsonrpc":"2.0","method":"notifications/stalled"}\n');
    child.stdout.write('{"jsonrpc":"2.0","method":"notifications/after-stall"}\n');
    assert.equal(stalledStream.destroyedByPolicy, true);
    assert.equal(stalledStream.messages.length, 1);
    assert.equal(bridge.sseClients.size, 0);
    assert.equal(activityCount, 0);
  } finally {
    bridge.dispose();
  }
});

test('server-initiated requests round-trip through live SSE and HTTP', async () => {
  const gateway = require(GATEWAY);
  const token = 'grok-bot-test-token-32chars-min';
  const child = fakeChild();
  const childMessages = [];
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.trim().split('\n')) {
      if (!line) continue;
      const message = JSON.parse(line);
      childMessages.push(message);
      if (message.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18' },
        })}\n`);
      }
    }
  });
  const bridge = gateway.startStdioBridge({ spawn: () => child, restart: false });
  const server = gateway.createServer({
    token, host: '127.0.0.1', port: 0, bridge, requestTimeoutMs: 50, idleSessionMs: 60,
  });
  await listen(server);
  const { port } = server.address();
  let sseRequest;
  try {
    const common = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const initialized = await httpRequest({
      port, path: '/mcp', method: 'POST', headers: common,
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers['mcp-session-id'];

    let resolveConnected;
    let resolveServerRequest;
    const connected = new Promise((resolve) => { resolveConnected = resolve; });
    const serverRequest = new Promise((resolve) => { resolveServerRequest = resolve; });
    sseRequest = http.request({
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
        if (body.includes(': connected')) resolveConnected();
        if (body.includes('"method":"roots/list"')) resolveServerRequest(body);
      });
    });
    sseRequest.on('error', () => {});
    sseRequest.end();
    await Promise.race([connected, delay(1000).then(() => { throw new Error('SSE did not connect'); })]);
    await delay(40);
    child.stdout.write('{"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n');
    await delay(40);
    assert.equal(server.sessions.size, 1);

    child.stdout.write('{"jsonrpc":"2.0","id":"child-request-1","method":"roots/list","params":{}}\n');
    const sseBody = await Promise.race([serverRequest, delay(1000).then(() => { throw new Error('server request was not delivered'); })]);
    assert.match(sseBody, /"id":"child-request-1"/);

    const forwarded = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      body: '{"jsonrpc":"2.0","id":"child-request-1","result":{"roots":[]}}',
    });
    assert.equal(forwarded.status, 202);
    assert.deepEqual(childMessages.at(-1), {
      jsonrpc: '2.0', id: 'child-request-1', result: { roots: [] },
    });

    child.stdin.write = (_chunk, callback) => {
      process.nextTick(() => callback(new Error('async child write failed')));
      return true;
    };
    const failedForward = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      body: '{"jsonrpc":"2.0","id":"child-request-2","result":{"roots":[]}}',
    });
    assert.equal(failedForward.status, 502);

    child.stdin.write = () => true;
    const stalledForward = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      body: '{"jsonrpc":"2.0","id":"child-request-3","result":{"roots":[]}}',
    });
    assert.equal(stalledForward.status, 502);
    assert.match(stalledForward.body, /write timed out/);

    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      delay(1000).then(() => { throw new Error('server close hung on active SSE'); }),
    ]);
    assert.equal(child.killed, true);
  } finally {
    sseRequest?.destroy();
    if (server.listening) await disposeServer(server);
  }
});

test('stdio bridge handles child process errors without uncaught failure', async () => {
  const gateway = require(GATEWAY);
  const child = fakeChild();
  const bridge = gateway.startStdioBridge({ spawn: () => child, restart: false });
  try {
    assert.doesNotThrow(() => child.emit('error', new Error('spawn failed')));
    assert.equal(bridge.alive, false);
    await assert.rejects(bridge.send({ jsonrpc: '2.0', id: 1, method: 'x' }, 10), /not alive/);
  } finally {
    bridge.dispose();
  }
});

test('a child error followed by exit schedules only one bridge restart', async () => {
  const gateway = require(GATEWAY);
  const first = fakeChild();
  const second = fakeChild();
  let spawned = 0;
  const bridge = gateway.startStdioBridge({
    spawn: () => (spawned += 1) === 1 ? first : second,
    backoffMs: 5,
    restart: true,
  });
  try {
    first.emit('error', new Error('spawn failed'));
    first.emit('exit', 1);
    await delay(25);
    assert.equal(spawned, 2);
    const stream = { messages: [], write(value) { this.messages.push(value); } };
    bridge.sseClients.add(stream);
    first.stdout.write('{"jsonrpc":"2.0","method":"notifications/stale"}\n');
    second.stdout.write('{"jsonrpc":"2.0","method":"notifications/current"}\n');
    assert.equal(stream.messages.length, 1);
    assert.match(stream.messages[0], /notifications\/current/);
  } finally {
    bridge.dispose();
  }
});

test('gateway validates origin and protocol before session work, bounds idle sessions, and accepts client responses', async () => {
  const gateway = require(GATEWAY);
  const token = 'grok-bot-test-token-32chars-min';
  const bridges = [];
  const createBridge = () => {
    const bridge = {
      sseClients: new Set(),
      sent: [],
      disposed: false,
      send: async (message) => ({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }),
      post: async (message) => {
        if (message.id === 78) throw new Error('child unavailable');
        bridge.sent.push(message);
      },
      dispose: () => {
        bridge.disposed = true;
        for (const client of bridge.sseClients) client.end();
        bridge.sseClients.clear();
      },
      health: () => ({ alive: true, restarts: 0 }),
    };
    bridges.push(bridge);
    return bridge;
  };
  const server = gateway.createServer({
    token,
    host: '127.0.0.1',
    port: 0,
    createBridge,
    maxSessions: 1,
    idleSessionMs: 30,
    supportedProtocolVersions: ['2025-06-18'],
  });
  await listen(server);
  const { port } = server.address();
  let idleSseRequest;
  try {
    const common = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const originDenied = await httpRequest({
      port, path: '/mcp', method: 'POST', headers: { ...common, origin: 'https://evil.example' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(originDenied.status, 403);
    assert.equal(bridges.length, 0);

    const badVersion = await httpRequest({
      port, path: '/mcp', method: 'POST', headers: { ...common, 'mcp-protocol-version': '2099-01-01' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(badVersion.status, 400);
    assert.equal(bridges.length, 0);

    const initialized = await httpRequest({
      port, path: '/mcp', method: 'POST', headers: { ...common, origin: `http://127.0.0.1:${port}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers['mcp-session-id'];
    assert.equal(bridges.length, 1);

    const response = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, 'mcp-session-id': sessionId },
      body: '{"jsonrpc":"2.0","id":77,"result":{"ok":true}}',
    });
    assert.equal(response.status, 202);
    assert.equal(response.body, '');
    assert.deepEqual(bridges[0].sent, [{ jsonrpc: '2.0', id: 77, result: { ok: true } }]);

    const responseFailure = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, 'mcp-session-id': sessionId },
      body: '{"jsonrpc":"2.0","id":78,"result":{"ok":true}}',
    });
    assert.equal(responseFailure.status, 502);

    let resolveIdleSse;
    const idleSseConnected = new Promise((resolve) => { resolveIdleSse = resolve; });
    idleSseRequest = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': sessionId },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (chunk.includes(': connected')) resolveIdleSse();
      });
    });
    idleSseRequest.on('error', () => {});
    idleSseRequest.end();
    await Promise.race([idleSseConnected, delay(1000).then(() => { throw new Error('idle SSE did not connect'); })]);

    const admissionDenied = await httpRequest({
      port, path: '/mcp', method: 'POST', headers: common,
      body: '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}',
    });
    assert.equal(admissionDenied.status, 429);
    await delay(45);
    const reinitialized = await httpRequest({
      port, path: '/mcp', method: 'POST', headers: common,
      body: '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}',
    });
    assert.equal(reinitialized.status, 200);
    assert.equal(bridges[0].disposed, true);
  } finally {
    idleSseRequest?.destroy();
    await disposeServer(server);
  }
});

test('gateway records the initialization result protocol and requires exact local origins', async () => {
  const gateway = require(GATEWAY);
  const token = 'grok-bot-test-token-32chars-min';
  const bridge = {
    sseClients: new Set(),
    send: async (message) => message.method === 'initialize'
      ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }
      : { jsonrpc: '2.0', id: message.id, result: {} },
    dispose() {},
    health: () => ({ alive: true, restarts: 0 }),
  };
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, bridge });
  await listen(server);
  const { port } = server.address();
  try {
    const common = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const wrongPortOrigin = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, origin: `http://127.0.0.1:${port + 1}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(wrongPortOrigin.status, 403);

    const initialized = await httpRequest({
      port, path: '/mcp', method: 'POST', headers: common,
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers['mcp-session-id'];
    const wrongVersion = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' },
      body: '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    });
    assert.equal(wrongVersion.status, 400);
    const negotiatedVersion = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { ...common, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-06-18' },
      body: '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}',
    });
    assert.equal(negotiatedVersion.status, 200);
  } finally {
    await disposeServer(server);
  }
});

test('gateway safely rejects malformed Host and disposes a failed initialization', async () => {
  const gateway = require(GATEWAY);
  const token = 'grok-bot-test-token-32chars-min';
  let disposed = false;
  const bridge = {
    sseClients: new Set(),
    send: async () => { throw new Error('initialization failed'); },
    dispose: () => { disposed = true; },
    health: () => ({ alive: true, restarts: 0 }),
  };
  const server = gateway.createServer({
    token,
    host: '127.0.0.1',
    port: 0,
    bridge,
    requestTimeoutMs: 20,
  });
  await listen(server);
  const { port } = server.address();
  try {
    const malformedHost = {
      status: null,
      writeHead(status) { this.status = status; },
      end() {},
    };
    server.emit('request', { headers: { host: '[' }, url: '/health', method: 'GET' }, malformedHost);
    assert.equal(malformedHost.status, 400);

    const failed = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(failed.status, 504);
    assert.equal(failed.headers['mcp-session-id'], undefined);
    assert.equal(server.sessions.size, 0);
    assert.equal(disposed, true);
  } finally {
    await disposeServer(server);
  }
});

test('gateway rejects and disposes an initialization that negotiates an unsupported version', async () => {
  const gateway = require(GATEWAY);
  const token = 'grok-bot-test-token-32chars-min';
  let disposed = false;
  const bridge = {
    sseClients: new Set(),
    send: async (message) => ({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2099-01-01' } }),
    dispose: () => { disposed = true; },
    health: () => ({ alive: true, restarts: 0 }),
  };
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, bridge });
  await listen(server);
  const { port } = server.address();
  try {
    const response = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(response.status, 502);
    assert.equal(response.headers['mcp-session-id'], undefined);
    assert.equal(server.sessions.size, 0);
    assert.equal(disposed, true);
  } finally {
    await disposeServer(server);
  }
});

test('closing the gateway disposes every active session bridge', async () => {
  const gateway = require(GATEWAY);
  const token = 'grok-bot-test-token-32chars-min';
  let disposed = false;
  const bridge = {
    sseClients: new Set(),
    send: async (message) => ({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }),
    dispose: () => {
      disposed = true;
      for (const client of bridge.sseClients) client.end();
      bridge.sseClients.clear();
    },
    health: () => ({ alive: true, restarts: 0 }),
  };
  const server = gateway.createServer({ token, host: '127.0.0.1', port: 0, bridge });
  await listen(server);
  const { port } = server.address();
  try {
    const initialized = await httpRequest({
      port, path: '/mcp', method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    });
    assert.equal(initialized.status, 200);
    assert.equal(server.sessions.size, 1);
    let resolveConnected;
    const connected = new Promise((resolve) => { resolveConnected = resolve; });
    const sseRequest = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'mcp-session-id': initialized.headers['mcp-session-id'] },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (chunk.includes(': connected')) resolveConnected();
      });
    });
    sseRequest.on('error', () => {});
    sseRequest.end();
    await Promise.race([connected, delay(1000).then(() => { throw new Error('SSE did not connect'); })]);
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      delay(1000).then(() => { throw new Error('server close hung on active SSE'); }),
    ]);
    assert.equal(disposed, true);
    assert.equal(server.sessions.size, 0);
  } finally {
    if (server.listening) await disposeServer(server);
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
      }, 1000);
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tag: process.env.FAKE_TAG || 'ok',
        ...(msg.method === 'initialize' ? { protocolVersion: msg.params.protocolVersion } : {}),
      },
    }) + '\\n');
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

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = process.pid;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function disposeServer(server) {
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
