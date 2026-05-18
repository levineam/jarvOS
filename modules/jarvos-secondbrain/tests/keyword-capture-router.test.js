const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyRoutingPlan,
  buildRoutingPlan,
  classifyCaptureIntent,
  detectTrigger,
  dispatchCaptureToSkills,
  hasCaptureIntent,
} = require('../bridge/routing/src/keyword-capture-router.js');

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
    return fn();
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

  withVaultEnv(vault, () => {
    const result = applyRoutingPlan({
      text: 'I have an idea: build a lighter bridge promotion dashboard',
      date: TEST_DATE,
    });

    assert.equal(result.plan.route, 'idea');
    assert.equal(result.plan.confidence, 'high');
    assert.deepEqual(result.plan.skillIds, ['idea-parking']);
    assert.equal(result.note, null);
    assert.equal(result.noteLink.heading, '## 💡 Ideas');

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 💡 Ideas\n- build a lighter bridge promotion dashboard/);
    assert.equal(fs.readdirSync(vault.notesDir).length, 0);
  });
});

test('plain "I have an idea about X" lands cleanly in the Ideas section', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, () => {
    const result = applyRoutingPlan({
      text: 'I have an idea about reusable capture workflows',
      date: TEST_DATE,
    });

    assert.equal(result.plan.route, 'idea');
    assert.equal(result.plan.createNote, false);

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 💡 Ideas\n- reusable capture workflows/);
    assert.doesNotMatch(journal, /I have an idea/);
  });
});

test('substantive idea creates both an Ideas entry and a standalone note link with backlink metadata', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, () => {
    const result = applyRoutingPlan({
      title: 'Bridge routing architecture',
      text: 'Here is an idea: define a shared routing layer and keep storage-specific writes inside adapters so journal and note behavior stay portable.',
      date: TEST_DATE,
    });

    assert.equal(result.plan.route, 'idea');
    assert.ok(result.note);
    assert.ok(result.noteLink);

    const noteFiles = fs.readdirSync(vault.notesDir);
    assert.equal(noteFiles.length, 1);
    assert.equal(noteFiles[0], 'Bridge routing architecture.md');

    const note = readDirFile(vault.notesDir, noteFiles[0]);
    assert.match(note, /type: "draft"/);
    assert.match(note, /source: "idea-capture"/);
    assert.match(note, /created_from: "journal\/2026-01-02"/);

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 💡 Ideas\n- \[\[Bridge routing architecture\]\]/);
  });
});

test('note trigger creates a standalone note plus a journal Notes backlink', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, () => {
    const explicit = applyRoutingPlan({
      text: 'make a note about package map ownership',
      date: TEST_DATE,
    });

    assert.ok(explicit.note);
    assert.equal(explicit.note.title, 'package map ownership');
    assert.deepEqual(explicit.plan.skillIds, ['note-creation', 'journal-entry']);

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 📝 Notes\n- \[\[package map ownership\]\]/);

    const note = readDirFile(vault.notesDir, 'package map ownership.md');
    assert.match(note, /# package map ownership/);
    assert.match(note, /source: "note-capture"/);
  });
});

test('medium-confidence capture routes to Flagged for review without creating a note', () => {
  const vault = makeTempVault();

  withVaultEnv(vault, () => {
    const plan = buildRoutingPlan({
      text: 'capture the package naming decision for later reference',
      date: TEST_DATE,
    });
    assert.equal(plan.route, 'flagged');
    assert.equal(plan.confidence, 'medium');
    assert.equal(plan.reviewRequired, true);
    assert.deepEqual(plan.skillIds, ['journal-entry']);

    const result = dispatchCaptureToSkills({
      text: 'capture the package naming decision for later reference',
      date: TEST_DATE,
    });

    assert.equal(result.note, null);
    assert.equal(fs.readdirSync(vault.notesDir).length, 0);

    const journal = readDirFile(vault.journalDir, `${TEST_DATE}.md`);
    assert.match(journal, /## 🚩 Flagged\n- \[ \] capture the package naming decision for later reference _\(review before filing\)_/);
  });
});

test('classifier exposes release contract confidence and review metadata', () => {
  assert.deepEqual(classifyCaptureIntent({ text: 'make a note about routing contracts' }), {
    route: 'note',
    detectedTrigger: 'note',
    confidence: 'high',
    reviewRequired: false,
    skillIds: ['note-creation', 'journal-entry'],
    reason: 'explicit-note-capture',
  });

  assert.deepEqual(classifyCaptureIntent({ text: 'remember this routing question' }), {
    route: 'flagged',
    detectedTrigger: null,
    confidence: 'medium',
    reviewRequired: true,
    skillIds: ['journal-entry'],
    reason: 'ambiguous-capture-for-review',
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
