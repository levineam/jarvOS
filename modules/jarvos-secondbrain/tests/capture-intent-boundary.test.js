'use strict';

/**
 * SUP-3981 — explicit-intent boundary for durable capture.
 *
 * A message without explicit durable-capture intent must never create a
 * durable note, Journal Notes backlink, or durable memory record. Salience
 * and confidence are descriptive only after capture is authorized.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeCapture } = require('../packages/jarvos-ambient/src/intent/capture-authorization');
const { dispatchCapture } = require('../bridge/dispatch/src/capture-dispatcher');
const { applyRoutingPlan } = require('../bridge/routing/src/keyword-capture-router');
const { captureThat } = require('../bridge/routing/src/capture-that');
const { digestText } = require('../bridge/provenance/src/content-origin-contract');

const TEST_DATE = '2026-09-17';

const INCIDENT_TEXTS = [
  'I want to make sure that the article-generator skill is generic in the sense that it can find and understand any relevant public materials about a topic, not just a fixed list of sources.',
  'I want you to look at the transcripts from the following videos and give me a report on the common themes across all of them.',
];

function explodingAdapter() {
  return {
    writeNote() { throw new Error('unauthorized capture must not write a note'); },
    appendLineToJournalSection() { throw new Error('unauthorized capture must not append to the journal'); },
    ensureJournal() { throw new Error('unauthorized capture must not touch the journal'); },
  };
}

function recordingAdapter() {
  const calls = [];
  return {
    calls,
    writeNote(input) {
      calls.push(['writeNote', input]);
      return { written: true, title: input.title, path: `/tmp/${input.title}.md` };
    },
    appendLineToJournalSection(input) {
      calls.push(['appendLineToJournalSection', input]);
      return { ...input, alreadyPresent: false };
    },
    ensureJournal(input) {
      calls.push(['ensureJournal', input]);
      return { existed: true };
    },
  };
}

test('exact-shape incident texts never authorize a durable capture', () => {
  for (const text of INCIDENT_TEXTS) {
    const authorization = authorizeCapture({ text });
    assert.equal(authorization.authorized, false);
    assert.equal(authorization.source, null);
    assert.equal(authorization.trigger, null);
  }
});

test('exact-shape incident texts with high-confidence preference are observed-only, never captured', () => {
  for (const text of INCIDENT_TEXTS) {
    const result = dispatchCapture({
      text,
      classification: { salienceClass: 'preference', confidence: 0.9 },
    }, { adapter: explodingAdapter() });

    assert.equal(result.captured, false);
    assert.equal(result.observed, true);
    assert.equal(result.path, 'salience_observed');
    assert.equal(result.skillId, null);
    assert.deepEqual(result.destinations, []);
    assert.equal('routing' in result, false);
    assert.deepEqual(result.artifactReceipt, { schemaVersion: 'jarvos.artifact-receipt.v1', artifacts: [] });
  }
});

test('any high-confidence preference without explicit intent is not captured, even with valid content-origin evidence', () => {
  const text = 'I really like how the new build pipeline handles caching, it feels much cleaner than before.';
  const withoutEvidence = dispatchCapture({
    text,
    classification: { salienceClass: 'preference', confidence: 0.95 },
  }, { adapter: explodingAdapter() });
  assert.equal(withoutEvidence.captured, false);
  assert.equal(withoutEvidence.observed, true);
  assert.equal(withoutEvidence.path, 'salience_observed');

  const withEvidence = dispatchCapture({
    text,
    classification: { salienceClass: 'preference', confidence: 0.95 },
    content_origin: 'human',
    content_origin_basis: 'verbatim_user',
    human_evidence_eligible: true,
    user_source: { capture_event_id: 'forged', actor: 'user' },
  }, { adapter: explodingAdapter() });
  assert.equal(withEvidence.captured, false);
  assert.equal(withEvidence.observed, true);
  assert.equal(withEvidence.path, 'salience_observed');
});

test('a bare mention of the word "capture" does not authorize a durable write', () => {
  const text = "Let's talk about how the capture system's bug happened last week.";
  const authorization = authorizeCapture({ text });
  assert.equal(authorization.authorized, false);

  const result = dispatchCapture({ text }, { adapter: explodingAdapter() });
  assert.equal(result.captured, false);
  assert.equal(result.path, 'no_capture');
});

test('bare strict commands remain needs_input with no mutation', () => {
  for (const text of ['Idea:', 'Note:', 'Journal:', 'Add to Journal:']) {
    const result = dispatchCapture({ text, date: TEST_DATE }, { adapter: explodingAdapter() });
    assert.equal(result.captured, false);
    assert.equal(result.path, 'hard_command_needs_input');
    assert.equal(result.hardCommand.disposition, 'needs_input');
  }
});

test('positive control: Note: creates a note and journal backlink', () => {
  const adapter = recordingAdapter();
  const authorization = authorizeCapture({ text: 'Note: durable intent boundary contract' });
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.source, 'hard_command');
  assert.equal(authorization.trigger, 'note');

  const result = dispatchCapture({ text: 'Note: durable intent boundary contract', date: TEST_DATE }, { adapter });
  assert.equal(result.captured, true);
  assert.equal(result.skillId, 'note-creation');
  assert.equal(adapter.calls[0][0], 'writeNote');
  assert.equal(adapter.calls[1][0], 'appendLineToJournalSection');
});

test('positive control: natural-language "make a note" creates a note and journal backlink', () => {
  const adapter = recordingAdapter();
  const text = 'make a note about the durable intent boundary contract';
  const authorization = authorizeCapture({ text });
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.source, 'keyword_trigger');
  assert.equal(authorization.trigger, 'note');

  const result = dispatchCapture({ text, date: TEST_DATE }, { adapter });
  assert.equal(result.captured, true);
  assert.equal(result.skillId, 'note-creation');
  assert.equal(adapter.calls[0][0], 'writeNote');
  assert.equal(adapter.calls[1][0], 'appendLineToJournalSection');
});

test('positive control: bounded "save this"/"save that" preserve natural-language capture', () => {
  for (const text of ['save this important detail about the release', 'save that for the retro notes']) {
    const authorization = authorizeCapture({ text });
    assert.equal(authorization.authorized, true);
    assert.equal(authorization.source, 'natural_language');
    assert.equal(authorization.trigger, 'note');

    const adapter = recordingAdapter();
    const result = dispatchCapture({ text, date: TEST_DATE }, { adapter });
    assert.equal(result.captured, true);
    assert.equal(result.skillId, 'note-creation');
    assert.equal(adapter.calls[0][0], 'writeNote');
    assert.equal(adapter.calls[1][0], 'appendLineToJournalSection');
  }
});

test('positive control: Idea: stays journal Ideas only unless an explicit durable flag says otherwise', () => {
  const lightweight = recordingAdapter();
  const lightResult = dispatchCapture({
    text: 'Idea: a lightweight thought that should stay in the journal',
    date: TEST_DATE,
  }, { adapter: lightweight });
  assert.equal(lightResult.captured, true);
  assert.equal(lightResult.skillId, 'journal-entry');
  assert.deepEqual(lightweight.calls.map(([kind]) => kind), ['appendLineToJournalSection']);

  const substantive = recordingAdapter();
  const substantiveResult = dispatchCapture({
    text: 'Idea: durable capture contract for future agents',
    createDurableNote: true,
    date: TEST_DATE,
  }, { adapter: substantive });
  assert.equal(substantiveResult.captured, true);
  assert.equal(substantiveResult.skillId, 'note-creation');
  assert.deepEqual(substantive.calls.map(([kind]) => kind), ['writeNote', 'appendLineToJournalSection']);
});

test('explicit note intent plus high salience uses salience for downstream memory routing only after intent is established', () => {
  const adapter = recordingAdapter();
  const result = dispatchCapture({
    text: 'Note: we decided to keep adapter writes behind skill dispatch',
    date: TEST_DATE,
    classification: { salienceClass: 'decision', confidence: 0.92 },
  }, { adapter });

  assert.equal(result.captured, true);
  assert.equal(result.skillId, 'note-creation');
  assert.deepEqual(result.destinations, ['journal', 'notes', 'memory']);
  assert.equal(result.routing.memory.record.class, 'decision');
});

test('intentional writes retain all five jarvos-content-origin/v1 frontmatter fields', () => {
  const content = 'The user supplied this durable thought verbatim.';
  const captureEventId = 'capture-boundary-human-1';
  const adapter = recordingAdapter();

  applyRoutingPlan({
    trigger: 'note',
    title: 'Durable human thought',
    text: content,
    date: TEST_DATE,
    captureEventId,
    content_origin: 'human',
    content_origin_basis: 'verbatim_user',
    user_source: {
      capture_event_id: captureEventId,
      actor: 'user',
      source_digest: digestText(content),
      content_digest: digestText(content),
    },
  }, {
    adapter,
    resolveUserSource: (id) => (id === captureEventId ? { capture_event_id: id, actor: 'user', text: content } : null),
  });

  const [, noteInput] = adapter.calls[0];
  const frontmatter = noteInput.frontmatter;
  assert.equal(frontmatter.content_origin_schema, 'jarvos-content-origin/v1');
  assert.equal(frontmatter.content_origin, 'human');
  assert.equal(frontmatter.content_origin_basis, 'verbatim_user');
  assert.equal(frontmatter.content_origin_source.capture_event_id, captureEventId);
  assert.equal(frontmatter.human_evidence_eligible, true);
});

test('"capture that" remains an authorized programmatic declaration', () => {
  const adapter = recordingAdapter();
  const recentMessages = [
    { role: 'user', content: 'Tell me about the routing boundary work' },
    { role: 'assistant', content: 'The explicit-intent boundary keeps salience descriptive only, never authorizing.' },
    { role: 'user', content: 'capture that' },
  ];

  const result = captureThat({ recentMessages, date: TEST_DATE }, { adapter });
  assert.equal(result.captured, true);
  assert.equal(adapter.calls[0][0], 'writeNote');
  assert.equal(adapter.calls[1][0], 'appendLineToJournalSection');
});
