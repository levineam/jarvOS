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

const { checkRuntime, validateManifest } = require('../src/index.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ADAPTER = path.join(ROOT, 'runtimes/muse/adapter.json');
const MUSE_GATEWAY = path.join(ROOT, 'runtimes/muse/gateway.js');
const gateway = require(path.join(ROOT, 'modules/jarvos-agent-context/scripts/jarvos-mcp-http.js'));
const muse = require(MUSE_GATEWAY);

const TOKEN = 'muse-readonly-test-token-32chars';
const ALLOWED = ['jarvos_hydrate', 'jarvos_projects_context', 'jarvos_recall', 'jarvos_startup_brief'];

function childReply(message) {
  if (message.id == null) return null;
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: 'jarvos' },
        instructions: 'call jarvos_create_note',
      },
    };
  }
  if (message.method === 'tools/list') {
    const open = { type: 'object', properties: { config: { type: 'string' }, seeds: { type: 'array' } } };
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: ['jarvos_hydrate', 'jarvos_create_note', 'jarvos_recall', 'jarvos_control_plane', 'jarvos_startup_brief',
          'jarvos_session_thread_write', 'jarvos_projects_context', 'jarvos_shared_skills']
          .map((name) => ({ name, description: `${name} description`, inputSchema: open })),
      },
    };
  }
  return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } };
}

function fakeBridge() {
  const bridge = {
    sseClients: new Set(),
    sent: [],
    raw: [],
    posted: [],
    send: async (message) => {
      bridge.raw.push(message);
      bridge.sent.push(JSON.parse(JSON.stringify(message)));
      return childReply(message);
    },
    post: async (message) => { bridge.posted.push(message); },
    health: () => ({ alive: true, restarts: 0 }),
  };
  return bridge;
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.received = [];
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      child.received.push(message);
      if (message.id == null) continue;
      // Child-originated traffic that must never reach the client.
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'child-req-1', method: 'sampling/createMessage', params: { leak: 'backchannel-leak' } })}\n`);
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'backchannel-leak' } })}\n`);
      child.stdout.write(`${JSON.stringify(childReply(message))}\n`);
    }
  });
  return child;
}

async function startServer(options) {
  const server = gateway.createServer({ token: TOKEN, host: '127.0.0.1', port: 0, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpRequest(port, { method = 'POST', body, session, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method,
      agent: false,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        ...(session ? { 'mcp-session-id': session } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function openSse(port, session) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'GET',
      agent: false,
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'mcp-session-id': session },
    }, (res) => {
      res.setEncoding('utf8');
      res.once('data', () => {
        resolve({ status: res.statusCode, headers: res.headers });
        res.destroy();
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function initialize(port, params = { protocolVersion: '2025-06-18', clientInfo: { name: 'muse', version: '1.0' } }) {
  const response = await httpRequest(port, { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params } });
  assert.equal(response.status, 200, response.body);
  return { response, session: response.headers['mcp-session-id'] };
}

function toolCall(id, name, args) {
  const params = { name };
  if (args !== undefined) params.arguments = args;
  return { jsonrpc: '2.0', id, method: 'tools/call', params };
}

test('read-only initialize, ping and tools/list expose only the four allowlisted tools', async () => {
  const bridge = fakeBridge();
  const { server, port } = await startServer({ bridge, readOnly: true });
  try {
    const { response, session } = await initialize(port, {
      protocolVersion: '2025-06-18',
      capabilities: { sampling: {}, roots: { listChanged: true } },
      clientInfo: { name: 'muse', version: '1.0', extra: 'dropped' },
      _meta: { progressToken: 1 },
    });
    assert.ok(session);
    assert.deepEqual(response.json.result.capabilities, { tools: {} });
    assert.equal(response.json.result.instructions, undefined);
    assert.deepEqual(bridge.sent[0].params, {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'muse', version: '1.0' },
    });

    const initialized = await httpRequest(port, { session, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    assert.equal(initialized.status, 202);
    assert.deepEqual(bridge.sent[1], { jsonrpc: '2.0', method: 'notifications/initialized' });

    const initializedWithId = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 2, method: 'notifications/initialized' } });
    assert.equal(initializedWithId.json.error.code, -32601);
    assert.equal(bridge.sent.length, 2);

    const ping = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 3, method: 'ping' } });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json, { jsonrpc: '2.0', id: 3, result: {} });
    assert.equal(bridge.sent.length, 2);

    const list = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 4, method: 'tools/list' } });
    assert.equal(list.status, 200);
    const tools = list.json.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ALLOWED);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.inputSchema.properties.config, undefined);
      assert.equal(tool.inputSchema.properties.seeds, undefined);
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
    assert.deepEqual(Object.keys(byName.jarvos_hydrate.properties), ['maxChars']);
    assert.deepEqual(Object.keys(byName.jarvos_startup_brief.properties), ['query', 'maxChars']);
    assert.deepEqual(Object.keys(byName.jarvos_recall.properties), ['query', 'includeQmd', 'autoGraph']);
    assert.deepEqual(byName.jarvos_recall.required, ['query']);
    assert.deepEqual(Object.keys(byName.jarvos_projects_context.properties), ['profile', 'date', 'timeZone', 'from', 'to']);

    const cursor = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { cursor: 'x' } } });
    assert.equal(cursor.json.error.code, -32602);
    assert.equal(bridge.sent.length, 3);
  } finally {
    await closeServer(server);
  }
});

