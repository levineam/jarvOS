'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const jarvosPaths = require('../../jarvos-secondbrain/bridge/config/jarvos-paths.js');
const { createJarvosVaultTransforms } = require('../../jarvos-secondbrain/src/vault-transform-registry.js');
const {
  createNote,
  controlPlane,
  currentWork,
  defaultFrontmatter,
  ensureTodayJournal,
  healthTodayJournal,
  hydrate,
  readSessionThread,
  redactObviousSecrets,
  synthesizeRecall,
  verifyNoteCaptureContract,
  writeSessionThread,
} = require('../src/index.js');
const {
  CONFIG_ENV: PROJECTS_CONTEXT_CONFIG_ENV,
  createHostProjectsContextProvider,
} = require('../src/projects-context-bootstrap.js');
const { issueRouteCapability } = require('../../jarvos-runtime-kit/src/index.js');
const {
  callTool,
  PROMPTS,
  TOOLS,
  withToolTimeout,
  resolveHostCredential,
  readCredentialFile,
  CREDENTIAL_ENV,
  CREDENTIAL_FILE_ENV,
  WORK_ACTION_HOST_UNAVAILABLE,
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
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    // Isolate the workspace default too: without this, config-derived
    // fallbacks that key off getClawdDir() (e.g. the Projects context config
    // path) would resolve against whatever real workspace happens to exist
    // on the machine running the suite, instead of the temp fixture.
    JARVOS_WORKSPACE_DIR: process.env.JARVOS_WORKSPACE_DIR,
  };

  process.env.JARVOS_VAULT_DIR = vault;
  process.env.JARVOS_NOTES_DIR = notes;
  process.env.JARVOS_JOURNAL_DIR = journal;
  process.env.JARVOS_TIMEZONE = 'UTC';
  process.env.JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE = '1';
  process.env.XDG_STATE_HOME = path.join(tmp, 'state');
  process.env.JARVOS_WORKSPACE_DIR = tmp;
  jarvosPaths.resetConfigCache();

  let result;
  try {
    result = fn({ tmp, vault, notes, journal, mutationService: fakeMutationService(vault) });
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

function fakeMutationService(vaultRoot) {
  const transforms = createJarvosVaultTransforms();
  const vaultId = 'test-agent-context-vault';
  let sequence = 0;
  return {
    vaultRoot,
    vaultId,
    createWriteContext({ vaultRelativePath, intentId, operationSource }) {
      sequence += 1;
      return {
        mutationExecutor: (operation) => this.execute(operation),
        operationId: intentId || `test-operation-${String(sequence).padStart(8, '0')}`,
        sequence,
        source: operationSource,
        vaultId,
        vaultRoot,
      };
    },
    execute(operation) {
      const filePath = path.join(vaultRoot, operation.vaultRelativePath);
      const exists = fs.existsSync(filePath);
      if (operation.operationKind === 'create') {
        if (exists && fs.readFileSync(filePath, 'utf8') !== operation.content) return fakeReceipt(operation, 'conflict');
        if (!exists) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, operation.content, 'utf8');
        }
        return fakeReceipt(operation, exists ? 'already_satisfied' : 'committed');
      }
      if (operation.operationKind === 'transform' && exists) {
        const current = fs.readFileSync(filePath, 'utf8');
        const next = transforms.applyNode(current, operation);
        if (!transforms.isSatisfied(next, operation)) return fakeReceipt(operation, 'failed');
        fs.writeFileSync(filePath, next, 'utf8');
        return fakeReceipt(operation, next === current ? 'already_satisfied' : 'committed');
      }
      return fakeReceipt(operation, 'unavailable');
    },
  };
}

