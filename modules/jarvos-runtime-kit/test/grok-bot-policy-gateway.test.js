'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const gateway = require(path.join(ROOT, 'modules/jarvos-agent-context/scripts/jarvos-mcp-http.js'));
const grok = require(path.join(ROOT, 'runtimes/grok-bot/gateway.js'));

const TOKEN = 'grok-policy-test-token-32chars-x';
const ALLOWED = ['jarvos_create_note', 'jarvos_hydrate', 'jarvos_journal_health', 'jarvos_projects_context', 'jarvos_recall',
  'jarvos_session_thread_read', 'jarvos_session_thread_write', 'jarvos_startup_brief'];
const PRIVILEGED = ['jarvos_control_plane', 'jarvos_coding_task', 'jarvos_shared_skills', 'jarvos_todo_update',
  'jarvos_common_work', 'jarvos_projects_update'];
const CONTENT = '# Idea\n\nGrok captured this.';
const THREAD_WRITE = Object.freeze({ threadId: 'grok-thread-0001', summary: 'Grok checkpoint' });
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function childReply(message) {
  if (message.id == null) return null;
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'jarvos' }, instructions: 'call jarvos_control_plane' } };
  }
  if (message.method === 'tools/list') {
    const open = { type: 'object', properties: { config: { type: 'string' }, seeds: { type: 'array' } } };
    return { jsonrpc: '2.0', id: message.id, result: { tools: [...ALLOWED, ...PRIVILEGED].map((name) => ({ name, description: name, inputSchema: open })) } };
  }
  return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } };
}

// Minimal fake bridge; tools named in timeoutNames fail like the stdio bridge's request timeout.
function fakeBridge({ timeoutNames = [] } = {}) {
  const bridge = {
    sseClients: new Set(),
    sent: [],
    posted: [],
    send: async (message) => {
      bridge.sent.push(JSON.parse(JSON.stringify(message)));
      if (message.method === 'tools/call' && timeoutNames.includes(message.params?.name)) {
        throw new Error(`MCP request ${message.id} timed out`);
      }
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
  child.kill = () => { child.killed = true; };
  return child;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpRequest(port, { method = 'POST', body, session, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method, agent: false,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(session ? { 'mcp-session-id': session } : {}), ...headers },
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

async function withServer(options, fn) {
  const bridge = options.bridge || fakeBridge();
  const server = gateway.createServer({ token: TOKEN, host: '127.0.0.1', port: 0, ...options, bridge });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    const init = await httpRequest(port, { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { sampling: {} }, clientInfo: { name: 'grok', version: '1' } } } });
    assert.equal(init.status, 200, init.body);
    const ctx = { port, bridge, init, session: init.headers['mcp-session-id'] };
    ctx.post = (body) => httpRequest(port, { session: ctx.session, body });
    await fn(ctx);
  } finally {
    await closeServer(server);
  }
}

const GROK = () => ({ toolPolicy: grok.GROK_TOOL_POLICY });
const toolCall = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: args === undefined ? { name } : { name, arguments: args } });
const callsTo = (bridge, name) => bridge.sent.filter((m) => m.method === 'tools/call' && m.params.name === name);

async function listSchemas(ctx) {
  const list = await ctx.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.status, 200, list.body);
  return Object.fromEntries(list.json.result.tools.map((tool) => [tool.name, tool.inputSchema]));
}

async function expectRejectedWithoutDispatch(ctx, cases) {
  const baseline = ctx.bridge.sent.length;
  for (const [name, args] of cases) {
    const denied = await ctx.post(toolCall(20, name, args));
    assert.ok(denied.json && denied.json.error, `${name} ${JSON.stringify(args)?.slice(0, 120)}`);
    assert.equal(denied.json.error.code, -32602, name);
    assert.doesNotMatch(denied.body, /SECRET-VALUE-123/);
  }
  assert.equal(ctx.bridge.sent.length, baseline, 'nothing denied may reach the child');
}