test('read-only denies other methods, notifications, client responses and GET without forwarding', async () => {
  const bridge = fakeBridge();
  const { server, port } = await startServer({ bridge, readOnly: true });
  try {
    const { session } = await initialize(port);
    const baseline = bridge.sent.length;

    for (const method of ['prompts/list', 'prompts/get', 'resources/list', 'resources/read', 'resources/templates/list',
      'completion/complete', 'logging/setLevel', 'sampling/createMessage', 'unknown/method']) {
      const denied = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 10, method, params: { name: 'boot_jarvos' } } });
      assert.equal(denied.json.error.code, -32601, method);
    }
    for (const method of ['notifications/cancelled', 'notifications/roots/list_changed', 'notifications/progress']) {
      const denied = await httpRequest(port, { session, body: { jsonrpc: '2.0', method, params: { requestId: 1 } } });
      assert.equal(denied.status, 400, method);
    }
    const clientResponse = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 'child-req-1', result: { ok: true } } });
    assert.equal(clientResponse.status, 400);
    assert.equal(clientResponse.json.error.code, -32600);

    const noId = await httpRequest(port, { session, body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'jarvos_hydrate', arguments: {} } } });
    assert.equal(noId.status, 400);
    const nullId = await httpRequest(port, { session, body: { ...toolCall(null, 'jarvos_hydrate', {}) } });
    assert.equal(nullId.status, 400);
    const meta = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'jarvos_hydrate', arguments: {}, _meta: { progressToken: 'p' } } } });
    assert.equal(meta.json.error.code, -32602);
    const extraTopLevel = await httpRequest(port, { session, body: { ...toolCall(12, 'jarvos_hydrate', {}), extra: true } });
    assert.equal(extraTopLevel.status, 400);
    const batch = await httpRequest(port, { session, body: [toolCall(13, 'jarvos_hydrate', {})] });
    assert.equal(batch.status, 400);

    for (const name of ['jarvos_create_note', 'jarvos_session_thread_write', 'jarvos_session_thread_read', 'jarvos_control_plane',
      'jarvos_shared_skills', 'jarvos_synthesize', 'constructor', '__proto__']) {
      const denied = await httpRequest(port, { session, body: toolCall(14, name, {}) });
      assert.equal(denied.json.error.code, -32602, name);
    }

    const get = await httpRequest(port, { method: 'GET', session, headers: { accept: 'text/event-stream' } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.allow, 'POST, DELETE');
    assert.equal(bridge.sseClients.size, 0);

    assert.equal(bridge.sent.length, baseline);
    assert.equal(bridge.posted.length, 0);

    const deleted = await httpRequest(port, { method: 'DELETE', session });
    assert.equal(deleted.status, 204);
  } finally {
    await closeServer(server);
  }
});

