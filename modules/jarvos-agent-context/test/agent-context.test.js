'use strict';

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const jarvosPaths = require('../../jarvos-secondbrain/bridge/config/jarvos-paths.js');
const {
  createNote,
  controlPlane,
  currentWork,
  defaultFrontmatter,
  hydrate,
  readSessionThread,
  redactObviousSecrets,
  synthesizeRecall,
  verifyNoteCaptureContract,
  writeSessionThread,
} = require('../src/index.js');
const {
  callTool,
  PROMPTS,
  TOOLS,
  withToolTimeout,
  resolveHostCredential,
  readCredentialFile,
  CREDENTIAL_ENV,
  CREDENTIAL_FILE_ENV,
} = require('../scripts/jarvos-mcp.js');

function withIsolatedAgentContextPackage(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-agent-context-package-'));
  const packageRoot = path.join(tmp, 'node_modules', '@jarvos', 'agent-context');
  const controlPlaneRoot = path.join(tmp, 'node_modules', '@jarvos', 'control-plane');
  try {
    fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
    fs.mkdirSync(path.dirname(controlPlaneRoot), { recursive: true });
    fs.cpSync(path.join(__dirname, '..', 'src'), path.join(packageRoot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(packageRoot, 'package.json'));
    fs.cpSync(path.join(__dirname, '..', '..', 'jarvos-control-plane', 'src'), path.join(controlPlaneRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(__dirname, '..', '..', 'jarvos-control-plane', 'scripts'), path.join(controlPlaneRoot, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', '..', 'jarvos-control-plane', 'package.json'), path.join(controlPlaneRoot, 'package.json'));
    return fn(packageRoot);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function withTempVault(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-agent-context-'));
  const vault = path.join(tmp, 'vault');
  const notes = path.join(vault, 'Notes');
  const journal = path.join(vault, 'Journal');
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(journal, { recursive: true });

  const oldEnv = {
    JARVOS_VAULT_DIR: process.env.JARVOS_VAULT_DIR,
    JARVOS_NOTES_DIR: process.env.JARVOS_NOTES_DIR,
    JARVOS_JOURNAL_DIR: process.env.JARVOS_JOURNAL_DIR,
    JARVOS_TIMEZONE: process.env.JARVOS_TIMEZONE,
    JARVOS_SESSION_THREAD_ID: process.env.JARVOS_SESSION_THREAD_ID,
    JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE: process.env.JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE,
  };

  process.env.JARVOS_VAULT_DIR = vault;
  process.env.JARVOS_NOTES_DIR = notes;
  process.env.JARVOS_JOURNAL_DIR = journal;
  process.env.JARVOS_TIMEZONE = 'UTC';
  process.env.JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE = '1';
  jarvosPaths.resetConfigCache();

  let result;
  try {
    result = fn({ tmp, vault, notes, journal });
  } catch (error) {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jarvosPaths.resetConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }

  const cleanup = () => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jarvosPaths.resetConfigCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

async function withControlPlaneHost(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-control-plane-host-'));
  const hostModule = path.join(tmp, 'host-service.js');
  const previous = process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
  const previousCredential = process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
  const source = path.join(__dirname, '..', '..', 'jarvos-control-plane', 'src', 'index.js');
  fs.writeFileSync(hostModule, [
    `const { createApplicationService, createMemoryApplicationStore } = require(${JSON.stringify(source)});`,
    "const service = createApplicationService({ store: createMemoryApplicationStore(), resolveCredential: (credential) => credential === 'test-credential' ? { id: 'principal:test', capabilities: ['control-plane.read', 'control-plane.mutate', 'control-plane.approve'], maxSensitivity: 'internal' } : null, canRead: () => true, policy: () => ({ outcome: 'require_approval', allowCreatorApproval: true, requiredCapability: 'control-plane.approve' }) });",
    'module.exports = () => service;',
  ].join('\n'), 'utf8');
  process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE = hostModule;
  // The MCP surface binds the credential from the host session, never from
  // model-visible tool input.
  process.env.JARVOS_CONTROL_PLANE_CREDENTIAL = 'test-credential';
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
    else process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE = previous;
    if (previousCredential === undefined) delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    else process.env.JARVOS_CONTROL_PLANE_CREDENTIAL = previousCredential;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('defaultFrontmatter includes note-capture contract fields', () => {
  const frontmatter = defaultFrontmatter({ project: 'codex' });
  assert.equal(frontmatter.status, 'draft');
  assert.equal(frontmatter.type, 'note');
  assert.equal(frontmatter.project, 'codex');
});

test('control-plane service gives authenticated human and MCP callers the same core lifecycle', async () => {
  await withControlPlaneHost(async () => {
    const input = {
      credential: 'test-credential', actor: { kind: 'agent', harness: 'test' },
      resource: { machineId: 'machine-test', type: 'workspace', id: 'one' }, mutationClass: 'workspace.test',
      desiredGeneration: '1', commandSpec: { operation: 'test' }, idempotencyKey: 'agent-context-parity',
    };
    assert.throws(() => controlPlane('list', {}), /authentication failed/);
    const human = controlPlane('request', input);
    assert.equal(human.ok, true);
    assert.equal(human.request.status, 'approval_required');
    // The MCP caller supplies no credential; it is bound server-side. A model
    // credential is ignored even if passed.
    const mcp = await callTool('jarvos_control_plane', { operation: 'approval-state', credential: 'attacker-supplied', requestId: human.request.id });
    assert.equal(mcp.isError, false);
    assert.match(mcp.content[0].text, /approval_required/);
    const approved = controlPlane('approve', { credential: 'test-credential', requestId: human.request.id, fence: human.request.approval.fence });
    assert.equal(approved.request.status, 'approved');
  });
});

test('control-plane manager never resolves from a shadowing workspace cwd', () => {
  const { loadControlPlaneManager } = require('../src/index.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-shadow-'));
  const previousCwd = process.cwd();
  try {
    // Plant a hostile @jarvos/control-plane/manager under the workspace cwd.
    const shadowDir = path.join(tmp, 'node_modules', '@jarvos', 'control-plane');
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'package.json'), JSON.stringify({
      name: '@jarvos/control-plane', version: '9.9.9', exports: { './manager': './manager.js' },
    }), 'utf8');
    fs.writeFileSync(path.join(shadowDir, 'manager.js'), 'module.exports = { __shadow: true, createControlPlaneService() { throw new Error("shadow manager was loaded"); } };', 'utf8');

    process.chdir(tmp);
    const manager = loadControlPlaneManager();
    assert.notEqual(manager.__shadow, true, 'workspace cwd must never shadow the control-plane manager');
    assert.equal(typeof manager.createControlPlaneService, 'function');
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('published agent-context resolves its declared control-plane dependency in an isolated install', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.dependencies['@jarvos/control-plane'], '0.1.0');
  withIsolatedAgentContextPackage((packageRoot) => {
    const isolated = require(packageRoot);
    const { createApplicationService, createMemoryApplicationStore } = require(path.join(packageRoot, '..', 'control-plane', 'src'));
    const applicationService = createApplicationService({
      store: createMemoryApplicationStore(),
      resolveCredential: () => ({ id: 'principal:isolated', capabilities: ['control-plane.read'] }),
      canRead: () => true,
    });
    const result = isolated.controlPlane('list', { credential: 'installed-package' }, { applicationService });
    assert.equal(result.ok, true);
  });
});

test('createNote writes note, links journal, and verifies contract', () => {
  withTempVault(({ notes, journal }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const journalPath = path.join(journal, `${date}.md`);
    fs.writeFileSync(journalPath, `# ${date}\n\n## 📝 Notes\n`, 'utf8');

    const result = createNote({
      title: 'Codex jarvOS Adapter Test',
      content: 'Research notes for Codex.',
      frontmatter: { project: 'codex' },
    });

    assert.equal(result.ok, true);
    assert.ok(result.note.path.startsWith(notes));
    assert.ok(fs.readFileSync(result.note.path, 'utf8').includes('project: "codex"'));
    assert.ok(fs.readFileSync(journalPath, 'utf8').includes('[[Codex jarvOS Adapter Test]]'));
    assert.equal(result.verification.ok, true);
    assert.equal(result.note.journal.journalPath, journalPath);
    assert.equal(result.note.knowledge.optimized, true);
    assert.equal(result.note.knowledge.qmdStatus, 'pending-refresh');
    assert.ok(fs.existsSync(result.note.knowledge.artifactPath));

    const verification = verifyNoteCaptureContract({
      notePath: result.note.path,
      noteTitle: 'Codex jarvOS Adapter Test',
      notesDir: notes,
      journalPath,
      section: '📝 Notes',
    });
    assert.equal(verification.ok, true);
  });
});

test('createNote creates today journal when missing', () => {
  withTempVault(({ journal }) => {
    const result = createNote({
      title: 'Missing Journal Test',
      content: 'Create the journal if needed.',
    });

    assert.equal(result.ok, true);
    assert.ok(result.journal.journalPath.startsWith(journal));
    assert.ok(fs.readFileSync(result.journal.journalPath, 'utf8').includes('[[Missing Journal Test]]'));
  });
});

test('session thread writes a note, links today journal, and reads across hosts', () => {
  withTempVault(({ notes, journal }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const write = writeSessionThread({
      threadId: 'SUP-2219',
      issueIdentifier: 'SUP-2219',
      artifact: 'SUP-2219',
      project: 'continuity',
      host: 'claude-code',
      actor: 'Claude',
      event: 'decision',
      summary: 'Read side works; write side needs the shared session thread.',
      nextStep: 'Have Codex read this on entry and continue the implementation.',
    });

    assert.equal(write.ok, true);
    assert.ok(write.note.path.startsWith(notes));
    assert.ok(fs.readFileSync(write.note.path, 'utf8').includes('Have Codex read this on entry'));
    assert.ok(fs.readFileSync(path.join(journal, `${date}.md`), 'utf8').includes('[[JarvOS Session Thread - SUP-2219]]'));

    const read = readSessionThread({
      threadId: 'SUP-2219',
      host: 'codex',
    });
    assert.equal(read.found, true);
    assert.match(read.markdown, /Claude - decision/);
    assert.match(read.markdown, /Next:/);
    assert.match(read.markdown, /Have Codex read this on entry/);
  });
});

test('session thread writes serialize concurrent checkpoints', async () => {
  await withTempVault(async () => {
    const script = `
      const { writeSessionThread } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'index.js'))});
      const worker = process.argv[1];
      writeSessionThread({
        threadId: 'race-thread',
        actor: worker,
        event: 'checkpoint',
        summary: 'summary from ' + worker,
        lockTimeoutMs: 30000,
        lockRetryDelayMs: 25
      });
    `;

    const children = Array.from({ length: 6 }, (_, index) => {
      return spawn(process.execPath, ['-e', script, `worker-${index}`], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });

    const results = await Promise.all(children.map((child) => new Promise((resolve) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (code) => resolve({ code, stderr }));
    })));

    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }

    const read = readSessionThread({ threadId: 'race-thread', maxChars: 12000 });
    for (let index = 0; index < children.length; index += 1) {
      assert.match(read.content, new RegExp(`summary from worker-${index}`));
    }
  });
});

test('session thread defaults prefer current Paperclip task over global host thread', () => {
  withTempVault(() => {
    const oldPaperclipTaskId = process.env.PAPERCLIP_TASK_ID;
    const oldSessionThreadId = process.env.JARVOS_SESSION_THREAD_ID;
    process.env.PAPERCLIP_TASK_ID = 'SUP-2219';
    process.env.JARVOS_SESSION_THREAD_ID = 'global-host-thread';
    try {
      const write = writeSessionThread({
        actor: 'Codex',
        event: 'checkpoint',
        summary: 'Issue-specific handoff.',
      });
      assert.match(write.title, /SUP-2219/);
      assert.doesNotMatch(write.title, /global-host-thread/);
      assert.equal(readSessionThread({ threadId: 'SUP-2219' }).found, true);
      assert.equal(readSessionThread({ threadId: 'global-host-thread' }).found, false);
    } finally {
      if (oldPaperclipTaskId === undefined) delete process.env.PAPERCLIP_TASK_ID;
      else process.env.PAPERCLIP_TASK_ID = oldPaperclipTaskId;
      if (oldSessionThreadId === undefined) delete process.env.JARVOS_SESSION_THREAD_ID;
      else process.env.JARVOS_SESSION_THREAD_ID = oldSessionThreadId;
    }
  });
});

test('MCP session thread tools round-trip through the shared note and journal path', async () => {
  await withTempVault(async ({ journal }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const write = await callTool('jarvos_session_thread_write', {
      threadId: 'artifact-a',
      artifact: 'artifact-a',
      host: 'openclaw',
      actor: 'OpenClaw',
      event: 'artifact-change',
      summary: 'Artifact moved from draft to review.',
      nextStep: 'Review the linked artifact before editing.',
    });
    assert.equal(write.isError, false);
    assert.match(write.content[0].text, /jarvOS Session Thread Written/);
    assert.ok(fs.readFileSync(path.join(journal, `${date}.md`), 'utf8').includes('[[JarvOS Session Thread - artifact-a]]'));

    const read = await callTool('jarvos_session_thread_read', {
      threadId: 'artifact-a',
      host: 'codex',
    });
    assert.equal(read.isError, false);
    assert.match(read.content[0].text, /Artifact moved from draft to review/);
    assert.match(read.content[0].text, /Review the linked artifact before editing/);
  });
});

test('MCP tool list includes jarvOS tools', () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    'jarvos_control_plane',
    'jarvos_current_work',
    'jarvos_recall',
    'jarvos_synthesize',
    'jarvos_create_note',
    'jarvos_session_thread_read',
    'jarvos_session_thread_write',
    'jarvos_startup_brief',
    'jarvos_hydrate',
  ]);
  assert.match(
    TOOLS.find((tool) => tool.name === 'jarvos_hydrate').description,
    /boot jarvOS/,
  );
});

test('control-plane MCP tool never takes a model-visible credential', () => {
  const controlPlaneTool = TOOLS.find((tool) => tool.name === 'jarvos_control_plane');
  assert.ok(!(controlPlaneTool.inputSchema.required || []).includes('credential'));
  assert.ok(!('credential' in (controlPlaneTool.inputSchema.properties || {})));
  assert.deepEqual(controlPlaneTool.inputSchema.required, ['operation']);
});

test('Codex setup registers only credential file path, never the secret value', () => {
  const setupPath = path.join(__dirname, '..', '..', '..', 'runtimes', 'codex', 'setup.sh');
  const source = fs.readFileSync(setupPath, 'utf8');
  // Persisted MCP registration must use the file-path binding.
  assert.match(source, /JARVOS_CONTROL_PLANE_CREDENTIAL_FILE/);
  assert.match(source, /--env "JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=\$CONTROL_PLANE_CREDENTIAL_FILE"/);
  // Never put the secret on codex mcp add argv / config.
  // Negative lookahead: CREDENTIAL_FILE must not count as the forbidden binding.
  assert.doesNotMatch(source, /--env\s+["']?JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)=/);
  assert.doesNotMatch(source, /JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)=\$\{?CONTROL_PLANE_CREDENTIAL\}?/);
  // Setup must not require ambient secret for registration.
  assert.doesNotMatch(source, /CONTROL_PLANE_CREDENTIAL="\$\{JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)/);
});

// Executable setup.sh branches with a fake codex on PATH and a temp CODEX_CONFIG.
// Never mutates the real ~/.codex/config.toml.
function runCodexSetup(envOverrides = {}) {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const setupPath = path.join(repoRoot, 'runtimes', 'codex', 'setup.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-setup-'));
  const binDir = path.join(tmp, 'bin');
  const codexLog = path.join(tmp, 'codex-args.log');
  const configPath = path.join(tmp, 'codex-config.toml');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(configPath, '', 'utf8');
  // Fake codex records invocations and pretends jarvos is not registered.
  const fakeCodex = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf '%s\\n' "$*" >> ${JSON.stringify(codexLog)}`,
    'if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "get" ]; then exit 1; fi',
    'exit 0',
    '',
  ].join('\n');
  const fakeCodexPath = path.join(binDir, 'codex');
  fs.writeFileSync(fakeCodexPath, fakeCodex, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(fakeCodexPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    CODEX_CONFIG: configPath,
    // Public-only setup: clear private host bindings unless the caller sets them.
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: '',
    JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: '',
    ...envOverrides,
  };
  // Empty string override should delete so setup sees "unset".
  if (!env.JARVOS_CONTROL_PLANE_SERVICE_MODULE) delete env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
  if (!env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE) delete env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;

  const result = spawnSync('bash', [setupPath], {
    encoding: 'utf8',
    cwd: repoRoot,
    env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    tmp,
    configPath,
    codexLog,
    result,
    cleanup() {
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

test('Codex setup succeeds publicly with no control-plane host pair', () => {
  const run = runCodexSetup();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    assert.match(run.result.stdout, /Registered jarvOS MCP server for Codex:/);
    assert.doesNotMatch(run.result.stdout, /control-plane host bindings/);
    const log = fs.existsSync(run.codexLog) ? fs.readFileSync(run.codexLog, 'utf8') : '';
    assert.match(log, /mcp add /);
    assert.doesNotMatch(log, /JARVOS_CONTROL_PLANE_SERVICE_MODULE=/);
    assert.doesNotMatch(log, /JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=/);
    assert.doesNotMatch(log, /JARVOS_CONTROL_PLANE_CREDENTIAL=/);
    // Real user config must not be touched; only the temp CODEX_CONFIG may change.
    assert.ok(fs.existsSync(run.configPath));
  } finally {
    run.cleanup();
  }
});

test('Codex setup fails closed on half control-plane host pair', () => {
  const onlyService = runCodexSetup({
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: path.join(__dirname, '..', '..', 'jarvos-control-plane', 'scripts', 'jarvos-manager.js'),
  });
  try {
    assert.notEqual(onlyService.result.status, 0);
    assert.match(onlyService.result.stderr, /JARVOS_CONTROL_PLANE_CREDENTIAL_FILE/);
    assert.ok(!fs.existsSync(onlyService.codexLog) || !fs.readFileSync(onlyService.codexLog, 'utf8').includes('mcp add'),
      'half-pair must not register MCP');
  } finally {
    onlyService.cleanup();
  }

  const credTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-setup-half-cred-'));
  try {
    const credFile = path.join(credTmp, 'cred');
    fs.writeFileSync(credFile, 'secret\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(credFile, 0o600);
    const onlyCred = runCodexSetup({
      JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: credFile,
    });
    try {
      assert.notEqual(onlyCred.result.status, 0);
      assert.match(onlyCred.result.stderr, /JARVOS_CONTROL_PLANE_SERVICE_MODULE/);
    } finally {
      onlyCred.cleanup();
    }
  } finally {
    fs.rmSync(credTmp, { recursive: true, force: true });
  }
});

test('Codex setup fails closed on unsafe credential mode or ancestry', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const hostModule = path.join(repoRoot, 'modules', 'jarvos-control-plane', 'scripts', 'jarvos-manager.js');
  const secret = 'setup-unsafe-secret-never-logged';

  // World-readable leaf.
  const modeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-setup-mode-'));
  try {
    const openCred = path.join(modeTmp, 'open.credential');
    fs.writeFileSync(openCred, `${secret}\n`, { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(openCred, 0o644);
    const run = runCodexSetup({
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: hostModule,
      JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: openCred,
    });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /owner-only|credential file/i);
      assert.ok(!run.result.stderr.includes(secret), 'stderr must not include secret');
      assert.ok(!run.result.stderr.includes(openCred), 'stderr must not include credential path');
      assert.ok(!fs.existsSync(run.codexLog) || !fs.readFileSync(run.codexLog, 'utf8').includes('mcp add'));
    } finally {
      run.cleanup();
    }
  } finally {
    fs.rmSync(modeTmp, { recursive: true, force: true });
  }

  // Non-sticky world-writable parent ancestry.
  const ancestryTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-setup-ancestry-'));
  try {
    const unsafeParent = path.join(ancestryTmp, 'unsafe');
    fs.mkdirSync(unsafeParent, { recursive: true });
    fs.chmodSync(unsafeParent, 0o777);
    const nestedCred = path.join(unsafeParent, 'nested.credential');
    fs.writeFileSync(nestedCred, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(nestedCred, 0o600);
    const run = runCodexSetup({
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: hostModule,
      JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: nestedCred,
    });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /owner-only|trusted non-writable|credential file/i);
      assert.ok(!run.result.stderr.includes(secret), 'stderr must not include secret');
      assert.ok(!run.result.stderr.includes(nestedCred), 'stderr must not include credential path');
    } finally {
      run.cleanup();
    }
    fs.chmodSync(unsafeParent, 0o755);
  } finally {
    fs.rmSync(ancestryTmp, { recursive: true, force: true });
  }
});

test('resolveHostCredential reads owner-only credential file and fails closed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-cred-'));
  const previousFile = process.env[CREDENTIAL_FILE_ENV];
  const previousAmbient = process.env[CREDENTIAL_ENV];
  try {
    delete process.env[CREDENTIAL_FILE_ENV];
    delete process.env[CREDENTIAL_ENV];

    const secret = 'file-secret';
    const credFile = path.join(tmp, 'control-plane.credential');
    fs.writeFileSync(credFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(credFile, 0o600);

    assert.equal(readCredentialFile(credFile), secret);
    assert.equal(resolveHostCredential({ [CREDENTIAL_FILE_ENV]: credFile }), secret);

    // Ambient env remains valid when no file binding is configured.
    assert.equal(resolveHostCredential({ [CREDENTIAL_ENV]: 'ambient-secret' }), 'ambient-secret');
    assert.equal(resolveHostCredential({}), null);

    // Relative paths fail closed.
    assert.throws(() => readCredentialFile('relative/secret'), /absolute path/);

    // Missing file fails closed (and does not fall through to ambient when set).
    const missing = path.join(tmp, 'missing.credential');
    assert.throws(
      () => resolveHostCredential({ [CREDENTIAL_FILE_ENV]: missing, [CREDENTIAL_ENV]: 'ambient-secret' }),
      /does not exist/,
    );

    // Empty file fails closed.
    const empty = path.join(tmp, 'empty.credential');
    fs.writeFileSync(empty, '', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(empty, 0o600);
    assert.throws(() => readCredentialFile(empty), /empty/);

    // Group/other-readable file fails closed.
    const open = path.join(tmp, 'open.credential');
    fs.writeFileSync(open, 'leaky\n', { encoding: 'utf8', mode: 0o644 });
    fs.chmodSync(open, 0o644);
    assert.throws(() => {
      try {
        readCredentialFile(open);
      } catch (error) {
        assert.ok(!String(error.message).includes('leaky'), 'error must not include secret');
        assert.ok(!String(error.message).includes(open), 'error must not include path');
        throw error;
      }
    }, /owner-only/);

    // Unsafe writable parent (non-sticky) fails closed for ancestry.
    const unsafeParent = path.join(tmp, 'unsafe-parent');
    fs.mkdirSync(unsafeParent, { recursive: true });
    fs.chmodSync(unsafeParent, 0o777);
    const nested = path.join(unsafeParent, 'nested.credential');
    fs.writeFileSync(nested, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(nested, 0o600);
    assert.throws(() => {
      try {
        readCredentialFile(nested);
      } catch (error) {
        assert.ok(!String(error.message).includes(secret), 'ancestry error must not include secret');
        assert.ok(!String(error.message).includes(nested), 'ancestry error must not include path');
        throw error;
      }
    }, /writable location|untrusted location/);
    fs.chmodSync(unsafeParent, 0o755);

    // Directory is not a credential file.
    assert.throws(() => readCredentialFile(tmp), /regular file/);
  } finally {
    if (previousFile === undefined) delete process.env[CREDENTIAL_FILE_ENV];
    else process.env[CREDENTIAL_FILE_ENV] = previousFile;
    if (previousAmbient === undefined) delete process.env[CREDENTIAL_ENV];
    else process.env[CREDENTIAL_ENV] = previousAmbient;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('MCP approve fence is coerced to CLI integer semantics', async () => {
  await withControlPlaneHost(async () => {
    const created = controlPlane('request', {
      credential: 'test-credential',
      actor: { kind: 'agent', harness: 'test' },
      resource: { machineId: 'machine-test', type: 'workspace', id: 'fence-coerce' },
      mutationClass: 'workspace.test',
      desiredGeneration: '1',
      commandSpec: { operation: 'test' },
      idempotencyKey: 'mcp-fence-coerce',
    });
    assert.equal(created.ok, true);
    const fence = created.request.approval.fence;
    assert.equal(typeof fence, 'number');

    // String fence (JSON-style) must coerce and approve, matching CLI --fence.
    const approved = await callTool('jarvos_control_plane', {
      operation: 'approve',
      requestId: created.request.id,
      fence: String(fence),
    });
    assert.equal(approved.isError, false, approved.content?.[0]?.text);
    assert.match(approved.content[0].text, /"status": "approved"/);

    // Invalid fence values fail closed without crashing the transport.
    const bad = await callTool('jarvos_control_plane', {
      operation: 'approve',
      requestId: created.request.id,
      fence: 'not-an-integer',
    });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /fence must be an integer/);
  });
});

test('control-plane MCP tool binds credential from file at runtime', async () => {
  await withControlPlaneHost(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-file-bind-'));
    const previousFile = process.env[CREDENTIAL_FILE_ENV];
    const previousAmbient = process.env[CREDENTIAL_ENV];
    try {
      const credFile = path.join(tmp, 'control-plane.credential');
      fs.writeFileSync(credFile, 'test-credential\n', { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(credFile, 0o600);

      // Prefer file binding over ambient; clear ambient to prove file path works.
      delete process.env[CREDENTIAL_ENV];
      process.env[CREDENTIAL_FILE_ENV] = credFile;

      const listed = await callTool('jarvos_control_plane', { operation: 'list' });
      assert.equal(listed.isError, false, listed.content?.[0]?.text);
      assert.match(listed.content[0].text, /"ok": true/);

      // Fail closed when the configured file is unusable (do not use ambient).
      process.env[CREDENTIAL_ENV] = 'test-credential';
      process.env[CREDENTIAL_FILE_ENV] = path.join(tmp, 'missing.credential');
      const failed = await callTool('jarvos_control_plane', { operation: 'list' });
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /does not exist|credential/i);
    } finally {
      if (previousFile === undefined) delete process.env[CREDENTIAL_FILE_ENV];
      else process.env[CREDENTIAL_FILE_ENV] = previousFile;
      if (previousAmbient === undefined) delete process.env[CREDENTIAL_ENV];
      else process.env[CREDENTIAL_ENV] = previousAmbient;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function mcpRequest(message) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'jarvos-mcp.js'),
  ], {
    input: `${JSON.stringify(message)}\n`,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, result.stdout);
  return JSON.parse(lines[0]);
}

test('MCP initialize advertises tool and prompt capabilities', () => {
  const response = mcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  });

  assert.equal(response.id, 1);
  assert.deepEqual(response.result.capabilities, { tools: {}, prompts: {} });
});

test('MCP prompt list includes boot jarvOS prompt', () => {
  assert.deepEqual(PROMPTS.map((prompt) => prompt.name), ['boot_jarvos']);

  const response = mcpRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'prompts/list',
    params: {},
  });

  assert.equal(response.id, 2);
  assert.equal(response.result.prompts[0].name, 'boot_jarvos');
  assert.equal(response.result.prompts[0].title, 'Boot jarvOS');
  assert.match(response.result.prompts[0].description, /Working Context Packet/);
});

test('MCP prompt get returns boot jarvOS instructions', () => {
  const response = mcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'prompts/get',
    params: { name: 'boot_jarvos', arguments: { maxChars: 7500 } },
  });

  const message = response.result.messages[0];
  assert.equal(message.role, 'user');
  assert.match(message.content.text, /Boot jarvOS/);
  assert.match(message.content.text, /jarvos_hydrate/);
  assert.match(message.content.text, /maxChars: 7500/);
  assert.match(message.content.text, /Hydration Report/);
  assert.match(message.content.text, /Do not paste raw private notes/);
});

test('MCP prompt get reports unknown prompts as JSON-RPC errors', () => {
  const response = mcpRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'prompts/get',
    params: { name: 'missing_prompt' },
  });

  assert.equal(response.id, 4);
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /Unknown prompt: missing_prompt/);
});

test('MCP jarvos_create_note returns text content', async () => {
  await withTempVault(async ({ journal }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    fs.writeFileSync(path.join(journal, `${date}.md`), `# ${date}\n\n## 📝 Notes\n`, 'utf8');

    const result = await callTool('jarvos_create_note', {
      title: 'MCP Note Test',
      content: 'Created through the MCP call path.',
    });
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, /jarvOS Note Created/);
  });
});

