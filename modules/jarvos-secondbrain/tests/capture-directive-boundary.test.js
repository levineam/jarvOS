'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authorizeCapture } = require('../packages/jarvos-ambient/src/intent/capture-authorization');
const ambient = require('../packages/jarvos-ambient/src/intent/keyword-capture-router');
const bridge = require('../bridge/routing/src/keyword-capture-router');
const { dispatchCapture } = require('../bridge/dispatch/src/capture-dispatcher');
const { captureWithJarvos } = require('../bridge/capture/src/universal-capture');
const { createAcknowledgedVaultMutationService } = require('./helpers/acknowledged-vault-mutation-service');

// Short scrubbed excerpts; never copy private task bodies into public fixtures.
const CASES = [
  ['quoted mention', 'Create notes only on an explicit capture request ("note:", "make a note", "save this", "idea:" per existing rules).'],
  ['unquoted list', 'A classifier signal must never create a standalone note; only explicit note:, make a note, save this, idea: per rules or explicit capture_that.'],
  ['scorer only', 'Isolate the patch-lifecycle test from the live gateway stamp.'],
];
const POSITIVES = [
  ['Make a note of that.', 'note'],
  ['Please make a note that the vendor call moved to Friday.', 'note'],
  ['ok so, make a note: buy milk', 'note'],
  ['Hey Jarvis, take a note about the plan', 'note'],
  ['idea: x', 'idea'],
  ['note: x', 'note'],
];

for (const [name, text] of CASES) {
  test(`capture directive excerpt: ${name} does not authorize or trigger`, () => {
    assert.equal(authorizeCapture({ text }).authorized, false);
    for (const router of [ambient, bridge]) {
      assert.equal(router.detectTrigger({ text }), null);
      assert.equal(router.hasCaptureIntent({ text }), false);
    }
  });

  test(`dispatcher excerpt: ${name} creates no note or journal`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-directive-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const notesDir = path.join(root, 'Notes');
    const journalDir = path.join(root, 'Journal');
    fs.mkdirSync(notesDir);
    fs.mkdirSync(journalDir);
    const env = {
      VAULT_NOTES_DIR: notesDir,
      JARVOS_NOTES_DIR: notesDir,
      JOURNAL_DIR: journalDir,
      JARVOS_JOURNAL_DIR: journalDir,
      JARVOS_VAULT_DIR: root,
      JARVOS_KNOWLEDGE_DIR: path.join(root, '.jarvos', 'knowledge'),
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const options = {
      vaultRoot: root,
      journalDir,
      mutationService: createAcknowledgedVaultMutationService(root),
    };
    const result = dispatchCapture({
      text,
      date: '2026-01-02',
      classification: { salienceClass: 'lesson', confidence: 0.9 },
    }, options);
    assert.equal(result.captured, false);
    assert.equal(result.path, 'salience_observed');
    assert.deepEqual(result.destinations, []);
    assert.deepEqual(result.artifactReceipt.artifacts, []);
    const universal = captureWithJarvos({
      source: 'codex',
      title: 'Capture boundary',
      text,
      salienceClass: 'lesson',
      confidence: 0.9,
      date: '2026-01-02',
    }, options);
    assert.equal(universal.note, null);
    assert.equal(universal.routing.plan.ignored, true);
    assert.deepEqual(universal.artifactReceipt.artifacts, []);
    assert.deepEqual(fs.readdirSync(notesDir), []);
    assert.deepEqual(fs.readdirSync(journalDir), []);
  });
}

for (const [text, trigger] of POSITIVES) {
  test(`capture directive positive: ${text}`, () => {
    assert.equal(authorizeCapture({ text }).authorized, true);
    assert.equal(authorizeCapture({ text }).trigger, trigger);
    for (const router of [ambient, bridge]) {
      assert.equal(router.detectTrigger({ text }), trigger);
      assert.equal(router.hasCaptureIntent({ text }), true);
    }
  });
}

const PHRASES = [
  'make a note', 'take a note', 'note to self', 'I will note that',
  'remember this note', 'I have an idea', "here's an idea", 'my idea is',
  'an idea for', 'save this', 'write that down',
];