test('read-only rejects argument injection and forwards only allowlisted keys', async () => {
  const bridge = fakeBridge();
  const { server, port } = await startServer({ bridge, readOnly: true });
  try {
    const { session } = await initialize(port);
    const baseline = bridge.sent.length;
    const invalid = [
      ['jarvos_hydrate', { config: '/tmp/config.json' }],
      ['jarvos_hydrate', { maxChars: 0 }],
      ['jarvos_hydrate', { maxChars: 20001 }],
      ['jarvos_hydrate', { maxChars: 1.5 }],
      ['jarvos_hydrate', { maxChars: '100' }],
      ['jarvos_hydrate', { maxItems: 5 }],
      ['jarvos_hydrate', { includeAllAgents: true }],
      ['jarvos_hydrate', { statuses: ['todo'] }],
      ['jarvos_hydrate', null],
      ['jarvos_hydrate', []],
      ['jarvos_hydrate', 'maxChars=5'],
      ['jarvos_recall', {}],
      ['jarvos_recall', { query: '' }],
      ['jarvos_recall', { query: 'x'.repeat(2001) }],
      ['jarvos_recall', { query: 'a\u0000b' }],
      ['jarvos_recall', { query: { nested: true } }],
      ['jarvos_recall', { query: 'x', synthesize: true }],
      ['jarvos_recall', { query: 'x', mode: 'synthesis' }],
      ['jarvos_recall', { query: 'x', seeds: ['people/a'] }],
      ['jarvos_recall', { query: 'x', config: 'SECRET-VALUE-123' }],
      ['jarvos_recall', { query: 'x', provider: 'p' }],
      ['jarvos_recall', { query: 'x', command: 'rm -rf /' }],
      ['jarvos_recall', { query: 'x', path: '/etc/passwd' }],
      ['jarvos_recall', { query: 'x', serverPath: '/tmp/evil.js' }],
      ['jarvos_recall', { query: 'x', constructor: 'y' }],
      ['jarvos_recall', { query: 'x', includeQmd: 'true' }],
      ['jarvos_startup_brief', { maxItems: 3 }],
      ['jarvos_startup_brief', { query: 'x', maxChars: -1 }],
      ['jarvos_projects_context', { profile: 'all' }],
      ['jarvos_projects_context', { date: '2026-9-1' }],
      ['jarvos_projects_context', { timeZone: '../etc/passwd' }],
      ['jarvos_projects_context', { from: 'yesterday' }],
      ['jarvos_projects_context', { to: '2026-01-01T00:00:00+01:00' }],
      ['jarvos_projects_context', { profile: 'orientation', extra: { nested: true } }],
    ];
    for (const [name, args] of invalid) {
      const denied = await httpRequest(port, { session, body: toolCall(20, name, args) });
      assert.equal(denied.json.error.code, -32602, `${name} ${JSON.stringify(args)}`);
      assert.doesNotMatch(denied.body, /SECRET-VALUE-123/);
    }
    const proto = await httpRequest(port, {
      session,
      body: '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"jarvos_recall","arguments":{"query":"x","__proto__":{"polluted":true}}}}',
    });
    assert.equal(proto.json.error.code, -32602);
    assert.equal({}.polluted, undefined);
    assert.equal(bridge.sent.length, baseline);

    const recall = await httpRequest(port, { session, body: toolCall(22, 'jarvos_recall', { query: 'hello', includeQmd: true, autoGraph: false }) });
    assert.equal(recall.status, 200);
    assert.deepEqual(recall.json.result.content, [{ type: 'text', text: 'ok' }]);
    const forwarded = bridge.sent.at(-1);
    assert.deepEqual(forwarded, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: { name: 'jarvos_recall', arguments: { query: 'hello', includeQmd: true, autoGraph: false } },
    });
    assert.equal(Object.getPrototypeOf(bridge.raw.at(-1).params.arguments), null);

    await httpRequest(port, { session, body: toolCall(23, 'jarvos_hydrate') });
    assert.deepEqual(bridge.sent.at(-1).params, { name: 'jarvos_hydrate', arguments: {} });

    const projectArgs = { profile: 'recent-activity', date: '2026-09-27', timeZone: 'America/New_York', from: '2026-09-27T00:00:00Z', to: '2026-09-27T12:00:00.000Z' };
    await httpRequest(port, { session, body: toolCall(24, 'jarvos_projects_context', projectArgs) });
    assert.deepEqual(bridge.sent.at(-1).params, { name: 'jarvos_projects_context', arguments: projectArgs });

    await httpRequest(port, { session, body: toolCall(25, 'jarvos_startup_brief', { query: 'today', maxChars: 4000 }) });
    assert.deepEqual(bridge.sent.at(-1).params, { name: 'jarvos_startup_brief', arguments: { query: 'today', maxChars: 4000 } });
  } finally {
    await closeServer(server);
  }
});

