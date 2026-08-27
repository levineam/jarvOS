'use strict';

const assert = require('assert');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  PROJECTS_CONTEXT_REFRESH_CONTRACT,
  computeStampDigest,
  createStamp,
} = require('../src/projects-context-refresh.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const plugin = require(path.join(ROOT, 'runtimes', 'openclaw', 'jarvos-next-turn-plugin.js'));

function sessionMappingPath(root, sessionKey) {
  return path.join(root, `${createHash('sha256').update(sessionKey).digest('hex')}.json`);
}

test('OpenClaw registers normal-turn stewardship injection through agent_turn_prepare', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-stewardship-'));
  const mappingRoot = path.join(temp, 'mappings');
  const contextFile = path.join(temp, 'context.json');
  const bridge = path.join(temp, 'jarvos-stewardship-bridge');
  const sessionKey = 'agent:main:stewardship-regression';
  const registrations = [];
  let answerToolFactory = null;

  try {
    fs.mkdirSync(mappingRoot, { recursive: true });
    fs.writeFileSync(contextFile, '{}', { mode: 0o600 });
    fs.writeFileSync(bridge, [
      '#!/bin/sh',
      'if [ "$1" = "nextTurnInput" ]; then',
      "  printf '%s\\n' '{\"available\":true,\"pendingInSessionInput\":true,\"prompt\":\"Choose the guarded path.\",\"choices\":[\"Continue\",\"Stop\"],\"default\":\"Continue\",\"correlation\":\"judgment-42\"}'",
      'fi',
      '',
    ].join('\n'), { mode: 0o700 });
    fs.writeFileSync(sessionMappingPath(mappingRoot, sessionKey), JSON.stringify({
      schemaVersion: 1,
      contextFile,
      bridgeExecutable: bridge,
    }), { mode: 0o600 });

    plugin({
      pluginConfig: { mappingRoot },
      on(name, handler, options) { registrations.push({ name, handler, options }); },
      registerTool(factory) { answerToolFactory = factory; },
    });

    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].name, 'agent_turn_prepare');
    assert.equal(registrations[0].options.timeoutMs, 5000);
    assert.equal(typeof answerToolFactory, 'function');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'openclaw.plugin.json'), 'utf8')).hooks,
      ['agent_turn_prepare'],
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(ROOT, 'runtimes', 'openclaw', 'adapter.json'), 'utf8')).stewardshipAdapter.capabilities.nextTurnInput.event,
      'agent_turn_prepare',
    );

    const output = registrations[0].handler(
      { prompt: 'Record the displayed preference.', messages: [], queuedInjections: [] },
      { sessionKey },
    );
    assert.match(output.prependContext, /jarvOS stewardship preference request:/);
    assert.match(output.prependContext, /Choose the guarded path\./);
    assert.match(output.prependContext, /Continue \(default\)/);
    assert.match(output.prependContext, /judgment-42/);
    assert.match(output.prependContext, /authorizes only recording that preference/);
    assert.match(output.prependContext, /Recording the preference is not approval to execute it/);
    assert.doesNotMatch(output.prependContext, /display-only/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('OpenClaw stewardship answer tool fails closed without a matching session mapping', async () => {
  const answer = plugin.answerTool({ sessionKey: 'agent:main:missing' }, { mappingRoot: os.tmpdir() });
  const result = await answer.execute('call-42', { correlation: 'judgment-42', choice: 'Continue' });

  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'No matching pending stewardship judgment.' }]);
});

function refreshEnvelope(status) {
  if (status === 'invalid') return { available: true };
  if (status === 'unavailable') {
    return { contract: PROJECTS_CONTEXT_REFRESH_CONTRACT, status, stamp: null, stampDigest: null, fingerprint: null, markdown: null };
  }
  const stamp = createStamp({
    providerRevision: 'provider:1', profileRevision: 'profile:1', registryWatermark: 'registry:1',
    activityWatermark: null, workRevision: null, focusEpoch: 'focus:1',
  });
  return {
    contract: PROJECTS_CONTEXT_REFRESH_CONTRACT,
    status,
    stamp,
    stampDigest: computeStampDigest(stamp),
    fingerprint: 'a'.repeat(64),
    markdown: status === 'unchanged' ? null : '## Projects Context\n\n- refreshed from OpenClaw\n',
  };
}

