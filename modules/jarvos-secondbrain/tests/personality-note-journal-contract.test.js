'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONTRACT_CLI = path.join(REPO_ROOT, 'scripts', 'obsidian-note-journal-contract.js');
const { verifyContract } = require('../bridge/provenance/src/note-journal-contract.js');

function runContract({ root, personality, frontmatter = {} }) {
  const input = {
    personality,
    title: `SUP-2229 ${personality} smoke`,
    content: `# SUP-2229 ${personality} smoke\n\nContract smoke for ${personality}.`,
    frontmatter: {
      status: 'draft',
      type: 'reference',
      project: 'SUP-2229',
      author: 'jarvis',
      ...frontmatter,
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

function withEnv(nextEnv, fn) {
  const previous = Object.fromEntries(Object.keys(nextEnv).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(nextEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test('canonical writer owns jarvos_note_id and preserves it across caller-supplied rewrites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-note-id-'));
  const first = runContract({ root, personality: 'codex' });
  assert.equal(first.status, 0, first.stderr);
  const firstResult = JSON.parse(first.stdout);
  assert.match(firstResult.noteId, /^[0-9a-f-]{36}$/i);

  const second = runContract({
    root,
    personality: 'codex',
    frontmatter: { jarvos_note_id: 'caller-controlled-id' },
  });
  assert.equal(second.status, 0, second.stderr);
  const secondResult = JSON.parse(second.stdout);
  assert.equal(secondResult.noteId, firstResult.noteId);
  assert.doesNotMatch(fs.readFileSync(secondResult.notePath, 'utf8'), /caller-controlled-id/);
});

test('a verified deferred backlink queue is a successful partial contract result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-deferred-backlink-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  const title = 'Deferred durable note';
  const notePath = path.join(notesDir, `${title}.md`);
  const journalPath = path.join(journalDir, `${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}.md`);
  const deferredPath = path.join(root, '.jarvos', 'journal-maintenance', 'deferred-backlinks.json');
  const qmdPendingPath = path.join(root, '.jarvos', 'knowledge', 'qmd-refresh-pending.json');
  const recoveryKey = 'deferred-recovery-key';

  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(path.dirname(deferredPath), { recursive: true });
  fs.mkdirSync(path.dirname(qmdPendingPath), { recursive: true });
  fs.writeFileSync(notePath, [
    '---',
    'status: draft',
    'type: reference',
    'project: "SUP-0000"',
    'created: 2030-01-02',
    'updated: 2030-01-02',
    'author: jarvis',
    'source_personality: codex',
    'contract: obsidian-note-journal-v1',
    'jarvos_note_id: 123e4567-e89b-12d3-a456-426614174000',
    '---',
    '',
    `# ${title}`,
  ].join('\n'));
  fs.writeFileSync(deferredPath, JSON.stringify({
    version: 1,
    entries: {
      [recoveryKey]: {
        status: 'pending',
        noteTitle: title,
        journalPath,
        noteId: '123e4567-e89b-12d3-a456-426614174000',
        notePath: `Notes/${title}.md`,
      },
    },
  }));
  fs.writeFileSync(qmdPendingPath, JSON.stringify({
    entries: {
      [`Notes/${title}.md`]: { status: 'pending-refresh' },
    },
  }));

  const result = {
    path: notePath,
    title,
    journal: {
      status: 'deferred',
      deferredBacklink: { deferredPath, key: recoveryKey },
    },
    knowledge: { qmdPendingPath, qmdStatus: 'pending-refresh' },
  };

  withEnv({ VAULT_NOTES_DIR: notesDir, JOURNAL_DIR: journalDir }, () => {
    const verification = verifyContract(result, 'codex');
    assert.equal(verification.ok, true, verification.failures.join('; '));
    assert.equal(verification.journalComplete, false);
    assert.equal(verification.deferred, true);
    assert.equal(verification.recoveryKey, recoveryKey);

    fs.writeFileSync(deferredPath, JSON.stringify({ version: 1, entries: {} }));
    const missingReceipt = verifyContract(result, 'codex');
    assert.equal(missingReceipt.ok, false);
    assert.match(missingReceipt.failures.join('; '), /missing deferred backlink queue record/);
  });
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