test('read-only drops child-originated requests and notifications', async () => {
  const child = fakeChild();
  let bridge;
  const createBridge = () => {
    bridge = gateway.startStdioBridge({ spawn: () => child, restart: false });
    return bridge;
  };
  const { server, port } = await startServer({ createBridge, readOnly: true, requestTimeoutMs: 2000 });
  try {
    const { response, session } = await initialize(port);
    assert.deepEqual(response.json.result.capabilities, { tools: {} });
    const call = await httpRequest(port, { session, body: toolCall(2, 'jarvos_hydrate', { maxChars: 500 }) });
    assert.equal(call.status, 200);
    for (const text of [response.body, call.body]) {
      assert.doesNotMatch(text, /backchannel-leak|sampling\/createMessage|child-req-1/);
    }
    const get = await httpRequest(port, { method: 'GET', session });
    assert.equal(get.status, 405);
    assert.equal(bridge.sseClients.size, 0);
    assert.ok(child.received.every((message) => typeof message.method === 'string'));
    assert.deepEqual(child.received.map((message) => message.method), ['initialize', 'tools/call']);
  } finally {
    await closeServer(server);
  }
});

test('default mode keeps legacy forwarding of prompts, client responses and GET SSE', async () => {
  const bridge = fakeBridge();
  const { server, port } = await startServer({ bridge });
  try {
    const initParams = { protocolVersion: '2025-06-18', capabilities: { sampling: {} }, clientInfo: { name: 'grok', version: '1' } };
    const { response, session } = await initialize(port, initParams);
    assert.deepEqual(response.json.result.capabilities, { tools: {}, prompts: {}, resources: {} });
    assert.deepEqual(bridge.sent[0].params, initParams);

    const prompts = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'boot_jarvos' } } });
    assert.equal(prompts.status, 200);
    assert.equal(bridge.sent.at(-1).method, 'prompts/get');

    const list = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 3, method: 'tools/list' } });
    assert.equal(list.json.result.tools.length, 8);

    const write = await httpRequest(port, { session, body: toolCall(4, 'jarvos_create_note', { title: 't', config: 'c' }) });
    assert.equal(write.status, 200);
    assert.deepEqual(bridge.sent.at(-1).params, { name: 'jarvos_create_note', arguments: { title: 't', config: 'c' } });

    const clientResponse = await httpRequest(port, { session, body: { jsonrpc: '2.0', id: 'child-req-1', result: {} } });
    assert.equal(clientResponse.status, 202);
    assert.equal(bridge.posted.length, 1);

    const sse = await openSse(port, session);
    assert.equal(sse.status, 200);
    assert.match(sse.headers['content-type'], /text\/event-stream/);
  } finally {
    await closeServer(server);
  }
});