function selectedProjectsEnvironment(temp) {
  const runtimeRoot = path.join(temp, 'selected-runtime');
  return {
    JARVOS_STEWARDSHIP_RUNTIME_ROOT: runtimeRoot,
    JARVOS_STEWARDSHIP_SELECTED_PRIVATE_COMMIT: '1'.repeat(40),
    JARVOS_STEWARDSHIP_SELECTED_PUBLIC_COMMIT: '2'.repeat(40),
    JARVOS_PROJECTS_CONTEXT_CONFIG: path.join(runtimeRoot, 'config', 'jarvos-project-context.json'),
    ACTIVE_ASSISTANT_PROJECTS_PROVIDER_MODULE: path.join(runtimeRoot, 'scripts', 'lib', 'jarvos-projects-local-provider.js'),
    ACTIVE_ASSISTANT_PUBLIC_RUNTIME_ROOT: path.join(runtimeRoot, 'repos', 'jarvOS'),
  };
}

function mappedOpenClawContext(temp, refreshStatus) {
  const mappingRoot = path.join(temp, 'mappings'); const contextFile = path.join(temp, 'context.json');
  const sessionKey = 'agent:main:projects-context'; const bridge = path.join(temp, 'bridge');
  const projectsEnvironment = selectedProjectsEnvironment(temp);
  fs.mkdirSync(mappingRoot, { recursive: true }); fs.writeFileSync(contextFile, '{}', { mode: 0o600 });
  fs.writeFileSync(sessionMappingPath(mappingRoot, sessionKey), JSON.stringify({ schemaVersion: 2, contextFile, bridgeExecutable: bridge, projectsEnvironment }), { mode: 0o600 });
  return { bridge, config: { mappingRoot }, context: { sessionKey }, projectsEnvironment };
}

function bridgeStub(refreshStatus) {
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'projectsContextRefresh' && refreshStatus === 'timeout') {
      return { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) };
    }
    const response = args[0] === 'projectsContextRefresh'
      ? refreshEnvelope(refreshStatus)
      : { available: true, pendingInSessionInput: true, prompt: 'Preserve the stewardship judgment.', choices: ['Wait', 'Stop'], default: 'Wait', correlation: 'openclaw-judgment' };
    return { status: 0, stdout: JSON.stringify(response) };
  };
  return { calls, spawnSyncImpl };
}