test('MCP timeout logs late tool completion after bounded failure', async () => {
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function captureWrite(chunk, encoding, callback) {
    writes.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };

  try {
    await assert.rejects(
      withToolTimeout('slow_tool', () => new Promise((resolve) => {
        setTimeout(() => resolve('ok'), 20);
      }), 1),
      /slow_tool timed out after 1ms/,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.match(writes.join(''), /jarvos_mcp_tool_late_settlement/);
  assert.match(writes.join(''), /slow_tool/);
});

test('jarvos_recall can return WS5 synthesis over WS4 retrieval evidence', () => {
  const result = synthesizeRecall({
    query: 'What matters for jarvOS notes?',
    dryRun: true,
    includeQmd: true,
    autoGraph: false,
  });

  assert.equal(result.ok, true);
  assert.match(result.markdown, /jarvOS Retrieval Synthesis/);
  assert.match(result.markdown, /Retrieval Status/);
  assert.match(result.markdown, /Source Bundle/);
});

test('MCP jarvos_synthesize returns text content', async () => {
  const result = await callTool('jarvos_synthesize', {
    query: 'What matters for jarvOS notes?',
    dryRun: true,
    includeQmd: true,
    autoGraph: false,
  });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /jarvOS Retrieval Synthesis/);
});

test('currentWork can filter hydration statuses and omit unbacked in_review issues', async () => {
  const oldFetch = global.fetch;
  const oldEnv = {
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
  };

  process.env.PAPERCLIP_API_KEY = 'test-key';
  process.env.PAPERCLIP_COMPANY_ID = 'company-1';
  process.env.PAPERCLIP_AGENT_ID = 'agent-1';
  global.fetch = async () => ({
    ok: true,
    json: async () => ([
      { identifier: 'WORK-1', status: 'in_progress', title: 'Active work', assigneeAgentId: 'agent-1' },
      { identifier: 'WORK-2', status: 'in_review', title: 'Review PR #42', assigneeAgentId: 'agent-1' },
      { identifier: 'WORK-3', status: 'in_review', title: 'No review artifact', assigneeAgentId: 'agent-1' },
      { identifier: 'WORK-4', status: 'todo', title: 'Later', assigneeAgentId: 'agent-1' },
    ]),
  });

  try {
    const result = await currentWork({ statuses: ['in_progress', 'in_review'], maxItems: 10 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.issues.map((issue) => issue.identifier), ['WORK-1', 'WORK-2']);
    assert.match(result.markdown, /WORK-1/);
    assert.match(result.markdown, /WORK-2/);
    assert.doesNotMatch(result.markdown, /WORK-3/);
    assert.doesNotMatch(result.markdown, /WORK-4/);
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('redactObviousSecrets removes common token shapes', () => {
  const redacted = redactObviousSecrets('OPENAI_API_KEY=sk-abc12345678901234567890\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz');
  assert.match(redacted, /OPENAI_API_KEY=/);
  assert.doesNotMatch(redacted, /abc12345678901234567890/);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz/);
});

test('hydrate includes journal, linked notes, ontology context packet, report, and redacts secrets', async () => {
  const oldFetch = global.fetch;
  const oldEnv = {
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
  };

  process.env.PAPERCLIP_API_KEY = 'test-key';
  process.env.PAPERCLIP_COMPANY_ID = 'company-1';
  process.env.PAPERCLIP_AGENT_ID = 'agent-1';
  global.fetch = async () => ({
    ok: true,
    json: async () => ([
      { identifier: 'WORK-1558', status: 'in_progress', title: 'Codex app hydration', assigneeAgentId: 'agent-1' },
    ]),
  });

  try {
    await withTempVault(async ({ notes, journal, tmp }) => {
      const journalPath = path.join(journal, '2026-05-12.md');
      fs.writeFileSync(journalPath, '# 2026-05-12\n\nWork on [[Codex Memory Note]].\nAPI_KEY=sk-abc12345678901234567890\n', 'utf8');
      fs.writeFileSync(path.join(notes, 'Codex Memory Note.md'), '# Codex Memory Note\n\nHydration detail.\n', 'utf8');

      const ontologyDir = path.join(tmp, 'ontology');
      fs.mkdirSync(ontologyDir, { recursive: true });
      fs.writeFileSync(path.join(ontologyDir, '1-higher-order.md'), '# Higher\n\n## My Higher Order\n\nUse meaning to interpret and prioritize work.\n', 'utf8');
      fs.writeFileSync(path.join(ontologyDir, '5-goals.md'), '## G1 — Build shared memory\n\n**Status:** active\n', 'utf8');

      const result = await hydrate({
        maxChars: 9000,
        journal: { date: '2026-05-12', timeZone: 'UTC' },
        ontology: { ontologyDir },
      });

      assert.equal(result.ok, true);
      assert.match(result.markdown, /WORK-1558/);
      assert.match(result.markdown, /Today Journal/);
      assert.match(result.markdown, /Codex Memory Note/);
      assert.match(result.markdown, /jarvOS Ontology Context Packet/);
      assert.match(result.markdown, /hierarchy-of-meaning/);
      assert.match(result.markdown, /G1/);
      assert.match(result.markdown, /Hydration Report/);
      assert.match(result.markdown, /Redaction/);
      assert.ok(result.markdown.length <= 9000);
      assert.doesNotMatch(result.markdown, /abc12345678901234567890/);
    });
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('hydrate ignores journal wikilinks that resolve outside the notes directory', async () => {
  const oldFetch = global.fetch;
  const oldEnv = {
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
  };

  process.env.PAPERCLIP_API_KEY = 'test-key';
  process.env.PAPERCLIP_COMPANY_ID = 'company-1';
  process.env.PAPERCLIP_AGENT_ID = 'agent-1';
  global.fetch = async () => ({
    ok: true,
    json: async () => ([]),
  });

  try {
    await withTempVault(async ({ vault, notes, journal }) => {
      fs.writeFileSync(path.join(journal, '2026-05-12.md'), '# 2026-05-12\n\n[[../Secret]] and [[Visible Note]]\n', 'utf8');
      fs.writeFileSync(path.join(vault, 'Secret.md'), '# Secret\n\nOutside notes content.\n', 'utf8');
      fs.writeFileSync(path.join(notes, 'Visible Note.md'), '# Visible Note\n\nInside notes content.\n', 'utf8');

      const result = await hydrate({
        maxChars: 9000,
        journal: { date: '2026-05-12', timeZone: 'UTC' },
        ontology: { ontologyDir: path.join(vault, 'missing-ontology') },
      });

      assert.match(result.markdown, /Inside notes content/);
      assert.match(result.markdown, /linked note not found: \[\[\.\.\/Secret\]\]/);
      assert.doesNotMatch(result.markdown, /Outside notes content/);
    });
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('hydrate keeps final output within the configured character budget', async () => {
  const oldFetch = global.fetch;
  const oldEnv = {
    PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
    PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
    PAPERCLIP_AGENT_ID: process.env.PAPERCLIP_AGENT_ID,
  };

  process.env.PAPERCLIP_API_KEY = 'test-key';
  process.env.PAPERCLIP_COMPANY_ID = 'company-1';
  process.env.PAPERCLIP_AGENT_ID = 'agent-1';
  global.fetch = async () => ({
    ok: true,
    json: async () => ([]),
  });

  try {
    await withTempVault(async ({ journal }) => {
      fs.writeFileSync(path.join(journal, '2026-05-12.md'), `# 2026-05-12\n\n${'journal detail '.repeat(400)}\n`, 'utf8');

      const result = await hydrate({
        maxChars: 900,
        journal: { date: '2026-05-12', timeZone: 'UTC' },
        ontology: { ontologyDir: path.join(journal, 'missing-ontology') },
      });

      assert.ok(result.markdown.length <= 900);
      assert.equal(result.report.finalChars, result.markdown.length);
      assert.doesNotMatch(result.markdown, /No live session thread found/);
    });
  } finally {
    global.fetch = oldFetch;
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('MCP jarvos_hydrate returns text content', async () => {
  await withTempVault(async ({ journal }) => {
    const oldEnv = {
      JARVOS_PAPERCLIP_ENV_FILE: process.env.JARVOS_PAPERCLIP_ENV_FILE,
      PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
      PAPERCLIP_COMPANY_ID: process.env.PAPERCLIP_COMPANY_ID,
    };
    process.env.JARVOS_PAPERCLIP_ENV_FILE = path.join(journal, 'missing-paperclip-env.sh');
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_COMPANY_ID;
    fs.writeFileSync(path.join(journal, '2026-05-12.md'), '# 2026-05-12\n\nNo links today.\n', 'utf8');
    try {
      const result = await callTool('jarvos_hydrate', {
        maxChars: 5000,
        journal: { date: '2026-05-12', timeZone: 'UTC' },
      });
      assert.equal(result.isError, false);
      assert.match(result.content[0].text, /jarvOS Working Context Packet/);
    } finally {
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
