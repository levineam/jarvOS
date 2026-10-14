'use strict';

const assert = require('assert');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGIN = path.join(ROOT, 'runtimes/hermes/plugins/jarvos-context/__init__.py');

function exercise(mode) {
  const script = String.raw`
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("jarvos_context", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Context:
  def __init__(self): self.hooks = {}; self.calls = []
  def register_hook(self, name, fn): self.hooks[name] = fn
  def dispatch_tool(self, name, args):
    self.calls.append([name, args])
    mode = os.environ["MODE"]
    if mode == "timeout": time.sleep(.08)
    if mode == "error": return '{"error":"secret-context"}'
    if mode == "malformed": return "not a packet"
    if mode == "oversized": return "# jarvOS Working Context Packet\\n" + ("x" * 7000)
    return "# jarvOS Working Context Packet\\nPublic bounded context"
ctx = Context(); module.register(ctx)
ctx.hooks["on_session_start"](session_id="shared", platform="cli")
first = ctx.hooks["pre_llm_call"](session_id="shared", platform="cli")
second = ctx.hooks["pre_llm_call"](session_id="shared", platform="cli")
ctx.hooks["on_session_start"](session_id="shared", platform="gateway")
route_collision = ctx.hooks["pre_llm_call"](session_id="shared", platform="gateway")
print(json.dumps({"first": first, "second": second, "route": route_collision, "calls": ctx.calls}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, PLUGIN], {
    encoding: 'utf8',
    env: { ...process.env, MODE: mode, JARVOS_HERMES_HYDRATE_TIMEOUT_SECONDS: '0.01' },
  }));
}

test('Hermes plugin injects a bounded packet once per route/session without collisions', () => {
  const result = exercise('happy');
  assert.match(result.first.context, /Working Context Packet/);
  assert.equal(result.second, null);
  assert.match(result.route.context, /Working Context Packet/);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.calls[0], ['jarvos_hydrate', { maxChars: 6000 }]);
});

test('Hermes plugin obtains an opaque route capability without putting route fields in the packet', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-hermes-route-plugin-'));
  fs.chmodSync(temp, 0o700);
  const socketPath = path.join(temp, 'bridge.sock');
  const server = net.createServer((connection) => {
    let input = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n', 1)[0]);
      if (request.harness !== 'hermes' || request.nativeSession !== 'shared') {
        connection.end(JSON.stringify({ ok: false, code: 'invalid_request' }) + '\n');
        return;
      }
      connection.end(JSON.stringify({ ok: true, routeCapability: 'opaque-route-capability-' + 'x'.repeat(48) }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("jarvos_context", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Context:
  def __init__(self): self.hooks = {}; self.calls = []
  def register_hook(self, name, fn): self.hooks[name] = fn
  def dispatch_tool(self, name, args):
    self.calls.append([name, args])
    return "# jarvOS Working Context Packet\\nSafe packet"
ctx = Context(); module.register(ctx)
ctx.hooks["on_session_start"](session_id="shared", platform="cli")
print(json.dumps({"result": ctx.hooks["pre_llm_call"](session_id="shared", platform="cli"), "calls": ctx.calls}))
`;
  const env = { ...process.env, JARVOS_HERMES_CONTEXT_BRIDGE_SOCKET: socketPath, JARVOS_HERMES_CONTEXT_BRIDGE_CREDENTIAL: 'adapter-credential-r1' };
  delete env.JARVOS_HERMES_CONTEXT_BRIDGE_CREDENTIAL_FILE;
  const output = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, PLUGIN], { env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `python exited ${code}`)));
  });
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
  assert.equal(output.calls[0][0], 'jarvos_hydrate');
  assert.match(output.calls[0][1].sessionThread.routeCapability, /^opaque-route-capability-/);
  assert.doesNotMatch(output.result.context, /opaque-route-capability|shared|cli/);
});

for (const mode of ['timeout', 'error', 'malformed', 'oversized']) {
  test(`Hermes hydration fails open for ${mode} without returning packet content`, () => {
    const result = exercise(mode);
    assert.equal(result.first, null);
    assert.equal(result.second, null);
    assert.equal(result.route, null);
    assert.doesNotMatch(JSON.stringify(result), /secret-context|not a packet|x{100}/);
  });
}