test('Muse launcher selects only Muse credentials and fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-muse-gateway-'));
  try {
    const museToken = 'muse-only-token-0123456789abcdef';
    const genericToken = 'generic-token-0123456789abcdef00';
    const museFile = path.join(dir, 'muse.token');
    const genericFile = path.join(dir, 'generic.token');
    const sameValueFile = path.join(dir, 'same-value.token');
    fs.writeFileSync(museFile, `${museToken}\n`, { mode: 0o600 });
    fs.writeFileSync(genericFile, `${genericToken}\n`, { mode: 0o600 });
    fs.writeFileSync(sameValueFile, `${museToken}\n`, { mode: 0o600 });

    const refuse = (env, pattern) => {
      assert.throws(() => muse.resolveMuseConfig(env), (error) => {
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, new RegExp(`${museToken}|${genericToken}`));
        return true;
      });
    };

    refuse({ JARVOS_MCP_HTTP_TOKEN: genericToken, JARVOS_MCP_HTTP_TOKEN_FILE: genericFile }, /refusing to start/);
    refuse({}, /refusing to start/);

    const selected = muse.resolveMuseConfig({
      JARVOS_MUSE_MCP_TOKEN_FILE: museFile,
      JARVOS_MCP_HTTP_TOKEN: genericToken,
      JARVOS_MCP_HTTP_TOKEN_FILE: genericFile,
      JARVOS_MCP_HTTP_PORT: '9999',
      JARVOS_MCP_HTTP_HOST: '0.0.0.0',
    });
    assert.deepEqual(selected, { token: museToken, host: '127.0.0.1', port: 8766 });
    assert.equal(muse.MUSE_DEFAULT_PORT, 8766);
    assert.equal(muse.resolveMuseConfig({ JARVOS_MUSE_MCP_TOKEN: museToken }).token, museToken);

    refuse({ JARVOS_MUSE_MCP_TOKEN: museToken, JARVOS_MCP_HTTP_TOKEN: museToken }, /must differ/);
    refuse({ JARVOS_MUSE_MCP_TOKEN_FILE: museFile, JARVOS_MCP_HTTP_TOKEN_FILE: sameValueFile }, /must differ/);
    refuse({ JARVOS_MUSE_MCP_TOKEN_FILE: museFile, JARVOS_MCP_HTTP_TOKEN_FILE: museFile }, /must not be the generic/);

    const link = path.join(dir, 'link.token');
    fs.symlinkSync(museFile, link);
    refuse({ JARVOS_MUSE_MCP_TOKEN_FILE: link }, /trusted owner-only/);
    const loose = path.join(dir, 'loose.token');
    fs.writeFileSync(loose, `${museToken}\n`, { mode: 0o644 });
    fs.chmodSync(loose, 0o644);
    refuse({ JARVOS_MUSE_MCP_TOKEN_FILE: loose }, /trusted owner-only/);

    refuse({ JARVOS_MUSE_MCP_TOKEN: museToken, JARVOS_MUSE_MCP_HOST: '100.64.0.1' }, /non-loopback/);
    refuse({ JARVOS_MUSE_MCP_TOKEN: museToken, JARVOS_MUSE_MCP_HOST: '100.64.0.1', JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK: '1' }, /non-loopback/);
    assert.equal(muse.resolveMuseConfig({
      JARVOS_MUSE_MCP_TOKEN: museToken,
      JARVOS_MUSE_MCP_HOST: '100.64.0.1',
      JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK: '1',
    }).host, '100.64.0.1');
    refuse({ JARVOS_MUSE_MCP_TOKEN: museToken, JARVOS_MUSE_MCP_PORT: '8765' }, /general gateway/);
    refuse({ JARVOS_MUSE_MCP_TOKEN: museToken, JARVOS_MUSE_MCP_PORT: 'abc' }, /valid port/);

    // Rejected starts only: each exits before binding anything.
    for (const env of [
      { PATH: process.env.PATH, JARVOS_MCP_HTTP_TOKEN: genericToken },
      { PATH: process.env.PATH, JARVOS_MUSE_MCP_TOKEN: museToken, JARVOS_MUSE_MCP_HOST: '0.0.0.0' },
    ]) {
      const started = spawnSync(process.execPath, [MUSE_GATEWAY], { encoding: 'utf8', env, timeout: 5000 });
      assert.notEqual(started.status, 0);
      assert.match(started.stderr, /refusing/);
      assert.doesNotMatch(`${started.stderr}${started.stdout}`, new RegExp(`${museToken}|${genericToken}`));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Muse child environment drops credentials and service bindings but keeps host read config', () => {
  const env = {
    PATH: '/usr/bin',
    JARVOS_PROJECTS_CONTEXT_CONFIG: '/host/projects.json',
    JARVOS_VAULT_PATH: '/host/vault',
    JARVOS_MUSE_MCP_TOKEN: 'muse',
    JARVOS_MUSE_MCP_TOKEN_FILE: '/host/muse.token',
    JARVOS_MCP_HTTP_TOKEN: 'generic',
    JARVOS_MCP_HTTP_TOKEN_FILE: '/host/generic.token',
    JARVOS_CONTROL_PLANE_CREDENTIAL: 'cp',
    JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: '/host/cp',
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: '/host/cp.js',
    JARVOS_WORK_ACTION_SERVICE_MODULE: '/host/work.js',
    JARVOS_COMMON_WORK_SERVICE_MODULE: '/host/common.js',
    JARVOS_COMMON_WORK_HARNESS: 'codex',
    JARVOS_SHARED_SKILLS_CONFIG_PATH: '/host/skills.json',
    JARVOS_MEANING_PROVIDER_MODULE: '/host/meaning.js',
  };
  let captured = null;
  const bridge = gateway.startStdioBridge({
    spawn: (_command, _args, options) => {
      captured = options.env;
      return fakeChild();
    },
    restart: false,
    env,
    childEnv: muse.museChildEnv,
  });
  bridge.dispose();
  for (const key of muse.CHILD_ENV_DENYLIST) assert.equal(Object.prototype.hasOwnProperty.call(captured, key), false, key);
  assert.equal(captured.JARVOS_PROJECTS_CONTEXT_CONFIG, '/host/projects.json');
  assert.equal(captured.JARVOS_VAULT_PATH, '/host/vault');
  assert.equal(captured.PATH, '/usr/bin');

  // Legacy default child env only drops the generic gateway token.
  const legacy = gateway.startStdioBridge({
    spawn: (_command, _args, options) => {
      captured = options.env;
      return fakeChild();
    },
    restart: false,
    env,
  });
  legacy.dispose();
  assert.equal(captured.JARVOS_MCP_HTTP_TOKEN, undefined);
  assert.equal(captured.JARVOS_CONTROL_PLANE_CREDENTIAL, 'cp');
});

