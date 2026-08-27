'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

const {
  TOOLS,
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

test('a trusted 0644 Projects config is accepted for work-action host binding', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-config-mode-'));
  fs.chmodSync(workspace, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const servicePath = path.join(workspace, 'todo-service.js');
  // The config is owner-controlled and non-group/world-writable, but readable
  // (0644): trusted ancestry is the integrity boundary, not an owner-only leaf.
  fs.writeFileSync(configPath, JSON.stringify({ workspaceRoot: workspace }), 'utf8');
  fs.chmodSync(configPath, 0o644);
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
    assert.ok(loadHostWorkActionService().service);
  }).finally(() => {
    delete require.cache[servicePath];
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});

test('a 0644 work-action service module is refused even with a trusted config', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-service-mode-'));
  fs.chmodSync(workspace, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const servicePath = path.join(workspace, 'todo-service.js');
  writeOwnerFile(configPath, JSON.stringify({ workspaceRoot: workspace }));
  fs.writeFileSync(servicePath, [
    "'use strict';",
    'module.exports = {',
    "  list: async () => ({ contract: 'jarvos.work-action/v1', ok: true, items: [] }),",
    '};',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(servicePath, 0o644);
  await withWorkActionEnv({
    JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    JARVOS_WORK_ACTION_SERVICE_MODULE: servicePath,
  }, async () => {
    const result = await callTool('jarvos_todo_list', {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, WORK_ACTION_HOST_REFUSED);
    assert.equal(loadHostWorkActionService().service, null);
  }).finally(() => {
    delete require.cache[servicePath];
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});

test('a group/world-writable Projects config is refused even when the work-action module is owner-only', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-config-writable-'));
  fs.chmodSync(workspace, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const servicePath = path.join(workspace, 'todo-service.js');
  fs.writeFileSync(configPath, JSON.stringify({ workspaceRoot: workspace }), 'utf8');
  fs.chmodSync(configPath, 0o666);
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
    assert.equal(loadHostWorkActionService().service, null);
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

test('Todo transition schema tells agents exactly when status is required', () => {
  const tool = TOOLS.find((candidate) => candidate.name === 'jarvos_todo_transition');
  assert.ok(tool);
  assert.equal(tool.inputSchema.oneOf[0].properties.action.const, 'transition');
  assert.deepEqual(tool.inputSchema.oneOf[0].required, ['status']);
  assert.deepEqual(tool.inputSchema.oneOf[1].properties.action.enum, ['claim', 'complete', 'reopen']);
  assert.deepEqual(tool.inputSchema.oneOf[1].not.required, ['status']);
});

test('Todo transition rejects a missing status before calling the host service', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-transition-status-'));
  fs.chmodSync(workspace, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const servicePath = path.join(workspace, 'todo-service.js');
  writeOwnerFile(configPath, JSON.stringify({ workspaceRoot: workspace }));
  writeOwnerFile(servicePath, [
    "'use strict';",
    'module.exports = { transition: async () => { throw new Error("must not run"); } };',
    '',
  ].join('\n'));
  await withWorkActionEnv({
    JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    JARVOS_WORK_ACTION_SERVICE_MODULE: servicePath,
  }, async () => {
    const result = await callTool('jarvos_todo_transition', {
      itemId: 'bd-1', operationId: 'missing-status-1', action: 'transition',
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Todo transition status is required');
  }).finally(() => {
    delete require.cache[servicePath];
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});

test('Todo transition rejects an unknown action instead of reopening work', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-todo-transition-action-'));
  fs.chmodSync(workspace, 0o700);
  const configPath = path.join(workspace, 'projects.json');
  const servicePath = path.join(workspace, 'todo-service.js');
  writeOwnerFile(configPath, JSON.stringify({ workspaceRoot: workspace }));
  writeOwnerFile(servicePath, [
    "'use strict';",
    'let reopens = 0;',
    'module.exports = {',
    '  reopen: async () => { reopens += 1; return { ok: true }; },',
    '  __reopens: () => reopens,',
    '};',
    '',
  ].join('\n'));
  await withWorkActionEnv({
    JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    JARVOS_WORK_ACTION_SERVICE_MODULE: servicePath,
  }, async () => {
    const result = await callTool('jarvos_todo_transition', {
      itemId: 'bd-1', operationId: 'unknown-action-1', action: 'typo',
    });
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'Unsupported Todo transition action');
    assert.equal(loadHostWorkActionService().service.__reopens(), 0);
  }).finally(() => {
    delete require.cache[servicePath];
    fs.rmSync(workspace, { recursive: true, force: true });
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
  assert.match(claude, /claude mcp add --scope user "\$\{MCP_ENV_ARGS\[@\]\}" jarvos -- "\$\{MCP_COMMAND\[@\]\}"/);
  assert.match(codex, /codex mcp add "\$\{MCP_ENV_ARGS\[@\]\}" jarvos -- "\$\{MCP_COMMAND\[@\]\}"/);
});

// Records the argv of a fake `codex`/`claude` CLI so setup.sh's real MCP
// registration call can be inspected without a real installed CLI.
function writeFakeMcpCli(binPath, recordPath) {
  fs.writeFileSync(binPath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `const recordPath = ${JSON.stringify(recordPath)};`,
    "if (args[0] === 'mcp' && args[1] === 'get') process.exit(1);",
    "if (args[0] === 'mcp' && args[1] === 'remove') process.exit(0);",
    "if (args[0] === 'mcp' && args[1] === 'add') { fs.writeFileSync(recordPath, JSON.stringify(args)); process.exit(0); }",
    'process.exit(0);',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(binPath, 0o755);
}

test('Codex and Claude setup register a validated stable entrypoint instead of the immutable install script', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-stable-entrypoint-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });

    const entrypointRoot = path.join(tmp, 'entrypoint-root');
    fs.mkdirSync(entrypointRoot, { recursive: true });
    fs.chmodSync(entrypointRoot, 0o700);
    const stableEntrypoint = path.join(entrypointRoot, 'jarvos-mcp-shim');
    fs.writeFileSync(stableEntrypoint, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o700 });
    fs.chmodSync(stableEntrypoint, 0o700);

    const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const key of [
      'JARVOS_MANAGED_REPOSITORIES', 'JARVOS_STEWARDSHIP_STABLE_ROOT', 'JARVOS_STEWARDSHIP_ONLY',
      'JARVOS_MANAGED_HARNESS_ROLLBACK', 'JARVOS_CODEX_PROVIDER_MODE', 'JARVOS_PROFILE',
      'JARVOS_WORK_ACTION_SERVICE_MODULE', 'JARVOS_PROJECTS_CONTEXT_CONFIG',
      'JARVOS_STEWARDSHIP_BRIDGE_COMMAND', 'JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT',
      'JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT', 'JARVOS_STEWARDSHIP_BRIDGE_PATH',
      'JARVOS_STAGED_PUBLIC_RUNTIME_ROOT', 'JARVOS_CONTROL_PLANE_SERVICE_MODULE',
      'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE',
    ]) delete baseEnv[key];

    // -- Codex --
    const codexRecord = path.join(tmp, 'codex-mcp-add.json');
    writeFakeMcpCli(path.join(bin, 'codex'), codexRecord);
    const codexHome = path.join(tmp, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    const codexResult = spawnSync('bash', [path.join(REPO_ROOT, 'runtimes', 'codex', 'setup.sh')], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        HOME: path.join(tmp, 'home-codex'),
        CODEX_HOME: codexHome,
        CODEX_CONFIG: path.join(codexHome, 'config.toml'),
        JARVOS_MCP_STABLE_ENTRYPOINT: stableEntrypoint,
      },
    });
    assert.equal(codexResult.status, 0, codexResult.stderr || codexResult.stdout);
    const codexArgs = JSON.parse(fs.readFileSync(codexRecord, 'utf8'));
    assert.ok(codexArgs.includes(stableEntrypoint), codexArgs.join(' '));
    assert.ok(!codexArgs.some((value) => value.includes('jarvos-mcp.js')), codexArgs.join(' '));

    // -- Claude --
    const claudeRecord = path.join(tmp, 'claude-mcp-add.json');
    writeFakeMcpCli(path.join(bin, 'claude'), claudeRecord);
    const claudeDesktopConfig = path.join(tmp, 'claude-desktop', 'claude_desktop_config.json');
    const claudeResult = spawnSync('bash', [path.join(REPO_ROOT, 'runtimes', 'claude', 'setup.sh')], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        HOME: path.join(tmp, 'home-claude'),
        CLAUDE_SETTINGS: path.join(tmp, 'claude-settings', 'settings.json'),
        CLAUDE_DESKTOP_CONFIG: claudeDesktopConfig,
        CLAUDE_MD_PATH: path.join(tmp, 'claude-md', 'CLAUDE.md'),
        JARVOS_MCP_STABLE_ENTRYPOINT: stableEntrypoint,
        JARVOS_SKIP_CLAUDE_MD: '1',
      },
    });
    assert.equal(claudeResult.status, 0, claudeResult.stderr || claudeResult.stdout);
    const claudeArgs = JSON.parse(fs.readFileSync(claudeRecord, 'utf8'));
    assert.ok(claudeArgs.includes(stableEntrypoint), claudeArgs.join(' '));
    assert.ok(!claudeArgs.some((value) => value.includes('jarvos-mcp.js')), claudeArgs.join(' '));

    const desktopConfig = JSON.parse(fs.readFileSync(claudeDesktopConfig, 'utf8'));
    assert.equal(desktopConfig.mcpServers.jarvos.command, stableEntrypoint);
    assert.equal(desktopConfig.mcpServers.jarvos.args, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex and Claude setup register the immutable install script when no stable entrypoint is bound', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-portable-entrypoint-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const key of [
      'JARVOS_MANAGED_REPOSITORIES', 'JARVOS_STEWARDSHIP_STABLE_ROOT', 'JARVOS_STEWARDSHIP_ONLY',
      'JARVOS_MANAGED_HARNESS_ROLLBACK', 'JARVOS_CODEX_PROVIDER_MODE', 'JARVOS_PROFILE',
      'JARVOS_WORK_ACTION_SERVICE_MODULE', 'JARVOS_PROJECTS_CONTEXT_CONFIG', 'JARVOS_MCP_STABLE_ENTRYPOINT',
      'JARVOS_STEWARDSHIP_BRIDGE_COMMAND', 'JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT',
      'JARVOS_STEWARDSHIP_CLAUDE_SESSION_MAP_ROOT', 'JARVOS_STEWARDSHIP_BRIDGE_PATH',
      'JARVOS_STAGED_PUBLIC_RUNTIME_ROOT', 'JARVOS_CONTROL_PLANE_SERVICE_MODULE',
      'JARVOS_CONTROL_PLANE_CREDENTIAL_FILE',
    ]) delete baseEnv[key];

    const codexRecord = path.join(tmp, 'codex-mcp-add.json');
    writeFakeMcpCli(path.join(bin, 'codex'), codexRecord);
    const codexHome = path.join(tmp, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    const codexResult = spawnSync('bash', [path.join(REPO_ROOT, 'runtimes', 'codex', 'setup.sh')], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        HOME: path.join(tmp, 'home-codex'),
        CODEX_HOME: codexHome,
        CODEX_CONFIG: path.join(codexHome, 'config.toml'),
      },
    });
    assert.equal(codexResult.status, 0, codexResult.stderr || codexResult.stdout);
    const codexArgs = JSON.parse(fs.readFileSync(codexRecord, 'utf8'));
    assert.ok(codexArgs.some((value) => value.endsWith(path.join('jarvos-agent-context', 'scripts', 'jarvos-mcp.js'))), codexArgs.join(' '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rerunning Codex setup from a different immutable runtime preserves the same stable entrypoint', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-rerun-entrypoint-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const codexRecord = path.join(tmp, 'codex-mcp-add.json');
    writeFakeMcpCli(path.join(bin, 'codex'), codexRecord);

    const entrypointRoot = path.join(tmp, 'entrypoint-root');
    fs.mkdirSync(entrypointRoot, { recursive: true });
    fs.chmodSync(entrypointRoot, 0o700);
    const stableEntrypoint = path.join(entrypointRoot, 'jarvos-mcp-shim');
    fs.writeFileSync(stableEntrypoint, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o700 });
    fs.chmodSync(stableEntrypoint, 0o700);

    const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const key of [
      'JARVOS_MANAGED_REPOSITORIES', 'JARVOS_STEWARDSHIP_STABLE_ROOT', 'JARVOS_STEWARDSHIP_ONLY',
      'JARVOS_MANAGED_HARNESS_ROLLBACK', 'JARVOS_CODEX_PROVIDER_MODE', 'JARVOS_PROFILE',
      'JARVOS_WORK_ACTION_SERVICE_MODULE', 'JARVOS_PROJECTS_CONTEXT_CONFIG',
    ]) delete baseEnv[key];

    // A second immutable runtime generation: its own install root, with its
    // own copy of setup.sh and its own MCP script at a different path. A
    // rerun from here must still register the owner-supplied stable
    // entrypoint, never this generation's own jarvos-mcp.js.
    const runtime2Root = path.join(tmp, 'runtime-generation-2');
    const runtime2McpDir = path.join(runtime2Root, 'modules', 'jarvos-agent-context', 'scripts');
    const runtime2CodexDir = path.join(runtime2Root, 'runtimes', 'codex');
    fs.mkdirSync(runtime2McpDir, { recursive: true });
    fs.mkdirSync(runtime2CodexDir, { recursive: true });
    fs.writeFileSync(path.join(runtime2McpDir, 'jarvos-mcp.js'), '// stub for a different runtime generation\n');
    fs.writeFileSync(path.join(runtime2CodexDir, 'hooks.json'), '{"hooks":{}}\n');
    fs.writeFileSync(path.join(runtime2CodexDir, 'jarvos-session-start-hook.js'), '// stub\n');
    fs.writeFileSync(path.join(runtime2CodexDir, 'jarvos-session-turn-hook.js'), '// stub\n');
    fs.writeFileSync(path.join(runtime2CodexDir, 'trust-session-start-hook.js'), '// stub\n');
    fs.copyFileSync(path.join(REPO_ROOT, 'runtimes', 'codex', 'setup.sh'), path.join(runtime2CodexDir, 'setup.sh'));
    fs.chmodSync(path.join(runtime2CodexDir, 'setup.sh'), 0o755);

    const runFrom = (setupPath) => {
      const codexHome = path.join(tmp, `codex-home-${path.basename(path.dirname(path.dirname(setupPath))) || 'a'}-${Math.random()}`);
      fs.mkdirSync(codexHome, { recursive: true });
      const result = spawnSync('bash', [setupPath], {
        encoding: 'utf8',
        env: {
          ...baseEnv,
          HOME: `${codexHome}-home`,
          CODEX_HOME: codexHome,
          CODEX_CONFIG: path.join(codexHome, 'config.toml'),
          JARVOS_MCP_STABLE_ENTRYPOINT: stableEntrypoint,
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(fs.readFileSync(codexRecord, 'utf8'));
    };

    const firstRun = runFrom(path.join(REPO_ROOT, 'runtimes', 'codex', 'setup.sh'));
    assert.ok(firstRun.includes(stableEntrypoint));

    fs.unlinkSync(codexRecord);
    const rerun = runFrom(path.join(runtime2CodexDir, 'setup.sh'));
    assert.ok(rerun.includes(stableEntrypoint));
    assert.ok(!rerun.some((value) => value.includes('runtime-generation-2')), rerun.join(' '));
    assert.deepEqual(rerun, firstRun);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an unsafe stable entrypoint binding is rejected without echoing the path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-unsafe-entrypoint-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const codexRecord = path.join(tmp, 'codex-mcp-add.json');
    writeFakeMcpCli(path.join(bin, 'codex'), codexRecord);

    const groupWritableRoot = path.join(tmp, 'group-writable-root');
    fs.mkdirSync(groupWritableRoot, { recursive: true });
    fs.chmodSync(groupWritableRoot, 0o700);
    const groupWritableEntrypoint = path.join(groupWritableRoot, 'unsafe-shim');
    fs.writeFileSync(groupWritableEntrypoint, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o755 });
    fs.chmodSync(groupWritableEntrypoint, 0o755);

    const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const key of [
      'JARVOS_MANAGED_REPOSITORIES', 'JARVOS_STEWARDSHIP_STABLE_ROOT', 'JARVOS_STEWARDSHIP_ONLY',
      'JARVOS_MANAGED_HARNESS_ROLLBACK', 'JARVOS_CODEX_PROVIDER_MODE', 'JARVOS_PROFILE',
    ]) delete baseEnv[key];
    const codexHome = path.join(tmp, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });

    for (const [label, value] of [
      ['relative', 'relative/shim'],
      ['escaped', '../escaped-shim'],
      ['missing', path.join(groupWritableRoot, 'does-not-exist')],
      ['group-writable', groupWritableEntrypoint],
    ]) {
      const result = spawnSync('bash', [path.join(REPO_ROOT, 'runtimes', 'codex', 'setup.sh')], {
        encoding: 'utf8',
        env: {
          ...baseEnv,
          HOME: path.join(tmp, `home-${label}`),
          CODEX_HOME: codexHome,
          CODEX_CONFIG: path.join(codexHome, 'config.toml'),
          JARVOS_MCP_STABLE_ENTRYPOINT: value,
        },
      });
      assert.notEqual(result.status, 0, `${label} binding must be rejected`);
      assert.match(result.stderr, /JARVOS_MCP_STABLE_ENTRYPOINT/);
      assert.doesNotMatch(result.stderr, /does-not-exist|unsafe-shim|escaped-shim/);
      assert.equal(fs.existsSync(codexRecord), false, `${label} binding must not register an MCP server`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an entrypoint file mode of 0700 does not excuse unsafe ancestry, for both Codex and Claude setup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-unsafe-ancestry-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });

    // The leaf file is exactly as owner-only as a trusted entrypoint: 0700,
    // owned by us, not a symlink. Only its parent directory is unsafe -- group
    // and world writable, non-sticky -- which lets an unprivileged co-tenant of
    // that directory delete and replace the "trusted" file at will.
    const trustedRoot = path.join(tmp, 'trusted-root');
    fs.mkdirSync(trustedRoot, { recursive: true });
    fs.chmodSync(trustedRoot, 0o700);
    const unsafeAncestor = path.join(trustedRoot, 'world-writable-subdir');
    fs.mkdirSync(unsafeAncestor, { recursive: true });
    fs.chmodSync(unsafeAncestor, 0o777);
    const entrypoint = path.join(unsafeAncestor, 'jarvos-mcp-shim');
    fs.writeFileSync(entrypoint, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o700 });
    fs.chmodSync(entrypoint, 0o700);

    const baseEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    for (const key of [
      'JARVOS_MANAGED_REPOSITORIES', 'JARVOS_STEWARDSHIP_STABLE_ROOT', 'JARVOS_STEWARDSHIP_ONLY',
      'JARVOS_MANAGED_HARNESS_ROLLBACK', 'JARVOS_CODEX_PROVIDER_MODE', 'JARVOS_PROFILE',
      'JARVOS_WORK_ACTION_SERVICE_MODULE', 'JARVOS_PROJECTS_CONTEXT_CONFIG',
    ]) delete baseEnv[key];

    // -- Codex --
    const codexRecord = path.join(tmp, 'codex-mcp-add.json');
    writeFakeMcpCli(path.join(bin, 'codex'), codexRecord);
    const codexHome = path.join(tmp, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    const codexResult = spawnSync('bash', [path.join(REPO_ROOT, 'runtimes', 'codex', 'setup.sh')], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        HOME: path.join(tmp, 'home-codex'),
        CODEX_HOME: codexHome,
        CODEX_CONFIG: path.join(codexHome, 'config.toml'),
        JARVOS_MCP_STABLE_ENTRYPOINT: entrypoint,
      },
    });
    assert.notEqual(codexResult.status, 0, 'Codex setup must reject an owner-only file behind unsafe ancestry');
    assert.match(codexResult.stderr, /JARVOS_MCP_STABLE_ENTRYPOINT/);
    assert.doesNotMatch(codexResult.stderr, /jarvos-mcp-shim|world-writable-subdir/);
    assert.equal(fs.existsSync(codexRecord), false, 'Codex setup must not register an MCP server for unsafe ancestry');

    // -- Claude --
    const claudeRecord = path.join(tmp, 'claude-mcp-add.json');
    writeFakeMcpCli(path.join(bin, 'claude'), claudeRecord);
    const claudeDesktopConfig = path.join(tmp, 'claude-desktop', 'claude_desktop_config.json');
    const claudeResult = spawnSync('bash', [path.join(REPO_ROOT, 'runtimes', 'claude', 'setup.sh')], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        HOME: path.join(tmp, 'home-claude'),
        CLAUDE_SETTINGS: path.join(tmp, 'claude-settings', 'settings.json'),
        CLAUDE_DESKTOP_CONFIG: claudeDesktopConfig,
        CLAUDE_MD_PATH: path.join(tmp, 'claude-md', 'CLAUDE.md'),
        JARVOS_MCP_STABLE_ENTRYPOINT: entrypoint,
        JARVOS_SKIP_CLAUDE_MD: '1',
      },
    });
    assert.notEqual(claudeResult.status, 0, 'Claude setup must reject an owner-only file behind unsafe ancestry');
    assert.match(claudeResult.stderr, /JARVOS_MCP_STABLE_ENTRYPOINT/);
    assert.doesNotMatch(claudeResult.stderr, /jarvos-mcp-shim|world-writable-subdir/);
    assert.equal(fs.existsSync(claudeRecord), false, 'Claude setup must not register an MCP server for unsafe ancestry');
    assert.equal(fs.existsSync(claudeDesktopConfig), false, 'Claude setup must not persist Desktop config for unsafe ancestry');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
    const authorizationModule = path.join(workspaceRoot, 'authorize.js');
    const completionModule = path.join(workspaceRoot, 'completion.js');
    writeOwnerFile(authorizationModule, 'module.exports.authorizeMutation = async () => ({ authorized: true });\n');
    writeOwnerFile(completionModule, 'module.exports.resolveCompletionReceipt = async () => null;\n');
    const trackerOperationStoreRoot = path.join(workspaceRoot, 'tracker-operations');
    const workActionOperationStoreRoot = path.join(workspaceRoot, 'work-action-operations');
    const executionLinkStoreRoot = path.join(workspaceRoot, 'execution-links');
    for (const root of [trackerOperationStoreRoot, workActionOperationStoreRoot, executionLinkStoreRoot]) {
      fs.mkdirSync(root, { mode: 0o700 });
    }
    writeOwnerFile(configPath, JSON.stringify({
      workspaceRoot,
      beadsWorkspace: workspaceRoot,
      beadsWorkspaceId: 'test-beads-workspace',
      trackerOperationStoreRoot,
      workActionOperationStoreRoot,
      executionLinkStoreRoot,
      workActionAuthorizationModule: authorizationModule,
      workActionCompletionModule: completionModule,
      registeredCompletionProducers: ['andrew-owner-attestation'],
    }));

    await withWorkActionEnv({
      JARVOS_WORK_ACTION_SERVICE_MODULE: hostModule,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    }, async () => {
      const { service, error } = loadHostWorkActionService();
      assert.equal(error, null);
      assert.ok(service);
      assert.deepEqual((await service.list()).items, []);
      const roots = [trackerOperationStoreRoot, workActionOperationStoreRoot, executionLinkStoreRoot].map((entry) => fs.realpathSync(entry));
      assert.equal(new Set(roots).size, 3);
      assert.ok(roots.every((entry) => (fs.statSync(entry).mode & 0o077) === 0));
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('the live host fails closed when terminal-authority configuration is incomplete', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-action-terminal-config-'));
  const hostModule = path.join(workspaceRoot, 'work-action-host-service.js');
  const authorizationModule = path.join(workspaceRoot, 'authorize.js');
  const completionModule = path.join(workspaceRoot, 'completion.js');
  const invalidCompletionModule = path.join(workspaceRoot, 'invalid-completion.js');
  const configPath = path.join(workspaceRoot, 'projects.json');
  try {
    fs.copyFileSync(path.join(REPO_ROOT, 'examples', 'work-action-host-service.js'), hostModule);
    fs.chmodSync(hostModule, 0o600);
    writeOwnerFile(authorizationModule, 'module.exports.authorizeMutation = async () => ({ authorized: true });\n');
    writeOwnerFile(completionModule, 'module.exports.resolveCompletionReceipt = async () => null;\n');
    writeOwnerFile(invalidCompletionModule, 'module.exports = {};\n');
    const roots = ['tracker', 'actions', 'links'].map((name) => path.join(workspaceRoot, name));
    for (const root of roots) fs.mkdirSync(root, { mode: 0o700 });
    const base = {
      workspaceRoot,
      beadsWorkspace: workspaceRoot,
      beadsWorkspaceId: 'test-beads-workspace',
      trackerOperationStoreRoot: roots[0],
      workActionOperationStoreRoot: roots[1],
      executionLinkStoreRoot: roots[2],
      workActionAuthorizationModule: authorizationModule,
      workActionCompletionModule: completionModule,
      registeredCompletionProducers: ['andrew-owner-attestation'],
    };
    const cases = [
      { ...base, beadsWorkspaceId: undefined },
      { ...base, workActionCompletionModule: invalidCompletionModule },
      { ...base, registeredCompletionProducers: [] },
    ];
    await withWorkActionEnv({
      JARVOS_WORK_ACTION_SERVICE_MODULE: hostModule,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    }, () => {
      for (const config of cases) {
        writeOwnerFile(configPath, JSON.stringify(config));
        const { service, error } = loadHostWorkActionService();
        assert.equal(service, null);
        assert.match(error, /failed to load/);
        assert.ok(roots.every((root) => (fs.statSync(root).mode & 0o077) === 0));
      }
    });
  } finally {
    delete require.cache[hostModule];
    delete require.cache[invalidCompletionModule];
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('loading the live host never provisions or chmods configured state roots', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-action-read-only-load-'));
  const hostModule = path.join(workspaceRoot, 'work-action-host-service.js');
  const authorizationModule = path.join(workspaceRoot, 'authorize.js');
  const completionModule = path.join(workspaceRoot, 'completion.js');
  const configPath = path.join(workspaceRoot, 'projects.json');
  const missingRoot = path.join(workspaceRoot, 'must-not-be-created');
  try {
    fs.copyFileSync(path.join(REPO_ROOT, 'examples', 'work-action-host-service.js'), hostModule);
    fs.chmodSync(hostModule, 0o600);
    writeOwnerFile(authorizationModule, 'module.exports.authorizeMutation = async () => ({ authorized: true });\n');
    writeOwnerFile(completionModule, 'module.exports.resolveCompletionReceipt = async () => null;\n');
    writeOwnerFile(configPath, JSON.stringify({
      workspaceRoot,
      beadsWorkspace: workspaceRoot,
      beadsWorkspaceId: 'test-beads-workspace',
      trackerOperationStoreRoot: missingRoot,
      workActionOperationStoreRoot: path.join(workspaceRoot, 'also-missing'),
      executionLinkStoreRoot: path.join(workspaceRoot, 'still-missing'),
      workActionAuthorizationModule: authorizationModule,
      workActionCompletionModule: completionModule,
      registeredCompletionProducers: ['andrew-owner-attestation'],
    }));
    await withWorkActionEnv({
      JARVOS_WORK_ACTION_SERVICE_MODULE: hostModule,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    }, () => {
      const { service, error } = loadHostWorkActionService();
      assert.equal(service, null);
      assert.match(error, /failed to load/);
      assert.equal(fs.existsSync(missingRoot), false);
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('the live host rejects owner-only state below non-sticky writable ancestry', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-action-safe-workspace-'));
  const unsafeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-action-unsafe-parent-'));
  const hostModule = path.join(workspaceRoot, 'work-action-host-service.js');
  const authorizationModule = path.join(workspaceRoot, 'authorize.js');
  const completionModule = path.join(workspaceRoot, 'completion.js');
  const configPath = path.join(workspaceRoot, 'projects.json');
  try {
    fs.chmodSync(unsafeParent, 0o777);
    const roots = ['tracker', 'actions', 'links'].map((name) => path.join(unsafeParent, name));
    for (const root of roots) fs.mkdirSync(root, { mode: 0o700 });
    fs.copyFileSync(path.join(REPO_ROOT, 'examples', 'work-action-host-service.js'), hostModule);
    fs.chmodSync(hostModule, 0o600);
    writeOwnerFile(authorizationModule, 'module.exports.authorizeMutation = async () => ({ authorized: true });\n');
    writeOwnerFile(completionModule, 'module.exports.resolveCompletionReceipt = async () => null;\n');
    writeOwnerFile(configPath, JSON.stringify({
      workspaceRoot,
      beadsWorkspace: workspaceRoot,
      beadsWorkspaceId: 'test-beads-workspace',
      trackerOperationStoreRoot: roots[0],
      workActionOperationStoreRoot: roots[1],
      executionLinkStoreRoot: roots[2],
      workActionAuthorizationModule: authorizationModule,
      workActionCompletionModule: completionModule,
      registeredCompletionProducers: ['andrew-owner-attestation'],
    }));
    await withWorkActionEnv({
      JARVOS_WORK_ACTION_SERVICE_MODULE: hostModule,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    }, () => {
      const { service, error } = loadHostWorkActionService();
      assert.equal(service, null);
      assert.match(error, /failed to load/);
      assert.equal(fs.statSync(unsafeParent).mode & 0o777, 0o777);
    });
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(unsafeParent, { recursive: true, force: true });
  }
});

test('the live host rejects executable authorization modules below unsafe nested ancestry', async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-work-action-module-ancestry-'));
  const hostModule = path.join(workspaceRoot, 'work-action-host-service.js');
  const unsafeDirectory = path.join(workspaceRoot, 'unsafe-modules');
  const authorizationModule = path.join(unsafeDirectory, 'authorize.js');
  const completionModule = path.join(workspaceRoot, 'completion.js');
  const configPath = path.join(workspaceRoot, 'projects.json');
  try {
    fs.mkdirSync(unsafeDirectory, { mode: 0o777 });
    fs.chmodSync(unsafeDirectory, 0o777);
    fs.copyFileSync(path.join(REPO_ROOT, 'examples', 'work-action-host-service.js'), hostModule);
    fs.chmodSync(hostModule, 0o600);
    writeOwnerFile(authorizationModule, 'module.exports.authorizeMutation = async () => ({ authorized: true });\n');
    writeOwnerFile(completionModule, 'module.exports.resolveCompletionReceipt = async () => null;\n');
    const roots = ['tracker', 'actions', 'links'].map((name) => path.join(workspaceRoot, name));
    for (const root of roots) fs.mkdirSync(root, { mode: 0o700 });
    writeOwnerFile(configPath, JSON.stringify({
      workspaceRoot,
      beadsWorkspace: workspaceRoot,
      beadsWorkspaceId: 'test-beads-workspace',
      trackerOperationStoreRoot: roots[0],
      workActionOperationStoreRoot: roots[1],
      executionLinkStoreRoot: roots[2],
      workActionAuthorizationModule: authorizationModule,
      workActionCompletionModule: completionModule,
      registeredCompletionProducers: ['andrew-owner-attestation'],
    }));
    await withWorkActionEnv({
      JARVOS_WORK_ACTION_SERVICE_MODULE: hostModule,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    }, () => {
      const { service, error } = loadHostWorkActionService();
      assert.equal(service, null);
      assert.match(error, /failed to load/);
      assert.doesNotMatch(error, /unsafe-modules|authorize\.js/);
    });
  } finally {
    delete require.cache[hostModule];
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
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
