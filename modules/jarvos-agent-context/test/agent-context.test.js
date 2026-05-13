'use strict';

const assert = require('assert');
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
  redactObviousSecrets,
  verifyNoteCaptureContract,
} = require('../src/index.js');
const { callTool, TOOLS } = require('../scripts/jarvos-mcp.js');

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

test('MCP tool list includes jarvOS tools', () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    'jarvos_current_work',
    'jarvos_recall',
    'jarvos_create_note',
    'jarvos_startup_brief',
    'jarvos_hydrate',
  ]);
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
