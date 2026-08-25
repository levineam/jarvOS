const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyRoutingPlan,
  applyStrictCommandPlan,
  buildRoutingPlan,
  detectTrigger,
  hasCaptureIntent,
  parseHardCaptureCommand,
} = require('../bridge/routing/src/keyword-capture-router.js');
const { receiptIsAcknowledged } = require('../src/artifact-receipt.js');
const { createAcknowledgedVaultMutationService } = require('./helpers/acknowledged-vault-mutation-service');

const TEST_DATE = '2026-01-02';

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-secondbrain-'));
  const notesDir = path.join(root, 'Notes');
  const journalDir = path.join(root, 'Journal');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  return { root, notesDir, journalDir };
}

function withVaultEnv(vault, fn) {
  const prevNotes = process.env.VAULT_NOTES_DIR;
  const prevJournal = process.env.JOURNAL_DIR;
  process.env.VAULT_NOTES_DIR = vault.notesDir;
  process.env.JOURNAL_DIR = vault.journalDir;
  try {
    return fn({ mutationService: createAcknowledgedVaultMutationService(vault.root), vaultRoot: vault.root, journalDir: vault.journalDir });
  } finally {
    if (prevNotes === undefined) delete process.env.VAULT_NOTES_DIR;
    else process.env.VAULT_NOTES_DIR = prevNotes;
    if (prevJournal === undefined) delete process.env.JOURNAL_DIR;
    else process.env.JOURNAL_DIR = prevJournal;
  }
}

function readDirFile(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

test('idea trigger routes lightweight capture to the journal Ideas section only', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, (options) => {
    const result = applyRoutingPlan({
      text: 'I have an idea: build a lighter bridge promotion dashboard',
      date: TEST_DATE,
    }, options);

    assert.equal(result.plan.route, 'idea');
    assert.equal(result.note, null);
    assert.equal(result.noteLink.heading, '## 💡 Ideas');

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 💡 Ideas\n- build a lighter bridge promotion dashboard/);
    assert.equal(fs.readdirSync(vault.notesDir).length, 0);
  });
});

test('substantive idea creates a note linked from the Ideas section', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, (options) => {
    const result = applyRoutingPlan({
      title: 'Bridge routing architecture',
      text: 'Here is an idea: define a shared routing layer and keep storage-specific writes inside adapters so journal and note behavior stay portable.',
      date: TEST_DATE,
    }, options);

    assert.equal(result.plan.route, 'idea');
    assert.ok(result.note);
    assert.equal(result.note.title, 'Bridge routing architecture');
    assert.ok(result.noteLink);
    assert.deepEqual(result.artifactReceipt.artifacts.map(({ kind, vaultRelativePath, outcome }) => ({ kind, vaultRelativePath, outcome })), [
      { kind: 'note', vaultRelativePath: 'Notes/Bridge routing architecture.md', outcome: 'committed' },
      { kind: 'journal', vaultRelativePath: 'Journal/2026-01-02.md', outcome: 'committed' },
    ]);
    assert.equal(fs.readdirSync(vault.notesDir).length, 1);

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 💡 Ideas\n- \[\[Bridge routing architecture\]\] — define a shared routing layer and keep storage-specific writes inside adapters so journal and note behavior stay portable\./);
    assert.equal(journal.split('[[Bridge routing architecture]]').length - 1, 1);
  });
});

test('note trigger and ambiguous capture both bias to standalone notes plus journal Notes links', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, (options) => {
    const explicit = applyRoutingPlan({
      text: 'note: lock the package map and explain where routing belongs',
      title: 'Secondbrain package map',
      date: TEST_DATE,
    }, options);

    const defaultPlan = buildRoutingPlan({
      text: 'capture the package naming decision for later reference',
      date: TEST_DATE,
    });
    assert.equal(defaultPlan.route, 'note');
    assert.equal(defaultPlan.defaultedToNoteBias, true);

    const implicit = applyRoutingPlan({
      text: 'capture the package naming decision for later reference',
      date: TEST_DATE,
    }, options);

    assert.ok(explicit.note);
    assert.ok(implicit.note);

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 📝 Notes\n- \[\[Secondbrain package map\]\]/);
    assert.match(journal, /\[\[capture the package naming decision for later reference\]\]/);
  });
});

test('anti-trigger phrases do not get captured as idea events', () => {
  assert.equal(detectTrigger({ text: 'I have no idea why that failed.' }), null);
  assert.equal(hasCaptureIntent({ text: 'I have no idea why that failed.' }), false);
  assert.equal(buildRoutingPlan({ text: 'What\'s the idea behind this?' }).ignored, true);

  const result = applyRoutingPlan({ text: 'That is not a good idea.' });
  assert.equal(result.plan.ignored, true);
  assert.equal(result.note, null);
  assert.equal(result.journalEntry, null);
});