for (const phrase of PHRASES) {
  test(`capture directive clause boundaries: ${phrase}`, () => {
    for (const prefix of ['', 'Context. ', 'Context! ', 'Context? ', 'Context\n', 'Please ', 'ok so, ', 'Hey Jarvis, ', 'Hey Jarvis, could you please ', 'please also just now ']) {
      assert.equal(authorizeCapture({ text: `${prefix}${phrase} the plan` }).authorized, true, prefix);
    }
    for (const prefix of ['Use ', 'Context, ', 'Context: ', 'Context; ', 'Context - ', '(', '[', 'only explicit note:, ', '- ', '* ', '1. ', 'Context\n  2. ', 'e.g. ']) {
      const text = `${prefix}${phrase} the plan`;
      assert.equal(authorizeCapture({ text }).authorized, false, text);
      assert.equal(ambient.detectTrigger({ text }), null, text);
      assert.equal(ambient.hasCaptureIntent({ text }), false, text);
    }
  });
}

test('capture directive lead-ins are allowlisted and limited to six', () => {
  for (const lead of ['please', 'pls', 'can you', 'could you', 'would you', 'will you', 'i want you to', "i'd like you to", 'go ahead and', 'just', 'also', 'and', 'so', 'ok', 'okay', 'yeah', 'hey', 'hi', 'now', 'then', 'jarvis', 'claude']) {
    for (const comma of ['', ',']) {
      assert.equal(authorizeCapture({ text: `${lead}${comma} make a note of the plan` }).authorized, true, lead + comma);
    }
  }
  assert.equal(authorizeCapture({ text: 'please, also, just, make a note of the plan' }).authorized, true);
  assert.equal(authorizeCapture({ text: 'please, also, just, now, then, so, make a note of the plan' }).authorized, true);
  assert.equal(authorizeCapture({ text: 'please, also, just, now, then, so, ok, make a note of the plan' }).authorized, false);
});

test('capture directive guards still suppress quotes, negation, reported and incidental speech', () => {
  for (const text of ['"Please make a note of the plan."', 'Do not make a note of the plan', 'He said make a note of the plan', 'Discussed an idea for the plan', 'Context. "Make a note of the plan."']) {
    assert.equal(authorizeCapture({ text }).authorized, false, text);
    assert.equal(ambient.detectTrigger({ text }), null, text);
    assert.equal(ambient.hasCaptureIntent({ text }), false, text);
  }
});

test('text naming the same capture phrase twice is treated as a catalog, not a request', () => {
  for (const phrase of ['make a note', 'take a note', 'save this', 'write that down']) {
    const text = `The docs mention "${phrase}". Please ${phrase} the plan`;
    assert.equal(authorizeCapture({ text }).authorized, false, text);
  }
});

test('review findings: catalogs of phrases are mentions, single polite requests still work, linear time', () => {
  const rejected = [
    'Capture phrases include:\n- make a note\n- save this\n- take a note',
    'Capture phrases include:\nmake a note\nsave this',
    'Capture phrases include:\n\nmake a note\nsave this',
    'Capture phrases include:\nmake a note.\nsave this.',
    'The phrase "make a note" is documented below.\nMake a note is an example, not a request.',
    'The phrase "make a note" is documented below.\nPlease make a note is an example, not a request.',
    'only explicit note:, make a note, save this, idea: per rules',
  ];
  const allowed = [
    'Hey Jarvis, could you please make a note of the call time?',
    'Meeting update:\nThe call moved to Friday.\nPlease make a note of the new time.',
    'Meeting update:\nThe call moved to Friday\nPlease make a note of the new time.',
    'Here\u2019s an idea for the plan.',
  ];
  for (const text of rejected) assert.equal(authorizeCapture({ text }).authorized, false, text);
  for (const text of allowed) assert.equal(authorizeCapture({ text }).authorized, true, text);
  assert.equal(ambient.detectTrigger({ text: 'Here\u2019s an idea for the plan.' }), 'idea');
  const started = Date.now();
  for (const text of ['.' + ' '.repeat(200000) + 'x make a note', '\n'.repeat(100000) + 'x make a note', 'a'.repeat(200000) + ' make a note']) {
    assert.equal(authorizeCapture({ text }).authorized, false);
  }
  assert.ok(Date.now() - started < 1000, 'whitespace-heavy input must not take quadratic time');
});

test('third-round review findings: idea-phrase catalogs, apostrophes, spacing, etc.', () => {
  for (const text of [
    'Supported capture phrases:\nmake a note\nI have an idea for a feature',
    'Supported capture phrases:\nI have an idea\nmake a note',
    'Supported capture phrases:\nI\u2019ll note that\nmake a note',
  ]) assert.equal(authorizeCapture({ text }).authorized, false, text);
  for (const text of [
    'Could  you please make a note of the call time?',
    'Could\u00a0you please make a note of the call time?',
    'We need milk, bread, etc. Could you please save this shopping list?',
    'I have an idea for the app. Here\u2019s another idea for the plan.',
  ]) assert.equal(authorizeCapture({ text }).authorized, true, text);
});
