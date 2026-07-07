'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONTRACT_CLI = path.join(REPO_ROOT, 'scripts', 'obsidian-note-journal-contract.js');

function runContract({ root, personality }) {
  const input = {
    personality,
    title: `SUP-2229 ${personality} smoke`,
    content: `# SUP-2229 ${personality} smoke\n\nContract smoke for ${personality}.`,
    frontmatter: {
      status: 'draft',
      type: 'reference',
      project: 'SUP-2229',
      author: 'jarvis',
    },
  };
  const env = {
    ...process.env,
    VAULT_NOTES_DIR: path.join(root, 'Notes'),
    JOURNAL_DIR: path.join(root, 'Journal'),
    JARVOS_KNOWLEDGE_DIR: path.join(root, '.jarvos', 'knowledge'),
    JARVOS_ALLOW_UNSAFE_TEST_JOURNAL_WRITE: '1',
  };
  return spawnSync(process.execPath, [CONTRACT_CLI], {
    cwd: REPO_ROOT,
    env,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

test('supported AI personalities can execute the Obsidian note/journal contract', () => {
  for (const personality of ['michael', 'claude-code', 'hermes', 'codex']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sup-2229-${personality}-`));
    const first = runContract({ root, personality });
    assert.equal(first.status, 0, `${personality} first write failed: ${first.stderr}`);
    const parsedFirst = JSON.parse(first.stdout);
    assert.equal(parsedFirst.personality, personality);
    assert.equal(parsedFirst.created, true);
    assert.equal(parsedFirst.qmdStatus, 'pending-refresh');
    assert.equal(parsedFirst.verification.ok, true);
    assert.ok(parsedFirst.notePath.startsWith(path.join(root, 'Notes')));
    assert.equal(parsedFirst.journalPath, path.join(root, 'Journal', `${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}.md`));

    const second = runContract({ root, personality });
    assert.equal(second.status, 0, `${personality} update failed: ${second.stderr}`);
    const parsedSecond = JSON.parse(second.stdout);
    assert.equal(parsedSecond.created, false);
    assert.equal(parsedSecond.verification.ok, true);

    const journalMd = fs.readFileSync(parsedSecond.journalPath, 'utf8');
    const backlink = `- [[${parsedSecond.title}]]`;
    assert.equal(journalMd.split(backlink).length - 1, 1, `${personality} should have exactly one journal backlink`);

    const qmd = JSON.parse(fs.readFileSync(parsedSecond.qmdPendingPath, 'utf8'));
    assert.equal(qmd.entries[`Notes/${parsedSecond.title}.md`].status, 'pending-refresh');
  }
});

test('unsupported personalities fail closed instead of raw-writing orphaned markdown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-2229-unsupported-'));
  const env = {
    ...process.env,
    VAULT_NOTES_DIR: path.join(root, 'Notes'),
    JOURNAL_DIR: path.join(root, 'Journal'),
    JARVOS_KNOWLEDGE_DIR: path.join(root, '.jarvos', 'knowledge'),
  };
  const result = spawnSync(process.execPath, [CONTRACT_CLI], {
    cwd: REPO_ROOT,
    env,
    input: JSON.stringify({
      personality: 'unknown',
      title: 'Should not write',
      content: 'This should fail before writing.',
    }),
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported personality/);
  assert.equal(fs.existsSync(path.join(root, 'Notes')), false);
  assert.equal(fs.existsSync(path.join(root, 'Journal')), false);
});

test('durable note contract refuses lightweight Idea captures without explicit durable intent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-3283-lightweight-idea-'));
  const env = {
    ...process.env,
    VAULT_NOTES_DIR: path.join(root, 'Notes'),
    JOURNAL_DIR: path.join(root, 'Journal'),
    JARVOS_KNOWLEDGE_DIR: path.join(root, '.jarvos', 'knowledge'),
  };
  const result = spawnSync(process.execPath, [CONTRACT_CLI], {
    cwd: REPO_ROOT,
    env,
    input: JSON.stringify({
      personality: 'codex',
      title: 'Vibe economics',
      content: 'Idea: the end of "vibe economics". Concept is that economics up until now has basically been based on vibes.',
      frontmatter: {
        status: 'draft',
        type: 'reference',
        project: 'SUP-3283',
        author: 'jarvis',
      },
    }),
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /jarvos-capture\.js/);
  assert.equal(fs.existsSync(path.join(root, 'Notes')), false);
  assert.equal(fs.existsSync(path.join(root, 'Journal')), false);
});