function fakeReceipt(operation, status) {
  return {
    schemaVersion: 1,
    operation,
    status,
    lifecycleState: ['committed', 'already_satisfied'].includes(status) ? 'acknowledged' : status,
    persistence: 'durable',
    obsidian: ['committed', 'already_satisfied'].includes(status) ? 'acknowledged' : 'unavailable',
    sync: 'unknown',
  };
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
  withTempVault(({ notes, journal, mutationService }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const journalPath = path.join(journal, `${date}.md`);
    fs.writeFileSync(journalPath, `# ${date}\n\n## 📝 Notes\n`, 'utf8');

    const result = createNote({
      title: 'Codex jarvOS Adapter Test',
      content: 'Research notes for Codex.',
      frontmatter: { project: 'codex' },
      mutationService,
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
  withTempVault(({ journal, mutationService }) => {
    const result = createNote({
      title: 'Missing Journal Test',
      content: 'Create the journal if needed.',
      mutationService,
    });

    assert.equal(result.ok, true);
    assert.ok(result.journal.journalPath.startsWith(journal));
    assert.ok(fs.readFileSync(result.journal.journalPath, 'utf8').includes('[[Missing Journal Test]]'));
  });
});

test('agent note outcome separates committed note, deferred backlink, and unknown Sync without leaking paths', async () => {
  await withTempVault(async ({ vault, journal, mutationService }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    fs.writeFileSync(path.join(journal, `${date}.md`), `# ${date}\n\n## 📝 Notes\n`, 'utf8');
    const execute = mutationService.execute.bind(mutationService);
    mutationService.execute = (operation) => operation.vaultRelativePath.startsWith('Journal/')
      ? fakeReceipt(operation, 'unavailable')
      : execute(operation);

    const result = createNote({
      title: 'Deferred Link Test',
      content: 'The note persists even while its journal backlink waits.',
      mutationService,
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome.note.status, 'committed');
    assert.equal(result.outcome.backlink.status, 'deferred');
    assert.equal(result.outcome.sync.status, 'unknown');
    assert.doesNotMatch(result.markdown, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.markdown, /operationId|expectedHash|intendedHash|createdAt/);

    const mcp = await callTool('jarvos_create_note', {
      title: 'Deferred Link MCP Test',
      content: 'MCP must expose only the bounded status.',
      mutationService,
    });
    assert.equal(mcp.isError, true);
    assert.match(mcp.content[0].text, /Journal backlink: deferred/);
    assert.doesNotMatch(mcp.content[0].text, new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('saved-locally note is pending rather than written or fully synced', () => {
  withTempVault(({ journal, mutationService }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    fs.writeFileSync(path.join(journal, `${date}.md`), `# ${date}\n\n## 📝 Notes\n`, 'utf8');
    const execute = mutationService.execute.bind(mutationService);
    mutationService.execute = (operation) => {
      if (operation.vaultRelativePath.startsWith('Notes/')) {
        const committed = execute(operation);
        return { ...committed, status: 'saved_locally_sync_pending', lifecycleState: 'local_applied', persistence: 'pending', obsidian: 'pending', sync: 'pending' };
      }
      return fakeReceipt(operation, 'unavailable');
    };
    const result = createNote({ title: 'Offline Note Test', content: 'Local only for now.', mutationService });
    assert.equal(result.ok, false);
    assert.equal(result.outcome.note.status, 'saved_locally_sync_pending');
    assert.equal(result.outcome.note.obsidian, 'pending');
    assert.equal(result.outcome.sync.status, 'pending');
    assert.match(result.markdown, /jarvOS Note Pending/);
  });
});

test('session thread writes a note, links today journal, and reads across hosts', () => {
  withTempVault(({ notes, journal, mutationService }) => {
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
      mutationService,
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

test('session thread appends checkpoints through latest-content transforms', () => {
  withTempVault(({ mutationService }) => {
    for (let index = 0; index < 6; index += 1) {
      const result = writeSessionThread({
        threadId: 'race-thread',
        actor: `worker-${index}`,
        event: 'checkpoint',
        summary: `summary from worker-${index}`,
        timestamp: `2026-08-06T12:00:0${index}.000Z`,
        mutationService,
      });
      assert.equal(result.ok, true);
    }

    const read = readSessionThread({ threadId: 'race-thread', maxChars: 12000 });
    for (let index = 0; index < 6; index += 1) {
      assert.match(read.content, new RegExp(`summary from worker-${index}`));
    }
    assert.equal((read.content.match(/Rolling live working thread/g) || []).length, 1);
  });
});

test('route-bound session threads ignore caller-selected dimensions and isolate colliding native ids', () => {
  withTempVault(() => {
    const previous = {
      required: process.env.JARVOS_REQUIRE_ROUTE_CAPABILITY,
      secret: process.env.JARVOS_ROUTE_BINDING_SECRET,
      generation: process.env.JARVOS_ROUTE_BINDING_GENERATION,
    };
    process.env.JARVOS_REQUIRE_ROUTE_CAPABILITY = '1';
    process.env.JARVOS_ROUTE_BINDING_SECRET = 'agent-context-route-secret';
    process.env.JARVOS_ROUTE_BINDING_GENERATION = 'hermes-jarvos.v1';
    const base = {
      harness: 'hermes', profile: 'default', platform: 'telegram', conversation: 'chat',
      sender: 'sender', generation: 'hermes-jarvos.v1',
    };
    const first = issueRouteCapability({ route: { ...base, nativeSession: 'session/a' }, secret: process.env.JARVOS_ROUTE_BINDING_SECRET });
    const second = issueRouteCapability({ route: { ...base, nativeSession: 'session-a' }, secret: process.env.JARVOS_ROUTE_BINDING_SECRET });
    try {
      const firstWrite = writeSessionThread({
        routeCapability: first,
        threadId: 'caller-chosen-collision',
        actor: 'Hermes',
        summary: 'first route checkpoint',
      });
      const secondWrite = writeSessionThread({
        routeCapability: second,
        threadId: 'caller-chosen-collision',
        actor: 'Hermes',
        summary: 'second route checkpoint',
      });
      assert.notEqual(firstWrite.note.path, secondWrite.note.path);
      assert.equal(readSessionThread({ routeCapability: first }).content.includes('second route checkpoint'), false);
      assert.equal(readSessionThread({ routeCapability: second }).content.includes('first route checkpoint'), false);
      assert.throws(() => readSessionThread({ threadId: 'raw-caller-thread' }), /route capability is required/);
    } finally {
      for (const [key, value] of Object.entries({
        JARVOS_REQUIRE_ROUTE_CAPABILITY: previous.required,
        JARVOS_ROUTE_BINDING_SECRET: previous.secret,
        JARVOS_ROUTE_BINDING_GENERATION: previous.generation,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('route-bound session threads can validate an owner-only injected key file', () => {
  withTempVault(({ tmp, mutationService }) => {
    const secretPath = path.join(tmp, 'route-secret');
    fs.writeFileSync(secretPath, 'agent-context-route-secret', { mode: 0o600 });
    fs.chmodSync(secretPath, 0o600);
    const previous = {
      required: process.env.JARVOS_REQUIRE_ROUTE_CAPABILITY,
      secret: process.env.JARVOS_ROUTE_BINDING_SECRET,
      secretFile: process.env.JARVOS_ROUTE_BINDING_SECRET_FILE,
      generation: process.env.JARVOS_ROUTE_BINDING_GENERATION,
    };
    process.env.JARVOS_REQUIRE_ROUTE_CAPABILITY = '1';
    delete process.env.JARVOS_ROUTE_BINDING_SECRET;
    process.env.JARVOS_ROUTE_BINDING_SECRET_FILE = secretPath;
    process.env.JARVOS_ROUTE_BINDING_GENERATION = 'hermes-jarvos.v1';
    try {
      const capability = issueRouteCapability({
        route: {
          harness: 'hermes', profile: 'default', platform: 'telegram', conversation: 'chat',
          sender: 'sender', nativeSession: 'session-file', generation: 'hermes-jarvos.v1',
        },
        secret: 'agent-context-route-secret',
      });
      const result = writeSessionThread({
        routeCapability: capability,
        summary: 'file-bound route checkpoint',
        mutationService,
      });
      assert.match(result.markdown, /Session Thread Written/);
    } finally {
      for (const [key, value] of Object.entries({
        JARVOS_REQUIRE_ROUTE_CAPABILITY: previous.required,
        JARVOS_ROUTE_BINDING_SECRET: previous.secret,
        JARVOS_ROUTE_BINDING_SECRET_FILE: previous.secretFile,
        JARVOS_ROUTE_BINDING_GENERATION: previous.generation,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('session thread defaults prefer current Paperclip task over global host thread', () => {
  withTempVault(({ mutationService }) => {
    const oldPaperclipTaskId = process.env.PAPERCLIP_TASK_ID;
    const oldSessionThreadId = process.env.JARVOS_SESSION_THREAD_ID;
    process.env.PAPERCLIP_TASK_ID = 'SUP-2219';
    process.env.JARVOS_SESSION_THREAD_ID = 'global-host-thread';
    try {
      const write = writeSessionThread({
        actor: 'Codex',
        event: 'checkpoint',
        summary: 'Issue-specific handoff.',
        mutationService,
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
  await withTempVault(async ({ journal, mutationService }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const write = await callTool('jarvos_session_thread_write', {
      threadId: 'artifact-a',
      artifact: 'artifact-a',
      host: 'openclaw',
      actor: 'OpenClaw',
      event: 'artifact-change',
      summary: 'Artifact moved from draft to review.',
      nextStep: 'Review the linked artifact before editing.',
      mutationService,
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
    'jarvos_common_work',
    'jarvos_todo_create',
    'jarvos_todo_list',
    'jarvos_todo_show',
    'jarvos_todo_transition',
    'jarvos_control_plane',
    'jarvos_shared_skills',
    'jarvos_current_work',
    'jarvos_projects_context',
    'jarvos_projects_propose',
    'jarvos_recall',
    'jarvos_synthesize',
    'jarvos_create_note',
    'jarvos_session_thread_read',
    'jarvos_session_thread_write',
    'jarvos_startup_brief',
    'jarvos_hydrate',
    'jarvos_journal_health',
    'jarvos_ensure_today_journal',
  ]);
  assert.match(
    TOOLS.find((tool) => tool.name === 'jarvos_hydrate').description,
    /boot jarvOS/,
  );
  const healthDescription = TOOLS.find((tool) => tool.name === 'jarvos_journal_health').description;
  const ensureDescription = TOOLS.find((tool) => tool.name === 'jarvos_ensure_today_journal').description;
  assert.match(healthDescription, /read-only health/);
  assert.match(ensureDescription, /explicit user request/);
  assert.match(ensureDescription, /trusted host-declared maintenance trigger/);
  assert.match(ensureDescription, /do not run this during startup/);
  const shared = TOOLS.find((tool) => tool.name === 'jarvos_shared_skills');
  assert.deepEqual(shared.inputSchema.properties.operation.enum, [
    'status', 'explain', 'inventory', 'plan', 'repair', 'exclude', 'include',
  ]);
  assert.equal('credential' in shared.inputSchema.properties, false);
});

test('named Todo MCP actions fail closed when the host work-action binding is absent', async () => {
  const previousModule = process.env.JARVOS_WORK_ACTION_SERVICE_MODULE;
  const previousConfig = process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  delete process.env.JARVOS_WORK_ACTION_SERVICE_MODULE;
  delete process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  try {
    const result = await callTool('jarvos_todo_list', {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, WORK_ACTION_HOST_UNAVAILABLE);
    assert.match(result.content[0].text, /JARVOS_WORK_ACTION_SERVICE_MODULE/);
    assert.match(result.content[0].text, /JARVOS_PROJECTS_CONTEXT_CONFIG/);
  } finally {
    if (previousModule === undefined) delete process.env.JARVOS_WORK_ACTION_SERVICE_MODULE;
    else process.env.JARVOS_WORK_ACTION_SERVICE_MODULE = previousModule;
    if (previousConfig === undefined) delete process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
    else process.env.JARVOS_PROJECTS_CONTEXT_CONFIG = previousConfig;
  }
});

test('Todo MCP strips caller-supplied authorization and evidence before invoking its host service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-todo-host-'));
  fs.chmodSync(root, 0o700);
  const configPath = path.join(root, 'projects.json');
  const servicePath = path.join(root, 'todo-service.js');
  fs.writeFileSync(configPath, JSON.stringify({ workspaceRoot: root }), { mode: 0o600 });
  fs.writeFileSync(servicePath, [
    "'use strict';",
    'module.exports = {',
    '  create: async (input) => { globalThis.__jarvosTodoMcpInput = input; return { ok: true }; },',
    '  completeFromHost: async (input) => { globalThis.__jarvosTodoMcpCompletion = input; return { ok: true, completed: true }; },',
    '};',
  ].join('\n'), { mode: 0o600 });
  const previousConfig = process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  const previousService = process.env.JARVOS_WORK_ACTION_SERVICE_MODULE;
  process.env.JARVOS_PROJECTS_CONTEXT_CONFIG = configPath;
  process.env.JARVOS_WORK_ACTION_SERVICE_MODULE = servicePath;
  try {
    const result = await callTool('jarvos_todo_create', {
      title: 'safe request', operationId: 'mcp-op-1', canonical: { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' },
      authorization: { ok: true }, capability: 'forged', evidence: { kind: 'execution-verified' }, evidenceReceiptId: 'forged',
    });
    assert.equal(result.isError, false);
    assert.deepEqual(globalThis.__jarvosTodoMcpInput, {
      title: 'safe request', description: undefined, operationId: 'mcp-op-1',
      canonical: { kind: 'outcome', id: 'out_000001', revision: 1, breadcrumb: 'Project › Outcome' },
      actor: { kind: 'agent', id: 'mcp' },
    });
    assert.equal('evidence' in TOOLS.find((tool) => tool.name === 'jarvos_todo_transition').inputSchema.properties, false);
    const completed = await callTool('jarvos_todo_transition', {
      itemId: 'bd-safe', operationId: 'mcp-op-2', action: 'complete',
      evidence: { kind: 'execution-verified' }, evidenceReceiptId: 'forged', authorization: { ok: true },
    });
    assert.equal(completed.isError, false);
    assert.deepEqual(globalThis.__jarvosTodoMcpCompletion, {
      itemId: 'bd-safe', operationId: 'mcp-op-2', expectedRevision: undefined, actor: { kind: 'agent', id: 'mcp' },
    });
  } finally {
    delete globalThis.__jarvosTodoMcpInput;
    delete globalThis.__jarvosTodoMcpCompletion;
    delete require.cache[servicePath];
    if (previousConfig === undefined) delete process.env.JARVOS_PROJECTS_CONTEXT_CONFIG;
    else process.env.JARVOS_PROJECTS_CONTEXT_CONFIG = previousConfig;
    if (previousService === undefined) delete process.env.JARVOS_WORK_ACTION_SERVICE_MODULE;
    else process.env.JARVOS_WORK_ACTION_SERVICE_MODULE = previousService;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared-skill MCP mutation operations fail closed without a host-bound owner session', async () => {
  const previous = process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
  const previousFile = process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
  delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
  delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
  try {
    for (const operation of ['inventory', 'plan', 'repair', 'exclude', 'include']) {
      const result = await callTool('jarvos_shared_skills', { operation, id: 'private-skill' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /owner session is not configured/i);
      assert.doesNotMatch(result.content[0].text, /private-skill|absolutePath/);
    }
  } finally {
    if (previous === undefined) delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    else process.env.JARVOS_CONTROL_PLANE_CREDENTIAL = previous;
    if (previousFile === undefined) delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
    else process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE = previousFile;
  }
});

test('shared-skill MCP status and explain match redacted operator behavior', async () => {
  const skills = require('../../jarvos-skills/src');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-skills-'));
  fs.chmodSync(root, 0o700);
  const harnessRoot = path.join(root, 'skills');
  const bundle = path.join(harnessRoot, 'secret-transcribe');
  fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bundle, 'SKILL.md'), '---\nname: secret-transcribe\n---\n', { mode: 0o600 });
  const controlRoot = path.join(root, 'control');
  const configPath = path.join(controlRoot, 'config.json');
  const config = skills.defaultConfig();
  config.controlRoot = controlRoot;
  config.publicCatalogPath = path.join(controlRoot, 'public-catalog.json');
  config.localOverlayPath = path.join(controlRoot, 'local-overlay.json');
  config.inventory.enabled = true;
  config.inventory.registeredRoots = [{
    rootId: 'codex-private', harness: 'codex', root: harnessRoot, trustClass: 'markdown-only', lifecycle: 'available',
  }];
  skills.saveConfig(config, configPath);
  const previous = process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH;
  process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH = configPath;
  try {
    for (const [operation, args] of [['status', {}], ['explain', { id: 'secret-transcribe' }]]) {
      const result = await callTool('jarvos_shared_skills', { operation, ...args });
      assert.equal(result.isError, false);
      assert.doesNotMatch(result.content[0].text, /secret-transcribe|absolutePath|SKILL\.md/);
      assert.match(result.content[0].text, /skill-[a-f0-9]{24}/);
    }
  } finally {
    if (previous === undefined) delete process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH;
    else process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP journal actions expose closed empty-object schemas and safe lifecycle results', () => {
  withTempVault(({ journal }) => {
    const indexPath = path.join(journal, 'Journaling.md');
    fs.writeFileSync(indexPath, '![[Journal/2026-08-07.md]]\n', 'utf8');
    const old = new Date(Date.now() - (10 * 60 * 1000));
    fs.utimesSync(indexPath, old, old);
    const listed = mcpRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'tools/list',
      params: {},
    }, process.env);
    const tools = listed.result.tools.filter((tool) => ['jarvos_journal_health', 'jarvos_ensure_today_journal'].includes(tool.name));
    assert.deepEqual(tools.map((tool) => tool.name), ['jarvos_journal_health', 'jarvos_ensure_today_journal']);
    for (const tool of tools) {
      assert.deepEqual(tool.inputSchema, {
        type: 'object',
        additionalProperties: false,
        properties: {},
      });
    }

    const health = mcpRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'tools/call',
      params: { name: 'jarvos_journal_health', arguments: {} },
    }, process.env);
    const healthBody = JSON.parse(health.result.content[0].text);
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.outcome, 'health');
    assert.equal(typeof healthBody.date, 'string');
    assert.deepEqual(Object.keys(healthBody).sort(), [
      'canonicalStatus',
      'date',
      'derivedIndexStatus',
      'outcome',
      'status',
    ]);

    const ensured = mcpRequest({
      jsonrpc: '2.0',
      id: 53,
      method: 'tools/call',
      params: { name: 'jarvos_ensure_today_journal', arguments: {} },
    }, process.env);
    const ensuredBody = JSON.parse(ensured.result.content[0].text);
    assert.equal(ensuredBody.status, 'ok');
    assert.equal(ensuredBody.outcome, 'created');
    assert.equal(typeof ensuredBody.date, 'string');
    assert.equal(ensuredBody.derivedIndexOutcome, 'index-updated');
    assert.deepEqual(Object.keys(ensuredBody).sort(), ['date', 'derivedIndexOutcome', 'outcome', 'status']);
    assert.match(fs.readFileSync(indexPath, 'utf8'), new RegExp(`!\\[\\[Journal/${ensuredBody.date}\\.md\\]\\]`));

    const journalPath = path.join(journal, `${ensuredBody.date}.md`);
    const beforeRetry = fs.readFileSync(journalPath, 'utf8');
    const retry = mcpRequest({
      jsonrpc: '2.0',
      id: 54,
      method: 'tools/call',
      params: { name: 'jarvos_ensure_today_journal', arguments: {} },
    }, process.env);
    assert.equal(JSON.parse(retry.result.content[0].text).outcome, 'healthy-existing');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), beforeRetry);

    const serialized = `${JSON.stringify(healthBody)}${JSON.stringify(ensuredBody)}`;
    for (const forbidden of [
      journal,
      'receiptPath',
      'indexPath',
      'sha256',
      'checksum',
      'timestamp',
      'provenance',
      'runId',
      'trigger',
      'private authored text',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `public journal DTO leaked ${forbidden}`);
    }

    const rejected = mcpRequest({
      jsonrpc: '2.0',
      id: 55,
      method: 'tools/call',
      params: { name: 'jarvos_ensure_today_journal', arguments: { path: journalPath } },
    }, process.env);
    assert.equal(rejected.error.code, -32602);
    assert.match(rejected.error.message, /empty object/);

    for (const invalidArguments of [null, false]) {
      const invalid = mcpRequest({
        jsonrpc: '2.0',
        id: 56,
        method: 'tools/call',
        params: { name: 'jarvos_journal_health', arguments: invalidArguments },
      }, process.env);
      assert.equal(invalid.error.code, -32602);
      assert.match(invalid.error.message, /empty object/);
    }
  });
});

test('public journal actions reject arguments before lifecycle access', async () => {
  await assert.rejects(
    () => callTool('jarvos_journal_health', { date: '2030-01-01' }),
    /empty object/,
  );
  await assert.rejects(
    () => callTool('jarvos_ensure_today_journal', { repair: true }),
    /empty object/,
  );
});

test('MCP journal ensure preserves a configured nested journal folder prefix', () => {
  withTempVault(({ vault }) => {
    const nestedJournal = path.join(vault, 'Notes', 'Journal');
    fs.mkdirSync(nestedJournal, { recursive: true });
    const indexPath = path.join(nestedJournal, 'Journaling.md');
    fs.writeFileSync(indexPath, '![[Notes/Journal/2026-08-07.md]]\n', 'utf8');
    const old = new Date(Date.now() - (10 * 60 * 1000));
    fs.utimesSync(indexPath, old, old);
    process.env.JARVOS_JOURNAL_DIR = nestedJournal;

    const response = mcpRequest({
      jsonrpc: '2.0',
      id: 58,
      method: 'tools/call',
      params: { name: 'jarvos_ensure_today_journal', arguments: {} },
    }, process.env);

    assert.equal(response.error, undefined);
    const body = JSON.parse(response.result.content[0].text);
    assert.equal(body.status, 'ok');
    assert.equal(body.derivedIndexOutcome, 'index-updated');
    assert.match(
      fs.readFileSync(indexPath, 'utf8'),
      new RegExp(`!\\[\\[Notes/Journal/${body.date}\\.md\\]\\]`),
    );
  });
});

test('MCP keeps legacy null-argument normalization for non-journal tools', () => {
  const prompt = mcpRequest({
    jsonrpc: '2.0',
    id: 57,
    method: 'prompts/get',
    params: { name: 'boot_jarvos', arguments: null },
  });
  assert.equal(prompt.error, undefined);
  assert.match(prompt.result.messages[0].content.text, /Boot jarvOS/);
});

test('public journal actions fail closed without configuration and do not create fallback files', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-journal-mcp-no-config-'));
  fs.mkdirSync(path.join(tempHome, 'config'), { recursive: true });
  const env = { ...process.env, HOME: tempHome, XDG_CONFIG_HOME: path.join(tempHome, 'config'), TZ: 'Pacific/Auckland' };
  for (const key of Object.keys(env)) {
    if (/^(?:JARVOS_|CLAWD_DIR$|JOURNAL_DIR$|VAULT_NOTES_DIR$|TZ$)/.test(key)) delete env[key];
  }
  env.HOME = tempHome;
  env.XDG_CONFIG_HOME = path.join(tempHome, 'config');
  env.TZ = 'Pacific/Auckland';

  try {
    const health = mcpRequest({
      jsonrpc: '2.0',
      id: 61,
      method: 'tools/call',
      params: { name: 'jarvos_journal_health', arguments: {} },
    }, env);
    const ensure = mcpRequest({
      jsonrpc: '2.0',
      id: 62,
      method: 'tools/call',
      params: { name: 'jarvos_ensure_today_journal', arguments: {} },
    }, env);
    const healthBody = JSON.parse(health.result.content[0].text);
    const ensureBody = JSON.parse(ensure.result.content[0].text);
    assert.equal(healthBody.status, 'error');
    assert.equal(ensureBody.status, 'error');
    assert.equal(healthBody.date, null);
    assert.equal(ensureBody.date, null);
    assert.doesNotMatch(JSON.stringify(healthBody), /Pacific\/Auckland|Vault v3|jarvOS/);
    assert.doesNotMatch(JSON.stringify(ensureBody), /Pacific\/Auckland|Vault v3|jarvOS/);
    assert.deepEqual(fs.readdirSync(tempHome), ['config']);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('control-plane MCP tool never takes a model-visible credential', () => {
  const controlPlaneTool = TOOLS.find((tool) => tool.name === 'jarvos_control_plane');
  assert.ok(!(controlPlaneTool.inputSchema.required || []).includes('credential'));
  assert.ok(!('credential' in (controlPlaneTool.inputSchema.properties || {})));
  assert.deepEqual(controlPlaneTool.inputSchema.required, ['operation']);
  assert.ok(controlPlaneTool.inputSchema.properties.operation.enum.includes('activation-status'));
  assert.equal(controlPlaneTool.inputSchema.properties.runtime.enum.includes('all'), true);
});

test('control-plane MCP exposes the same closed activation status without a model-visible evidence path', async () => {
  await withControlPlaneHost(async () => {
    const result = await callTool('jarvos_control_plane', {
      operation: 'activation-status',
      runtime: 'all',
    });
    assert.equal(result.isError, false, result.content?.[0]?.text);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, true);
    assert.deepEqual(body.results.map((status) => status.harness), ['claude', 'codex', 'hermes', 'openclaw']);
    for (const status of body.results) {
      assert.equal(status.schemaVersion, 'jarvos-managed-activation-status/v1');
      assert.notEqual(status.state, 'active');
      assert.equal(Object.prototype.hasOwnProperty.call(status, 'sessionId'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(status, 'privatePath'), false);
    }
    const schema = TOOLS.find((tool) => tool.name === 'jarvos_control_plane').inputSchema.properties;
    assert.equal(Object.prototype.hasOwnProperty.call(schema, 'evidencePath'), false);
  });
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

function renderFakeCodexToml(config) {
  const scalar = (value) => {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return `[${value.map(scalar).join(', ')}]`;
    return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${scalar(item)}`).join(', ')} }`;
  };
  const sections = [];
  const visit = (value, keys) => {
    const direct = Object.entries(value).filter(([, item]) => item === null || typeof item !== 'object' || Array.isArray(item));
    if (keys.length && direct.length) sections.push(`[${keys.join('.')}]\n${direct.map(([key, item]) => `${key} = ${scalar(item)}`).join('\n')}`);
    for (const [key, item] of Object.entries(value)) if (item && typeof item === 'object' && !Array.isArray(item)) visit(item, [...keys, key]);
  };
  visit(config, []);
  return sections.length ? `${sections.join('\n\n')}\n` : '';
}

// Executable setup.sh branches with a semantic fake app-server and a temp
// CODEX_CONFIG. Never mutates the real ~/.codex/config.toml.
function runCodexSetup(envOverrides = {}) {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const setupPath = path.join(repoRoot, 'runtimes', 'codex', 'setup.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-setup-'));
  const binDir = path.join(tmp, 'bin');
  const codexHome = path.join(tmp, 'codex-home');
  const codexLog = path.join(tmp, 'codex-args.log');
  const mcpStatePath = path.join(tmp, 'mcp-state.json');
  const providerCliStatePath = path.join(tmp, 'provider-codex-state.json');
  const providerStatePath = path.join(codexHome, 'jarvos-compound-engineering.state.json');
  const configPath = path.join(tmp, 'codex-config.toml');
  const configModelPath = path.join(tmp, 'codex-config-model.json');
  const rpcLog = path.join(tmp, 'codex-rpc.log');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const initialConfigModel = envOverrides.FAKE_CODEX_CONFIG_INITIAL_MODEL
    ? JSON.parse(envOverrides.FAKE_CODEX_CONFIG_INITIAL_MODEL) : {};
  const writeConfigModel = (value) => {
    fs.writeFileSync(configModelPath, JSON.stringify(value), 'utf8');
    fs.writeFileSync(configPath, renderFakeCodexToml(value), 'utf8');
  };
  const readConfigModel = () => JSON.parse(fs.readFileSync(configModelPath, 'utf8'));
  writeConfigModel(initialConfigModel);
  // Fake Codex records invocations and persists disposable semantic user-layer
  // and MCP models with content-derived versions.
  const fakeCodex = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(codexLog)}, args.join(' ') + '\\n');`,
    `const statePath = ${JSON.stringify(mcpStatePath)};`,
    `const providerStatePath = ${JSON.stringify(providerCliStatePath)};`,
    `if (args[0] === '--version') { process.stdout.write(${JSON.stringify(`codex-cli ${envOverrides.FAKE_CODEX_VERSION || '0.146.0'}\n`)}); process.exit(0); }`,
    "if (args[0] === 'app-server') {",
    "  const crypto = require('node:crypto');",
    `  const modelPath = ${JSON.stringify(configModelPath)};`,
    `  const configFile = ${JSON.stringify(configPath)};`,
    "  const canonicalConfigFile = fs.realpathSync(configFile);",
    `  const rpcLogPath = ${JSON.stringify(rpcLog)};`,
    "  const readModel = () => JSON.parse(fs.readFileSync(modelPath, 'utf8'));",
    "  const scalar = (value) => { if (typeof value === 'string') return JSON.stringify(value); if (typeof value === 'boolean' || typeof value === 'number') return String(value); if (Array.isArray(value)) return `[${value.map(scalar).join(', ')}]`; return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${scalar(item)}`).join(', ')} }`; };",
    "  const render = (config) => { const sections = []; const visit = (value, keys) => { const direct = Object.entries(value).filter(([, item]) => item === null || typeof item !== 'object' || Array.isArray(item)); if (keys.length && direct.length) sections.push(`[${keys.join('.')}]\\n${direct.map(([key, item]) => `${key} = ${scalar(item)}`).join('\\n')}`); for (const [key, item] of Object.entries(value)) if (item && typeof item === 'object' && !Array.isArray(item)) visit(item, [...keys, key]); }; visit(config, []); return sections.length ? `${sections.join('\\n\\n')}\\n` : ''; };",
    "  const writeModel = (value) => { fs.writeFileSync(modelPath, JSON.stringify(value)); fs.writeFileSync(configFile, render(value)); };",
    "  const registration = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')).transport : null;",
    "  const userConfig = () => { const value = JSON.parse(JSON.stringify(readModel())); const current = registration(); if (current) { value.mcp_servers ||= {}; value.mcp_servers.jarvos = current; } return value; };",
    "  const version = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');",
    "  const setAt = (value, keyPath, replacement) => { const keys = keyPath.split('.'); let cursor = value; for (const key of keys.slice(0, -1)) cursor = cursor[key] ||= {}; const leaf = keys.at(-1); if (replacement === null) delete cursor[leaf]; else cursor[leaf] = replacement; };",
    "  const owned = new Set(['hooks', 'features', 'shell_environment_policy', 'shell_environment_policy.set', 'hooks.SessionStart', 'hooks.UserPromptSubmit', 'features.hooks', 'features.codex_hooks', 'shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_COMMAND', 'shell_environment_policy.set.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT', 'shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE']);",
    "  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "  let input = '';",
    "  process.stdin.setEncoding('utf8');",
    "  process.stdin.on('data', (chunk) => {",
    "    input += chunk; let newline;",
    "    while ((newline = input.indexOf('\\n')) >= 0) {",
    "      const line = input.slice(0, newline).trim(); input = input.slice(newline + 1);",
    "      if (!line) continue;",
    "      let message; try { message = JSON.parse(line); } catch (_) { continue; }",
    "      fs.appendFileSync(rpcLogPath, `${message.method} ${JSON.stringify(message.params || {})}\\n`);",
    "      if (message.method === 'initialize') { emit({ id: message.id, result: { ok: true } }); continue; }",
    "      if (message.method === 'config/read') {",
    "        const config = userConfig(); const layers = [{ name: { type: 'user', file: canonicalConfigFile, profile: null }, version: version(config), config }];",
    "        if (process.env.FAKE_CODEX_HOOK_APP_SERVER_MODE === 'overridden') layers.push({ name: { type: 'system' }, version: 'higher', config: { features: { hooks: false } } });",
    "        emit({ id: message.id, result: { config, origins: {}, layers } }); continue;",
    "      }",
    "      if (message.method === 'config/batchWrite') {",
    "        const params = message.params || {}; const edits = params.edits || []; const before = userConfig();",
    "        const isMcp = edits.length === 1 && edits[0].keyPath === 'mcp_servers.jarvos';",
    "        const validHook = edits.length > 0 && edits.every((edit) => owned.has(edit.keyPath));",
    "        const expectedFile = isMcp ? configFile : canonicalConfigFile;",
    "        if (params.filePath !== expectedFile || params.expectedVersion !== version(before) || (!isMcp && !validHook) || edits.some((edit) => edit.mergeStrategy !== 'replace')) { emit({ id: message.id, error: { code: -32009, message: 'configuration version conflict' } }); continue; }",
    "        const mode = isMcp ? process.env.FAKE_CODEX_APP_SERVER_MODE : (process.env.FAKE_CODEX_HOOK_APP_SERVER_MODE || 'success');",
    "        if (isMcp && !['success', 'success-readd', 'conflict', 'overridden'].includes(mode)) { emit({ id: message.id, error: { code: -32000, message: 'app-server CAS unavailable' } }); continue; }",
    "        if (mode === 'conflict') {",
    "          if (isMcp) fs.writeFileSync(statePath, JSON.stringify({ name: 'jarvos', transport: { type: 'stdio', command: 'concurrent-replacement', args: [], env: {} } }));",
    "          else { const concurrent = readModel(); concurrent.unrelated ||= {}; concurrent.unrelated.concurrent = 'kept'; writeModel(concurrent); }",
    "          emit({ id: message.id, error: { code: -32009, message: 'configuration version conflict' } }); continue;",
    "        }",
    "        if (isMcp) {",
    "          if (mode === 'overridden') fs.writeFileSync(statePath, JSON.stringify({ name: 'jarvos', transport: { type: 'stdio', command: 'higher-layer-override', args: [], env: {} } }));",
    "          else { try { fs.unlinkSync(statePath); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (mode === 'success-readd') fs.writeFileSync(statePath, JSON.stringify({ name: 'jarvos', transport: { type: 'stdio', command: 'foreign-readd', args: [], env: {} } })); }",
    "        } else { const model = readModel(); for (const edit of edits) setAt(model, edit.keyPath, edit.value); writeModel(model); }",
    "        const status = mode === 'overridden' ? 'okOverridden' : 'ok';",
    "        emit({ id: message.id, result: { status, version: version(userConfig()), filePath: expectedFile, overriddenMetadata: status === 'okOverridden' ? { keyPath: edits[0].keyPath } : null } });",
    "      }",
    "    }",
    "  });",
    "  process.stdin.resume();",
    "  return;",
    "}",
    "if (args[0] === 'mcp' && args[1] === 'list') {",
    "  if (process.env.FAKE_CODEX_LIST_MODE === 'fail') process.exit(8);",
    "  if (process.env.FAKE_CODEX_LIST_MODE === 'malformed') { process.stdout.write('{'); process.exit(0); }",
    "  const entries = fs.existsSync(statePath) ? [JSON.parse(fs.readFileSync(statePath, 'utf8'))] : [];",
    '  process.stdout.write(JSON.stringify(entries)); process.exit(0);',
    '}',
    "if (args[0] === 'mcp' && args[1] === 'get') {",
    "  if (process.env.FAKE_CODEX_GET_MODE === 'fail') process.exit(9);",
    "  if (!fs.existsSync(statePath)) process.exit(1);",
    "  if (process.env.FAKE_CODEX_GET_MALFORMED === '1') { process.stdout.write('{'); process.exit(0); }",
    "  process.stdout.write(fs.readFileSync(statePath, 'utf8')); process.exit(0);",
    '}',
    "if (args[0] === 'mcp' && args[1] === 'remove') {",
    "  if (process.env.FAKE_CODEX_REMOVE_MODE === 'fail') process.exit(7);",
    "  if (process.env.FAKE_CODEX_REMOVE_MODE === 'retain') process.exit(0);",
    '  try { fs.unlinkSync(statePath); } catch (error) { if (error.code !== "ENOENT") throw error; }',
    '  process.exit(0);',
    '}',
    "if (args[0] === 'mcp' && args[1] === 'add') {",
    "  if (process.env.FAKE_CODEX_ADD_MODE === 'fail-before') process.exit(6);",
    '  const env = {}; let index = 2;',
    "  while (args[index] === '--env') { const value = args[index + 1]; const split = value.indexOf('='); env[value.slice(0, split)] = value.slice(split + 1); index += 2; }",
    "  if (args[index] !== 'jarvos' || args[index + 1] !== '--') process.exit(2);",
    '  const command = args[index + 2]; const commandArgs = args.slice(index + 3);',
    "  fs.writeFileSync(statePath, JSON.stringify({ name: 'jarvos', transport: { type: 'stdio', command, args: commandArgs, env } }));",
    "  if (process.env.FAKE_CODEX_ADD_MODE === 'write-then-fail') process.exit(6);",
    '  process.exit(0);',
    '}',
    "if (args.join(' ') === 'plugin list --json') {",
    "  const value = fs.existsSync(providerStatePath) ? JSON.parse(fs.readFileSync(providerStatePath, 'utf8')) : { installed: [], marketplaces: [] };",
    "  process.stdout.write(JSON.stringify({ installed: value.installed || [] })); process.exit(0);",
    '}',
    "if (args.join(' ') === 'plugin marketplace list --json') {",
    "  const value = fs.existsSync(providerStatePath) ? JSON.parse(fs.readFileSync(providerStatePath, 'utf8')) : { installed: [], marketplaces: [] };",
    "  process.stdout.write(JSON.stringify({ marketplaces: value.marketplaces || [] })); process.exit(0);",
    '}',
    "if (args[0] === 'plugin' && args[1] === 'remove') {",
    "  const value = fs.existsSync(providerStatePath) ? JSON.parse(fs.readFileSync(providerStatePath, 'utf8')) : { installed: [], marketplaces: [] };",
    "  value.installed = (value.installed || []).filter((entry) => entry.pluginId !== args[2]); fs.writeFileSync(providerStatePath, JSON.stringify(value)); process.exit(0);",
    '}',
    "if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {",
    "  const value = fs.existsSync(providerStatePath) ? JSON.parse(fs.readFileSync(providerStatePath, 'utf8')) : { installed: [], marketplaces: [] };",
    "  value.marketplaces = (value.marketplaces || []).filter((entry) => entry.name !== args[3]); fs.writeFileSync(providerStatePath, JSON.stringify(value)); process.exit(0);",
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
  const fakeCodexPath = path.join(binDir, 'selected-codex');
  fs.writeFileSync(fakeCodexPath, fakeCodex, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(fakeCodexPath, 0o755);
  const pathCodex = path.join(binDir, 'codex');
  fs.writeFileSync(pathCodex, `#!/usr/bin/env bash\nprintf '%s\\n' 'path-codex-was-used' >> ${JSON.stringify(codexLog)}\nexit 99\n`, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(pathCodex, 0o755);
  if (envOverrides.FAKE_CODEX_INITIAL_JSON) fs.writeFileSync(mcpStatePath, envOverrides.FAKE_CODEX_INITIAL_JSON, 'utf8');
  if (envOverrides.FAKE_CODEX_LEGACY_HOOKS) {
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), envOverrides.FAKE_CODEX_LEGACY_HOOKS, 'utf8');
  }

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    CODEX_HOME: codexHome,
    CODEX_CONFIG: configPath,
    JARVOS_CODEX_EXECUTABLE: fakeCodexPath,
    // Public-only setup: clear private host bindings unless the caller sets them.
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: '',
    JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: '',
    JARVOS_WORK_ACTION_SERVICE_MODULE: '',
    JARVOS_PROJECTS_CONTEXT_CONFIG: '',
    JARVOS_STEWARDSHIP_BRIDGE_COMMAND: '',
    JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: '',
    JARVOS_STEWARDSHIP_STABLE_ROOT: '',
    ...envOverrides,
  };
  // Empty string override should delete so setup sees "unset".
  if (!env.JARVOS_CONTROL_PLANE_SERVICE_MODULE) delete env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
  if (!env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE) delete env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
  if (!env.JARVOS_WORK_ACTION_SERVICE_MODULE) delete env.JARVOS_WORK_ACTION_SERVICE_MODULE;
  if (!env.JARVOS_PROJECTS_CONTEXT_CONFIG) delete env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  if (!env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND) delete env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  if (!env.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT) delete env.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT;
  if (!env.JARVOS_STEWARDSHIP_STABLE_ROOT) delete env.JARVOS_STEWARDSHIP_STABLE_ROOT;

  const invoke = (overrides = {}) => spawnSync('bash', [setupPath], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...env, ...overrides },
    maxBuffer: 4 * 1024 * 1024,
  });
  const result = invoke();
  return {
    tmp,
    codexHome,
    configPath,
    configModelPath,
    rpcLog,
    codexLog,
    fakeCodexPath,
    mcpStatePath,
    providerCliStatePath,
    providerStatePath,
    receiptPath: path.join(codexHome, 'jarvos-codex-mcp-receipt.json'),
    hookFeatureReceiptPath: path.join(codexHome, 'jarvos-codex-hook-feature-receipt.json'),
    result,
    rerun: invoke,
    readConfigModel,
    writeConfigModel,
    cleanup() {
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function seedCodexProviderRollback(run) {
  const revision = 'e36ddb8cbd4dd902d3b6ddd96165a783b0ac4711';
  const marketplaceRoot = path.join(run.codexHome, 'compound-marketplace');
  fs.mkdirSync(marketplaceRoot, { recursive: true });
  fs.writeFileSync(path.join(marketplaceRoot, '.codex-marketplace-install.json'), JSON.stringify({
    source_type: 'git',
    source: 'https://github.com/EveryInc/compound-engineering-plugin.git',
    revision,
  }), { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(run.providerCliStatePath, JSON.stringify({
    installed: [{
      pluginId: 'compound-engineering@compound-engineering-plugin',
      name: 'compound-engineering',
      marketplaceName: 'compound-engineering-plugin',
      version: '3.21.4',
      enabled: true,
    }],
    marketplaces: [{ name: 'compound-engineering-plugin', root: marketplaceRoot }],
  }), { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(run.providerStatePath, JSON.stringify({
    schemaVersion: 'jarvos-codex-provider-state/v1',
    provider: 'compound-engineering',
    version: '3.21.4',
    revision,
    marketplace: 'compound-engineering-plugin',
    plugin: 'compound-engineering@compound-engineering-plugin',
    marketplaceAdded: true,
    pluginAdded: true,
  }), { encoding: 'utf8', mode: 0o600 });
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
    assert.doesNotMatch(log, /JARVOS_WORK_ACTION_SERVICE_MODULE=/);
    assert.doesNotMatch(log, /JARVOS_PROJECTS_CONTEXT_CONFIG=/);
    // Real user config must not be touched; only the temp CODEX_CONFIG may change.
    assert.ok(fs.existsSync(run.configPath));
  } finally {
    run.cleanup();
  }
});

test('Codex setup preserves a present MCP registration when app-server CAS is unavailable', () => {
  const run = runCodexSetup();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const receipt = JSON.parse(fs.readFileSync(run.receiptPath, 'utf8'));
    assert.equal(receipt.state, 'active');
    assert.equal(fs.statSync(run.receiptPath).mode & 0o777, 0o600);

    const repeated = run.rerun();
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    const rolledBack = run.rerun({
      JARVOS_MANAGED_HARNESS_ROLLBACK: '1',
      JARVOS_PROJECTS_CONTEXT_CONFIG: '/different-after-setup/projects.json',
    });
    assert.notEqual(rolledBack.status, 0);
    assert.match(rolledBack.stderr, /app-server|preserving|reconciliation/i);
    assert.equal(fs.existsSync(run.receiptPath), true);
    assert.equal(fs.existsSync(run.mcpStatePath), true);

    const commands = fs.readFileSync(run.codexLog, 'utf8').trim().split('\n');
    assert.equal(commands.filter((entry) => entry.startsWith('mcp add ')).length, 1);
    assert.equal(commands.filter((entry) => entry === 'mcp remove jarvos').length, 0);
    assert.equal(commands.filter((entry) => entry === 'app-server --listen stdio://').length, 4);
    assert.equal(commands.includes('path-codex-was-used'), false);
    assert.doesNotMatch(fs.readFileSync(run.configPath, 'utf8'), /jarvos-session-start-hook\.js|jarvos-session-turn-hook\.js/);
  } finally {
    run.cleanup();
  }
});

test('Codex MCP rollback uses an exact app-server CAS and clears only its receipt', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(fs.existsSync(run.mcpStatePath), false);
    const commands = fs.readFileSync(run.codexLog, 'utf8');
    assert.match(commands, /app-server --listen stdio:\/\//);
    assert.doesNotMatch(commands, /mcp remove jarvos/);
    assert.doesNotMatch(fs.readFileSync(run.configPath, 'utf8'), /jarvos-session-start-hook\.js|jarvos-session-turn-hook\.js/);
  } finally {
    run.cleanup();
  }
});

test('Codex MCP CAS conflict preserves a concurrent replacement and still rolls back other phases', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'conflict' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    seedCodexProviderRollback(run);
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAS conflict|preserving|reconciliation/i);
    assert.equal(JSON.parse(fs.readFileSync(run.mcpStatePath, 'utf8')).transport.command, 'concurrent-replacement');
    assert.equal(fs.existsSync(run.receiptPath), true);
    assert.equal(fs.existsSync(run.providerStatePath), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(run.providerCliStatePath, 'utf8')), { installed: [], marketplaces: [] });
    assert.doesNotMatch(fs.readFileSync(run.codexLog, 'utf8'), /mcp remove jarvos/);
    assert.doesNotMatch(fs.readFileSync(run.configPath, 'utf8'), /jarvos-session-start-hook\.js|jarvos-session-turn-hook\.js/);
    const commands = fs.readFileSync(run.codexLog, 'utf8');
    assert.match(commands, /plugin remove compound-engineering@compound-engineering-plugin --json/);
    assert.match(commands, /plugin marketplace remove compound-engineering-plugin --json/);
  } finally {
    run.cleanup();
  }
});

test('Codex MCP CAS re-add leaves the new registration without the old receipt', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success-readd' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(JSON.parse(fs.readFileSync(run.mcpStatePath, 'utf8')).transport.command, 'foreign-readd');
    assert.doesNotMatch(fs.readFileSync(run.codexLog, 'utf8'), /mcp remove jarvos/);
  } finally {
    run.cleanup();
  }
});

test('Codex MCP CAS clears its receipt when a higher layer overrides the committed user-layer deletion', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'overridden' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(JSON.parse(fs.readFileSync(run.mcpStatePath, 'utf8')).transport.command, 'higher-layer-override');
    assert.doesNotMatch(fs.readFileSync(run.codexLog, 'utf8'), /mcp remove jarvos/);
  } finally {
    run.cleanup();
  }
});

test('Codex MCP rollback clears an active receipt when its registration is already absent', () => {
  const run = runCodexSetup();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    fs.unlinkSync(run.mcpStatePath);
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(fs.existsSync(run.mcpStatePath), false);
    const commands = fs.readFileSync(run.codexLog, 'utf8');
    assert.doesNotMatch(commands, /mcp remove jarvos/);
    assert.match(commands, /app-server --listen stdio:\/\//, 'hook rollback still uses its semantic app-server transaction');
  } finally {
    run.cleanup();
  }
});

test('Codex setup preserves state when MCP inspection is inconclusive', () => {
  const run = runCodexSetup({
    FAKE_CODEX_GET_MODE: 'fail',
    FAKE_CODEX_LIST_MODE: 'fail',
  });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /inspect|preserving/i);
    assert.equal(fs.existsSync(run.receiptPath), false);
    const commands = fs.readFileSync(run.codexLog, 'utf8');
    assert.doesNotMatch(commands, /mcp add |mcp remove /);
  } finally {
    run.cleanup();
  }
});

test('Codex setup preserves a pre-existing or later-changed jarvOS MCP registration', () => {
  const foreign = runCodexSetup({
    FAKE_CODEX_INITIAL_JSON: JSON.stringify({
      name: 'jarvos',
      transport: { type: 'stdio', command: 'other-command', args: [], env: {} },
    }),
  });
  try {
    assert.notEqual(foreign.result.status, 0);
    assert.match(foreign.result.stderr, /did not create it|preserving/i);
    assert.equal(fs.existsSync(foreign.receiptPath), false);
    const log = fs.readFileSync(foreign.codexLog, 'utf8');
    assert.doesNotMatch(log, /mcp (?:add|remove) /);
  } finally {
    foreign.cleanup();
  }

  const changed = runCodexSetup();
  try {
    assert.equal(changed.result.status, 0, changed.result.stderr || changed.result.stdout);
    const value = JSON.parse(fs.readFileSync(changed.mcpStatePath, 'utf8'));
    value.transport.command = 'locally-changed-command';
    fs.writeFileSync(changed.mcpStatePath, JSON.stringify(value));
    const rolledBack = changed.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(rolledBack.status, 0);
    assert.match(rolledBack.stderr, /changed after setup|preserving/i);
    assert.equal(fs.existsSync(changed.receiptPath), true);
    assert.equal(fs.existsSync(changed.mcpStatePath), true);
    assert.doesNotMatch(fs.readFileSync(changed.codexLog, 'utf8'), /mcp remove jarvos/);
  } finally {
    changed.cleanup();
  }

  const behaviorChanged = runCodexSetup();
  try {
    assert.equal(behaviorChanged.result.status, 0, behaviorChanged.result.stderr || behaviorChanged.result.stdout);
    const value = JSON.parse(fs.readFileSync(behaviorChanged.mcpStatePath, 'utf8'));
    value.enabled = false;
    fs.writeFileSync(behaviorChanged.mcpStatePath, JSON.stringify(value));
    const rolledBack = behaviorChanged.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(rolledBack.status, 0);
    assert.equal(fs.existsSync(behaviorChanged.receiptPath), true);
    assert.doesNotMatch(fs.readFileSync(behaviorChanged.codexLog, 'utf8'), /mcp remove jarvos/);
  } finally {
    behaviorChanged.cleanup();
  }
});

test('Codex MCP rollback failures do not block hook or provider rollback', () => {
  const cases = [
    {
      label: 'corrupt receipt',
      prepare(run) {
        fs.writeFileSync(run.receiptPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
      },
      overrides: {},
    },
    {
      label: 'inconclusive inspection',
      prepare() {},
      overrides: { FAKE_CODEX_GET_MODE: 'fail', FAKE_CODEX_LIST_MODE: 'fail' },
    },
    {
      label: 'changed registration',
      prepare(run) {
        const value = JSON.parse(fs.readFileSync(run.mcpStatePath, 'utf8'));
        value.transport.command = 'locally-changed-command';
        fs.writeFileSync(run.mcpStatePath, JSON.stringify(value));
      },
      overrides: {},
    },
    {
      label: 'present matching registration',
      prepare() {},
      overrides: {},
    },
  ];

  for (const scenario of cases) {
    const run = runCodexSetup();
    try {
      assert.equal(run.result.status, 0, `${scenario.label}: ${run.result.stderr || run.result.stdout}`);
      seedCodexProviderRollback(run);
      scenario.prepare(run);
      const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1', ...scenario.overrides });
      assert.notEqual(result.status, 0, `${scenario.label} should report unresolved MCP rollback`);
      assert.equal(fs.existsSync(run.receiptPath), true, `${scenario.label} should preserve its receipt`);
      assert.equal(fs.existsSync(run.mcpStatePath), true, `${scenario.label} should preserve its registration`);
      assert.equal(fs.existsSync(run.providerStatePath), false, `${scenario.label} should still roll back provider state`);
      assert.deepEqual(JSON.parse(fs.readFileSync(run.providerCliStatePath, 'utf8')), { installed: [], marketplaces: [] });
      assert.doesNotMatch(fs.readFileSync(run.codexLog, 'utf8'), /mcp remove jarvos/);
      assert.doesNotMatch(fs.readFileSync(run.configPath, 'utf8'), /jarvos-session-start-hook\.js|jarvos-session-turn-hook\.js/);
      const commands = fs.readFileSync(run.codexLog, 'utf8');
      assert.match(commands, /plugin remove compound-engineering@compound-engineering-plugin --json/);
      assert.match(commands, /plugin marketplace remove compound-engineering-plugin --json/);
    } finally {
      run.cleanup();
    }
  }
});

test('Codex hook rollback failure does not block MCP or provider rollback', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    seedCodexProviderRollback(run);
    const drifted = run.readConfigModel();
    drifted.hooks.SessionStart = 'not-an-array';
    run.writeConfigModel(drifted);

    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hook rollback did not complete|hooks=1/i);
    assert.equal(fs.existsSync(run.receiptPath), false, 'MCP receipt should still be cleared');
    assert.equal(fs.existsSync(run.mcpStatePath), false, 'MCP registration should still be removed');
    assert.equal(fs.existsSync(run.providerStatePath), false, 'provider state should still be rolled back');
    assert.deepEqual(JSON.parse(fs.readFileSync(run.providerCliStatePath, 'utf8')), { installed: [], marketplaces: [] });
    const commands = fs.readFileSync(run.codexLog, 'utf8');
    assert.doesNotMatch(commands, /mcp remove jarvos/);
    assert.match(commands, /plugin remove compound-engineering@compound-engineering-plugin --json/);
    assert.match(commands, /plugin marketplace remove compound-engineering-plugin --json/);
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback restores exact owned key presence and values', () => {
  const initialModel = {
    features: { hooks: false, codex_hooks: true, unrelated: true },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'user-session-start' }] }] },
  };
  const run = runCodexSetup({
    FAKE_CODEX_APP_SERVER_MODE: 'success',
    FAKE_CODEX_CONFIG_INITIAL_MODEL: JSON.stringify(initialModel),
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    assert.equal(fs.statSync(run.hookFeatureReceiptPath).mode & 0o777, 0o600);
    const ownership = JSON.parse(fs.readFileSync(run.hookFeatureReceiptPath, 'utf8'));
    assert.equal(ownership.schemaVersion, 'jarvos-codex-hook-feature-receipt/v4');
    assert.deepEqual(ownership.before['features.hooks'], { present: true, value: false });
    assert.deepEqual(ownership.before['hooks.UserPromptSubmit'], { present: false, value: null });
    assert.deepEqual(Object.keys(ownership.before).sort(), [
      'features.codex_hooks',
      'features.hooks',
      'hooks.SessionStart',
      'hooks.UserPromptSubmit',
      'shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_COMMAND',
      'shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE',
      'shell_environment_policy.set.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT',
    ]);
    assert.deepEqual(ownership.parentBefore, {
      hooks: true,
      features: true,
      shell_environment_policy: false,
      'shell_environment_policy.set': false,
    });
    const configured = fs.readFileSync(run.configPath, 'utf8');
    assert.match(configured, /hooks = true/);
    assert.doesNotMatch(configured, /codex_hooks = true/);
    assert.match(configured, /jarvos-session-start-hook\.js/);

    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), false);
    assert.deepEqual(run.readConfigModel(), initialModel);
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback removes only originally absent empty parent tables', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(run.configPath, 'utf8'), '');
    assert.deepEqual(run.readConfigModel(), {});
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback preserves unrelated keys concurrently added inside owned parents', () => {
  const run = runCodexSetup({
    FAKE_CODEX_APP_SERVER_MODE: 'success',
    JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-bridge',
    JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: '/private/jarvos-map',
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const concurrent = run.readConfigModel();
    concurrent.hooks.OtherEvent = [{ hooks: [{ type: 'command', command: 'keep-hook' }] }];
    concurrent.features.keep_feature = true;
    concurrent.shell_environment_policy.inherit = 'all';
    concurrent.shell_environment_policy.set.USER_VALUE = 'keep';
    run.writeConfigModel(concurrent);

    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(run.readConfigModel(), {
      hooks: { OtherEvent: [{ hooks: [{ type: 'command', command: 'keep-hook' }] }] },
      features: { keep_feature: true },
      shell_environment_policy: { set: { USER_VALUE: 'keep' }, inherit: 'all' },
    });
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback preserves changed managed sections but still completes MCP cleanup', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const changed = run.readConfigModel();
    changed.features.hooks = false;
    run.writeConfigModel(changed);

    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hook or feature state changed|hooks=1/i);
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), true);
    assert.deepEqual(run.readConfigModel(), changed);
    assert.equal(fs.existsSync(run.receiptPath), false, 'independent MCP rollback should complete');
    assert.equal(fs.existsSync(run.mcpStatePath), false);
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback fails closed for unreceipted jarvOS hook state', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const configured = fs.readFileSync(run.configPath, 'utf8');
    fs.unlinkSync(run.hookFeatureReceiptPath);

    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no jarvOS-owned hook-feature receipt.*preserving|hooks=1/i);
    assert.equal(fs.readFileSync(run.configPath, 'utf8'), configured);
    assert.equal(fs.existsSync(run.receiptPath), false, 'independent MCP rollback should complete');
    assert.equal(fs.existsSync(run.mcpStatePath), false);
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback preserves corrupt receipt state while MCP cleanup completes', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const configured = run.readConfigModel();
    fs.writeFileSync(run.hookFeatureReceiptPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a recognized jarvOS ownership record|hooks=1/i);
    assert.deepEqual(run.readConfigModel(), configured);
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), true);
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(fs.existsSync(run.mcpStatePath), false);
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature receipt recovers a pending claim after the managed write', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const receipt = JSON.parse(fs.readFileSync(run.hookFeatureReceiptPath, 'utf8'));
    fs.writeFileSync(run.hookFeatureReceiptPath, JSON.stringify({ ...receipt, state: 'pending' }), { mode: 0o600 });
    const result = run.rerun();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(run.hookFeatureReceiptPath, 'utf8')).state, 'active');
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback clears an active receipt after its completed write', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const receipt = JSON.parse(fs.readFileSync(run.hookFeatureReceiptPath, 'utf8'));
    run.writeConfigModel({});
    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), false);
    assert.equal(receipt.state, 'active');
  } finally {
    run.cleanup();
  }
});

