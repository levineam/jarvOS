'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { callTool, TOOLS, COMMON_WORK_HOST_UNAVAILABLE } = require('../scripts/jarvos-mcp.js');
const plugin = require('../../../runtimes/openclaw/jarvos-next-turn-plugin.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ENV_KEYS = ['JARVOS_COMMON_WORK_SERVICE_MODULE', 'JARVOS_COMMON_WORK_HARNESS'];

function withCommonWorkEnv(values, fn) {
  const prior = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of ENV_KEYS) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  });
}

function makeService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-common-work-host-'));
  fs.chmodSync(root, 0o700);
  const servicePath = path.join(root, 'common-work-service.js');
  const dispatch = path.join(REPO_ROOT, 'modules', 'jarvos-runtime-kit', 'src', 'harness-dispatch.js');
  fs.writeFileSync(servicePath, [
    "'use strict';",
    `const { COMMON_WORK_ACTIONS, createCommonWorkBridge } = require(${JSON.stringify(dispatch)});`,
    'module.exports.createCommonWorkService = ({ harness }) => {',
    '  globalThis.__jarvosCommonWorkFactoryHarnesses = (globalThis.__jarvosCommonWorkFactoryHarnesses || []).concat(harness);',
    '  const authority = Object.fromEntries(COMMON_WORK_ACTIONS.map((action) => [action, async (input) => {',
    '    globalThis.__jarvosCommonWorkCalls = (globalThis.__jarvosCommonWorkCalls || []).concat({ harness, action, input });',
    "    return action === 'get_status' ? { ok: false, code: 'stale_handoff' } : { ok: true, harness, action };",
    '  }]));',
    '  authority.reread = async () => ({ ok: true });',
    '  return createCommonWorkBridge(authority);',
    '};',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(servicePath, 0o600);
  return { root, servicePath };
}

function cleanupService(fixture) {
  delete require.cache[fixture.servicePath];
  fs.rmSync(fixture.root, { recursive: true, force: true });
  delete globalThis.__jarvosCommonWorkFactoryHarnesses;
  delete globalThis.__jarvosCommonWorkCalls;
}

test('common-work MCP tool is declared with only action and input', () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'jarvos_common_work');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['action', 'input']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['action', 'input']);
});

test('common-work MCP invokes the canonical service for fixed Claude, Codex, and Hermes harnesses', async () => {
  const fixture = makeService();
  try {
    for (const harness of ['claude', 'codex', 'hermes']) {
      await withCommonWorkEnv({ JARVOS_COMMON_WORK_SERVICE_MODULE: fixture.servicePath, JARVOS_COMMON_WORK_HARNESS: harness }, async () => {
        const result = await callTool('jarvos_common_work', { action: 'resolve_work_record', input: { request: 'safe' } });
        assert.equal(result.isError, false);
        assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, harness, action: 'resolve_work_record' });
      });
    }
    assert.deepEqual(globalThis.__jarvosCommonWorkFactoryHarnesses, ['claude', 'codex', 'hermes']);
  } finally {
    cleanupService(fixture);
  }
});

test('OpenClaw native common-work tool fixes the OpenClaw harness identity', async () => {
  const fixture = makeService();
  try {
    const result = await plugin.commonWorkTool({ commonWorkServiceModule: fixture.servicePath })
      .execute('call-1', { action: 'resolve_workspace', input: { request: 'safe' } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, harness: 'openclaw', action: 'resolve_workspace' });
    assert.deepEqual(globalThis.__jarvosCommonWorkFactoryHarnesses, ['openclaw']);
  } finally {
    cleanupService(fixture);
  }
});

test('common-work host fails closed for missing or untrusted modules without loading either', async () => {
  await withCommonWorkEnv({ JARVOS_COMMON_WORK_HARNESS: 'codex' }, async () => {
    const result = await callTool('jarvos_common_work', { action: 'resolve_work_record', input: {} });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, COMMON_WORK_HOST_UNAVAILABLE);
  });

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-common-work-untrusted-'));
  const untrustedPath = path.join(outside, 'untrusted.js');
  fs.writeFileSync(untrustedPath, "globalThis.__jarvosCommonWorkUntrustedLoaded = true; module.exports = () => ({});\n", 'utf8');
  fs.chmodSync(untrustedPath, 0o644);
  delete globalThis.__jarvosCommonWorkUntrustedLoaded;
  try {
    await withCommonWorkEnv({ JARVOS_COMMON_WORK_SERVICE_MODULE: untrustedPath, JARVOS_COMMON_WORK_HARNESS: 'codex' }, async () => {
      const result = await callTool('jarvos_common_work', { action: 'resolve_work_record', input: {} });
      assert.equal(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), { ok: false, code: 'common_work_service_refused' });
      assert.equal(globalThis.__jarvosCommonWorkUntrustedLoaded, undefined);
      assert.equal(require.cache[untrustedPath], undefined);
    });
  } finally {
    delete globalThis.__jarvosCommonWorkUntrustedLoaded;
    delete require.cache[untrustedPath];
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('common-work rejects nested reserved authority input before service load and preserves authority denials', async () => {
  const fixture = makeService();
  try {
    await withCommonWorkEnv({ JARVOS_COMMON_WORK_SERVICE_MODULE: fixture.servicePath, JARVOS_COMMON_WORK_HARNESS: 'codex' }, async () => {
      const rejected = await callTool('jarvos_common_work', {
        action: 'resolve_work_record', input: { ordinary: { harness: 'caller-selected' } },
      });
      assert.equal(rejected.isError, true);
      assert.deepEqual(JSON.parse(rejected.content[0].text), { ok: false, code: 'reserved_authority_input' });
      assert.equal(globalThis.__jarvosCommonWorkFactoryHarnesses, undefined);
      assert.equal(globalThis.__jarvosCommonWorkCalls, undefined);

      const stale = await callTool('jarvos_common_work', { action: 'get_status', input: {} });
      assert.equal(stale.isError, true);
      assert.deepEqual(JSON.parse(stale.content[0].text), { ok: false, code: 'stale_handoff' });
    });
  } finally {
    cleanupService(fixture);
  }
});
