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
  currentWork,
  defaultFrontmatter,
  hydrate,
  readSessionThread,
  redactObviousSecrets,
  synthesizeRecall,
  verifyNoteCaptureContract,
  writeSessionThread,
} = require('../src/index.js');
const { callTool, PROMPTS, TOOLS } = require('../scripts/jarvos-mcp.js');

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
  };

  process.env.JARVOS_VAULT_DIR = vault;
  process.env.JARVOS_NOTES_DIR = notes;
  process.env.JARVOS_JOURNAL_DIR = journal;
  process.env.JARVOS_TIMEZONE = 'UTC';
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

test('defaultFrontmatter includes note-capture contract fields', () => {
  const frontmatter = defaultFrontmatter({ project: 'codex' });
  assert.equal(frontmatter.status, 'draft');
  assert.equal(frontmatter.type, 'note');
  assert.equal(frontmatter.project, 'codex');
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

test('hydrate includes journal, linked notes, ontology spine, report, and redacts secrets', async () => {
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
      fs.writeFileSync(path.join(ontologyDir, '1-higher-order.md'), '# Higher\n\n## My Higher Order\n\nUse meaning to steer execution.\n', 'utf8');
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
      assert.match(result.markdown, /jarvos-ontology Meaning Spine/);
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