test('Codex hook-feature rollback preserves unrelated concurrent configuration', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const concurrent = run.readConfigModel();
    concurrent.unrelated = { value: 'kept' };
    run.writeConfigModel(concurrent);

    const result = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const restored = fs.readFileSync(run.configPath, 'utf8');
    assert.match(restored, /\[unrelated\]\nvalue = "kept"/);
    assert.doesNotMatch(restored, /\[hooks\]/);
    assert.doesNotMatch(restored, /\[features\]/);
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), false);
  } finally {
    run.cleanup();
  }
});

test('Codex hook setup uses one exact-version semantic batch and recovers a conflict without losing unrelated config', () => {
  const run = runCodexSetup({
    FAKE_CODEX_APP_SERVER_MODE: 'success',
    FAKE_CODEX_HOOK_APP_SERVER_MODE: 'conflict',
  });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /version-bound configuration transaction|preserving/i);
    assert.equal(JSON.parse(fs.readFileSync(run.hookFeatureReceiptPath, 'utf8')).state, 'pending');
    assert.deepEqual(run.readConfigModel(), { unrelated: { concurrent: 'kept' } });

    const recovered = run.rerun({ FAKE_CODEX_HOOK_APP_SERVER_MODE: 'success' });
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.equal(JSON.parse(fs.readFileSync(run.hookFeatureReceiptPath, 'utf8')).state, 'active');
    assert.equal(run.readConfigModel().unrelated.concurrent, 'kept');
    const batches = fs.readFileSync(run.rpcLog, 'utf8').trim().split('\n')
      .filter((line) => line.startsWith('config/batchWrite '))
      .map((line) => JSON.parse(line.slice('config/batchWrite '.length)))
      .filter((params) => params.edits.some((edit) => edit.keyPath === 'hooks.SessionStart'));
    assert.equal(batches.length, 2, 'each attempt must submit exactly one hook batch');
    for (const batch of batches) {
      assert.equal(batch.filePath, fs.realpathSync(run.configPath));
      assert.equal(typeof batch.expectedVersion, 'string');
      assert.ok(batch.expectedVersion.length > 0);
      assert.ok(batch.edits.every((edit) => edit.mergeStrategy === 'replace'));
    }
  } finally {
    run.cleanup();
  }
});

