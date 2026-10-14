'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCaptureEvent } = require('../bridge/capture/src/universal-capture');
const { prepareIdentifiedCapture } = require('../packages/jarvos-ambient/src/intent/capture-identity');
const { buildThreePackagePlan } = require('../packages/jarvos-ambient/src/routing');

const capture = (captureIdentity) => ({
  text: 'note: The workshop date is undecided.', date: '2030-02-03',
  source: 'codex', actor: 'human', captureMode: 'manual',
  privacyTier: 'local-private', origin: 'synthetic:workshop', captureIdentity,
});

test('capture preserves exact namespaced identity and different-revision correction', () => {
  const captureIdentity = {
    namespace: 'workshop', id: 'Opening', revision: 'draft B',
    relation: { kind: 'corrects', target: { namespace: 'workshop', id: 'Opening', revision: 'draft A' } },
  };
  assert.deepEqual(normalizeCaptureEvent(capture(captureIdentity)).captureIdentity, captureIdentity);
});

test('malformed and complete self-target identities fail before routing', () => {
  const identity = { namespace: 'workshop', id: 'Opening', revision: 'A' };
  for (const invalid of [null, {}, { ...identity, revision: '' }, { ...identity, extra: true },
    { ...identity, relation: { kind: 'corrects', target: identity } }]) {
    assert.throws(() => normalizeCaptureEvent(capture(invalid)), (error) =>
      /captureIdentity/.test(error.message) && Array.isArray(error.errors) && error.errors.length > 0);
  }
});

test('identified direct routing rejects a clock-derived fallback title', () => {
  const event = { trigger: 'note', date: '2030-02-03', captureIdentity: { namespace: 'workshop', id: 'bare', revision: '1' } };
  assert.throws(() => prepareIdentifiedCapture(event, buildThreePackagePlan(event)), /title or text/);
});

test('three-package output reports the identity-qualified title and backlink it wrote', () => {
  const { applyThreePackagePlan } = require('../bridge/routing/src/three-package-router');
  const event = { ...capture({ namespace: 'workshop', id: 'three', revision: '1' }), trigger: 'note', title: 'Workshop: Plan' };
  let line;
  const result = applyThreePackagePlan(event, { adapter: {
    writeNote: ({ title }) => ({ written: true, title: title.replace(':', '-') }),
    appendLineToJournalSection: (input) => { line = input.line; return {}; },
  } });
  assert.equal(result.plan.noteTitle, result.note.title);
  assert.equal(result.plan.journalLine, line);
  assert.equal(result.plan.actions.find((action) => action.kind === 'note').input.title, result.note.title);
  assert.equal(result.plan.actions.find((action) => action.kind === 'journal').input.line, line);
  assert.equal(result.plan.skillInvocations.find((invocation) => invocation.skillId === 'note-creation').input.title, result.note.title);
});

test('legacy capture does not require identity', () => {
  const input = capture(undefined);
  delete input.captureIdentity;
  assert.equal(normalizeCaptureEvent(input).captureIdentity, undefined);
});

test('writer-owned IDs are excluded even in rich routing plans and Unicode titles remain bounded', () => {
  const event = { ...capture({ namespace: 'workshop', id: 'Opening', revision: 'A' }), title: '🎭'.repeat(80) };
  const first = prepareIdentifiedCapture(event, buildThreePackagePlan(event));
  const changed = { ...event, frontmatter: { jarvos_note_id: 'ignored-caller-id' } };
  const retry = prepareIdentifiedCapture(changed, buildThreePackagePlan(changed));
  assert.equal(first.requestHash, retry.requestHash);
  assert.ok(Buffer.byteLength(`${first.plan.noteTitle}.md`, 'utf8') < 255);
  const reordered = { ...event, captureIdentity: { revision: 'A', id: 'Opening', namespace: 'workshop' } };
  assert.equal(prepareIdentifiedCapture(reordered, buildThreePackagePlan(reordered)).requestHash, first.requestHash);
  const caseChanged = { ...event, captureIdentity: { ...event.captureIdentity, id: 'opening' } };
  assert.notEqual(prepareIdentifiedCapture(caseChanged, buildThreePackagePlan(caseChanged)).intentId, first.intentId);
});