test('Muse launcher main passes fixed read-only, Muse config and child env scrubber to serve', async () => {
  const museToken = 'muse-only-token-0123456789abcdef';
  const genericToken = 'generic-token-0123456789abcdef00';
  const env = {
    PATH: '/usr/bin',
    JARVOS_VAULT_PATH: '/host/vault',
    JARVOS_MUSE_MCP_TOKEN: museToken,
    // Misleading generic and read-only-like settings that must not downgrade the launcher.
    JARVOS_MCP_HTTP_TOKEN: genericToken,
    JARVOS_MCP_HTTP_HOST: '0.0.0.0',
    JARVOS_MCP_HTTP_PORT: '8765',
    JARVOS_MCP_HTTP_READ_ONLY: '0',
    JARVOS_MUSE_MCP_READ_ONLY: 'false',
    JARVOS_READ_ONLY: '0',
    READ_ONLY: 'false',
    JARVOS_CONTROL_PLANE_CREDENTIAL: 'cp',
  };
  // Stub serve so main never listens or spawns.
  const realServe = gateway.serve;
  const served = {};
  let options = null;
  gateway.serve = async (received) => {
    options = received;
    return served;
  };
  try {
    assert.equal(await muse.main(env), served);
  } finally {
    gateway.serve = realServe;
  }

  assert.deepEqual(Object.keys(options).sort(), ['childEnv', 'env', 'host', 'port', 'readOnly', 'token']);
  assert.equal(options.readOnly, true);
  assert.equal(options.token, museToken);
  assert.notEqual(options.token, genericToken);
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, muse.MUSE_DEFAULT_PORT);
  assert.notEqual(options.port, gateway.DEFAULT_PORT);
  assert.equal(options.env, env);
  assert.equal(options.childEnv, muse.museChildEnv);

  let captured = null;
  const bridge = gateway.startStdioBridge({
    spawn: (_command, _args, spawnOptions) => {
      captured = spawnOptions.env;
      return fakeChild();
    },
    restart: false,
    env: options.env,
    childEnv: options.childEnv,
  });
  bridge.dispose();
  for (const key of muse.CHILD_ENV_DENYLIST) assert.equal(Object.prototype.hasOwnProperty.call(captured, key), false, key);
  assert.equal(captured.JARVOS_VAULT_PATH, '/host/vault');
});

