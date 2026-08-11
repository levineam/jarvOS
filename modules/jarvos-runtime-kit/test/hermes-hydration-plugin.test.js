'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
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

for (const mode of ['timeout', 'error', 'malformed', 'oversized']) {
  test(`Hermes hydration fails open for ${mode} without returning packet content`, () => {
    const result = exercise(mode);
    assert.equal(result.first, null);
    assert.equal(result.second, null);
    assert.equal(result.route, null);
    assert.doesNotMatch(JSON.stringify(result), /secret-context|not a packet|x{100}/);
  });
}
