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

test('identified journal-only routing binds identity and request without projecting a note title', () => {
  const event = { ...capture({ namespace: 'workshop', id: 'journal-only', revision: '1' }), text: 'idea: A short synthetic idea.' };
  const plan = buildThreePackagePlan(event);
  assert.equal(plan.createNote, false);
  assert.ok(plan.journalSection && plan.journalLine);
  const prepared = prepareIdentifiedCapture(event, plan);
  assert.match(prepared.intentId, /^capture:[a-f0-9]{64}$/);
  assert.match(prepared.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(prepared.plan.noteTitle, plan.noteTitle);
  assert.equal(prepared.plan.journalLine, plan.journalLine);
  assert.equal(prepared.plan.noteFrontmatter, plan.noteFrontmatter);
  const changed = { ...event, text: 'idea: Another short synthetic idea.' };
  const changedPrepared = prepareIdentifiedCapture(changed, buildThreePackagePlan(changed));
  assert.equal(changedPrepared.intentId, prepared.intentId);
  assert.notEqual(changedPrepared.requestHash, prepared.requestHash);
});

test('three-package identified journal-only storage writes no note and uses the canonical journal intent and hash', () => {
  // applyStoragePlan is the three-package storage boundary; memory routing lives
  // only in applyThreePackagePlan, so no memory writer can run here.
  const { applyStoragePlan } = require('../bridge/routing/src/three-package-router');
  const event = { ...capture({ namespace: 'workshop', id: 'three-journal-only', revision: '1' }), text: 'idea: A short synthetic idea.' };
  const plan = buildThreePackagePlan(event);
  assert.equal(plan.createNote, false);
  assert.ok(plan.journalSection && plan.journalLine);
  const prepared = prepareIdentifiedCapture(event, plan);
  const calls = [];
  const result = applyStoragePlan(plan, event, { adapter: {
    writeNote: () => { throw new Error('journal-only must not write a note'); },
    ensureJournal: () => { throw new Error('journal-only with a journal line must use its section stage'); },
    appendLineToJournalSection: (input) => { calls.push(input); return { acknowledged: true, artifactReceipt: { artifacts: [] } }; },
  } });
  assert.equal(result.note, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].intentId, `${prepared.intentId}:journal`);
  assert.equal(calls[0].requestHash, prepared.requestHash);
  assert.equal(calls[0].line, plan.journalLine);
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