test('Muse adapter, setup and docs declare read-only scope honestly', () => {
  const manifest = JSON.parse(fs.readFileSync(ADAPTER, 'utf8'));
  const validated = validateManifest(manifest);
  assert.equal(validated.ok, true, validated.errors.join('\n'));
  const checked = checkRuntime(ADAPTER, { root: ROOT });
  assert.equal(checked.ok, true, checked.errors.join('\n'));
  assert.equal(manifest.skillProjection, undefined);
  assert.deepEqual([...manifest.sharedAgentContext.requiredTools].sort(), ALLOWED);
  assert.deepEqual(Object.keys(gateway.READ_ONLY_TOOLS).sort(), ALLOWED);
  const caps = manifest.capabilityDescriptor.capabilities;
  for (const capability of [caps.notes.create, caps.notes.update, caps.notes.journalLink, caps.session.handoff,
    caps.skills.discover, caps.skills.invoke, caps.context.startupHydration]) {
    assert.equal(capability.status, 'unsupported');
  }
  assert.equal(manifest.operatorNotification.delivery.status, 'not-configured');
  assert.equal(manifest.targets[0].hydration.mode, 'manual');
  assert.doesNotMatch(JSON.stringify(manifest.targets), /boot_jarvos prompt|full MCP surface/);

  const setup = fs.readFileSync(path.join(ROOT, 'runtimes/muse/setup.sh'), 'utf8');
  assert.match(setup, /export JARVOS_MUSE_MCP_HOST="<vault-host-tailnet-ip>"\n\s*export JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK=1/);
  assert.match(setup, /Never reuse the generic JARVOS_MCP_HTTP_TOKEN/);
  assert.match(setup, /never point Muse at the general gateway/);
  assert.match(setup, /Read-only still exposes sensitive vault content/);
  assert.match(setup, /not an OS sandbox/);
  assert.match(setup, /no per-note ACL/);
  assert.match(setup, /operator's\s+decision/);
  assert.match(setup, /flag:'wx'/);
  assert.match(setup, /-L "\$TOKEN_FILE"/);
  assert.doesNotMatch(setup, /\$\{JARVOS_MCP_HTTP_[A-Z_]*:-/);
  assert.doesNotMatch(setup, /cat "\$TOKEN_FILE"|Bearer \$\(cat|Bearer \$\{/);
  assert.doesNotMatch(setup, /jarvos-mcp-http\.js"/);

  const readme = fs.readFileSync(path.join(ROOT, 'runtimes/muse/README.md'), 'utf8');
  assert.match(readme, /Read-only still exposes sensitive vault content/);
  assert.match(readme, /no per-note ACL/i);
  assert.match(readme, /operator's\s+decision/);
  assert.match(readme, /Never reuse the generic gateway credential/);
  assert.match(readme, /Never point Muse at the general gateway/);
  assert.match(readme, /JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK=1/);
  assert.doesNotMatch(readme, /jarvos_create_note`\) with source|Use `jarvos_session_thread_write`|declares skill projection \*\*supported\*\*/);
});
