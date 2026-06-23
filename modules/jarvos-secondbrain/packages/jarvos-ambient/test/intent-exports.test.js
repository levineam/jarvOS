'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ambient = require('../src');
const intent = require('../src/intent');
const routing = require('../src/routing');
const salience = require('../src/intent/salience-detector');
const keyword = require('../src/intent/keyword-capture-router');
const retroactive = require('../src/intent/retroactive-capture');
const contract = require('../src/intent/capture-contract');

test('package root exposes the intent namespace and stable helpers', () => {
  assert.equal(ambient.intent, intent);
  assert.equal(ambient.routing, routing);
  assert.equal(typeof ambient.classifyMessage, 'function');
  assert.equal(typeof ambient.detectTrigger, 'function');
  assert.equal(typeof ambient.buildThreePackagePlan, 'function');
  assert.equal(typeof ambient.dispatchSkillInvocations, 'function');
  assert.equal(typeof ambient.findBestCapture, 'function');
  assert.equal(typeof ambient.validateCaptureEvent, 'function');
});

test('salience classifier returns the canonical intent result shape', () => {
  const result = salience.classifyMessage("I've decided to use Postgres instead of SQLite");

  assert.deepEqual(Object.keys(result).sort(), ['confidence', 'salienceClass', 'signals']);
  assert.equal(result.salienceClass, 'decision');
  assert.ok(result.confidence > 0.5);
  assert.ok(result.signals.some((signal) => signal.startsWith('decision:')));
});

test('salience classifier covers canonical meaningful classes and suppresses false positives', () => {
  const cases = [
    ["I've decided to keep the module pure", 'decision'],
    ['I prefer short replies in the main chat', 'preference'],
    ['What if we built a portable capture router?', 'idea'],
    ['I changed my mind about putting storage in the classifier', 'belief_change'],
    ['I will send the report by Friday', 'commitment'],
    ['I just found out the API limit is 100 requests per minute', 'factual_learning'],
    ['Lesson learned: keep adapters outside the intent package', 'lesson'],
  ];

  for (const [text, expected] of cases) {
    assert.equal(salience.classifyMessage(text).salienceClass, expected, text);
  }

  assert.equal(salience.classifyMessage('ok sounds good').salienceClass, 'nothing');
  assert.equal(salience.classifyMessage('What time is it?').salienceClass, 'nothing');
  assert.equal(salience.classifyMessage('yes').salienceClass, 'nothing');
});

test('keyword capture detection exports pure trigger helpers', () => {
  assert.equal(keyword.detectTrigger({ text: 'idea: package this classifier' }), 'idea');
  assert.equal(keyword.detectTrigger({ text: 'I have no idea why that failed.' }), null);
  assert.equal(keyword.hasCaptureIntent({ text: 'save this for later' }), true);
  assert.equal(keyword.primaryText({ text: 'note: keep the host routing outside intent' }), 'keep the host routing outside intent');
});

test('keyword trigger detection respects explicit fields and anti-trigger wording', () => {
  assert.equal(keyword.detectTrigger({ trigger: 'note', text: 'plain body' }), 'note');
  assert.equal(keyword.detectTrigger({ mode: 'idea', text: 'plain body' }), 'idea');
  assert.equal(keyword.detectTrigger({ text: 'Here is an idea: ship pure contracts first' }), 'idea');
  assert.equal(keyword.detectTrigger({ text: 'Make a note that contracts validate trigger values' }), 'note');
  assert.equal(keyword.hasCaptureIntent({ text: 'write this down for later reference' }), true);

  assert.equal(keyword.detectTrigger({ text: 'Any idea why this failed?' }), null);
  assert.equal(keyword.hasCaptureIntent({ text: 'What is the idea behind this?' }), false);
});

test('retroactive capture exports content selection without applying side effects', () => {
  const result = retroactive.findBestCapture([
    { role: 'user', content: 'capture that' },
    { role: 'assistant', content: '# Contract\n\nClassify first, route second, adapt last.' },
  ]);

  assert.equal(result.message.role, 'assistant');
  assert.equal(retroactive.extractTitle(result.message.content), 'Contract');
  assert.equal(retroactive.isCaptureCommand('capture that'), true);
});

