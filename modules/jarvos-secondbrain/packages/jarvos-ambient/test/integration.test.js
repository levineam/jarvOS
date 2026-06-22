'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildThreePackagePlan,
  classifyMessage,
} = require('../src');
const {
  createLocalStorageAdapter,
  dispatchSkillInvocations,
} = require('../src/adapters');

test('ambient integration classifies, routes, dispatches skills, and writes through adapters', async () => {
  const calls = [];
  const text = "The decision is final: we've decided to keep adapter writes behind skill dispatch";
  const classification = classifyMessage(text);
  const plan = buildThreePackagePlan({
    text,
    date: '2026-05-19',
    ...classification,
  });

  assert.equal(classification.salienceClass, 'decision');
  assert.equal(plan.route, 'note');
  assert.equal(plan.routeToMemory, true);
  assert.deepEqual(
    plan.skillInvocations.map((invocation) => invocation.skillId).sort(),
    ['memory-promotion', 'note-creation'],
  );

  const adapter = createLocalStorageAdapter({
    backend: 'integration-test',
    storageAdapter: {
      writeNote(input) {
        calls.push(['note', input.title]);
        return { written: true, title: input.title };
      },
      appendLineToJournalSection(input) {
        calls.push(['journal', input.heading]);
        return { written: true, heading: input.heading, line: input.line };
      },
    },
    memoryAdapter: {
      createMemoryRecord(input) {
        calls.push(['memory', input.class]);
        return { written: true, record: input };
      },
    },
  });

  const dispatch = await dispatchSkillInvocations(plan, adapter);

  assert.equal(dispatch.ok, true);
  assert.deepEqual(calls, [
    ['note', plan.noteTitle],
    ['journal', '## ✅ Decisions'],
    ['memory', 'decision'],
  ]);
  assert.equal(dispatch.results[0].skillId, 'note-creation');
  assert.equal(dispatch.results[1].skillId, 'memory-promotion');
  assert.equal(dispatch.results.flatMap((result) => result.results).every((result) => result.ok), true);
});

test('ambient integration dispatches work-intake skill plans through compatibility aliases', async () => {
  const calls = [];
  const text = 'I will send and finish the release checklist by Friday';
  const classification = classifyMessage(text);
  const plan = buildThreePackagePlan({
    text,
    date: '2026-05-19',
    ...classification,
  });

  assert.equal(classification.salienceClass, 'commitment');
  assert.equal(plan.workIntake.operation, 'ensureTrackedWork');
  assert.equal(plan.skillInvocations.some((invocation) => invocation.skillId === 'work-intake'), true);

  const adapter = createLocalStorageAdapter({
    backend: 'integration-test',
    storageAdapter: {
      writeNote(input) {
        calls.push(['note', input.title]);
        return { written: true, title: input.title };
      },
      appendLineToJournalSection(input) {
        calls.push(['journal', input.heading]);
        return { written: true, heading: input.heading };
      },
    },
    paperclipClient: {
      createIssue(input) {
        calls.push(['work', input.title]);
        return { identifier: 'SUP-TEST', title: input.title };
      },
    },
  });

  const dispatch = await dispatchSkillInvocations(plan, adapter);

  assert.equal(dispatch.ok, true);
  assert.deepEqual(calls.map(([kind]) => kind), ['note', 'journal', 'work']);
  assert.equal(calls[2][1], 'I will send and finish the release checklist by Friday');
  assert.equal(
    dispatch.results.find((result) => result.skillId === 'work-intake').results[0].operation,
    'ensureTrackedWork',
  );
});
