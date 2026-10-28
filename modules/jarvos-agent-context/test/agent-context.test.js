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
  recall,
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
  resolveSharedSkillsOwnerCredential,
  readCredentialFile,
  CREDENTIAL_ENV,
  CREDENTIAL_FILE_ENV,
  sharedSkillsConfigPath,
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

test('agent-context note writers emit jarvos-content-origin/v1 and fail closed on human claims', () => {
  withTempVault(({ mutationService }) => {
    const assistantNote = createNote({ title: 'Origin Default Test', content: 'Assistant-written summary.', mutationService });
    assert.equal(assistantNote.ok, true);
    const assistantText = fs.readFileSync(assistantNote.note.path, 'utf8');
    assert.match(assistantText, /content_origin_schema: jarvos-content-origin\/v1/);
    assert.match(assistantText, /content_origin: assistant/);
    assert.match(assistantText, /content_origin_basis: assistant_generated/);
    assert.match(assistantText, /human_evidence_eligible: false/);

    // MCP callers have no receipt resolver, so a human claim cannot be verified.
    const forged = createNote({
      title: 'Forged Human Origin Test',
      content: 'Assistant prose claiming to be the user.',
      frontmatter: { content_origin: 'human', content_origin_basis: 'verbatim_user', human_evidence_eligible: true },
      mutationService,
    });
    assert.equal(forged.ok, true);
    const forgedText = fs.readFileSync(forged.note.path, 'utf8');
    assert.match(forgedText, /content_origin: unknown/);
    assert.match(forgedText, /content_origin_basis: unknown/);
    assert.match(forgedText, /human_evidence_eligible: false/);

    const thread = writeSessionThread({ threadId: 'origin-thread', actor: 'worker', event: 'checkpoint', summary: 'origin check', mutationService });
    assert.equal(thread.ok, true);
    const threadText = readSessionThread({ threadId: 'origin-thread', maxChars: 12000 });
    assert.match(fs.readFileSync(threadText.notePath || threadText.path, 'utf8'), /content_origin: assistant/);
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

test('MCP internal session thread requests no journal backlink or deferred intent', async () => {
  await withTempVault(async ({ vault, notes, journal, mutationService }) => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
    const journalPath = path.join(journal, `${date}.md`);
    const original = `# ${date}\n\n## 📝 Notes\n`;
    fs.writeFileSync(journalPath, original);
    writeSessionThread({ threadId: 'internal-checkpoint', summary: 'earlier internal checkpoint', journalPolicy: 'none', mutationService });
    const execute = mutationService.execute.bind(mutationService);
    const operations = [];
    mutationService.execute = (operation) => { operations.push(operation); return execute(operation); };
    const write = await callTool('jarvos_session_thread_write', {
      threadId: 'internal-checkpoint', summary: 'internal checkpoint once', journalPolicy: 'none', mutationService,
    });
    assert.equal(write.isError, false);
    assert.match(write.content[0].text, /Journal backlink: not_requested/);
    assert.match(write.content[0].text, /Session Thread Written/);
    const content = fs.readFileSync(path.join(notes, 'JarvOS Session Thread - internal-checkpoint.md'), 'utf8');
    assert.equal((content.match(/internal checkpoint once/g) || []).length, 1);
    assert.equal(operations.length, 1, 'only the note mutation is submitted');
    assert.equal(operations[0].transformName, 'session-thread-append');
    assert.equal(fs.readFileSync(journalPath, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(vault, '.jarvos/journal-maintenance/deferred-backlinks.json')), false);
  });
});

test('MCP internal session thread preserves an ambiguous append identity without journal work', async () => {
  await withTempVault(async ({ vault, journal, mutationService }) => {
    const execute = mutationService.execute.bind(mutationService);
    let submissions = 0;
    mutationService.execute = (operation) => {
      submissions += 1;
      execute(operation);
      return { ...fakeReceipt(operation, 'unknown_after_dispatch'), obsidian: 'unacknowledged' };
    };
    const write = await callTool('jarvos_session_thread_write', {
      threadId: 'internal-lost-ack', summary: 'ambiguous internal checkpoint', journalPolicy: 'none', mutationService,
    });
    assert.equal(write.isError, true);
    assert.match(write.content[0].text, /Mutation status: unknown_after_dispatch/);
    assert.match(write.content[0].text, /Operation: test-operation-00000001/);
    assert.match(write.content[0].text, /Journal backlink: not_requested/);
    assert.match(write.content[0].text, /Do not repeat the checkpoint/);
    const read = await callTool('jarvos_session_thread_read', { threadId: 'internal-lost-ack' });
    assert.equal((read.content[0].text.match(/ambiguous internal checkpoint/g) || []).length, 1);
    assert.equal(submissions, 1, 'readback neither replays nor drains');
    assert.deepEqual(fs.readdirSync(journal), []);
    assert.equal(fs.existsSync(path.join(vault, '.jarvos/journal-maintenance/deferred-backlinks.json')), false);
  });
});

test('direct and MCP session threads reject null and malformed journal policies before mutation', async () => {
  for (const journalPolicy of [null, 'typo', '', false, 0, [], {}, ['link']]) {
    for (const invoke of [writeSessionThread, (input) => callTool('jarvos_session_thread_write', input)]) {
      await withTempVault(async ({ vault, notes, journal, mutationService }) => {
        let intents = 0;
        let submissions = 0;
        mutationService.createWriteContext = () => { intents += 1; throw new Error('must not create mutation intent'); };
        mutationService.execute = () => { submissions += 1; throw new Error('must not dispatch mutation'); };
        await assert.rejects(async () => invoke({
          threadId: 'invalid-policy', summary: 'reject this checkpoint', journalPolicy, mutationService,
        }), /journalPolicy must be link or none/);
        assert.equal(intents, 0);
        assert.equal(submissions, 0);
        assert.deepEqual(fs.readdirSync(notes), []);
        assert.deepEqual(fs.readdirSync(journal), []);
        assert.equal(fs.existsSync(path.join(vault, '.jarvos/journal-maintenance/deferred-backlinks.json')), false);
      });
    }
  }
});

test('direct and MCP session threads preserve omitted and valid journal policies', async () => {
  for (const policy of [{}, { journalPolicy: undefined }, { journalPolicy: 'link' }, { journalPolicy: 'none' }]) {
    for (const viaMcp of [false, true]) {
      await withTempVault(async ({ notes, journal, mutationService }) => {
        const input = { threadId: 'valid-policy', summary: 'one valid checkpoint', mutationService, ...policy };
        const result = viaMcp ? await callTool('jarvos_session_thread_write', input) : writeSessionThread(input);
        const unlinked = policy.journalPolicy === 'none';
        if (viaMcp) {
          assert.equal(result.isError, false);
          assert.match(result.content[0].text, unlinked ? /Journal backlink: not_requested/ : /Journal backlink: linked/);
        } else {
          assert.equal(result.ok, true);
          assert.equal(result.journal.linked, !unlinked);
        }
        const note = fs.readFileSync(path.join(notes, 'JarvOS Session Thread - valid-policy.md'), 'utf8');
        assert.equal((note.match(/one valid checkpoint/g) || []).length, 1);
        assert.equal(fs.readdirSync(journal).length, unlinked ? 0 : 1);
      });
    }
  }
});

test('MCP session thread preserves ambiguous operation identity and an unattempted backlink', async () => {
  await withTempVault(async ({ journal, mutationService }) => {
    const execute = mutationService.execute.bind(mutationService);
    let submissions = 0;
    mutationService.execute = (operation) => {
      submissions += 1;
      if (submissions === 1) {
        execute(operation); // Obsidian saved the bytes but its acknowledgement was lost.
        return { ...fakeReceipt(operation, 'unknown_after_dispatch'), obsidian: 'unacknowledged' };
      }
      return fakeReceipt(operation, 'blocked');
    };
    const first = await callTool('jarvos_session_thread_write', { threadId: 'lost-ack', summary: 'first checkpoint', mutationService });
    assert.equal(first.isError, true);
    assert.match(first.content[0].text, /Mutation status: unknown_after_dispatch/);
    assert.match(first.content[0].text, /Operation: test-operation-00000001/);
    assert.match(first.content[0].text, /Journal backlink: pending/);
    assert.match(first.content[0].text, /Do not repeat the checkpoint/);
    const second = await callTool('jarvos_session_thread_write', { threadId: 'lost-ack', summary: 'second checkpoint', mutationService });
    assert.match(second.content[0].text, /Mutation status: blocked/);
    assert.match(second.content[0].text, /Operation: test-operation-00000002/);
    const read = await callTool('jarvos_session_thread_read', { threadId: 'lost-ack' });
    assert.equal((read.content[0].text.match(/first checkpoint/g) || []).length, 1);
    assert.doesNotMatch(read.content[0].text, /second checkpoint/);
    assert.equal(submissions, 2, 'readback must not submit another mutation or backlink');
    assert.deepEqual(fs.readdirSync(journal), []);
    assert.doesNotMatch(first.content[0].text, /vaultRelativePath|replayPayload|\/private\/|\/Users\//);
  });
});

test('MCP tool list includes jarvOS tools', () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    'jarvos_ripeness_context',
    'jarvos_active_assistant',
    'jarvos_common_work',
    'jarvos_todo_create',
    'jarvos_todo_list',
    'jarvos_todo_show',
    'jarvos_todo_transition',
    'jarvos_control_plane',
    'jarvos_coding_take_issue_to_done',
    'jarvos_shared_skills',
    'jarvos_current_work',
    'jarvos_projects_context',
    'jarvos_projects_roster',
    'jarvos_projects_record',
    'jarvos_projects_propose',
    'jarvos_projects_propose_v1',
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
  const roster = TOOLS.find((tool) => tool.name === 'jarvos_projects_roster');
  assert.deepEqual(roster.inputSchema, { type: 'object', additionalProperties: false, properties: {} });
  assert.match(roster.description, /jarvos\.projects-roster\/v1/);
  assert.match(roster.description, /id, kind, parentId, and revision/);
  assert.match(roster.description, /generation, scope, capturedAt, and complete/);
  assert.match(roster.description, /identity-only/i);
  assert.match(roster.description, /no lifecycle, owner, next action, or wait\/revisit signal/);
  assert.match(roster.description, /does not authorize continuing work/);
  const proposalV1 = TOOLS.find((tool) => tool.name === 'jarvos_projects_propose_v1');
  assert.deepEqual(proposalV1.inputSchema.properties.proposal.required, [
    'kind', 'expectedGeneration', 'record', 'rationale', 'evidenceRefs', 'expiresAt',
  ]);
  assert.deepEqual(proposalV1.inputSchema.properties.proposal.properties.record.required, [
    'kind', 'title', 'parentId', 'goal', 'definitionOfDone',
  ]);
  assert.match(proposalV1.description, /jarvos\.projects-proposal\/v1/);
  const healthDescription = TOOLS.find((tool) => tool.name === 'jarvos_journal_health').description;
  const ensureDescription = TOOLS.find((tool) => tool.name === 'jarvos_ensure_today_journal').description;
  assert.match(healthDescription, /read-only health/);
  assert.match(ensureDescription, /explicit user request/);
  assert.match(ensureDescription, /trusted host-declared maintenance trigger/);
  assert.match(ensureDescription, /do not run this during startup/);
  const shared = TOOLS.find((tool) => tool.name === 'jarvos_shared_skills');
  assert.deepEqual(shared.inputSchema.properties.operation.enum, [
    'status', 'explain', 'inventory', 'plan', 'repair', 'exclude', 'include',
    'decisions', 'explain-decision', 'resolve-decision',
    'acknowledge-decision', 'defer-decision', 'resume-decision',
  ]);
  assert.equal('credential' in shared.inputSchema.properties, false);
});

test('MCP jarvos_projects_roster is visible and accepts only an empty argument object', async () => {
  assert.ok(TOOLS.some((tool) => tool.name === 'jarvos_projects_roster'));
  await assert.rejects(
    () => callTool('jarvos_projects_roster', { profile: 'orientation' }),
    /empty object/,
  );
});

test('MCP jarvos_projects_record takes only record coordinates and needs a host readRecord', async () => {
  const tool = TOOLS.find((entry) => entry.name === 'jarvos_projects_record');
  assert.ok(tool, 'jarvos_projects_record must be listed');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.required, ['recordId', 'expectedGeneration', 'expectedRevision']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['expectedGeneration', 'expectedRevision', 'recordId']);
  const { setProjectsContextProvider } = require('../src/index.js');
  const outcome = async (args) => { try { return JSON.stringify(await callTool('jarvos_projects_record', args)); } catch (error) { return `rejected:${error.message}`; } };
  const coords = { recordId: 'prj_000002', expectedGeneration: 2, expectedRevision: 1 };
  let recordReads = 0; let plainReads = 0;
  try {
    setProjectsContextProvider({ read: async () => { plainReads += 1; return { status: 'unavailable' }; }, readRecord: async () => { recordReads += 1; return { status: 'unavailable', code: 'RECORD_UNAVAILABLE' }; } });
    for (const extra of [{ query: {} }, { path: '/tmp/x' }, { capability: {} }]) {
      assert.match(await outcome({ ...coords, ...extra }), /rejected|isError|unavailable/i);
    }
    assert.equal(recordReads, 0, 'extra keys must be rejected before readRecord');
    setProjectsContextProvider({ read: async () => { plainReads += 1; return { status: 'ok' }; } });
    assert.match(await outcome(coords), /unavailable/i);
    assert.equal(plainReads, 0, 'a provider without readRecord must not fall back to read');
  } finally { setProjectsContextProvider(null); }
});

test('MCP jarvos_projects_record and readProjectsRecord reject malformed record ids with zero provider calls', async () => {
  const tool = TOOLS.find((entry) => entry.name === 'jarvos_projects_record');
  assert.equal(tool.inputSchema.properties.recordId.pattern, '^(?:prj|out)_[0-9]{6,}$');
  const { setProjectsContextProvider, readProjectsRecord } = require('../src/index.js');
  let calls = 0;
  const counting = {
    read: async () => { calls += 1; return { status: 'unavailable' }; },
    readRoster: async () => { calls += 1; return { status: 'unavailable' }; },
    readRecord: async () => { calls += 1; return { status: 'unavailable', code: 'RECORD_UNAVAILABLE' }; },
  };
  try {
    setProjectsContextProvider(counting);
    for (const recordId of ['../x', 'prj_1', '', ' ', 'PRJ_000001', 'prj_00000a', 'xyz_000001', 'prj_000001 ', '/abs/prj_000001', 42, null]) {
      await assert.rejects(
        callTool('jarvos_projects_record', { recordId, expectedGeneration: 1, expectedRevision: 1 }),
        /accepts exactly recordId/,
        `MCP must reject ${JSON.stringify(recordId)}`,
      );
      assert.deepEqual(
        await readProjectsRecord({ provider: counting, recordId, expectedGeneration: 1, expectedRevision: 1 }),
        { ok: false, status: 'unavailable', contract: 'jarvos.projects-record/v1', code: 'RECORD_REQUEST_INVALID' },
        `facade must reject ${JSON.stringify(recordId)}`,
      );
    }
    assert.equal(calls, 0, 'malformed ids must never reach the provider');
  } finally { setProjectsContextProvider(null); }
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
  const previousSharedSkillsFile = process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE;
  delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
  delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
  delete process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE;
  try {
    for (const operation of ['inventory', 'plan', 'repair', 'exclude', 'include', 'decisions', 'explain-decision', 'resolve-decision', 'acknowledge-decision', 'defer-decision', 'resume-decision']) {
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
    if (previousSharedSkillsFile === undefined) delete process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE;
    else process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE = previousSharedSkillsFile;
  }
});

test('shared-skill MCP config binding preserves explicit paths and falls back lazily', () => {
  let fallbackCalls = 0;
  const fallback = () => {
    fallbackCalls += 1;
    return '/portable/default/config.json';
  };

  assert.equal(sharedSkillsConfigPath({}, fallback), '/portable/default/config.json');
  assert.equal(fallbackCalls, 1);
  assert.equal(
    sharedSkillsConfigPath({ JARVOS_SHARED_SKILLS_CONFIG_PATH: ' /host/config.json ' }, fallback),
    '/host/config.json',
  );
  assert.equal(fallbackCalls, 1);
});

test('shared-skill MCP status uses the portable default config when host binding is absent', () => {
  const skills = require('../../jarvos-skills/src');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-default-skills-'));
  try {
    const controlRoot = path.join(root, '.jarvos', 'shared-skills');
    const configPath = path.join(controlRoot, 'config.json');
    const config = skills.defaultConfig();
    config.controlRoot = controlRoot;
    config.publicCatalogPath = path.join(controlRoot, 'public-catalog.json');
    config.localOverlayPath = path.join(controlRoot, 'local-overlay.json');
    config.inventory.enabled = true;
    config.inventory.registeredRoots = [];
    for (const harness of skills.SUPPORTED_HARNESSES) {
      config.harnesses[harness].root = path.join(root, harness, 'skills');
    }
    skills.saveConfig(config, configPath);

    const mcpPath = path.join(__dirname, '..', 'scripts', 'jarvos-mcp.js');
    const script = [
      `const { callTool } = require(${JSON.stringify(mcpPath)});`,
      `callTool('jarvos_shared_skills', { operation: 'status' })`,
      ".then((result) => process.stdout.write(result.content[0].text))",
      '.catch((error) => { console.error(error); process.exit(1); });',
    ].join(' ');
    const env = { ...process.env, HOME: root };
    delete env.JARVOS_SHARED_SKILLS_CONFIG_PATH;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });

    assert.equal(child.status, 0, child.stderr);
    const payload = JSON.parse(child.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.mode, 'shared-status');
    assert.equal(payload.inventory.complete, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test('shared-skill MCP decision operations use opaque references and reject stale resolutions', async () => {
  const skills = require('../../jarvos-skills/src');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-decision-'));
  fs.chmodSync(root, 0o700);
  const harnessRoot = path.join(root, 'codex-skills');
  const bundle = path.join(harnessRoot, 'newsletter-generator');
  fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bundle, 'SKILL.md'), [
    '---',
    'name: newsletter-generator',
    'description: owner decision fixture',
    '---',
    '',
    'Use the approved network endpoint: https://example.test/submit',
    '',
  ].join('\n'), { mode: 0o600 });
  const tree = skills.computeBundleTree(bundle, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**', 'references/**', 'templates/**'],
  });
  const configPath = path.join(root, 'config.json');
  const config = skills.defaultConfig();
  config.controlRoot = root;
  config.publicCatalogPath = path.join(root, 'public-catalog.json');
  config.localOverlayPath = path.join(root, 'local-overlay.json');
  config.inventory.enabled = true;
  config.inventory.registeredRoots = [{
    rootId: 'codex-decision-fixture', harness: 'codex', root: harnessRoot, trustClass: 'markdown-only', lifecycle: 'available',
  }];
  skills.saveConfig(config, configPath);
  const statePath = skills.decisionStatePath({ configPath });
  const seeded = skills.reconcileDecisions({
    statePath,
    skills: [{
      logicalId: 'newsletter-generator',
      treeDigest: tree.treeDigest,
      attention: 'actionable',
      disposition: { kind: 'needs_input', reasonCode: 'needs_owner_input' },
    }],
  }).pending[0];
  const previousConfig = process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH;
  const previousCredential = process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
  const previousCredentialFile = process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
  const previousOwnerCredentialFile = process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE;
  const ownerCredentialFile = path.join(root, 'shared-skills-owner.credential');
  fs.writeFileSync(ownerCredentialFile, 'test-owner-session\n', { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(ownerCredentialFile, 0o600);
  process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH = configPath;
  delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
  delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
  process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE = ownerCredentialFile;
  try {
    const listed = await callTool('jarvos_shared_skills', { operation: 'decisions' });
    assert.equal(listed.isError, false);
    const listedPayload = JSON.parse(listed.content[0].text);
    assert.equal(listedPayload.decisions[0].decisionReference, seeded.decisionReference);
    assert.doesNotMatch(listed.content[0].text, /absolutePath|SKILL\.md/);

    const controlPlaneResult = await callTool('jarvos_control_plane', { operation: 'activation-status' });
    assert.equal(controlPlaneResult.isError, true);
    assert.match(controlPlaneResult.content[0].text, /credential is not configured/);

    const explained = await callTool('jarvos_shared_skills', {
      operation: 'explain-decision', decisionReference: seeded.decisionReference,
    });
    assert.equal(explained.isError, false);
    assert.equal(JSON.parse(explained.content[0].text).found, true);

    const acknowledged = await callTool('jarvos_shared_skills', {
      operation: 'acknowledge-decision', decisionReference: seeded.decisionReference,
    });
    assert.equal(acknowledged.isError, false);
    const acknowledgedPayload = JSON.parse(acknowledged.content[0].text);
    assert.equal(acknowledgedPayload.decision.status, 'pending');
    assert.deepEqual(acknowledgedPayload.decision.reminder, { status: 'acknowledged' });
    const invalidDefer = await callTool('jarvos_shared_skills', {
      operation: 'defer-decision', decisionReference: seeded.decisionReference, until: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(invalidDefer.isError, true);
    assert.match(invalidDefer.content[0].text, /invalid_until/);
    const deferred = await callTool('jarvos_shared_skills', {
      operation: 'defer-decision', decisionReference: seeded.decisionReference, until: '2999-01-01T00:00:00.000Z',
    });
    assert.equal(deferred.isError, false);
    assert.equal(JSON.parse(deferred.content[0].text).decision.reminder.status, 'deferred');
    const resumed = await callTool('jarvos_shared_skills', {
      operation: 'resume-decision', decisionReference: seeded.decisionReference,
    });
    assert.equal(resumed.isError, false);
    assert.deepEqual(JSON.parse(resumed.content[0].text).decision.reminder, { status: 'active' });

    const stale = await callTool('jarvos_shared_skills', {
      operation: 'resolve-decision', decisionReference: seeded.decisionReference,
      revision: 99, option: 'share',
    });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /stale/i);

    const valid = await callTool('jarvos_shared_skills', {
      operation: 'resolve-decision', decisionReference: seeded.decisionReference,
      revision: 1, option: 'keep-local',
    });
    assert.equal(valid.isError, false);
    const validPayload = JSON.parse(valid.content[0].text);
    assert.equal(validPayload.status, 'resolved');
    assert.equal(validPayload.receipt.option, 'keep-local');
    assert.match(valid.content[0].text, /postResolution/);
    assert.equal(skills.loadExclusionOverlay(path.join(root, 'inventory', 'exclusions.json')).status, 'valid');
  } finally {
    if (previousConfig === undefined) delete process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH;
    else process.env.JARVOS_SHARED_SKILLS_CONFIG_PATH = previousConfig;
    if (previousCredential === undefined) delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL;
    else process.env.JARVOS_CONTROL_PLANE_CREDENTIAL = previousCredential;
    if (previousCredentialFile === undefined) delete process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
    else process.env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE = previousCredentialFile;
    if (previousOwnerCredentialFile === undefined) delete process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE;
    else process.env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE = previousOwnerCredentialFile;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SHARED_SKILL_OWNER_OPERATIONS = ['inventory', 'plan', 'repair', 'exclude', 'include', 'decisions', 'explain-decision', 'resolve-decision', 'acknowledge-decision', 'defer-decision', 'resume-decision'];

// Child driver: records fs access under the watched shared-skill roots per
// callTool call, so a denial can be shown to precede config/ledger access.
const SHARED_SKILL_AUTHORITY_DRIVER = `'use strict';
const fs = require('fs');
const path = require('path');
const [mcpPath, requestsJson, ...watched] = process.argv.slice(2);
let touched = new Set();
const record = (value) => {
  const text = typeof value === 'string' ? value : value instanceof URL ? value.pathname : null;
  if (text && watched.some((root) => text === root || text.startsWith(root + path.sep))) touched.add(text);
};
for (const key of Object.keys(fs)) {
  const original = fs[key];
  if (typeof original !== 'function' || /^[A-Z]/.test(key)) continue;
  const spied = function (...args) { record(args[0]); record(args[1]); return original.apply(this, args); };
  Object.assign(spied, original);
  fs[key] = spied;
}
const { callTool } = require(mcpPath);
(async () => {
  const results = [];
  for (const [name, args] of JSON.parse(requestsJson)) {
    touched = new Set();
    try {
      const result = await callTool(name, args);
      results.push({ isError: result.isError === true, text: result.content.map((item) => item.text).join('\\n'), touched: [...touched] });
    } catch (error) {
      results.push({ threw: true, isError: true, text: String(error && error.message), touched: [...touched] });
    }
  }
  process.stdout.write(JSON.stringify(results));
})().catch((error) => { console.error(error); process.exit(1); });
`;

// Disposable shared-skill root: default config under a fixture HOME, harness
// roots, a seeded pending decision, synthetic credentials and a synthetic
// control-plane host built on the existing application-service factory.
function createSharedSkillAuthorityFixture({ body = 'PRIVATE-BODY-MARKER' } = {}) {
  const skills = require('../../jarvos-skills/src');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-skill-authority-')));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, 'home');
  const controlRoot = path.join(home, '.jarvos', 'shared-skills');
  const harnessRoot = path.join(root, 'harnesses');
  const auth = path.join(root, 'auth');
  const workspace = path.join(root, 'workspace');
  for (const dir of [controlRoot, harnessRoot, auth, workspace, path.join(root, 'tmp')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const bundle = path.join(harnessRoot, 'registered', 'private-authority-skill');
  fs.mkdirSync(bundle, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bundle, 'SKILL.md'), [
    '---', 'name: private-authority-skill', 'description: authority fixture', '---', '', body, '',
  ].join('\n'), { mode: 0o600 });
  const configPath = path.join(controlRoot, 'config.json');
  const config = skills.defaultConfig();
  config.controlRoot = controlRoot;
  config.publicCatalogPath = path.join(controlRoot, 'public-catalog.json');
  config.localOverlayPath = path.join(controlRoot, 'local-overlay.json');
  config.inventory.enabled = true;
  config.inventory.registeredRoots = [{
    rootId: 'codex-authority-fixture', harness: 'codex', root: path.join(harnessRoot, 'registered'), trustClass: 'markdown-only', lifecycle: 'available',
  }];
  for (const harness of skills.SUPPORTED_HARNESSES) {
    config.harnesses[harness].root = path.join(harnessRoot, harness, 'skills');
  }
  skills.saveConfig(config, configPath);
  const tree = skills.computeBundleTree(bundle, {
    allowlist: ['SKILL.md', 'scripts/**', 'assets/**', 'references/**', 'templates/**'],
  });
  const seeded = skills.reconcileDecisions({
    statePath: skills.decisionStatePath({ configPath }),
    skills: [{
      logicalId: 'private-authority-skill',
      treeDigest: tree.treeDigest,
      attention: 'actionable',
      disposition: { kind: 'needs_input', reasonCode: 'needs_owner_input' },
    }],
  }).pending[0];
  const secretFile = (name, value, mode = 0o600) => {
    const file = path.join(auth, name);
    fs.writeFileSync(file, `${value}\n`, { encoding: 'utf8', mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const hostModule = path.join(auth, 'host-service.js');
  const controlPlaneSource = path.join(__dirname, '..', '..', 'jarvos-control-plane', 'src', 'index.js');
  fs.writeFileSync(hostModule, [
    `const { createApplicationService, createMemoryApplicationStore } = require(${JSON.stringify(controlPlaneSource)});`,
    "const grants = { 'cp-readonly-token': ['control-plane.read'], 'cp-mutate-token': ['control-plane.read', 'control-plane.mutate', 'control-plane.approve'] };",
    "const service = createApplicationService({ store: createMemoryApplicationStore(), resolveCredential: (credential) => Object.hasOwn(grants, credential) ? { id: 'principal:synthetic-control-plane', capabilities: grants[credential], maxSensitivity: 'internal' } : null, canRead: () => true, policy: () => ({ outcome: 'require_approval', allowCreatorApproval: true, requiredCapability: 'control-plane.approve' }) });",
    'module.exports = () => service;',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
  const driver = path.join(root, 'driver.js');
  fs.writeFileSync(driver, SHARED_SKILL_AUTHORITY_DRIVER, { encoding: 'utf8', mode: 0o600 });
  return {
    root, home, controlRoot, harnessRoot, auth, workspace, configPath, seeded, hostModule, driver,
    ownerCredentialFile: secretFile('shared-skills-owner.credential', 'dedicated-owner-secret'),
    unsafeOwnerCredentialFile: secretFile('unsafe-owner.credential', 'unsafe-owner-secret', 0o644),
    emptyOwnerCredentialFile: secretFile('empty-owner.credential', ''),
    controlPlaneCredentialFile: secretFile('control-plane.credential', 'cp-mutate-token'),
  };
}

// Explicit minimal child env: nothing inherited except PATH, so no ambient
// JARVOS credential, config or live path can reach the MCP server.
function runSharedSkillAuthorityChild(fixture, bindings, requests) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: fixture.home,
    TMPDIR: path.join(fixture.root, 'tmp'),
    XDG_CONFIG_HOME: path.join(fixture.home, '.config'),
    XDG_STATE_HOME: path.join(fixture.home, '.local', 'state'),
    JARVOS_WORKSPACE_DIR: fixture.workspace,
    ...bindings,
  };
  const child = spawnSync(process.execPath, [
    fixture.driver,
    path.join(__dirname, '..', 'scripts', 'jarvos-mcp.js'),
    JSON.stringify(requests),
    fixture.controlRoot,
    fixture.harnessRoot,
  ], { cwd: fixture.workspace, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr);
  return { results: JSON.parse(child.stdout), stderr: child.stderr };
}

// Recursive snapshot of the disposable fixture only (mode and content).
function snapshotSharedSkillAuthorityFixture(fixture) {
  const entries = {};
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      const key = path.relative(fixture.root, full);
      if (stat.isDirectory()) {
        entries[key] = `dir:${stat.mode}`;
        walk(full);
      } else {
        entries[key] = `${stat.mode}:${stat.isFile() ? fs.readFileSync(full).toString('base64') : 'other'}`;
      }
    }
  };
  for (const dir of [fixture.controlRoot, fixture.harnessRoot, fixture.auth]) walk(dir);
  return entries;
}

test('disabled inventory keeps an explicit MCP resolution separate from automatic repair', () => {
  const skills = require('../../jarvos-skills/src');
  const fixture = createSharedSkillAuthorityFixture({ body: 'Use the approved network endpoint: https://example.test/submit' });
  try {
    const loaded = skills.loadConfig(fixture.configPath);
    loaded.config.inventory.enabled = false;
    skills.saveConfig(loaded.config, fixture.configPath);
    const before = snapshotSharedSkillAuthorityFixture(fixture);
    const { results } = runSharedSkillAuthorityChild(fixture, {
      JARVOS_SHARED_SKILLS_CONFIG_PATH: fixture.configPath,
      JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: fixture.ownerCredentialFile,
    }, [['jarvos_shared_skills', {
      operation: 'resolve-decision', decisionReference: fixture.seeded.decisionReference,
      revision: 1, option: 'share',
    }]]);
    assert.equal(results[0].isError, false, results[0].text);
    const result = JSON.parse(results[0].text);
    assert.equal(result.status, 'resolved');
    assert.equal(result.receipt.option, 'share');
    assert.deepEqual(result.postResolution, { status: 'disabled', reason: 'inventory_disabled' });
    const after = snapshotSharedSkillAuthorityFixture(fixture);
    const ledgerKey = path.relative(fixture.root, skills.decisionStatePath({ configPath: fixture.configPath }));
    delete before[ledgerKey];
    delete after[ledgerKey];
    assert.deepEqual(after, before, 'only the explicitly resolved decision may change');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

const SHARED_SKILL_AUTHORITY_SECRETS = ['dedicated-owner-secret', 'unsafe-owner-secret', 'cp-arbitrary-token', 'cp-readonly-token', 'cp-mutate-token', 'cp-rejected-token'];

function assertNoSharedSkillAuthorityLeak(fixture, text, label) {
  for (const value of [fixture.root, 'private-authority-skill', 'PRIVATE-BODY-MARKER', 'absolutePath', 'SKILL.md', ...SHARED_SKILL_AUTHORITY_SECRETS]) {
    assert.equal(text.includes(value), false, `${label}: response leaked a private value`);
  }
}

// Every owner operation, carrying model-injected authority that must be
// ignored, is denied before any shared-skill config, ledger or inventory
// access, leaves the fixture unchanged, and leaks nothing.
function assertSharedSkillOwnerDenied(scenario) {
  const fixture = createSharedSkillAuthorityFixture();
  try {
    const before = snapshotSharedSkillAuthorityFixture(fixture);
    const injected = {
      credential: 'cp-mutate-token',
      principal: { kind: 'owner', capabilities: ['skills.decisions.read', 'skills.decisions.resolve'] },
      service: { kind: 'owner' },
      applicationService: { kind: 'owner' },
      serviceModule: fixture.hostModule,
      credentialFile: fixture.ownerCredentialFile,
      ownerCredentialFile: fixture.ownerCredentialFile,
      configPath: fixture.configPath,
    };
    const requests = SHARED_SKILL_OWNER_OPERATIONS.map((operation) => ['jarvos_shared_skills', {
      operation,
      id: 'private-authority-skill',
      decisionReference: fixture.seeded.decisionReference,
      revision: 1,
      option: 'keep-local',
      until: '2999-01-01T00:00:00.000Z',
      reasonCode: 'owner_excluded',
      ...injected,
    }]);
    if (scenario.controlPlane) requests.push(['jarvos_control_plane', { operation: 'list' }]);
    const { results, stderr } = runSharedSkillAuthorityChild(fixture, scenario.env(fixture), requests);
    SHARED_SKILL_OWNER_OPERATIONS.forEach((operation, index) => {
      const result = results[index];
      const label = `${scenario.name}: ${operation}`;
      assert.equal(result.threw, undefined, `${label}: ${result.text}`);
      assert.equal(result.isError, true, label);
      assert.match(result.text, scenario.denial, label);
      assert.deepEqual(result.touched, [], `${label}: accessed shared-skill state before denial`);
      assertNoSharedSkillAuthorityLeak(fixture, result.text, label);
    });
    assertNoSharedSkillAuthorityLeak(fixture, stderr, `${scenario.name}: stderr`);
    if (scenario.controlPlane) {
      // The control-plane token's host outcome is real; it still grants nothing here.
      assert.equal(results.at(-1).isError, scenario.controlPlane !== 'accepted', `${scenario.name}: control-plane probe`);
    }
    assert.deepEqual(snapshotSharedSkillAuthorityFixture(fixture), before, `${scenario.name}: fixture changed`);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

const SHARED_SKILL_NOT_CONFIGURED = /^shared-skill owner session is not configured for this MCP session$/;
const SHARED_SKILL_BINDING_UNUSABLE = /^shared-skill owner credential file is unusable$/;

test('shared-skill owner operations never accept control-plane authority as ownership', async (t) => {
  const host = (fixture, credential) => ({
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: fixture.hostModule,
    JARVOS_CONTROL_PLANE_CREDENTIAL: credential,
  });
  const scenarios = [
    { name: 'absent authority before default config', env: () => ({}) },
    { name: 'arbitrary ambient control-plane token', env: () => ({ JARVOS_CONTROL_PLANE_CREDENTIAL: 'cp-arbitrary-token' }) },
    {
      name: 'host-valid control-plane credential file',
      env: (fixture) => ({ JARVOS_CONTROL_PLANE_SERVICE_MODULE: fixture.hostModule, JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: fixture.controlPlaneCredentialFile }),
      controlPlane: 'accepted',
    },
    { name: 'host-valid read-only control-plane token', env: (fixture) => host(fixture, 'cp-readonly-token'), controlPlane: 'accepted' },
    { name: 'host-valid mutating control-plane token', env: (fixture) => host(fixture, 'cp-mutate-token'), controlPlane: 'accepted' },
    { name: 'host-rejected control-plane token', env: (fixture) => host(fixture, 'cp-rejected-token'), controlPlane: 'denied' },
    {
      name: 'unavailable control-plane authenticator',
      env: (fixture) => ({ JARVOS_CONTROL_PLANE_SERVICE_MODULE: path.join(fixture.auth, 'missing-host-service.js'), JARVOS_CONTROL_PLANE_CREDENTIAL: 'cp-mutate-token' }),
      controlPlane: 'denied',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => assertSharedSkillOwnerDenied({ ...scenario, denial: SHARED_SKILL_NOT_CONFIGURED }));
  }
});

test('unusable dedicated shared-skill binding never falls back to the control plane', async (t) => {
  const fallback = (fixture, ownerFile) => ({
    JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: ownerFile,
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: fixture.hostModule,
    JARVOS_CONTROL_PLANE_CREDENTIAL: 'cp-mutate-token',
  });
  const scenarios = [
    { name: 'empty binding', env: (fixture) => fallback(fixture, ''), denial: SHARED_SKILL_NOT_CONFIGURED },
    { name: 'group/world-readable file', env: (fixture) => fallback(fixture, fixture.unsafeOwnerCredentialFile), denial: SHARED_SKILL_BINDING_UNUSABLE },
    { name: 'empty credential file', env: (fixture) => fallback(fixture, fixture.emptyOwnerCredentialFile), denial: SHARED_SKILL_BINDING_UNUSABLE },
    { name: 'missing file', env: (fixture) => fallback(fixture, path.join(fixture.auth, 'missing-owner.credential')), denial: SHARED_SKILL_BINDING_UNUSABLE },
    { name: 'relative path', env: (fixture) => fallback(fixture, 'shared-skills-owner.credential'), denial: SHARED_SKILL_BINDING_UNUSABLE },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => assertSharedSkillOwnerDenied({ ...scenario, controlPlane: 'accepted' }));
  }
});

test('dedicated shared-skill owner binding keeps full owner authority without control-plane authority', () => {
  const fixture = createSharedSkillAuthorityFixture();
  try {
    // Status and explain stay unbound, redacted reads.
    const unbound = runSharedSkillAuthorityChild(fixture, {}, [
      ['jarvos_shared_skills', { operation: 'status' }],
      ['jarvos_shared_skills', { operation: 'explain', id: 'private-authority-skill' }],
    ]).results;
    for (const result of unbound) {
      assert.equal(result.isError, false, result.text);
      assert.notDeepEqual(result.touched, [], 'watcher observes legitimate shared-skill reads');
      for (const value of ['private-authority-skill', 'PRIVATE-BODY-MARKER', 'absolutePath', 'SKILL.md']) {
        assert.equal(result.text.includes(value), false);
      }
    }
    assert.match(unbound[1].text, /skill-[a-f0-9]{24}/);

    // The dedicated file alone grants owner authority; a host-rejected
    // control-plane token and an injected narrower principal change nothing.
    const { decisionReference } = fixture.seeded;
    const { results, stderr } = runSharedSkillAuthorityChild(fixture, {
      JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: fixture.ownerCredentialFile,
      JARVOS_CONTROL_PLANE_SERVICE_MODULE: fixture.hostModule,
      JARVOS_CONTROL_PLANE_CREDENTIAL: 'cp-rejected-token',
    }, [
      ['jarvos_shared_skills', { operation: 'decisions', principal: { kind: 'reader', capabilities: [] } }],
      ['jarvos_shared_skills', { operation: 'explain-decision', decisionReference }],
      ['jarvos_shared_skills', { operation: 'inventory' }],
      ['jarvos_shared_skills', { operation: 'acknowledge-decision', decisionReference }],
      ['jarvos_control_plane', { operation: 'list' }],
    ]);
    const [decisions, explained, inventory, acknowledged, controlPlaneProbe] = results;
    assert.equal(decisions.isError, false, decisions.text);
    assert.equal(JSON.parse(decisions.text).decisions[0].decisionReference, decisionReference);
    assert.notDeepEqual(decisions.touched, []);
    assert.equal(explained.isError, false, explained.text);
    assert.equal(JSON.parse(explained.text).found, true);
    assert.equal(inventory.isError, false, inventory.text);
    assert.equal(acknowledged.isError, false, acknowledged.text);
    assert.deepEqual(JSON.parse(acknowledged.text).decision.reminder, { status: 'acknowledged' });
    assert.equal(controlPlaneProbe.isError, true, 'control-plane token is rejected by the host');
    for (const text of [...results.map((result) => result.text), stderr]) {
      for (const value of SHARED_SKILL_AUTHORITY_SECRETS) assert.equal(text.includes(value), false);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
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
  assert.match(source, /--env "JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE=\$SHARED_SKILLS_OWNER_CREDENTIAL_FILE"/);
  assert.match(source, /\[mcp_servers\.jarvos\.tools\.jarvos_shared_skills\]/);
  assert.match(source, /approval_mode = "prompt"/);
  // Never put the secret on codex mcp add argv / config.
  // Negative lookahead: CREDENTIAL_FILE must not count as the forbidden binding.
  assert.doesNotMatch(source, /--env\s+["']?JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)=/);
  assert.doesNotMatch(source, /JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)=\$\{?CONTROL_PLANE_CREDENTIAL\}?/);
  // Setup must not require ambient secret for registration.
  assert.doesNotMatch(source, /CONTROL_PLANE_CREDENTIAL="\$\{JARVOS_CONTROL_PLANE_CREDENTIAL(?!_FILE)/);
});

// Executable setup.sh branches with a fake codex on PATH and a temp CODEX_CONFIG.
// Never mutates the real ~/.codex/config.toml.
function runCodexSetup(envOverrides = {}, configSeed = '') {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const setupPath = path.join(repoRoot, 'runtimes', 'codex', 'setup.sh');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-codex-setup-'));
  const binDir = path.join(tmp, 'bin');
  const codexLog = path.join(tmp, 'codex-args.log');
  const configPath = path.join(tmp, 'config.toml');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(configPath, configSeed, 'utf8');
  // Fake codex records invocations and pretends jarvos is not registered.
  const fakeCodex = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf '%s\\n' "$*" >> ${JSON.stringify(codexLog)}`,
    'if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "get" ]; then exit 1; fi',
    'if [ "${1:-}" = "mcp" ] && [ "${2:-}" = "add" ] && [ "${JARVOS_TEST_CODEX_CORRUPT_AFTER_ADD:-0}" = "1" ]; then',
    '  printf \'\\n[mcp_servers.jarvos.tools."jarvos_shared_skills"]\\napproval_mode = "approve"\\n\' >> "$CODEX_CONFIG"',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  const fakeCodexPath = path.join(binDir, 'codex');
  fs.writeFileSync(fakeCodexPath, fakeCodex, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(fakeCodexPath, 0o755);

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    CODEX_HOME: tmp,
    CODEX_CONFIG: configPath,
    // Public-only setup: clear private host bindings unless the caller sets them.
    JARVOS_CONTROL_PLANE_SERVICE_MODULE: '',
    JARVOS_CONTROL_PLANE_CREDENTIAL_FILE: '',
    JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: '',
    JARVOS_WORK_ACTION_SERVICE_MODULE: '',
    JARVOS_PROJECTS_CONTEXT_CONFIG: '',
    JARVOS_STEWARDSHIP_BRIDGE_COMMAND: '',
    JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT: '',
    JARVOS_STEWARDSHIP_STABLE_ROOT: '',
    JARVOS_TEST_CODEX_CORRUPT_AFTER_ADD: '',
    ...envOverrides,
  };
  // Empty string override should delete so setup sees "unset".
  if (!env.JARVOS_CONTROL_PLANE_SERVICE_MODULE) delete env.JARVOS_CONTROL_PLANE_SERVICE_MODULE;
  if (!env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE) delete env.JARVOS_CONTROL_PLANE_CREDENTIAL_FILE;
  if (!env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE) delete env.JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE;
  if (!env.JARVOS_WORK_ACTION_SERVICE_MODULE) delete env.JARVOS_WORK_ACTION_SERVICE_MODULE;
  if (!env.JARVOS_PROJECTS_CONTEXT_CONFIG) delete env.JARVOS_PROJECTS_CONTEXT_CONFIG;
  if (!env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND) delete env.JARVOS_STEWARDSHIP_BRIDGE_COMMAND;
  if (!env.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT) delete env.JARVOS_STEWARDSHIP_CODEX_SESSION_MAP_ROOT;
  if (!env.JARVOS_STEWARDSHIP_STABLE_ROOT) delete env.JARVOS_STEWARDSHIP_STABLE_ROOT;
  if (!env.JARVOS_TEST_CODEX_CORRUPT_AFTER_ADD) delete env.JARVOS_TEST_CODEX_CORRUPT_AFTER_ADD;

  const rerun = () => spawnSync('bash', [setupPath], {
    encoding: 'utf8', cwd: repoRoot, env, maxBuffer: 4 * 1024 * 1024,
  });
  const result = rerun();
  return {
    tmp,
    configPath,
    codexLog,
    result,
    rerun,
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
    assert.doesNotMatch(log, /JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE=/);
    assert.doesNotMatch(log, /JARVOS_CONTROL_PLANE_CREDENTIAL=/);
    assert.doesNotMatch(log, /JARVOS_WORK_ACTION_SERVICE_MODULE=/);
    assert.doesNotMatch(log, /JARVOS_PROJECTS_CONTEXT_CONFIG=/);
    // Real user config must not be touched; only the temp CODEX_CONFIG may change.
    assert.ok(fs.existsSync(run.configPath));
    assert.match(fs.readFileSync(run.configPath, 'utf8'), /\[mcp_servers\.jarvos\.tools\.jarvos_shared_skills\]\napproval_mode = "prompt"/);
    assert.equal(run.rerun().status, 0);
    assert.equal((fs.readFileSync(run.configPath, 'utf8').match(/\[mcp_servers\.jarvos\.tools\.jarvos_shared_skills\]/g) || []).length, 1);
  } finally {
    run.cleanup();
  }
});

test('Codex setup refuses an unrecognized existing shared-skills approval form', () => {
  const run = runCodexSetup({}, '[mcp_servers.jarvos.tools."jarvos_shared_skills"]\napproval_mode = "approve"\n');
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /unrecognized jarvos_shared_skills tool config/);
    assert.ok(!fs.existsSync(run.codexLog) || !fs.readFileSync(run.codexLog, 'utf8').includes('mcp add'));
  } finally {
    run.cleanup();
  }
});

test('Codex setup upgrades an existing shared-skills gate and preserves quoted keys', () => {
  const run = runCodexSetup({}, [
    '[mcp_servers.jarvos.tools.jarvos_shared_skills]',
    '"approval_mode" = "approve"',
    'custom = true',
    '',
  ].join('\n'));
  try {
    assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
    const config = fs.readFileSync(run.configPath, 'utf8');
    assert.match(config, /approval_mode = "prompt"/);
    assert.doesNotMatch(config, /"approval_mode" = "approve"/);
    assert.match(config, /custom = true/);
    assert.equal(run.rerun().status, 0);
    assert.equal(fs.readFileSync(run.configPath, 'utf8'), config);
  } finally {
    run.cleanup();
  }
});

test('Codex setup binds shared-skill ownership without enabling the control plane', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-shared-skills-owner-'));
  const credentialFile = path.join(tmp, 'owner.credential');
  const secret = 'shared-skills-secret-never-logged';
  try {
    fs.writeFileSync(credentialFile, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(credentialFile, 0o600);
    const run = runCodexSetup({ JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: credentialFile });
    try {
      assert.equal(run.result.status, 0, run.result.stderr || run.result.stdout);
      const log = fs.readFileSync(run.codexLog, 'utf8');
      assert.ok(log.includes(`JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE=${credentialFile}`));
      assert.doesNotMatch(log, /JARVOS_CONTROL_PLANE_SERVICE_MODULE=/);
      assert.doesNotMatch(log, /JARVOS_CONTROL_PLANE_CREDENTIAL_FILE=/);
      assert.ok(!log.includes(secret), 'codex argv must not include secret');
    } finally {
      run.cleanup();
    }

    fs.chmodSync(credentialFile, 0o644);
    const unsafe = runCodexSetup({ JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: credentialFile });
    try {
      assert.notEqual(unsafe.result.status, 0);
      assert.match(unsafe.result.stderr, /owner-only|credential file/i);
      assert.ok(!unsafe.result.stderr.includes(secret), 'stderr must not include secret');
      assert.ok(!unsafe.result.stderr.includes(credentialFile), 'stderr must not include credential path');
    } finally {
      unsafe.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex setup refuses owner binding when the approval config targets another file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-shared-skills-config-mismatch-'));
  try {
    const credentialFile = path.join(tmp, 'owner.credential');
    fs.writeFileSync(credentialFile, 'owner\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(credentialFile, 0o600);
    const run = runCodexSetup({
      JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: credentialFile,
      CODEX_CONFIG: path.join(tmp, 'other-config.toml'),
    });
    try {
      assert.notEqual(run.result.status, 0);
      assert.match(run.result.stderr, /requires CODEX_CONFIG to equal/);
      assert.ok(!fs.existsSync(run.codexLog) || !fs.readFileSync(run.codexLog, 'utf8').includes('mcp add'));
    } finally {
      run.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex setup removes owner-bound MCP registration when final config apply fails', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-shared-skills-cleanup-'));
  try {
    const credentialFile = path.join(tmp, 'owner.credential');
    fs.writeFileSync(credentialFile, 'owner\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(credentialFile, 0o600);
    const run = runCodexSetup({
      JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: credentialFile,
      JARVOS_TEST_CODEX_CORRUPT_AFTER_ADD: '1',
    });
    try {
      assert.notEqual(run.result.status, 0);
      const calls = fs.readFileSync(run.codexLog, 'utf8').trim().split('\n');
      assert.match(calls.at(-1), /^mcp remove jarvos$/);
    } finally {
      run.cleanup();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

test('resolveSharedSkillsOwnerCredential is narrow and keeps control plane unbound', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-shared-skills-cred-'));
  try {
    const credentialFile = path.join(tmp, 'owner.credential');
    fs.writeFileSync(credentialFile, 'shared-skills-owner\n', { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(credentialFile, 0o600);
    const env = { JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: credentialFile };
    assert.equal(resolveSharedSkillsOwnerCredential(env), 'shared-skills-owner');
    assert.equal(resolveHostCredential(env), null);
    // A control-plane credential, ambient or file, never resolves as owner.
    assert.equal(resolveSharedSkillsOwnerCredential({ [CREDENTIAL_ENV]: 'valid-control-plane-fallback' }), null);
    assert.equal(resolveSharedSkillsOwnerCredential({ [CREDENTIAL_FILE_ENV]: credentialFile }), null);
    assert.equal(resolveSharedSkillsOwnerCredential({
      JARVOS_SHARED_SKILLS_OWNER_CREDENTIAL_FILE: '',
      [CREDENTIAL_ENV]: 'valid-control-plane-fallback',
    }), null);
    fs.chmodSync(credentialFile, 0o644);
    assert.throws(
      () => resolveSharedSkillsOwnerCredential({
        ...env,
        [CREDENTIAL_ENV]: 'valid-control-plane-fallback',
      }),
      /shared-skill owner credential file is unusable/,
    );
  } finally {
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

test('recall and synthesizeRecall keep QMD opt-in and spawn qmd only for includeQmd: true', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-recall-qmd-optin-'));
  const gbrainBin = path.join(root, 'fake-gbrain');
  const qmdBin = path.join(root, 'fake-qmd');
  const spyPath = path.join(root, 'qmd-invoked');
  fs.writeFileSync(gbrainBin, '#!/bin/sh\nprintf "%s\\n" "[0.9] projects/solo -- gbrain only"\n', 'utf8');
  fs.writeFileSync(qmdBin, `#!/bin/sh\necho invoked >> "${spyPath}"\nprintf "%s\\n" "[]"\n`, 'utf8');
  fs.chmodSync(gbrainBin, 0o755);
  fs.chmodSync(qmdBin, 0o755);
  const config = { gbrainBin, qmdBin, gbrainDir: root, brainDir: root, vaultDir: root, notesDir: root };

  for (const fn of [recall, synthesizeRecall]) {
    const result = fn({ query: 'solo', autoGraph: false, config });
    assert.equal(result.ok, true);
    assert.equal(result.bundle.includeQmd, false);
    assert.equal(result.bundle.engines.qmd, undefined);
    assert.equal(fs.existsSync(spyPath), false, `${fn.name} must not spawn qmd by default`);
  }

  const optedIn = recall({ query: 'solo', autoGraph: false, includeQmd: true, config });
  assert.equal(optedIn.bundle.includeQmd, true);
  assert.ok(optedIn.bundle.engines.qmd, 'includeQmd: true still runs the QMD leg');
  assert.equal(fs.existsSync(spyPath), true);
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

test('required-route hydration rejects missing, invalid, expired and foreign capabilities before returning private context', async () => {
  await withTempVault(async ({ journal }) => {
    const keys = ['JARVOS_REQUIRE_ROUTE_CAPABILITY', 'JARVOS_ROUTE_BINDING_SECRET', 'JARVOS_ROUTE_BINDING_SECRET_FILE', 'JARVOS_ROUTE_BINDING_GENERATION'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const secret = 'hydration-test-route-secret';
    const route = { harness: 'hermes', profile: 'default', platform: 'telegram', conversation: 'chat', sender: 'sender', nativeSession: 'hydration', generation: 'hermes-jarvos.v1' };
    process.env.JARVOS_REQUIRE_ROUTE_CAPABILITY = '1';
    process.env.JARVOS_ROUTE_BINDING_SECRET = secret;
    delete process.env.JARVOS_ROUTE_BINDING_SECRET_FILE;
    process.env.JARVOS_ROUTE_BINDING_GENERATION = route.generation;
    fs.writeFileSync(path.join(journal, '2026-05-12.md'), '# Private fixture journal\n');
    const options = { maxChars: 6000, projectsContext: false, ontology: false, journal: { date: '2026-05-12', timeZone: 'UTC' } };
    try {
      for (const sessionThread of [undefined, false, {},
        { routeCapability: 'invalid-capability' },
        { routeCapability: issueRouteCapability({ route, secret, now: 0 }) },
        { routeCapability: issueRouteCapability({ route: { ...route, generation: 'other-generation' }, secret }) },
        { routeCapability: issueRouteCapability({ route, secret: 'foreign-test-route-secret' }) },
      ]) {
        await assert.rejects(() => hydrate({ ...options, sessionThread }), /route capability/);
      }
      await assert.rejects(() => callTool('jarvos_hydrate', { maxChars: 6000, sessionThread: { routeCapability: 'invalid-capability' } }), /route capability/);
      const allowed = await hydrate({ ...options, sessionThread: { routeCapability: issueRouteCapability({ route, secret }) } });
      assert.match(allowed.markdown, /Private fixture journal/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
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

test('createHostProjectsContextProvider fails closed when its selected provider changes during binding', async () => {
  await withTempVault(async ({ tmp }) => {
    const workspace = path.join(tmp, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
    const configPath = path.join(workspace, 'projects-context.json');
    fs.writeFileSync(configPath, buildProjectsConfigFixture(workspace, 'race'));
    const original = fs.readFileSync; let providerReads = 0;
    fs.readFileSync = function patched(filePath, ...args) {
      if (String(filePath).endsWith('/provider.js') && ++providerReads === 2) throw new Error('selected provider changed');
      return original.call(this, filePath, ...args);
    };
    try { assert.equal(createHostProjectsContextProvider({ [PROJECTS_CONTEXT_CONFIG_ENV]: configPath }), null); }
    finally { fs.readFileSync = original; }
  });
});

// ---------------------------------------------------------------------------
// MCP execute-approved transport. The host session credential and the opaque
// requestId are the only values forwarded; the manager projects the awaited
// host result to { ok, requestId, outcome, code, claimId, expiresAt }.
// ---------------------------------------------------------------------------

function executeApprovedMcpHostSource({ recordFile, loadMarker }) {
  const source = path.join(__dirname, '..', '..', 'jarvos-control-plane', 'src', 'index.js');
  return [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(loadMarker)}, 'loaded');`,
    `const { createApplicationService, createMemoryApplicationStore } = require(${JSON.stringify(source)});`,
    "const inner = createApplicationService({ store: createMemoryApplicationStore(), resolveCredential: (credential) => credential === 'test-credential' ? { id: 'principal:test', capabilities: ['control-plane.read', 'control-plane.mutate'] } : null, canRead: () => true });",
    'const service = {',
    '  execute(operation, input) {',
    "    if (operation !== 'executeApproved') return inner.execute(operation, input);",
    `    fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify(input));`,
    "    if (input.requestId === 'request_reject') return new Promise((_, reject) => setTimeout(() => reject(new Error('PMS_EXECUTION_REFUSED')), 10));",
    "    if (input.requestId === 'request_refused') return Promise.resolve({ ok: false, requestId: input.requestId, outcome: 'refused', code: 'APPROVAL_UNAVAILABLE', claimId: null, expiresAt: null });",
    "    return new Promise((resolve) => setTimeout(() => resolve({ ok: true, requestId: input.requestId, outcome: 'installed', code: null, claimId: 'claim_fixture_mcp', expiresAt: '2026-10-20T12:00:00.000Z', secret: 'SYNTHETIC-SECRET-MARKER' }), 10));",
    '  },',
    '};',
    'module.exports = () => service;',
  ].join('\n');
}

async function withExecuteApprovedMcpHost(fn, { credential = 'test-credential' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-mcp-execute-approved-'));
  const keys = ['JARVOS_CONTROL_PLANE_SERVICE_MODULE', CREDENTIAL_ENV, CREDENTIAL_FILE_ENV];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const files = {
    hostModule: path.join(tmp, 'host-service.js'),
    recordFile: path.join(tmp, 'forwarded.json'),
    loadMarker: path.join(tmp, 'loaded.marker'),
  };
  fs.writeFileSync(files.hostModule, executeApprovedMcpHostSource(files), { encoding: 'utf8', mode: 0o600 });
  process.env.JARVOS_CONTROL_PLANE_SERVICE_MODULE = files.hostModule;
  delete process.env[CREDENTIAL_FILE_ENV];
  if (credential) process.env[CREDENTIAL_ENV] = credential;
  else delete process.env[CREDENTIAL_ENV];
  try { return await fn(files); } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Unknown control-plane operations may surface as a thrown tool error or an
// error result; either way they must be refused.
async function callToolSettled(name, args) {
  try {
    const result = await callTool(name, args);
    return { isError: result.isError, text: result.content?.[0]?.text || '' };
  } catch (error) {
    return { isError: true, text: error.message || String(error) };
  }
}

test('control-plane MCP schema exposes execute-approved but never internal claim or outcome operations', () => {
  const schema = TOOLS.find((tool) => tool.name === 'jarvos_control_plane').inputSchema;
  assert.ok(schema.properties.operation.enum.includes('execute-approved'));
  for (const internal of ['claimExecution', 'recordExecutionOutcome', 'claim-execution', 'record-execution-outcome']) {
    assert.equal(schema.properties.operation.enum.includes(internal), false, internal);
  }
  for (const authority of ['credential', 'approval', 'authorization', 'expectedApprover', 'claimId', 'pin', 'resolver', 'provider', 'path']) {
    assert.equal(Object.prototype.hasOwnProperty.call(schema.properties, authority), false, authority);
  }
});

test('MCP execute-approved awaits the host once and forwards only the bound credential and requestId', async () => {
  await withExecuteApprovedMcpHost(async ({ recordFile }) => {
    const result = await callTool('jarvos_control_plane', {
      operation: 'execute-approved',
      requestId: 'request_fixture_mcp',
      credential: 'attacker-supplied',
      fence: 9,
      approval: { allowed: true },
      authorization: { allowed: true },
      actor: { kind: 'human', id: 'forged' },
      commandSpec: { operation: 'pms-read-grant', arguments: { rootProjectId: 'prj_999999' } },
      expectedApprover: 'principal:forged',
      claimId: 'claim_forged',
      pin: 'forged-pin',
      resolver: 'forged-resolver',
      provider: '/tmp/forged-provider.js',
      path: '/tmp/forged-receipt.json',
      serviceModule: '/tmp/forged-host.js',
    });
    assert.equal(result.isError, false, result.content?.[0]?.text);
    assert.notEqual(result.content[0].text.trim(), '{}');
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: true, requestId: 'request_fixture_mcp', outcome: 'installed', code: null, claimId: 'claim_fixture_mcp', expiresAt: '2026-10-20T12:00:00.000Z',
    });
    assert.doesNotMatch(result.content[0].text, /SYNTHETIC-SECRET-MARKER|test-credential|attacker-supplied/);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordFile, 'utf8')), { credential: 'test-credential', requestId: 'request_fixture_mcp' });
  });
});

test('MCP execute-approved host rejection and refusal are error results, never {}', async () => {
  await withExecuteApprovedMcpHost(async () => {
    const rejected = await callTool('jarvos_control_plane', { operation: 'execute-approved', requestId: 'request_reject' });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /PMS_EXECUTION_REFUSED/);
    assert.notEqual(rejected.content[0].text.trim(), '{}');

    const refused = await callTool('jarvos_control_plane', { operation: 'execute-approved', requestId: 'request_refused' });
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(refused.content[0].text), {
      ok: false, requestId: 'request_refused', outcome: 'refused', code: 'APPROVAL_UNAVAILABLE', claimId: null, expiresAt: null,
    });
  });
});

test('MCP execute-approved fails closed without a host credential before loading the host', async () => {
  await withExecuteApprovedMcpHost(async ({ loadMarker, recordFile }) => {
    const result = await callTool('jarvos_control_plane', { operation: 'execute-approved', requestId: 'request_fixture_mcp', credential: 'attacker-supplied' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /credential/);
    assert.equal(fs.existsSync(loadMarker), false);
    assert.equal(fs.existsSync(recordFile), false);
  }, { credential: null });
});

test('MCP refuses internal claim and outcome operations without reaching the host', async () => {
  await withExecuteApprovedMcpHost(async ({ recordFile }) => {
    for (const operation of ['claimExecution', 'recordExecutionOutcome']) {
      const result = await callToolSettled('jarvos_control_plane', { operation, requestId: 'request_fixture_mcp', claimId: 'claim_forged', outcome: 'installed' });
      assert.equal(result.isError, true, operation);
      assert.match(result.text, /unsupported public control-plane operation/, operation);
    }
    assert.equal(fs.existsSync(recordFile), false);
    // Legacy reads still settle synchronously through the same host.
    const listed = await callTool('jarvos_control_plane', { operation: 'list' });
    assert.equal(listed.isError, false, listed.content?.[0]?.text);
  });
});