test('Codex hook transaction restores only owned nested keys and accepts higher-layer override status', () => {
  const initialModel = {
    shell_environment_policy: {
      inherit: 'all',
      set: {
        USER_VALUE: 'keep',
        JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'old-command',
        JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: '/old/map',
        JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE: '/old/context',
      },
    },
    features: { hooks: false, codex_hooks: true, unrelated: true },
  };
  const run = runCodexSetup({
    FAKE_CODEX_APP_SERVER_MODE: 'success',
    FAKE_CODEX_HOOK_APP_SERVER_MODE: 'overridden',
    FAKE_CODEX_CONFIG_INITIAL_MODEL: JSON.stringify(initialModel),
    JARVOS_STEWARDSHIP_BRIDGE_COMMAND: 'jarvos-bridge',
    JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: '/private/jarvos-map',
  });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const configured = run.readConfigModel();
    assert.equal(configured.shell_environment_policy.inherit, 'all');
    assert.equal(configured.shell_environment_policy.set.USER_VALUE, 'keep');
    assert.equal(configured.shell_environment_policy.set.JARVOS_STEWARDSHIP_BRIDGE_COMMAND, 'jarvos-bridge');
    assert.equal(Object.hasOwn(configured.shell_environment_policy.set, 'JARVOS_STEWARDSHIP_BRIDGE_CONTEXT_FILE'), false);

    const rollback = run.rerun({
      JARVOS_MANAGED_HARNESS_ROLLBACK: '1',
      FAKE_CODEX_HOOK_APP_SERVER_MODE: 'overridden',
    });
    assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
    const restored = run.readConfigModel();
    if (restored.hooks && Object.keys(restored.hooks).length === 0) delete restored.hooks;
    assert.deepEqual(restored, initialModel);
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), false);
  } finally {
    run.cleanup();
  }
});