test('OpenClaw refresh injects validated changed Projects context alongside stewardship judgment with one 250ms call', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-projects-refresh-'));
  const priorCredential = process.env.JARVOS_STEWARDSHIP_BRIDGE_CREDENTIAL;
  process.env.JARVOS_STEWARDSHIP_BRIDGE_CREDENTIAL = 'bridge-secret-must-not-reach-child';
  try {
    const fixture = mappedOpenClawContext(temp, 'refreshed');
    const bridge = bridgeStub('refreshed');
    const context = plugin.nextTurnContext({}, fixture.config, fixture.context, bridge);
    assert.match(context, /## Projects Context/);
    assert.match(context, /refreshed from OpenClaw/);
    assert.match(context, /openclaw-judgment/);
    assert.equal(plugin.PROJECTS_CONTEXT_REFRESH_TIMEOUT_MS, 250);
    assert.deepEqual(bridge.calls.map((call) => [call.args[0], call.options.timeout]), [
      ['projectsContextRefresh', 250], ['nextTurnInput', 5000],
    ]);
    assert.deepEqual(bridge.calls[0].options.env, {
      PATH: process.env.PATH || '', JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE: path.join(temp, 'context.json'),
      ...fixture.projectsEnvironment,
    });
    assert.deepEqual(bridge.calls[1].options.env, {
      PATH: process.env.PATH || '', JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE: path.join(temp, 'context.json'),
    });
  } finally {
    if (priorCredential === undefined) delete process.env.JARVOS_STEWARDSHIP_BRIDGE_CREDENTIAL;
    else process.env.JARVOS_STEWARDSHIP_BRIDGE_CREDENTIAL = priorCredential;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

for (const status of ['unchanged', 'unavailable', 'invalid', 'timeout']) {
  test(`OpenClaw ${status} Projects refresh fails open while preserving stewardship judgment`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-projects-refresh-'));
    try {
      const fixture = mappedOpenClawContext(temp, status);
      const bridge = bridgeStub(status);
      const context = plugin.nextTurnContext({}, fixture.config, fixture.context, bridge);
      assert.doesNotMatch(context, /## Projects Context|refreshed from OpenClaw/);
      assert.match(context, /openclaw-judgment/);
      assert.deepEqual(bridge.calls.map((call) => [call.args[0], call.options.timeout]), [
        ['projectsContextRefresh', 250], ['nextTurnInput', 5000],
      ]);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test('OpenClaw keeps schemaVersion 1 mappings on context-only judgment routing', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-projects-refresh-'));
  try {
    const mappingRoot = path.join(temp, 'mappings'); const contextFile = path.join(temp, 'context.json');
    const sessionKey = 'agent:main:legacy-mapping'; const bridgeExecutable = path.join(temp, 'bridge');
    fs.mkdirSync(mappingRoot, { recursive: true }); fs.writeFileSync(contextFile, '{}', { mode: 0o600 });
    fs.writeFileSync(sessionMappingPath(mappingRoot, sessionKey), JSON.stringify({ schemaVersion: 1, contextFile, bridgeExecutable }), { mode: 0o600 });
    const bridge = bridgeStub('unavailable');
    const context = plugin.nextTurnContext({}, { mappingRoot }, { sessionKey }, bridge);
    assert.doesNotMatch(context, /## Projects Context/);
    assert.match(context, /openclaw-judgment/);
    assert.deepEqual(bridge.calls.map((call) => [call.args[0], call.options.timeout]), [
      ['projectsContextRefresh', 250], ['nextTurnInput', 5000],
    ]);
    assert.deepEqual(bridge.calls[0].options.env, {
      PATH: process.env.PATH || '', JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE: contextFile,
    });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('OpenClaw rejects a schemaVersion 2 mapping with an expanded or non-deterministic Projects environment', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-openclaw-projects-refresh-'));
  try {
    const fixture = mappedOpenClawContext(temp, 'refreshed');
    const mapPath = sessionMappingPath(path.join(temp, 'mappings'), fixture.context.sessionKey);
    const mapping = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    mapping.projectsEnvironment.JARVOS_STEWARDSHIP_BRIDGE_CREDENTIAL = 'must-not-pass';
    fs.writeFileSync(mapPath, JSON.stringify(mapping), { mode: 0o600 });
    const bridge = bridgeStub('refreshed');
    assert.equal(plugin.nextTurnContext({}, fixture.config, fixture.context, bridge), null);
    assert.equal(bridge.calls.length, 0);

    delete mapping.projectsEnvironment.JARVOS_STEWARDSHIP_BRIDGE_CREDENTIAL;
    mapping.projectsEnvironment.JARVOS_PROJECTS_CONTEXT_CONFIG = `${temp}/selected-runtime/../projects-context.json`;
    fs.writeFileSync(mapPath, JSON.stringify(mapping), { mode: 0o600 });
    assert.equal(plugin.nextTurnContext({}, fixture.config, fixture.context, bridge), null);
    assert.equal(bridge.calls.length, 0);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