test('retroactive capture selection skips commands and accepts plain text fields', () => {
  const result = retroactive.findBestCapture([
    { role: 'assistant', text: 'Short answer.' },
    { role: 'user', content: 'capture that' },
    {
      role: 'assistant',
      text: '## Ambient Contract\n\nThe intent package returns plain objects and leaves every storage write to adapters.',
    },
  ]);

  assert.equal(result.message.role, 'assistant');
  assert.match(retroactive.messageContent(result.message), /intent package returns plain objects/);
  assert.equal(retroactive.scoreCapturability({ role: 'user', content: 'save that' }), 0);
});

test('capture contract validates canonical fields', () => {
  assert.equal(contract.CAPTURE_EVENT_SCHEMA_VERSION, '2.0');
  assert.deepEqual(contract.SUPPORTED_CAPTURE_EVENT_SCHEMA_VERSIONS, ['1.0', '2.0']);
  assert.deepEqual(contract.validateCaptureEvent({
    trigger: 'note',
    text: 'Prefer short replies in main chat',
    salienceClass: 'preference',
    confidence: 0.9,
    date: '2026-05-17',
  }), []);

  assert.deepEqual(contract.validateCaptureEvent({
    salienceClass: 'unknown',
    confidence: 2,
    date: '05/17/2026',
  }), [
    'CaptureEvent must have at least one of: text, content',
    'Unknown salienceClass: "unknown". Expected one of: idea, decision, belief_change, commitment, preference, factual_learning, lesson, nothing',
    'confidence must be a number between 0.0 and 1.0',
    'date must be ISO format YYYY-MM-DD',
  ]);

  assert.deepEqual(contract.validateCaptureEvent({
    trigger: 'random',
    text: 'keep trigger validation inside the pure contract',
  }), [
    'Unknown trigger: "random". Expected one of: idea, note, decision, preference, fact, lesson',
  ]);
});

test('capture contract accepts explicit v1 events for compatibility', () => {
  assert.deepEqual(contract.validateCaptureEvent({
    schemaVersion: '1.0',
    trigger: 'note',
    text: 'Keep old capture callers working while v2 adapters roll out',
  }), []);
});

test('capture contract validates source-backed v2 events', () => {
  assert.deepEqual(contract.validateCaptureEvent({
    schemaVersion: '2.0',
    trigger: 'note',
    text: 'Save this quote about generated wikis being rebuildable.',
    salienceClass: 'factual_learning',
    confidence: 0.84,
    date: '2026-06-21',
    source: {
      tool: 'codex',
      sessionId: 'codex-session-1',
      messageId: 'msg-42',
    },
    actor: {
      type: 'human',
      name: 'Andrew',
    },
    captureMode: 'prompted',
    privacyTier: 'local-private',
    evidence: [{
      type: 'message',
      messageId: 'msg-42',
      quote: 'generated wikis should be rebuildable',
      start: 5,
      end: 42,
    }],
    origin: {
      kind: 'session',
      ref: 'codex-session-1',
    },
  }), []);
});

test('capture contract requires core v2 provenance fields when schemaVersion is 2.0', () => {
  assert.deepEqual(contract.validateCaptureEvent({
    schemaVersion: '2.0',
    text: 'A v2 capture should say where it came from.',
  }), [
    'source is required for CaptureEvent schemaVersion 2.0',
    'actor is required for CaptureEvent schemaVersion 2.0',
    'captureMode is required for CaptureEvent schemaVersion 2.0',
    'privacyTier is required for CaptureEvent schemaVersion 2.0',
    'origin is required for CaptureEvent schemaVersion 2.0',
  ]);
});