test('Grok policy initialize is tools-only and discovery exposes exactly eight closed gateway-owned schemas', async () => {
  await withServer(GROK(), async (ctx) => {
    assert.deepEqual(ctx.init.json.result.capabilities, { tools: {} });
    assert.equal(ctx.init.json.result.instructions, undefined);
    const schemas = await listSchemas(ctx);
    assert.deepEqual(Object.keys(schemas).sort(), ALLOWED);
    for (const [name, schema] of Object.entries(schemas)) {
      assert.equal(schema.type, 'object', name);
      assert.equal(schema.additionalProperties, false, name);
      for (const key of ['config', 'seeds', 'source_personality']) assert.equal(hasOwn(schema.properties || {}, key), false, `${name}.${key}`);
    }
    const note = schemas.jarvos_create_note;
    assert.ok(note.required.includes('title') && note.required.includes('content'));
    const frontmatter = note.properties.frontmatter;
    assert.equal(frontmatter.type, 'object');
    assert.equal(frontmatter.additionalProperties, false);
    assert.deepEqual(Object.keys(frontmatter.properties).sort(), ['project', 'status', 'type']);
    for (const name of ['jarvos_session_thread_read', 'jarvos_session_thread_write']) {
      assert.ok(schemas[name].required.includes('threadId'), name);
      for (const key of ['title', 'routeCapability', 'host', 'journalPolicy']) assert.equal(hasOwn(schemas[name].properties, key), false, `${name}.${key}`);
    }
  });
});

test('Grok policy denies privileged tools, prompts/resources methods, client responses and GET/SSE without dispatch', async () => {
  await withServer(GROK(), async (ctx) => {
    const baseline = ctx.bridge.sent.length;
    for (const name of [...PRIVILEGED, 'jarvos_synthesize', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const denied = await ctx.post(toolCall(10, name, {}));
      assert.equal(denied.json.error.code, -32602, name);
    }
    for (const method of ['prompts/list', 'prompts/get', 'resources/list', 'resources/read', 'resources/templates/list', 'completion/complete', 'sampling/createMessage']) {
      const denied = await ctx.post({ jsonrpc: '2.0', id: 11, method, params: { name: 'boot_jarvos' } });
      assert.equal(denied.json.error.code, -32601, method);
    }
    const meta = await ctx.post({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'jarvos_hydrate', arguments: {}, _meta: { progressToken: 'p' } } });
    assert.ok(meta.json.error);
    const clientResponse = await ctx.post({ jsonrpc: '2.0', id: 'child-req-1', result: { ok: true } });
    assert.equal(clientResponse.status, 400);
    const get = await httpRequest(ctx.port, { method: 'GET', session: ctx.session, headers: { accept: 'text/event-stream' } });
    assert.equal(get.status, 405);
    assert.equal(ctx.bridge.sseClients.size, 0);
    assert.equal(ctx.bridge.sent.length, baseline);
    assert.equal(ctx.bridge.posted.length, 0);
  });
});

test('Grok policy rejects unknown, prototype and caller-config fields before child dispatch', async () => {
  await withServer(GROK(), async (ctx) => {
    await expectRejectedWithoutDispatch(ctx, [
      ['jarvos_hydrate', { config: '/tmp/config.json' }],
      ['jarvos_hydrate', { maxChars: 20001 }],
      ['jarvos_hydrate', null],
      ['jarvos_hydrate', []],
      ['jarvos_recall', { query: 'x', seeds: ['people/a'] }],
      ['jarvos_recall', { query: 'x'.repeat(2001) }],
      ['jarvos_recall', { query: 'x', constructor: 'y' }],
      ['jarvos_startup_brief', { configPath: '/etc/passwd' }],
      ['jarvos_projects_context', { config: 'SECRET-VALUE-123' }],
      ['jarvos_journal_health', { config: 'x' }],
      ['jarvos_journal_health', { journalDir: '/etc' }],
      ['jarvos_create_note', { title: 'ok', content: CONTENT, config: '/tmp/c.json' }],
      ['jarvos_create_note', { title: 'ok', content: CONTENT, path: '/etc/passwd' }],
    ]);
    const baseline = ctx.bridge.sent.length;
    for (const raw of [
      '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"jarvos_recall","arguments":{"query":"x","__proto__":{"polluted":true}}}}',
      '{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"jarvos_create_note","arguments":{"title":"ok","content":"c","frontmatter":{"__proto__":{"polluted":true}}}}}',
      '{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"jarvos_create_note","arguments":{"title":"ok","content":"c","frontmatter":{"constructor":"x"}}}}',
    ]) {
      const denied = await ctx.post(raw);
      assert.equal(denied.json.error.code, -32602, raw);
    }
    assert.equal({}.polluted, undefined);
    assert.equal(ctx.bridge.sent.length, baseline);
  });
});