test('Codex semantic setup leaves legacy hooks.json untouched and fails closed', () => {
  const legacy = '{"hooks":{"SessionStart":[]}}\n';
  const run = runCodexSetup({ FAKE_CODEX_LEGACY_HOOKS: legacy });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /legacy .*hooks\.json.*explicit semantic migration/i);
    assert.equal(fs.readFileSync(path.join(run.codexHome, 'hooks.json'), 'utf8'), legacy);
    assert.deepEqual(run.readConfigModel(), {});
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), false);
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(fs.existsSync(run.mcpStatePath), false);
  } finally {
    run.cleanup();
  }
});

test('Codex rollback ignores stale forward-install bindings', () => {
  const run = runCodexSetup({ FAKE_CODEX_APP_SERVER_MODE: 'success' });
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    seedCodexProviderRollback(run);
    const result = run.rerun({
      JARVOS_MANAGED_HARNESS_ROLLBACK: '1',
      JARVOS_MCP_STABLE_ENTRYPOINT: 'stale-relative-entrypoint',
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: 'stale-relative-service',
      JARVOS_WORK_ACTION_SERVICE_MODULE: 'stale-relative-work-service',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(fs.existsSync(run.mcpStatePath), false);
    assert.equal(fs.existsSync(run.providerStatePath), false);
    assert.doesNotMatch(fs.readFileSync(run.configPath, 'utf8'), /jarvos-session-start-hook\.js|jarvos-session-turn-hook\.js/);
  } finally {
    run.cleanup();
  }
});

test('Codex rollback without its CLI preserves hook ownership while other cleanup remains independent', () => {
  const run = runCodexSetup();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const result = run.rerun({
      JARVOS_MANAGED_HARNESS_ROLLBACK: '1',
      JARVOS_CODEX_EXECUTABLE: path.join(run.tmp, 'missing-codex'),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /continuing rollback phases|mcp=1/i);
    assert.equal(fs.existsSync(run.receiptPath), true, 'MCP receipt must be preserved without the CLI');
    assert.equal(fs.existsSync(run.mcpStatePath), true, 'MCP registration must be preserved without the CLI');
    assert.match(fs.readFileSync(run.configPath, 'utf8'), /jarvos-session-start-hook\.js|jarvos-session-turn-hook\.js/);
    assert.equal(fs.existsSync(run.hookFeatureReceiptPath), true, 'hook receipt must be preserved without app-server');
  } finally {
    run.cleanup();
  }
});

test('Codex setup reconciles bounded add outcomes without broad ownership claims', () => {
  const beforeWrite = runCodexSetup({ FAKE_CODEX_ADD_MODE: 'fail-before' });
  try {
    assert.notEqual(beforeWrite.result.status, 0);
    assert.equal(JSON.parse(fs.readFileSync(beforeWrite.receiptPath, 'utf8')).state, 'pending');
    assert.equal(fs.existsSync(beforeWrite.mcpStatePath), false);
    const rolledBack = beforeWrite.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(rolledBack.status, 0, rolledBack.stderr || rolledBack.stdout);
    assert.equal(fs.existsSync(beforeWrite.receiptPath), false);
    assert.doesNotMatch(fs.readFileSync(beforeWrite.codexLog, 'utf8'), /mcp remove jarvos/);
  } finally {
    beforeWrite.cleanup();
  }

  const afterWrite = runCodexSetup({ FAKE_CODEX_ADD_MODE: 'write-then-fail' });
  try {
    assert.equal(afterWrite.result.status, 0, afterWrite.result.stderr || afterWrite.result.stdout);
    assert.equal(JSON.parse(fs.readFileSync(afterWrite.receiptPath, 'utf8')).state, 'active');
  } finally {
    afterWrite.cleanup();
  }
});

test('Codex MCP rollback retains its receipt when CAS cannot be confirmed', () => {
  const failed = runCodexSetup();
  try {
    assert.equal(failed.result.status, 0, failed.result.stderr || failed.result.stdout);
    const result = failed.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(failed.receiptPath), true);
    assert.equal(fs.existsSync(failed.mcpStatePath), true);
    assert.doesNotMatch(fs.readFileSync(failed.codexLog, 'utf8'), /mcp remove jarvos/);
  } finally {
    failed.cleanup();
  }

  const uncertain = runCodexSetup();
  try {
    assert.equal(uncertain.result.status, 0, uncertain.result.stderr || uncertain.result.stdout);
    const result = uncertain.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1', FAKE_CODEX_APP_SERVER_MODE: 'conflict' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CAS conflict|preserving|reconciliation/i);
    assert.equal(fs.existsSync(uncertain.receiptPath), true);
    assert.doesNotMatch(fs.readFileSync(uncertain.codexLog, 'utf8'), /mcp remove jarvos/);
  } finally {
    uncertain.cleanup();
  }
});

