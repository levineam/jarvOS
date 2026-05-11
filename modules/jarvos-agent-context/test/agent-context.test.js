'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const jarvosPaths = require('../../jarvos-secondbrain/bridge/config/jarvos-paths.js');
const {
  createNote,
  defaultFrontmatter,
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
