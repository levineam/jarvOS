'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  callTool,
  loadHostWorkActionService,
  WORK_ACTION_HOST_UNAVAILABLE,
  WORK_ACTION_HOST_REFUSED,
} = require('../scripts/jarvos-mcp.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const ENV_KEYS = ['JARVOS_WORK_ACTION_SERVICE_MODULE', 'JARVOS_PROJECTS_CONTEXT_CONFIG'];

function withWorkActionEnv(overrides, fn) {
  const previous = {};
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  for (const key of ENV_KEYS) {
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function writeOwnerFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

test('unset work-action host vars stay unavailable and name what to configure', async () => {
  await withWorkActionEnv({}, async () => {
    const result = await callTool('jarvos_todo_list', {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, WORK_ACTION_HOST_UNAVAILABLE);
    assert.match(result.content[0].text, /JARVOS_WORK_ACTION_SERVICE_MODULE/);
    assert.match(result.content[0].text, /JARVOS_PROJECTS_CONTEXT_CONFIG/);
    assert.equal(loadHostWorkActionService().service, null);
  });
});

test('set-but-untrusted work-action module path is refused and never loaded', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-trusted-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-untrusted-'));
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(outside, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const untrustedPath = path.join(outside, 'untrusted-todo-service.js');
  writeOwnerFile(configPath, JSON.stringify({ workspaceRoot: workspace }));
  writeOwnerFile(untrustedPath, [
    "'use strict';",
    'globalThis.__jarvosUntrustedWorkActionLoaded = true;',
    'module.exports = {',
    '  list: async () => { throw new Error("untrusted module must not run"); },',
    '};',
    '',
  ].join('\n'));
  delete globalThis.__jarvosUntrustedWorkActionLoaded;
  await withWorkActionEnv({
    JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    JARVOS_WORK_ACTION_SERVICE_MODULE: untrustedPath,
  }, async () => {
    const result = await callTool('jarvos_todo_list', {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, WORK_ACTION_HOST_REFUSED);
    assert.equal(globalThis.__jarvosUntrustedWorkActionLoaded, undefined);
    assert.equal(loadHostWorkActionService().service, null);
    assert.equal(require.cache[untrustedPath], undefined);
    assert.doesNotMatch(result.content[0].text, new RegExp(untrustedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.content[0].text, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }).finally(() => {
    delete globalThis.__jarvosUntrustedWorkActionLoaded;
    delete require.cache[untrustedPath];
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

test('trusted work-action module loads and jarvos_todo_list returns a list shape', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-live-root-'));
  fs.chmodSync(workspace, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const servicePath = path.join(workspace, 'todo-service.js');
  writeOwnerFile(configPath, JSON.stringify({ workspaceRoot: workspace }));
  writeOwnerFile(servicePath, [
    "'use strict';",
    'module.exports = {',
    "  list: async () => ({ contract: 'jarvos.work-action/v1', ok: true, items: [] }),",
    '};',
    '',
  ].join('\n'));
  await withWorkActionEnv({
    JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    JARVOS_WORK_ACTION_SERVICE_MODULE: servicePath,
  }, async () => {
    const result = await callTool('jarvos_todo_list', {});
    assert.equal(result.isError, false, result.content?.[0]?.text);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.contract, 'jarvos.work-action/v1');
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.items));
    assert.ok(loadHostWorkActionService().service);
  }).finally(() => {
    delete require.cache[servicePath];
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});

test('Todo mutation tools stay unavailable and refused the same way reads do, without host binding', async () => {
  await withWorkActionEnv({}, async () => {
    const createResult = await callTool('jarvos_todo_create', { title: 'x', operationId: 'op-mutation-1', canonical: { kind: 'outcome' } });
    assert.equal(createResult.isError, true);
    assert.equal(createResult.content[0].text, WORK_ACTION_HOST_UNAVAILABLE);
    const transitionResult = await callTool('jarvos_todo_transition', { itemId: 'bd-1', operationId: 'op-mutation-2', action: 'claim' });
    assert.equal(transitionResult.isError, true);
    assert.equal(transitionResult.content[0].text, WORK_ACTION_HOST_UNAVAILABLE);
  });

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-mutation-untrusted-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-mutation-outside-'));
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(outside, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const untrustedPath = path.join(outside, 'untrusted-todo-service.js');
  writeOwnerFile(configPath, JSON.stringify({ workspaceRoot: workspace }));
  writeOwnerFile(untrustedPath, [
    "'use strict';",
    'module.exports = { create: async () => { throw new Error("untrusted module must not run"); } };',
    '',
  ].join('\n'));
  await withWorkActionEnv({
    JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    JARVOS_WORK_ACTION_SERVICE_MODULE: untrustedPath,
  }, async () => {
    const createResult = await callTool('jarvos_todo_create', { title: 'x', operationId: 'op-mutation-3', canonical: { kind: 'outcome' } });
    assert.equal(createResult.isError, true);
    assert.equal(createResult.content[0].text, WORK_ACTION_HOST_REFUSED);
  }).finally(() => {
    delete require.cache[untrustedPath];
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

test('caller-supplied actor and evidence fields never reach the host work-action service', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-caller-evidence-'));
  fs.chmodSync(workspace, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const servicePath = path.join(workspace, 'todo-service.js');
  writeOwnerFile(configPath, JSON.stringify({ workspaceRoot: workspace }));
  writeOwnerFile(servicePath, [
    "'use strict';",
    'let lastCreateRequest = null;',
    'let lastCompleteRequest = null;',
    'module.exports = {',
    '  create: async (request) => { lastCreateRequest = request; return { contract: "jarvos.work-action/v1", ok: true, workReference: { itemId: "bd-1" } }; },',
    '  completeFromHost: async (request) => { lastCompleteRequest = request; return { contract: "jarvos.work-action/v1", ok: true, status: "done" }; },',
    '  __getLastCreateRequest: () => lastCreateRequest,',
    '  __getLastCompleteRequest: () => lastCompleteRequest,',
    '};',
    '',
  ].join('\n'));
  await withWorkActionEnv({
    JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    JARVOS_WORK_ACTION_SERVICE_MODULE: servicePath,
  }, async () => {
    await callTool('jarvos_todo_create', {
      title: 'caller-forged', operationId: 'op-forged-1', canonical: { kind: 'outcome' },
      actor: { kind: 'human', id: 'attacker' },
    });
    const service = loadHostWorkActionService().service;
    assert.deepEqual(service.__getLastCreateRequest().actor, { kind: 'agent', id: 'mcp' });

    await callTool('jarvos_todo_transition', {
      itemId: 'bd-1', operationId: 'op-forged-2', action: 'complete',
      evidence: { kind: 'human-attested' }, evidenceReceiptId: 'forged-receipt',
      actor: { kind: 'human', id: 'attacker' },
    });
    const completeRequest = service.__getLastCompleteRequest();
    assert.deepEqual(completeRequest.actor, { kind: 'agent', id: 'mcp' });
    assert.equal(completeRequest.evidence, undefined);
    assert.equal(completeRequest.evidenceReceiptId, undefined);
  }).finally(() => {
    delete require.cache[servicePath];
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});

test('Claude and Codex setup scripts pass optional work-action env and never require it', () => {
  const claude = fs.readFileSync(path.join(REPO_ROOT, 'runtimes', 'claude', 'setup.sh'), 'utf8');
  const codex = fs.readFileSync(path.join(REPO_ROOT, 'runtimes', 'codex', 'setup.sh'), 'utf8');
  for (const source of [claude, codex]) {
    assert.match(source, /append_optional_mcp_env JARVOS_WORK_ACTION_SERVICE_MODULE/);
    assert.match(source, /append_optional_mcp_env JARVOS_PROJECTS_CONTEXT_CONFIG/);
    assert.match(source, /must be an absolute path when set/);
    assert.doesNotMatch(source, /: "\$\{JARVOS_WORK_ACTION_SERVICE_MODULE:\?/);
    assert.doesNotMatch(source, /: "\$\{JARVOS_PROJECTS_CONTEXT_CONFIG:\?/);
  }
  assert.match(claude, /claude mcp add --scope user "\$\{MCP_ENV_ARGS\[@\]\}" jarvos -- node/);
  assert.match(codex, /codex mcp add "\$\{MCP_ENV_ARGS\[@\]\}" jarvos -- node/);
});

test('the documented host binding actually starts from a workspace copy', async () => {
  // The published setup is: copy examples/work-action-host-service.js into the
  // Projects workspaceRoot as an owner-only file and point the env var at it.
  // That flow could not bind while the example vetted its own coding module the
  // way it vets caller-supplied ones -- the module ships inside the install tree,
  // which is neither under workspaceRoot nor owner-only, so every call refused.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-documented-host-'));
  try {
    const workspaceRoot = path.join(temp, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.chmodSync(workspaceRoot, 0o700);
    const hostModule = path.join(workspaceRoot, 'work-action-host-service.js');
    fs.copyFileSync(path.join(REPO_ROOT, 'examples', 'work-action-host-service.js'), hostModule);
    fs.chmodSync(hostModule, 0o600);
    const configPath = path.join(workspaceRoot, 'projects.json');
    writeOwnerFile(configPath, JSON.stringify({ workspaceRoot, beadsWorkspace: workspaceRoot }));

    await withWorkActionEnv({
      JARVOS_WORK_ACTION_SERVICE_MODULE: hostModule,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    }, () => {
      const { error } = loadHostWorkActionService();
      // Standing up a real Beads workspace is out of scope for a unit test, so
      // this pins the part that regressed: the documented copy gets past module
      // resolution. Any remaining failure must name a downstream cause, never the
      // containment refusal -- that message sent operators to check file modes
      // that were never the problem.
      assert.notEqual(error, WORK_ACTION_HOST_REFUSED);
      if (error !== null) {
        assert.doesNotMatch(error, /contained under/);
        assert.doesNotMatch(error, /owner-only regular file/);
        assert.match(error, /failed to load/);
      }
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a host module that fails to load is not reported as a containment refusal', async () => {
  // The module passed containment; saying otherwise names the wrong cause and
  // sends the operator to check file modes that were never the problem.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-host-load-error-'));
  try {
    const workspaceRoot = path.join(temp, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.chmodSync(workspaceRoot, 0o700);
    const hostModule = path.join(workspaceRoot, 'broken-host.js');
    writeOwnerFile(hostModule, "throw new Error('beads tracker unreachable');\n");
    const configPath = path.join(workspaceRoot, 'projects.json');
    writeOwnerFile(configPath, JSON.stringify({ workspaceRoot, beadsWorkspace: workspaceRoot }));

    await withWorkActionEnv({
      JARVOS_WORK_ACTION_SERVICE_MODULE: hostModule,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    }, () => {
      const { service, error } = loadHostWorkActionService();
      assert.equal(service, null);
      assert.notEqual(error, WORK_ACTION_HOST_REFUSED);
      assert.match(error, /failed to load/);
      assert.match(error, /beads tracker unreachable/);
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