test('Codex MCP receipt rejects loose modes, invalid content, and symlinks', () => {
  const receiptApi = require(path.join(__dirname, '..', '..', '..', 'runtimes', 'codex', 'mcp-registration-receipt.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-receipt-'));
  const codexHome = path.join(tmp, 'codex-home');
  const receiptPath = path.join(codexHome, 'jarvos-codex-mcp-receipt.json');
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const fingerprint = receiptApi.fingerprintRegistration({ command: 'node', args: ['server.js'], env: {} });
  try {
    const behaviorChanges = [
      { command: 'node', args: ['server.js'], env: {}, enabled: false },
      { command: 'node', args: ['server.js'], env: {}, env_vars: ['PASSTHROUGH'] },
      { command: 'node', args: ['server.js'], env: {}, startup_timeout_sec: 5 },
      { command: 'node', args: ['server.js'], env: {}, tool_timeout_sec: 7 },
      { command: 'node', args: ['server.js'], env: {}, enabled_tools: ['one'] },
      { command: 'node', args: ['server.js'], env: {}, disabled_tools: ['two'] },
    ];
    for (const changed of behaviorChanges) {
      assert.notEqual(receiptApi.fingerprintRegistration(changed), fingerprint);
    }

    receiptApi.claimReceipt(receiptPath, codexHome, fingerprint);
    fs.chmodSync(receiptPath, 0o644);
    assert.throws(() => receiptApi.readReceipt(receiptPath, codexHome), /mode 0600/);

    fs.chmodSync(receiptPath, 0o600);
    fs.writeFileSync(receiptPath, '{}\n', { mode: 0o600 });
    assert.throws(() => receiptApi.readReceipt(receiptPath, codexHome), /unsupported shape|recognized/);

    const target = path.join(codexHome, 'receipt-target.json');
    fs.renameSync(receiptPath, target);
    fs.symlinkSync(target, receiptPath);
    assert.throws(() => receiptApi.readReceipt(receiptPath, codexHome), /regular file/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('managed Codex provider version mismatch stops before profile mutation', () => {
  const run = runCodexSetup({
    JARVOS_CODEX_PROVIDER_MODE: 'new-managed',
    FAKE_CODEX_VERSION: '0.145.0',
  });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /not covered|conformance/i);
    assert.equal(fs.readFileSync(run.configPath, 'utf8'), '');
    assert.equal(fs.existsSync(run.receiptPath), false);
    assert.equal(fs.existsSync(run.mcpStatePath), false);
    const log = fs.readFileSync(run.codexLog, 'utf8');
    assert.match(log, /^--version\n$/);
    assert.doesNotMatch(log, /mcp |plugin /);

    const rollback = run.rerun({ JARVOS_MANAGED_HARNESS_ROLLBACK: '1' });
    assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
  } finally {
    run.cleanup();
  }
});

test('managed Codex provider preflight accepts the exact reviewed CLI version without writes', () => {
  const run = runCodexSetup();
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const manager = path.join(__dirname, '..', '..', '..', 'runtimes', 'codex', 'compound-engineering-activation.js');
    const before = fs.readdirSync(run.codexHome).sort();
    const result = spawnSync(process.execPath, [manager], {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: run.tmp,
        CODEX_HOME: run.codexHome,
        JARVOS_CODEX_EXECUTABLE: run.fakeCodexPath,
        JARVOS_CODEX_PROVIDER_MODE: 'new-managed',
        JARVOS_CODEX_PROVIDER_PREFLIGHT: '1',
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /0\.146\.0|no provider changes/i);
    assert.deepEqual(fs.readdirSync(run.codexHome).sort(), before);
  } finally {
    run.cleanup();
  }
});

test('Codex setup optionally binds work-action host env without requiring it', () => {
  const hostTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-setup-todo-host-'));
  try {
    const configPath = path.join(hostTmp, 'projects.json');
    const servicePath = path.join(hostTmp, 'todo-service.js');
    fs.writeFileSync(configPath, '{}\n', { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(servicePath, "'use strict';\nmodule.exports = {};\n", { encoding: 'utf8', mode: 0o600 });

    const bound = runCodexSetup({
      JARVOS_WORK_ACTION_SERVICE_MODULE: servicePath,
      JARVOS_PROJECTS_CONTEXT_CONFIG: configPath,
    });
    try {
      assert.equal(bound.result.status, 0, bound.result.stderr || bound.result.stdout);
      const log = fs.existsSync(bound.codexLog) ? fs.readFileSync(bound.codexLog, 'utf8') : '';
      assert.match(log, /JARVOS_WORK_ACTION_SERVICE_MODULE=/);
      assert.match(log, /JARVOS_PROJECTS_CONTEXT_CONFIG=/);
    } finally {
      bound.cleanup();
    }

    const relative = runCodexSetup({
      JARVOS_WORK_ACTION_SERVICE_MODULE: 'relative/todo-service.js',
    });
    try {
      assert.notEqual(relative.result.status, 0);
      assert.match(relative.result.stderr, /JARVOS_WORK_ACTION_SERVICE_MODULE must be an absolute path when set/);
      assert.doesNotMatch(relative.result.stderr, /relative\/todo-service/);
      assert.ok(!fs.existsSync(relative.codexLog) || !fs.readFileSync(relative.codexLog, 'utf8').includes('mcp add'));
    } finally {
      relative.cleanup();
    }
  } finally {
    fs.rmSync(hostTmp, { recursive: true, force: true });
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

function mcpRequest(message, env = process.env) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'jarvos-mcp.js'),
  ], {
    input: `${JSON.stringify(message)}\n`,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, result.stdout);
  return JSON.parse(lines[0]);
}

test('createNote retains a deferred journal receipt without retrying mutation', () => {
  withTempVault(({ notes, mutationService: baseMutationService }) => {
    const mutationService = {
      ...baseMutationService,
      execute(operation) {
        if (operation.vaultRelativePath.startsWith('Journal/')) return fakeReceipt(operation, 'unavailable');
        return baseMutationService.execute(operation);
      },
    };
    const result = createNote({
      title: 'Deferred Agent Context Note',
      content: 'The note must remain durable while backlink recovery is pending.',
      mutationService,
    });

    assert.equal(result.ok, false);
    assert.equal(result.note.journal.status, 'deferred');
    assert.equal(result.journal, result.note.journal);
    assert.equal(result.verification, null);
    assert.equal(result.outcome.backlink.deferred, true);
    assert.match(result.markdown, /Journal backlink: deferred/);
    assert.ok(fs.existsSync(result.note.path));
    assert.ok(result.note.path.startsWith(notes));
    const queue = JSON.parse(fs.readFileSync(result.journal.deferredBacklink.deferredPath, 'utf8'));
    assert.equal(Object.keys(queue.entries).length, 1);
  });
});

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
  await withTempVault(async ({ journal, mutationService }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    fs.writeFileSync(path.join(journal, `${date}.md`), `# ${date}\n\n## 📝 Notes\n`, 'utf8');

    const result = await callTool('jarvos_create_note', {
      title: 'MCP Note Test',
      content: 'Created through the MCP call path.',
      mutationService,
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
      assert.doesNotMatch(result.markdown, /WORK-1558|Paperclip Current Work/);
      assert.match(result.markdown, /Projects Context\nUnavailable/);
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

test('hydrate resolves ontology from the configured workspace when the bundle ships no ontology directory', async () => {
  const oldEnv = {
    JARVOS_WORKSPACE_DIR: process.env.JARVOS_WORKSPACE_DIR,
    JARVOS_ONTOLOGY_DIR: process.env.JARVOS_ONTOLOGY_DIR,
  };
  // A managed-software runtime ships modules without their content directories,
  // so neither the in-tree candidate nor an explicit override is available.
  delete process.env.JARVOS_ONTOLOGY_DIR;

  try {
    await withTempVault(async ({ journal, tmp }) => {
      fs.writeFileSync(path.join(journal, '2026-05-12.md'), '# 2026-05-12\n\nPlain entry.\n', 'utf8');

      const workspace = path.join(tmp, 'workspace');
      const ontologyDir = path.join(workspace, 'jarvos-ontology', 'ontology');
      fs.mkdirSync(ontologyDir, { recursive: true });
      fs.writeFileSync(
        path.join(ontologyDir, '1-higher-order.md'),
        '# Higher\n\n## My Higher Order\n\nWorkspace ontology content.\n',
        'utf8',
      );
      process.env.JARVOS_WORKSPACE_DIR = workspace;
      jarvosPaths.resetConfigCache();

      const result = await hydrate({
        maxChars: 9000,
        journal: { date: '2026-05-12', timeZone: 'UTC' },
      });

      assert.equal(result.ok, true);
      assert.match(result.markdown, /Workspace ontology content/);
      assert.doesNotMatch(result.markdown, /jarvos-ontology provider unavailable/);
      assert.match(result.markdown, /Ontology provider: .*jarvos-ontology\/ontology/);
    });
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jarvosPaths.resetConfigCache();
  }
});

// Minimal, self-contained Projects context config: enough for
// createHostProjectsContextProvider() to pass every integrity check
// (trusted workspace/repository/state roots, a requireable provider module)
// without needing the provider's read() to actually succeed. `marker` is
// carried through as the config's default query so a test can tell which
// config file was actually selected.
function buildProjectsConfigFixture(workspaceRoot, marker) {
  const repositoryRoot = path.join(workspaceRoot, 'repository');
  const stateRoot = path.join(workspaceRoot, 'state');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.mkdirSync(path.join(stateRoot, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(stateRoot, 'release-provider'), { recursive: true });
  fs.writeFileSync(
    path.join(repositoryRoot, 'provider.js'),
    "module.exports = { read: async () => ({ status: 'unavailable' }) };\n",
  );
  return JSON.stringify({
    workspaceRoot,
    repositoryRoot,
    providerModule: path.join(repositoryRoot, 'provider.js'),
    stateRoot,
    registryStateDir: path.join(stateRoot, 'registry'),
    releaseProviderStateDir: path.join(stateRoot, 'release-provider'),
    query: { marker },
  });
}

test('createHostProjectsContextProvider falls back to the workspace-derived config path when the env var is unset', async () => {
  const oldEnv = { JARVOS_WORKSPACE_DIR: process.env.JARVOS_WORKSPACE_DIR };
  try {
    await withTempVault(async ({ tmp }) => {
      const workspace = path.join(tmp, 'workspace');
      fs.mkdirSync(path.join(workspace, 'config'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, 'config', 'jarvos-project-context.json'),
        buildProjectsConfigFixture(workspace, 'default'),
      );

      process.env.JARVOS_WORKSPACE_DIR = workspace;
      jarvosPaths.resetConfigCache();

      const provider = createHostProjectsContextProvider({});
      assert.notEqual(provider, null);
      assert.equal(typeof provider.read, 'function');
      assert.equal(provider.defaultQuery.marker, 'default');
    });
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jarvosPaths.resetConfigCache();
  }
});

test('JARVOS_PROJECTS_CONTEXT_CONFIG still wins over the workspace-derived default when both are present', async () => {
  const oldEnv = { JARVOS_WORKSPACE_DIR: process.env.JARVOS_WORKSPACE_DIR };
  try {
    await withTempVault(async ({ tmp }) => {
      const workspace = path.join(tmp, 'workspace');
      fs.mkdirSync(path.join(workspace, 'config'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, 'config', 'jarvos-project-context.json'),
        buildProjectsConfigFixture(workspace, 'default'),
      );

      const overrideRoot = path.join(tmp, 'override');
      fs.mkdirSync(overrideRoot, { recursive: true });
      const overrideConfigPath = path.join(overrideRoot, 'projects-context.json');
      fs.writeFileSync(overrideConfigPath, buildProjectsConfigFixture(overrideRoot, 'override'));

      process.env.JARVOS_WORKSPACE_DIR = workspace;
      jarvosPaths.resetConfigCache();

      const provider = createHostProjectsContextProvider({ [PROJECTS_CONTEXT_CONFIG_ENV]: overrideConfigPath });
      assert.notEqual(provider, null);
      assert.equal(provider.defaultQuery.marker, 'override');
    });
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jarvosPaths.resetConfigCache();
  }
});

test('createHostProjectsContextProvider fails closed when the workspace-derived config path does not exist', async () => {
  const oldEnv = { JARVOS_WORKSPACE_DIR: process.env.JARVOS_WORKSPACE_DIR };
  try {
    await withTempVault(async ({ tmp }) => {
      // No config/jarvos-project-context.json under this workspace.
      const workspace = path.join(tmp, 'workspace-without-config');
      fs.mkdirSync(workspace, { recursive: true });

      process.env.JARVOS_WORKSPACE_DIR = workspace;
      jarvosPaths.resetConfigCache();

      let provider;
      assert.doesNotThrow(() => {
        provider = createHostProjectsContextProvider({});
      });
      assert.equal(provider, null);
    });
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jarvosPaths.resetConfigCache();
  }
});
