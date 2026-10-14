'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  TOOLS,
  callTool,
  CODING_PRODUCER_TOOL,
  CODING_PRODUCER_HOST_UNAVAILABLE,
} = require('../scripts/jarvos-mcp.js');

const ENV_KEYS = [
  'JARVOS_CODING_PRODUCER_MODULE',
  'JARVOS_PROJECTS_CONTEXT_CONFIG',
  'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE',
  'JARVOS_CONTROL_PLANE_CREDENTIAL',
];

function withEnv(overrides, fn) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

function ownerFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

function workspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coding-producer-')));
  fs.chmodSync(root, 0o700);
  return {
    root,
    config: ownerFile(path.join(root, 'projects.json'), JSON.stringify({ workspaceRoot: root })),
    credential: ownerFile(path.join(root, 'session.credential'), 'session-credential'),
  };
}

test('the coding producer tool exposes only ordinary request fields', () => {
  const tool = TOOLS.find((entry) => entry.name === CODING_PRODUCER_TOOL);
  assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['deliveryTrace', 'issueIdentifier', 'operation', 'requestId']);
  assert.deepEqual(tool.inputSchema.properties.operation.enum, ['accept-plan', 'complete']);
});

test('without a session credential the producer is never loaded, even with a credential argument', async () => {
  const ws = workspace();
  const modulePath = ownerFile(path.join(ws.root, 'producer.js'), 'globalThis.__codingProducerLoaded = true; module.exports = { invoke: async () => ({ ok: true }) };\n');
  delete globalThis.__codingProducerLoaded;
  await withEnv({ JARVOS_PROJECTS_CONTEXT_CONFIG: ws.config, JARVOS_CODING_PRODUCER_MODULE: modulePath }, async () => {
    const result = await callTool(CODING_PRODUCER_TOOL, { operation: 'complete', requestId: 'r1', issueIdentifier: 'SUP-1', credential: 'session-credential' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /credential is not configured/);
    assert.equal(globalThis.__codingProducerLoaded, undefined);
  }).finally(() => {
    delete globalThis.__codingProducerLoaded;
    fs.rmSync(ws.root, { recursive: true, force: true });
  });
});

test('an unbound or untrusted producer module fails closed', async () => {
  const ws = workspace();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-coding-producer-outside-')));
  const untrusted = ownerFile(path.join(outside, 'producer.js'), 'module.exports = { invoke: async () => ({ ok: true }) };\n');
  await withEnv({ JARVOS_PROJECTS_CONTEXT_CONFIG: ws.config, JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: ws.credential }, async () => {
    const unbound = await callTool(CODING_PRODUCER_TOOL, { operation: 'complete', requestId: 'r1', issueIdentifier: 'SUP-1' });
    assert.equal(unbound.isError, true);
    assert.equal(unbound.content[0].text, CODING_PRODUCER_HOST_UNAVAILABLE);
    process.env.JARVOS_CODING_PRODUCER_MODULE = untrusted;
    const refused = await callTool(CODING_PRODUCER_TOOL, { operation: 'complete', requestId: 'r1', issueIdentifier: 'SUP-1' });
    assert.equal(refused.content[0].text, CODING_PRODUCER_HOST_UNAVAILABLE);
    assert.equal(require.cache[untrusted], undefined);
  }).finally(() => {
    fs.rmSync(ws.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

test('only ordinary fields reach the host producer; authority-shaped arguments are dropped', async () => {
  const ws = workspace();
  const modulePath = ownerFile(path.join(ws.root, 'producer.js'), [
    'module.exports = () => ({',
    '  async invoke(request, host) {',
    '    globalThis.__codingProducerSeen = { request, hostKeys: Object.keys(host), readApproval: typeof host.readApproval };',
    "    return { ok: true, status: 'recorded' };",
    '  },',
    '});',
    '',
  ].join('\n'));
  await withEnv({ JARVOS_PROJECTS_CONTEXT_CONFIG: ws.config, JARVOS_CODING_PRODUCER_MODULE: modulePath, JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: ws.credential }, async () => {
    const result = await callTool(CODING_PRODUCER_TOOL, {
      operation: 'complete',
      requestId: 'r1',
      issueIdentifier: 'SUP-1',
      deliveryTrace: { schemaVersion: 'jarvos-coding-delivery-trace/v1' },
      credential: 'forged',
      acceptedPlanDigest: 'a'.repeat(64),
      deliveryObservation: { headCommit: 'b'.repeat(40) },
      ownerId: 'intruder',
      workRunId: 'run_forged',
      controlPlane: { fence: 99 },
    });
    assert.equal(result.isError, false);
    const seen = globalThis.__codingProducerSeen;
    assert.deepEqual(Object.keys(seen.request).sort(), ['deliveryTrace', 'issueIdentifier', 'operation', 'requestId']);
    assert.deepEqual(seen.hostKeys, ['readApproval']);
    assert.equal(seen.readApproval, 'function');
    assert.doesNotMatch(JSON.stringify(seen), /session-credential|forged|intruder/);
  }).finally(() => {
    delete globalThis.__codingProducerSeen;
    fs.rmSync(ws.root, { recursive: true, force: true });
  });
});