test('Grok policy forwards allowed reads with only validated arguments', async () => {
  await withServer(GROK(), async (ctx) => {
    for (const [id, name, args] of [
      [30, 'jarvos_hydrate', { maxChars: 500 }],
      [31, 'jarvos_recall', { query: 'hello', includeQmd: true }],
      [32, 'jarvos_startup_brief', { query: 'today' }],
      [33, 'jarvos_projects_context', { profile: 'orientation' }],
      [34, 'jarvos_journal_health', {}],
      [35, 'jarvos_session_thread_read', { threadId: 'grok-thread-0001' }],
    ]) {
      const res = await ctx.post(toolCall(id, name, args));
      assert.equal(res.status, 200, `${name} ${res.body}`);
      assert.deepEqual(res.json.result.content, [{ type: 'text', text: 'ok' }]);
      assert.deepEqual(ctx.bridge.sent.at(-1), { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    }
  });
});

test('jarvos_create_note stamps source_personality after validation and defaults project to empty string', async () => {
  await withServer(GROK(), async (ctx) => {
    const plain = await ctx.post(toolCall(40, 'jarvos_create_note', { title: 'Grok idea', content: CONTENT }));
    assert.equal(plain.status, 200, plain.body);
    const first = callsTo(ctx.bridge, 'jarvos_create_note').at(-1).params.arguments;
    assert.deepEqual(Object.keys(first).sort(), ['content', 'frontmatter', 'title']);
    assert.equal(first.title, 'Grok idea');
    assert.equal(first.content, CONTENT);
    assert.deepEqual(first.frontmatter, { project: '', source_personality: 'grok-bot' });
    assert.notEqual(first.frontmatter.project, 'jarvOS');

    await ctx.post(toolCall(41, 'jarvos_create_note', { title: 'Alpha plan', content: CONTENT, frontmatter: { project: 'Alpha', type: 'idea', status: 'draft' } }));
    assert.deepEqual(callsTo(ctx.bridge, 'jarvos_create_note').at(-1).params.arguments.frontmatter,
      { project: 'Alpha', type: 'idea', status: 'draft', source_personality: 'grok-bot' });

    const unfiled = await ctx.post(toolCall(42, 'jarvos_create_note', { title: 'Unfiled idea', content: CONTENT, frontmatter: { project: '' } }));
    assert.equal(unfiled.status, 200, unfiled.body);
    assert.deepEqual(callsTo(ctx.bridge, 'jarvos_create_note').at(-1).params.arguments.frontmatter,
      { project: '', source_personality: 'grok-bot' });
  });
});

test('jarvos_create_note rejects forged origin fields, unsafe titles and unbounded content', async () => {
  await withServer(GROK(), async (ctx) => {
    const note = (extra) => ['jarvos_create_note', { title: 'Grok idea', content: CONTENT, ...extra }];
    await expectRejectedWithoutDispatch(ctx, [
      note({ source_personality: 'codex' }),
      note({ frontmatter: { source_personality: 'grok-bot' } }),
      note({ frontmatter: { source_personality: 'codex', project: 'Alpha' } }),
      note({ frontmatter: { origin: 'codex' } }),
      note({ frontmatter: { harness: 'codex' } }),
      note({ frontmatter: { host: 'codex' } }),
      note({ frontmatter: { project: 'Alpha', tags: ['x'] } }),
      note({ frontmatter: [] }),
      note({ frontmatter: 'project: Alpha' }),
      note({ frontmatter: { project: 5 } }),
      note({ frontmatter: { project: { nested: true } } }),
      note({ frontmatter: { project: 'x'.repeat(5000) } }),
      ...['../x', '/abs', 'a\\b', 'a\u0000b', '', '..', 'a/../../b', 'x'.repeat(5000)].map((title) => note({ title })),
      ['jarvos_create_note', { content: CONTENT }],
      ['jarvos_create_note', { title: 'Grok idea' }],
      note({ content: { markdown: 'x' } }),
      note({ content: 'x'.repeat(900_000) }),
    ]);
  });
});

test('session thread tools require explicit threadId and writes are stamped host=grok-bot, journalPolicy=link', async () => {
  await withServer(GROK(), async (ctx) => {
    const writeArgs = { ...THREAD_WRITE };
    const reject = [
      ['jarvos_session_thread_write', { threadId: 'grok-thread-0001' }],
      ['jarvos_session_thread_write', { ...writeArgs, summary: '' }],
      ['jarvos_session_thread_read', { threadId: 'grok-thread-0001', maxChars: 0 }],
      ['jarvos_session_thread_read', { threadId: 'grok-thread-0001', maxChars: 1.5 }],
      ['jarvos_session_thread_read', { threadId: 'grok-thread-0001', maxChars: '500' }],
    ];
    for (const name of ['jarvos_session_thread_read', 'jarvos_session_thread_write']) {
      const base = name.endsWith('write') ? writeArgs : { threadId: 'grok-thread-0001' };
      const withoutThread = { ...base };
      delete withoutThread.threadId;
      reject.push([name, withoutThread], [name, { ...base, threadId: '' }], [name, { ...base, threadId: 5 }]);
      for (const key of ['title', 'routeCapability', 'host', 'journalPolicy']) reject.push([name, { ...base, [key]: 'caller-value' }]);
    }
    await expectRejectedWithoutDispatch(ctx, reject);

    const readArgs = { threadId: 'grok-thread-0001', maxChars: 2000 };
    const read = await ctx.post(toolCall(49, 'jarvos_session_thread_read', readArgs));
    assert.equal(read.status, 200, read.body);
    assert.deepEqual(callsTo(ctx.bridge, 'jarvos_session_thread_read').at(-1).params.arguments, readArgs);

    const write = await ctx.post(toolCall(50, 'jarvos_session_thread_write', writeArgs));
    assert.equal(write.status, 200, write.body);
    const forwarded = callsTo(ctx.bridge, 'jarvos_session_thread_write').at(-1).params.arguments;
    assert.equal(forwarded.threadId, 'grok-thread-0001');
    assert.equal(forwarded.summary, 'Grok checkpoint');
    assert.equal(forwarded.host, 'grok-bot');
    assert.equal(forwarded.journalPolicy, 'link');
    assert.equal(hasOwn(forwarded, 'title'), false);
    assert.equal(hasOwn(forwarded, 'routeCapability'), false);
  });
});

test('toolPolicy and readOnly are mutually exclusive in createServer and serve', async () => {
  assert.throws(() => gateway.createServer({ token: TOKEN, host: '127.0.0.1', port: 0, bridge: fakeBridge(), readOnly: true, toolPolicy: grok.GROK_TOOL_POLICY }));
  let started = null;
  try {
    await assert.rejects(async () => {
      started = await gateway.serve({ token: TOKEN, host: '127.0.0.1', port: 0, env: { PATH: '/usr/bin' }, readOnly: true, toolPolicy: grok.GROK_TOOL_POLICY, childEnv: grok.grokChildEnv });
    });
  } finally {
    if (started) await closeServer(started.server);
  }
});

test('unset toolPolicy keeps general forwarding and Muse readOnly behaviour unchanged', async () => {
  await withServer({}, async (ctx) => {
    assert.deepEqual(ctx.init.json.result.capabilities, { tools: {}, prompts: {}, resources: {} });
    const schemas = await listSchemas(ctx);
    assert.equal(Object.keys(schemas).length, ALLOWED.length + PRIVILEGED.length);
    const args = { title: '../t', config: 'c', frontmatter: { source_personality: 'x' } };
    const write = await ctx.post(toolCall(60, 'jarvos_create_note', args));
    assert.equal(write.status, 200);
    assert.deepEqual(ctx.bridge.sent.at(-1).params, { name: 'jarvos_create_note', arguments: args });
    const prompts = await ctx.post({ jsonrpc: '2.0', id: 61, method: 'prompts/get', params: { name: 'boot_jarvos' } });
    assert.equal(prompts.status, 200);
    assert.equal(ctx.bridge.sent.at(-1).method, 'prompts/get');
  });
  await withServer({ readOnly: true }, async (ctx) => {
    assert.deepEqual(Object.keys(await listSchemas(ctx)).sort(), Object.keys(gateway.READ_ONLY_TOOLS).sort());
    const denied = await ctx.post(toolCall(62, 'jarvos_create_note', { title: 't', content: 'c' }));
    assert.equal(denied.json.error.code, -32602);
  });
});

test('resolveGrokConfig refuses symlink aliases and hardlinks of the Grok token file as generic or Muse token files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-grok-alias-'));
  const secret = 'grok-alias-token-0123456789abcdef';
  try {
    const grokFile = path.join(dir, 'grok.token');
    fs.writeFileSync(grokFile, `${secret}\n`, { mode: 0o600 });
    fs.chmodSync(grokFile, 0o600);
    const symlinkAlias = path.join(dir, 'alias.token');
    fs.symlinkSync(grokFile, symlinkAlias);
    const hardlinkAlias = path.join(dir, 'hardlink.token');
    fs.linkSync(grokFile, hardlinkAlias);
    const base = { JARVOS_GROK_MCP_PORT: '8767', JARVOS_GROK_MCP_TOKEN_FILE: grokFile };
    assert.equal(grok.resolveGrokConfig(base).token, secret);
    for (const alias of [symlinkAlias, hardlinkAlias]) {
      for (const name of ['JARVOS_MCP_HTTP_TOKEN_FILE', 'JARVOS_MUSE_MCP_TOKEN_FILE']) {
        assert.throws(() => grok.resolveGrokConfig({ ...base, [name]: alias }), (error) => {
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        }, `${name} -> ${path.basename(alias)}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Grok write timeout reports uncertain outcome without replay; read, general and Muse timeouts keep existing errors', async () => {
  const bridge = fakeBridge({ timeoutNames: ['jarvos_create_note', 'jarvos_session_thread_write', 'jarvos_recall'] });
  await withServer({ ...GROK(), bridge }, async (ctx) => {
    for (const [id, name, args] of [
      [70, 'jarvos_create_note', { title: 'Grok idea', content: 'SECRET-BODY-1234' }],
      [71, 'jarvos_session_thread_write', { ...THREAD_WRITE }],
    ]) {
      const res = await ctx.post(toolCall(id, name, args));
      assert.ok(res.json && res.json.error, name);
      assert.equal(res.json.id, id);
      assert.match(res.json.error.message, /outcome uncertain/);
      assert.match(res.json.error.message, /do not retry blindly/);
      assert.ok(res.json.error.message.length <= 500);
      assert.doesNotMatch(res.body, /SECRET-BODY-1234|idempoten|safe to retry|will retry/i);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(callsTo(bridge, 'jarvos_create_note').length, 1);
    assert.equal(callsTo(bridge, 'jarvos_session_thread_write').length, 1);
    const read = await ctx.post(toolCall(72, 'jarvos_recall', { query: 'x' }));
    assert.equal(read.status, 504);
    assert.equal(read.json.error.message, 'MCP request 72 timed out');
  });
  await withServer({ bridge: fakeBridge({ timeoutNames: ['jarvos_create_note'] }) }, async (ctx) => {
    const res = await ctx.post(toolCall(73, 'jarvos_create_note', { title: 't', content: 'c' }));
    assert.equal(res.status, 504);
    assert.equal(res.json.error.message, 'MCP request 73 timed out');
  });
  await withServer({ readOnly: true, bridge: fakeBridge({ timeoutNames: ['jarvos_recall'] }) }, async (ctx) => {
    const res = await ctx.post(toolCall(74, 'jarvos_recall', { query: 'x' }));
    assert.equal(res.status, 504);
    assert.equal(res.json.error.message, 'MCP request 74 timed out');
  });
});

test('grokChildEnv keeps a finite config allowlist and drops credentials and service bindings', () => {
  const keep = {
    JARVOS_CONFIG_PATH: '/host/jarvos.json', JARVOS_TIMEZONE: 'America/New_York', JARVOS_JOURNAL_DIR: '/host/journal',
    JARVOS_PROJECTS_CONTEXT_CONFIG: '/host/projects.json', PATH: '/usr/bin', HOME: '/Users/host', LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8', JARVOS_VAULT_DIR: '/host/vault', JARVOS_NOTES_DIR: '/host/vault/Notes',
    XDG_CONFIG_HOME: '/Users/host/.config', XDG_STATE_HOME: '/Users/host/.local/state',
    // Enforcement flags, not credentials: forwarded so the child keeps failing closed.
    JARVOS_REQUIRE_ROUTE_CAPABILITY: '1', JARVOS_REQUIRE_CANONICAL_VAULT: '1',
  };
  const drop = Object.fromEntries([
    'JARVOS_VAULT_PATH', 'VAULT_DIR', 'NOTES_DIR',
    'JARVOS_ROUTE_SECRET', 'JARVOS_ROUTE_SECRET_FILE', 'JARVOS_ROUTE_GENERATION', 'JARVOS_CALLER_CAPABILITY',
    'JARVOS_OWNER_ID', 'JARVOS_OWNER_MODULE',
    'JARVOS_GROK_MCP_TOKEN', 'JARVOS_GROK_MCP_TOKEN_FILE', 'JARVOS_MCP_HTTP_TOKEN', 'JARVOS_MCP_HTTP_TOKEN_FILE',
    'JARVOS_MUSE_MCP_TOKEN', 'JARVOS_MCP_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY', 'GITHUB_TOKEN',
    'JARVOS_CONTROL_PLANE_CREDENTIAL', 'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE', 'JARVOS_CONTROL_PLANE_SERVICE_MODULE',
    'JARVOS_WORK_ACTION_SERVICE_MODULE', 'JARVOS_COMMON_WORK_SERVICE_MODULE', 'JARVOS_COMMON_WORK_HARNESS',
    'JARVOS_CODING_SERVICE_MODULE', 'JARVOS_SHARED_SKILLS_CONFIG_PATH', 'JARVOS_MEANING_PROVIDER_MODULE',
    'PAPERCLIP_API_KEY', 'PAPERCLIP_API_URL', 'PAPERCLIP_TASK_ID', 'JARVOS_SESSION_THREAD_ID', 'NODE_OPTIONS',
    'MY_SECRET', 'UNRELATED_VAR',
  ].map((key) => [key, `value-of-${key}`]));
  const source = { ...keep, ...drop };
  const snapshot = { ...source };
  const child = grok.grokChildEnv(source);
  assert.deepEqual(source, snapshot);
  for (const [key, value] of Object.entries(keep)) assert.equal(child[key], value, key);
  for (const key of Object.keys(drop)) assert.equal(hasOwn(child, key), false, key);
  assert.equal(hasOwn(child, 'JARVOS_VAULT_PATH'), false);
  assert.equal(child.JARVOS_REQUIRE_ROUTE_CAPABILITY, '1');
  assert.equal(child.JARVOS_REQUIRE_CANONICAL_VAULT, '1');

  const list = grok.GROK_CHILD_ENV_ALLOWLIST;
  assert.ok(Array.isArray(list) && Object.isFrozen(list));
  assert.ok(list.length > 0 && list.length < 64);
  for (const key of Object.keys(keep)) assert.ok(list.includes(key), key);
  for (const name of list) assert.doesNotMatch(name, /TOKEN|SECRET|API_KEY|CREDENTIAL|PASSWORD|PAPERCLIP|NODE_OPTIONS|SERVICE_MODULE|HARNESS/);
  for (const key of Object.keys(child)) assert.ok(list.includes(key), key);

  let captured = null;
  const bridge = gateway.startStdioBridge({ spawn: (_c, _a, options) => { captured = options.env; return fakeChild(); }, restart: false, env: source, childEnv: grok.grokChildEnv });
  bridge.dispose();
  assert.deepEqual(captured, child);
});

test('grokChildEnv preserves the workspace-selected vault through the canonical resolver', () => {
  const resolver = require(path.join(ROOT, 'modules/jarvos-secondbrain/bridge/config/src/resolve-config.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-grok-workspace-'));
  try {
    const home = path.join(dir, 'home');
    const workspace = path.join(dir, 'workspace');
    const selectedVault = path.join(dir, 'selected-vault');
    for (const d of [home, workspace, selectedVault]) fs.mkdirSync(d, { recursive: true });
    const configPath = path.join(workspace, 'jarvos.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ paths: { vault: selectedVault } }));
    const homeDefaultVault = path.join(home, 'Vaults', 'Vault v3');
    for (const name of resolver.PATH_ENV_KEYS.workspace) {
      const source = { HOME: home, PATH: process.env.PATH, [name]: workspace };
      for (const env of [source, grok.grokChildEnv(source)]) {
        assert.equal(resolver.discoverConfigPath({ env }), configPath, name);
        const vault = resolver.resolveConfig({ env }).paths.vault;
        assert.equal(vault, selectedVault, name);
        assert.notEqual(vault, homeDefaultVault, name);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const GROK_TOKEN = 'grok-only-token-0123456789abcdef';
const GENERIC_TOKEN = 'generic-token-0123456789abcdef00';
const MUSE_TOKEN = 'muse-only-token-0123456789abcdef';

function refuse(env, pattern) {
  assert.throws(() => grok.resolveGrokConfig(env), (error) => {
    if (pattern) assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, new RegExp(`${GROK_TOKEN}|${GENERIC_TOKEN}|${MUSE_TOKEN}`));
    return true;
  });
}

test('resolveGrokConfig requires Grok-only token, explicit valid port and loopback host', () => {
  const base = { JARVOS_GROK_MCP_TOKEN: GROK_TOKEN, JARVOS_GROK_MCP_PORT: '8767' };
  const ok = grok.resolveGrokConfig(base);
  assert.equal(typeof ok.then, 'undefined');
  assert.equal(ok.token, GROK_TOKEN);
  assert.equal(ok.port, 8767);
  assert.ok(gateway.isLoopbackHost(ok.host));

  refuse({ JARVOS_GROK_MCP_PORT: '8767' });
  refuse({ JARVOS_GROK_MCP_PORT: '8767', JARVOS_MCP_HTTP_TOKEN: GENERIC_TOKEN });
  refuse({ JARVOS_GROK_MCP_PORT: '8767', JARVOS_MCP_TOKEN: GENERIC_TOKEN });
  refuse({ JARVOS_GROK_MCP_PORT: '8767', JARVOS_MUSE_MCP_TOKEN: MUSE_TOKEN });

  refuse({ JARVOS_GROK_MCP_TOKEN: GROK_TOKEN }, /port/i);
  refuse({ JARVOS_GROK_MCP_TOKEN: GROK_TOKEN, JARVOS_MCP_HTTP_PORT: '8767', JARVOS_MUSE_MCP_PORT: '8768' }, /port/i);
  for (const port of ['', 'abc', '0', '65536', '1.5', '-1', '80x']) refuse({ ...base, JARVOS_GROK_MCP_PORT: port }, /port/i);
  for (const port of ['8765', '8766', '9000']) assert.equal(grok.resolveGrokConfig({ ...base, JARVOS_GROK_MCP_PORT: port }).port, Number(port));

  assert.ok(gateway.isLoopbackHost(grok.resolveGrokConfig({ ...base, JARVOS_MCP_HTTP_HOST: '0.0.0.0', JARVOS_MUSE_MCP_HOST: '0.0.0.0' }).host));
  refuse({ ...base, JARVOS_GROK_MCP_HOST: '100.64.0.1' }, /loopback/i);
  refuse({ ...base, JARVOS_GROK_MCP_HOST: '100.64.0.1', JARVOS_MCP_HTTP_ALLOW_NON_LOOPBACK: '1', JARVOS_MUSE_MCP_ALLOW_NON_LOOPBACK: '1' }, /loopback/i);
  assert.equal(grok.resolveGrokConfig({ ...base, JARVOS_GROK_MCP_HOST: '100.64.0.1', JARVOS_GROK_MCP_ALLOW_NON_LOOPBACK: '1' }).host, '100.64.0.1');
});

test('resolveGrokConfig rejects reused generic or Muse credentials and same-file bindings without writing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-grok-gateway-'));
  try {
    const write = (name, value, mode = 0o600) => { const file = path.join(dir, name); fs.writeFileSync(file, `${value}\n`, { mode }); fs.chmodSync(file, mode); return file; };
    const grokFile = write('grok.token', GROK_TOKEN);
    const genericFile = write('generic.token', GENERIC_TOKEN);
    const museFile = write('muse.token', MUSE_TOKEN);
    const sameValueFile = write('same-value.token', GROK_TOKEN);
    const looseFile = write('loose.token', GROK_TOKEN, 0o644);
    const before = fs.readdirSync(dir).sort();
    const port = { JARVOS_GROK_MCP_PORT: '8767' };
    const byFile = { ...port, JARVOS_GROK_MCP_TOKEN_FILE: grokFile };

    assert.equal(grok.resolveGrokConfig(byFile).token, GROK_TOKEN);
    assert.equal(grok.resolveGrokConfig({
      ...byFile, JARVOS_MCP_HTTP_TOKEN: GENERIC_TOKEN, JARVOS_MCP_HTTP_TOKEN_FILE: genericFile,
      JARVOS_MUSE_MCP_TOKEN: MUSE_TOKEN, JARVOS_MUSE_MCP_TOKEN_FILE: museFile,
    }).token, GROK_TOKEN);

    refuse({ ...port, JARVOS_GROK_MCP_TOKEN: GROK_TOKEN, JARVOS_MCP_HTTP_TOKEN: GROK_TOKEN });
    refuse({ ...port, JARVOS_GROK_MCP_TOKEN: GROK_TOKEN, JARVOS_MUSE_MCP_TOKEN: GROK_TOKEN });
    refuse({ ...port, JARVOS_GROK_MCP_TOKEN: GROK_TOKEN, JARVOS_MCP_HTTP_TOKEN_FILE: sameValueFile });
    refuse({ ...port, JARVOS_GROK_MCP_TOKEN: GROK_TOKEN, JARVOS_MUSE_MCP_TOKEN_FILE: sameValueFile });
    refuse({ ...byFile, JARVOS_MCP_HTTP_TOKEN_FILE: grokFile });
    refuse({ ...byFile, JARVOS_MUSE_MCP_TOKEN_FILE: grokFile });
    refuse({ ...byFile, JARVOS_MCP_HTTP_TOKEN_FILE: sameValueFile });
    refuse({ ...byFile, JARVOS_MUSE_MCP_TOKEN_FILE: sameValueFile });
    refuse({ ...port, JARVOS_GROK_MCP_TOKEN_FILE: looseFile });
    refuse({ ...port, JARVOS_GROK_MCP_TOKEN_FILE: path.join(dir, 'missing.token') });

    assert.deepEqual(fs.readdirSync(dir).sort(), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Grok launcher main pins GROK_TOOL_POLICY and grokChildEnv into shared serve', async () => {
  assert.ok(Object.isFrozen(grok.GROK_TOOL_POLICY));
  const env = {
    PATH: '/usr/bin', JARVOS_VAULT_PATH: '/host/vault', JARVOS_GROK_MCP_TOKEN: GROK_TOKEN, JARVOS_GROK_MCP_PORT: '8767',
    // Misleading settings that must not change the pinned policy, token or bind.
    JARVOS_MCP_HTTP_TOKEN: GENERIC_TOKEN, JARVOS_MCP_HTTP_PORT: '8765', JARVOS_MCP_HTTP_HOST: '0.0.0.0',
    JARVOS_GROK_MCP_READ_ONLY: '1', JARVOS_GROK_TOOL_POLICY: 'open', JARVOS_CONTROL_PLANE_CREDENTIAL: 'cp',
  };
  const realServe = gateway.serve;
  const served = {};
  let options = null;
  gateway.serve = async (received) => { options = received; return served; };
  try {
    assert.equal(await grok.main(env), served);
  } finally {
    gateway.serve = realServe;
  }
  const keys = Object.keys(options).filter((key) => !(key === 'readOnly' && options[key] === false)).sort();
  assert.deepEqual(keys, ['childEnv', 'env', 'host', 'port', 'token', 'toolPolicy']);
  assert.equal(options.toolPolicy, grok.GROK_TOOL_POLICY);
  assert.equal(options.childEnv, grok.grokChildEnv);
  assert.equal(options.token, GROK_TOKEN);
  assert.equal(options.port, 8767);
  assert.ok(gateway.isLoopbackHost(options.host));
  assert.equal(options.env, env);
});
