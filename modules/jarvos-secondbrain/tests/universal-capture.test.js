'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  captureWithJarvos,
  normalizeCaptureEvent,
} = require('../bridge/capture/src/universal-capture');

const TEST_DATE = '2026-06-22';

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-universal-capture-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  const knowledgeDir = path.join(root, '.jarvos', 'knowledge');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  return { root, notesDir, journalDir, knowledgeDir };
}

function withVaultEnv(vault, fn) {
  const previous = {
    VAULT_NOTES_DIR: process.env.VAULT_NOTES_DIR,
    JARVOS_NOTES_DIR: process.env.JARVOS_NOTES_DIR,
    JOURNAL_DIR: process.env.JOURNAL_DIR,
    JARVOS_JOURNAL_DIR: process.env.JARVOS_JOURNAL_DIR,
    JARVOS_KNOWLEDGE_DIR: process.env.JARVOS_KNOWLEDGE_DIR,
  };
  process.env.VAULT_NOTES_DIR = vault.notesDir;
  process.env.JARVOS_NOTES_DIR = vault.notesDir;
  process.env.JOURNAL_DIR = vault.journalDir;
  process.env.JARVOS_JOURNAL_DIR = vault.journalDir;
  process.env.JARVOS_KNOWLEDGE_DIR = vault.knowledgeDir;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseCapture(source, overrides = {}) {
  return {
    source,
    actor: { type: 'assistant', name: source },
    captureMode: 'prompted',
    privacyTier: 'local-private',
    origin: { kind: 'prompt', ref: `${source}:message-1` },
    evidence: [{ type: 'message', text: overrides.text || 'note: capture the universal contract', messageId: 'message-1' }],
    date: TEST_DATE,
    ...overrides,
  };
}

test('normalizes supported and custom agents into CaptureEvent v2', () => {
  for (const source of ['codex', 'claude-code', 'openclaw', 'hermes', 'custom:future-agent']) {
    const event = normalizeCaptureEvent(baseCapture(source, {
      text: 'note: capture the universal contract',
    }));
    assert.equal(event.schemaVersion, '2.0');
    assert.equal(typeof event.source === 'string' ? event.source : event.source.tool, source);
    assert.equal(event.captureMode, 'prompted');
    assert.equal(event.privacyTier, 'local-private');
  }
});

test('explicit note capture writes canonical note journal backlink and sidecars for each agent path', () => {
  for (const source of ['codex', 'claude-code', 'openclaw', 'hermes', 'custom:future-agent']) {
    const vault = makeTempVault();
    withVaultEnv(vault, () => {
      const result = captureWithJarvos(baseCapture(source, {
        title: `${source} universal capture`,
        text: 'note: capture the universal note path with source-backed evidence.',
        frontmatter: {
          status: 'draft',
          type: 'reference',
          project: 'SUP-3233',
          author: 'jarvis',
        },
      }));

      assert.equal(result.ok, true);
      assert.equal(result.routing.plan.route, 'note');
      assert.ok(result.note.path.startsWith(vault.notesDir));
      assert.equal(result.journalEntry.journalPath, path.join(vault.journalDir, `${TEST_DATE}.md`));
      assert.equal(fs.existsSync(path.join(vault.notesDir, `Daily Journal — ${TEST_DATE}.md`)), false);

      const journal = fs.readFileSync(result.journalEntry.journalPath, 'utf8');
      const backlink = `[[${result.note.title}]]`;
      assert.equal(journal.split(backlink).length - 1, 1);

      assert.equal(result.knowledge.qmdStatus, 'pending-refresh');
      assert.ok(fs.existsSync(result.knowledge.artifactPath));
      assert.ok(fs.existsSync(result.knowledge.qmdPendingPath));
      const artifact = JSON.parse(fs.readFileSync(result.knowledge.artifactPath, 'utf8'));
      assert.equal(artifact.knowledgeUnits.length > 0, true);
      assert.equal(artifact.qmd.status, 'pending-refresh');
    });
  }
});

test('idea capture keeps lightweight ideas in journal and promotes substantive ideas to notes', () => {
  const vault = makeTempVault();
  withVaultEnv(vault, () => {
    const lightweight = captureWithJarvos(baseCapture('codex', {
      text: 'idea: tiny dashboard polish',
    }));
    assert.equal(lightweight.routing.plan.route, 'idea');
    assert.equal(lightweight.note, null);

    const substantive = captureWithJarvos(baseCapture('codex', {
      title: 'Universal capture contract',
      text: 'idea: define one jarvOS capture contract because each agent should call the same entrypoint and retrieval should cite the same source-backed sidecars.',
      frontmatter: {
        status: 'draft',
        type: 'reference',
        project: 'SUP-3233',
        author: 'jarvis',
      },
    }));
    assert.equal(substantive.routing.plan.route, 'idea');
    assert.ok(substantive.note);
    assert.equal(substantive.note.title, 'Universal capture contract');

    const journal = fs.readFileSync(path.join(vault.journalDir, `${TEST_DATE}.md`), 'utf8');
    assert.match(journal, /## 💡 Ideas/);
    assert.equal(journal.split('[[Universal capture contract]]').length - 1, 1);
    assert.equal(substantive.knowledge.qmdStatus, 'pending-refresh');
  });
});