test('capture contract requires evidence for source-backed capture modes', () => {
  assert.deepEqual(contract.validateCaptureEvent({
    schemaVersion: '2.0',
    text: 'Ambient captures need evidence back to the source session.',
    source: 'codex',
    actor: 'assistant',
    captureMode: 'ambient',
    privacyTier: 'local-private',
    origin: {
      kind: 'session',
      ref: 'codex-session-1',
    },
  }), [
    'evidence is required for captureMode "ambient"',
  ]);

  assert.deepEqual(contract.validateCaptureEvent({
    schemaVersion: '2.0',
    text: 'Prompted captures also need evidence back to the source session.',
    source: 'codex',
    actor: 'human',
    captureMode: 'prompted',
    privacyTier: 'local-private',
    origin: {
      kind: 'session',
      ref: 'codex-session-1',
    },
  }), [
    'evidence is required for captureMode "prompted"',
  ]);
});

test('capture contract rejects invalid v2 source actor privacy and evidence values', () => {
  assert.deepEqual(contract.validateCaptureEvent({
    schemaVersion: '2.0',
    text: 'Invalid v2 fields should fail closed.',
    source: {
      tool: 'unsupported-tool',
      sessionId: 42,
    },
    actor: 'bot',
    captureMode: 'random',
    privacyTier: 'classified',
    evidence: [{
      type: 'database',
    }],
    origin: {
      kind: 'database',
    },
  }), [
    'Unknown source.tool: "unsupported-tool". Expected one of: openclaw, codex, claude-code, hermes, manual, journal, note, paperclip, discord, telegram, unknown, other, or custom:<slug>',
    'source.sessionId must be a string',
    'Unknown actor: "bot". Expected one of: human, assistant, tool, system, mixed, unknown',
    'Unknown origin.kind: "database". Expected one of: session, journal, note, transcript, prompt, file, url, manual',
    'origin must include at least one of: ref, path, uri, id',
    'Unknown captureMode: "random". Expected one of: ambient, prompted, manual, journal, note-write, session-summary, import, unknown',
    'Unknown privacyTier: "classified". Expected one of: public, local-private, private, sensitive, secret',
    'Unknown evidence[0].type: "database". Expected one of: text, message, file, note, journal, transcript, url, selection',
    'evidence[0] must include at least one of: text, quote, sourceId, messageId, path, uri, ref',
  ]);
});

test('ambient routing builds CRAM actions without side effects', () => {
  const plan = routing.buildThreePackagePlan({
    text: "I've decided to use Postgres for durable memory",
    salienceClass: 'decision',
    confidence: 0.92,
    date: '2026-05-19',
  });

  assert.equal(plan.version, 'ambient-routing-plan/v1');
  assert.equal(plan.route, 'note');
  assert.equal(plan.createNote, true);
  assert.equal(plan.routeToMemory, true);
  assert.equal(plan.memoryClass, 'decision');
  assert.ok(plan.actions.some((action) => action.kind === 'journal'));
  assert.ok(plan.actions.some((action) => action.kind === 'note'));
  assert.ok(plan.actions.some((action) => action.kind === 'memory'));
  assert.deepEqual(
    plan.skillInvocations.map((invocation) => invocation.skillId).sort(),
    ['memory-promotion', 'note-creation'],
  );
});

test('ambient routing produces work-intake skill plans for commitments', () => {
  const plan = routing.buildThreePackagePlan({
    text: 'I will write the routing refactor by Friday',
    salienceClass: 'commitment',
    confidence: 0.9,
    date: '2026-05-19',
  });

  assert.equal(plan.workIntake.operation, 'ensureTrackedWork');
  assert.equal(plan.workIntake.input.status, 'todo');
  assert.equal(plan.skillInvocations.some((invocation) => invocation.skillId === 'work-intake'), true);
  assert.equal(routing.previewRouting({
    text: 'I will write the routing refactor by Friday',
    salienceClass: 'commitment',
    confidence: 0.9,
  }).workIntake, true);
});

test('ambient routing can produce explicit work-intake plans without journal or note writes', () => {
  const plan = routing.buildThreePackagePlan({
    text: 'Create the release checklist',
    workIntake: true,
    issueTitle: 'Create release checklist',
  });

  assert.equal(plan.route, 'work-intake');
  assert.equal(plan.createNote, false);
  assert.equal(plan.actions.some((action) => action.kind === 'journal'), false);
  assert.deepEqual(
    plan.skillInvocations.map((invocation) => invocation.skillId),
    ['work-intake'],
  );
});
