'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const { CodexAppServerClient, fixedArgs } = require('../server/adapters/codex-app-server');

function fakeServer(handler) {
  const messages = [];
  const child = new EventEmitter();
  child.killCount = 0;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const message = JSON.parse(line);
        messages.push(message);
        handler(message, send, child);
      }
      callback();
    },
  });
  child.kill = () => { child.killCount += 1; child.emit('exit', 0, null); return true; };
  function send(message) { child.stdout.write(`${JSON.stringify(message)}\n`); }
  return { child, messages, send };
}

function protocol({ account = { type: 'chatgpt', email: null, planType: 'pro' }, turnMode = 'complete' } = {}) {
  let server;
  server = fakeServer((message, send, child) => {
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    if (message.method === 'account/read') send({ id: message.id, result: { account, requiresOpenaiAuth: !account } });
    if (message.method === 'model/list') send({ id: message.id, result: { data: [{ id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', description: '', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] } });
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      process.nextTick(() => {
        if (turnMode === 'complete') {
          send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello' } });
          send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
        }
        if (turnMode === 'forbidden') send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
        if (turnMode === 'exit') child.emit('exit', 7, null);
      });
    }
    if (message.method === 'turn/interrupt') {
      send({ id: message.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] } } });
    }
  });
  return server;
}

function clientFor(server) {
  return new CodexAppServerClient({ binary: process.execPath, spawnImpl: () => server.child, timeoutMs: 1_000, interruptTimeoutMs: 20 });
}

test('fixed app-server launch disables ambient execution and connector features', () => {
  const launchArgs = fixedArgs();
  const args = launchArgs.join(' ');
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'image_generation', 'browser_use', 'skill_search']) {
    const index = launchArgs.indexOf(feature);
    assert.ok(index > 0 && launchArgs[index - 1] === '--disable', `${feature} must be paired with --disable`);
  }
  assert.match(args, /mcp_servers=\{\}/);
  assert.match(args, /tools\.web_search=false/);
});

test('failed initialization kills the spawned child and removes its runtime directory', async () => {
  const server = fakeServer(() => {});
  const client = new CodexAppServerClient({
    binary: process.execPath,
    spawnImpl: () => server.child,
    timeoutMs: 10,
  });
  await assert.rejects(client.start(), /initialize timed out/);
  assert.equal(server.child.killCount, 1);
  assert.equal(client.child, null);
  assert.equal(client.runtimeDir, null);
});

test('subscription status and models come from managed app-server replies', async () => {
  const server = protocol();
  const client = clientFor(server);
  assert.deepEqual(await client.status(), { available: true, authenticated: true, connection: 'chatgpt-subscription', planType: 'pro', requiresSignIn: false });
  assert.equal((await client.models())[0].id, 'gpt-test');
  client.close();
});

test('logged-out managed account is reported without starting a paid fallback', async () => {
  const server = protocol({ account: null });
  const client = clientFor(server);
  assert.deepEqual(await client.status(), { available: true, authenticated: false, connection: 'none', planType: null, requiresSignIn: true });
  assert.equal(server.messages.some((message) => message.method === 'account/login/start'), false);
  client.close();
});

test('subscription turn streams text under the empty, read-only capability contract', async () => {
  const server = protocol();
  const client = clientFor(server);
  let text = '';
  const receipt = await client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta: (delta) => { text += delta; } });
  assert.equal(text, 'hello');
  assert.deepEqual(receipt.security, { forbiddenEvents: 0, serverRequests: 0 });
  const thread = server.messages.find((message) => message.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.approvalPolicy, 'never');
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(thread.dynamicTools, []);
  assert.deepEqual(thread.runtimeWorkspaceRoots, []);
  const turn = server.messages.find((message) => message.method === 'turn/start').params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  client.close();
});

test('synchronous turn notifications are retained until the turn is registered', async () => {
  const server = protocol({ turnMode: 'wait' });
  const originalWrite = server.child.stdin._write.bind(server.child.stdin);
  server.child.stdin._write = (chunk, encoding, callback) => {
    originalWrite(chunk, encoding, () => {
      const message = JSON.parse(String(chunk));
      if (message.method === 'turn/start') {
        server.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'early' } });
        server.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
      }
      callback();
    });
  };
  const client = clientFor(server);
  let text = '';
  await client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta: (delta) => { text += delta; } });
  assert.equal(text, 'early');
  client.close();
});

test('an already aborted signal never starts a subscription turn', async () => {
  const server = protocol();
  const client = clientFor(server);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta() {}, signal: controller.signal }), /interrupted/);
  assert.equal(server.messages.some((message) => message.method === 'turn/start'), false);
  client.close();
});

test('cancellation interrupts the exact subscription turn', async () => {
  const server = protocol({ turnMode: 'wait' });
  const client = clientFor(server);
  const controller = new AbortController();
  const pending = client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta() {}, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, /interrupted/);
  assert.ok(server.messages.some((message) => message.method === 'turn/interrupt' && message.params.turnId === 'turn-1'));
  client.close();
});

test('server-initiated tools are denied and fail the active turn', async () => {
  const server = protocol({ turnMode: 'forbidden' });
  const client = clientFor(server);
  await assert.rejects(client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta() {} }), /Blocked unexpected/);
  assert.ok(server.messages.some((message) => message.id === 900 && message.error?.code === -32601));
  assert.ok(server.messages.some((message) => message.method === 'turn/interrupt'));
  client.close();
});

test('a blocked synchronous server request is retained and fails the turn', async () => {
  const server = protocol({ turnMode: 'wait' });
  const originalWrite = server.child.stdin._write.bind(server.child.stdin);
  server.child.stdin._write = (chunk, encoding, callback) => {
    originalWrite(chunk, encoding, () => {
      const message = JSON.parse(String(chunk));
      if (message.method === 'turn/start') {
        server.send({ id: 901, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
      }
      callback();
    });
  };
  const client = clientFor(server);
  await assert.rejects(client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta() {} }), /Blocked unexpected/);
  assert.ok(server.messages.some((message) => message.id === 901 && message.error?.code === -32601));
  client.close();
});

test('an unacknowledged interrupt kills the shared child fail closed', async () => {
  const server = protocol({ turnMode: 'wait' });
  const originalWrite = server.child.stdin._write.bind(server.child.stdin);
  server.child.stdin._write = (chunk, encoding, callback) => {
    const message = JSON.parse(String(chunk));
    if (message.method === 'turn/interrupt') {
      server.messages.push(message);
      callback();
      return;
    }
    originalWrite(chunk, encoding, callback);
  };
  const client = clientFor(server);
  const controller = new AbortController();
  const pending = client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta() {}, signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, /interrupted/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(server.child.killCount, 1);
  assert.equal(client.child, null);
});

test('app-server process failure rejects the active turn', async () => {
  const server = protocol({ turnMode: 'exit' });
  const client = clientFor(server);
  await assert.rejects(client.turn({ conversationId: 'conversation123', model: 'gpt-test', effort: 'low', text: 'hi', onDelta() {} }), /exited \(7\)/);
  client.close();
});