test('adapter abstraction works with a mock storage adapter', () => {
  const calls = [];
  const mockAdapter = {
    ensureJournal({ date }) {
      calls.push(['ensureJournal', date]);
      return { journalPath: `/tmp/${date}.md`, existed: true };
    },
    appendLineToJournalSection({ heading, line, date }) {
      calls.push(['appendLineToJournalSection', heading, line, date]);
      return { heading, line, date, alreadyPresent: false };
    },
    writeNote({ title, content, frontmatter }) {
      calls.push(['writeNote', title, content, frontmatter]);
      return { written: true, path: `/tmp/${title}.md`, title };
    },
  };

  const result = applyRoutingPlan(
    {
      text: 'note to self: wire plain-markdown adapters before obsidian-specific polish',
      date: TEST_DATE,
    },
    { adapter: mockAdapter },
  );

  assert.equal(result.plan.route, 'note');
  assert.equal(calls[0][0], 'writeNote');
  assert.equal(calls[1][0], 'appendLineToJournalSection');
  assert.equal(calls[1][1], '## 📝 Notes');
  assert.match(JSON.stringify(calls[0][3]), /journal\/2026-01-02/);
});

test('strict hard commands are anchored, preserve payload colons, and expose public responses', () => {
  assert.deepEqual(parseHardCaptureCommand(' Idea: The Next Pandemic: AI Addiction '), {
    disposition: 'capture',
    matched: true,
    command: 'idea',
    route: 'idea',
    content: 'The Next Pandemic: AI Addiction',
    response: 'Captured to Ideas.',
  });
  assert.deepEqual(parseHardCaptureCommand('Note: Capture command: contract'), {
    disposition: 'capture',
    matched: true,
    command: 'note',
    route: 'note',
    content: 'Capture command: contract',
    response: 'Captured as a note.',
  });
  assert.deepEqual(parseHardCaptureCommand('Journal: Reviewed the capture bug'), {
    disposition: 'capture',
    matched: true,
    command: 'journal',
    route: 'journal',
    content: 'Reviewed the capture bug',
    response: 'Captured to Journal.',
  });
  assert.deepEqual(parseHardCaptureCommand('Add to Journal: Filed SUP-1: follow-up'), {
    disposition: 'capture',
    matched: true,
    command: 'add-to-journal',
    route: 'journal',
    content: 'Filed SUP-1: follow-up',
    response: 'Captured to Journal.',
  });

  for (const text of [
    'She said "Idea: fix the router" during standup.',
    'Could you help shape this idea: AI addiction?',
    'note to self: this remains ambient capture',
    'Let us journal: capture the highlights later',
  ]) {
    assert.equal(parseHardCaptureCommand(text).disposition, 'continue');
  }
});

test('bare strict commands request content without touching storage', () => {
  const explodingAdapter = {
    writeNote() { throw new Error('bare command must not write a note'); },
    appendLineToJournalSection() { throw new Error('bare command must not write a journal'); },
    ensureJournal() { throw new Error('bare command must not ensure a journal'); },
  };

  const cases = [
    ['Idea:', 'What idea should I capture?'],
    ['Note:   ', 'What note should I capture?'],
    ['Journal:', 'What should I add to your journal?'],
    ['  Add to Journal:  ', 'What should I add to your journal?'],
  ];

  for (const [text, response] of cases) {
    const parsed = parseHardCaptureCommand(text);
    assert.equal(parsed.disposition, 'needs_input');
    assert.equal(parsed.response, response);

    const result = applyStrictCommandPlan({ text, date: TEST_DATE }, { adapter: explodingAdapter });
    assert.equal(result.disposition, 'needs_input');
    assert.equal(result.response, response);
    assert.deepEqual(result.artifactReceipt.artifacts, []);
  }
});

test('all populated strict commands use the expected canonical writer route', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, (options) => {
    const idea = applyStrictCommandPlan({ text: 'Idea: ship the router: keep it simple', date: TEST_DATE }, options);
    assert.equal(idea.route, 'idea');
    assert.equal(idea.noteLink.heading, '## 💡 Ideas');
    assert.equal(receiptIsAcknowledged(idea.artifactReceipt), true);

    const note = applyStrictCommandPlan({ text: 'Note: Capture command contract', date: TEST_DATE }, options);
    assert.equal(note.route, 'note');
    assert.ok(note.note);
    assert.equal(receiptIsAcknowledged(note.artifactReceipt), true);

    const journal = applyStrictCommandPlan({ text: 'Journal: paid rent: $2,400', date: TEST_DATE }, options);
    assert.equal(journal.route, 'journal');
    assert.equal(journal.noteLink.heading, '## 📓 Journal Entry');
    assert.equal(journal.noteLink.line, '- paid rent: $2,400');
    assert.equal(receiptIsAcknowledged(journal.artifactReceipt), true);

    const add = applyStrictCommandPlan({ text: 'Add to Journal: closed SUP-1: filed follow-up', date: TEST_DATE }, options);
    assert.equal(add.route, 'journal');
    assert.equal(add.noteLink.heading, '## 📓 Journal Entry');
    assert.equal(receiptIsAcknowledged(add.artifactReceipt), true);
  });
});
