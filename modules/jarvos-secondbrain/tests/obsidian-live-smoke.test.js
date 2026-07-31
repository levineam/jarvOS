'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LIVE_GATE,
  canonicalLinkCount,
  parseObsidianVersion,
  resolveLivePair,
  runLiveSmoke,
  verifyObsidianCli,
} = require('../scripts/obsidian-live-smoke');

function createPair() {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-obsidian-live-smoke-'));
  const journalDir = path.join(vaultRoot, 'Journal');
  const notesDir = path.join(vaultRoot, 'Notes');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  const journalPath = path.join(journalDir, '2030-02-03.md');
  const notePath = path.join(notesDir, 'Verified Live Pair.md');
  fs.writeFileSync(notePath, '---\njarvos_note_id: verified-live-pair\n---\n\n# Verified Live Pair\n', 'utf8');
  fs.writeFileSync(journalPath, '## 📝 Notes\n- [[Verified Live Pair]]\n', 'utf8');
  return { vaultRoot, journalDir, notesDir, journalPath, notePath };
}

function liveEnv(pair, additions = {}) {
  return {
    [LIVE_GATE]: '1',
    JARVOS_LIVE_OBSIDIAN_JOURNAL_PATH: pair.journalPath,
    JARVOS_LIVE_OBSIDIAN_NOTE_PATH: pair.notePath,
    JARVOS_LIVE_OBSIDIAN_NOTE_TARGET: 'Verified Live Pair',
    ...additions,
  };
}

test('live smoke is a successful no-op unless explicitly enabled', () => {
  const result = runLiveSmoke({ env: {} });
  assert.deepEqual(result, { skipped: true, reason: `${LIVE_GATE} is not 1` });
});

test('registered CLI verification uses the version subcommand and requires Obsidian 1.12.7+', () => {
  const calls = [];
  const result = verifyObsidianCli({
    command: '/usr/local/bin/obsidian',
    execute(command, args) {
      calls.push([command, args]);
      return '1.13.2 (installer 1.7.7)\n';
    },
  });

  assert.deepEqual(calls, [['/usr/local/bin/obsidian', ['version']]]);
  assert.deepEqual(parseObsidianVersion('1.12.7'), [1, 12, 7]);
  assert.equal(result.version, '1.13.2');
  assert.throws(() => verifyObsidianCli({ execute: () => '1.12.6\n' }), /1\.12\.7 or newer/);
});

test('live smoke uses the canonical mutation path twice without duplicating an existing link', () => {
  const pair = createPair();
  const calls = [];
  try {
    const result = runLiveSmoke({
      env: liveEnv(pair),
      roots: pair,
      evaluate(code) {
        calls.push(code);
        return {
          vaultName: path.basename(pair.vaultRoot),
          journalPath: 'Journal/2030-02-03.md',
          notePath: 'Notes/Verified Live Pair.md',
          linkTargetPath: 'Notes/Verified Live Pair.md',
        };
      },
      mutate({ journalPath, noteTitle, section, evaluate }) {
        assert.equal(journalPath, pair.journalPath);
        assert.equal(noteTitle, 'Verified Live Pair');
        assert.equal(section, '📝 Notes');
        assert.equal(evaluate, arguments[0].evaluate);
        return { alreadyPresent: true, mutationOwner: 'obsidian-vault-process' };
      },
      execute() {
        return '1.12.7\n';
      },
    });

    assert.equal(result.skipped, false);
    assert.equal(result.mutationPasses, 2);
    assert.equal(calls.length, 1);
    assert.equal(canonicalLinkCount(fs.readFileSync(pair.journalPath, 'utf8'), 'Verified Live Pair'), 1);
  } finally {
    fs.rmSync(pair.vaultRoot, { recursive: true, force: true });
  }
});

test('live smoke fails closed when the configured pair is not already canonical', () => {
  const pair = createPair();
  fs.writeFileSync(pair.journalPath, '## 📝 Notes\n-\n', 'utf8');
  try {
    assert.throws(() => runLiveSmoke({
      env: liveEnv(pair),
      roots: pair,
      evaluate: () => ({
        vaultName: path.basename(pair.vaultRoot),
        journalPath: 'Journal/2030-02-03.md',
        notePath: 'Notes/Verified Live Pair.md',
        linkTargetPath: 'Notes/Verified Live Pair.md',
      }),
      execute: () => '1.12.7\n',
    }), /must already contain exactly one canonical link/);
  } finally {
    fs.rmSync(pair.vaultRoot, { recursive: true, force: true });
  }
});

test('configured paths must remain within the configured vault journal and notes roots', () => {
  const pair = createPair();
  try {
    assert.throws(
      () => resolveLivePair(liveEnv(pair, { JARVOS_LIVE_OBSIDIAN_NOTE_PATH: '../outside.md' }), pair),
      /must be inside/,
    );
  } finally {
    fs.rmSync(pair.vaultRoot, { recursive: true, force: true });
  }
});
