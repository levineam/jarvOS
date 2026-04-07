#!/usr/bin/env node
/**
 * Tests for the JarvOS capture system (SUP-370).
 *
 * Covers:
 * - Salience detector classification
 * - Three-package routing decisions
 * - "Capture that" retroactive capture
 * - Memory record creation
 * - Dedup logic
 * - Anti-trigger patterns
 */

'use strict';

const { classifyMessage, detectSalience } = require('../src/salience-detector');
const { buildThreePackagePlan, previewRouting } = require('../src/three-package-router');
const { buildRoutingPlan, detectTrigger, hasCaptureIntent } = require('../src/keyword-capture-router');
const { findBestCapture, extractTitle, isCaptureCommand, scoreCapturability } = require('../src/capture-that');
const { createMemoryRecord, checkMemoryDedup } = require('../../../../jarvos-memory/src/lib/memory-record');
const fs = require('fs');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAILED: ${message}`);
  }
}

function test(name, fn) {
  console.log(`[${name}]`);
  try {
    fn();
    console.log(`  ✓ passed`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ERROR: ${e.message}`);
  }
  console.log();
}

// ── Salience Detector ─────────────────────────────────────────────

test('salience: classifies decisions', () => {
  const r = classifyMessage("I've decided to use Postgres instead of SQLite");
  assert(r.salienceClass === 'decision', `Expected 'decision', got '${r.salienceClass}'`);
  assert(r.confidence > 0.5, `Confidence should be > 0.5, got ${r.confidence}`);
});

test('salience: classifies preferences', () => {
  const r = classifyMessage("I prefer short replies in the main chat");
  assert(r.salienceClass === 'preference', `Expected 'preference', got '${r.salienceClass}'`);
});

test('salience: classifies ideas', () => {
  const r = classifyMessage("What if we built a notification system?");
  assert(r.salienceClass === 'idea', `Expected 'idea', got '${r.salienceClass}'`);
});

test('salience: classifies factual learning', () => {
  const r = classifyMessage("I just found out the API rate limit is 100 requests per minute");
  assert(r.salienceClass === 'factual_learning', `Expected 'factual_learning', got '${r.salienceClass}'`);
});

test('salience: classifies commitments', () => {
  const r = classifyMessage("I will send the report by Friday");
  assert(r.salienceClass === 'commitment', `Expected 'commitment', got '${r.salienceClass}'`);
});

test('salience: suppresses casual messages', () => {
  const r = classifyMessage("ok sounds good");
  assert(r.salienceClass === 'nothing', `Expected 'nothing', got '${r.salienceClass}'`);
});

test('salience: suppresses questions', () => {
  const r = classifyMessage("What time is it?");
  assert(r.salienceClass === 'nothing', `Expected 'nothing', got '${r.salienceClass}'`);
});

test('salience: suppresses very short messages', () => {
  const r = classifyMessage("yes");
  assert(r.salienceClass === 'nothing', `Expected 'nothing', got '${r.salienceClass}'`);
});

// ── Keyword Capture Router ────────────────────────────────────────

test('keyword: detects idea trigger', () => {
  assert(detectTrigger({ text: 'idea: build a dark mode toggle' }) === 'idea', 'Should detect idea');
});

test('keyword: detects note trigger', () => {
  assert(detectTrigger({ text: 'note: API rate limit is 100rpm' }) === 'note', 'Should detect note');
});

test('keyword: anti-triggers for idea', () => {
  assert(detectTrigger({ text: 'I have no idea what to do' }) === null, 'Should not trigger on "no idea"');
  assert(detectTrigger({ text: "That's not a good idea" }) === null, 'Should not trigger on "not a good idea"');
});

test('keyword: general capture intent', () => {
  assert(hasCaptureIntent({ text: 'save this for later' }), 'Should detect capture intent');
  assert(hasCaptureIntent({ text: 'remember this important thing' }), 'Should detect capture intent');
  assert(!hasCaptureIntent({ text: 'hello, how are you?' }), 'Should not detect intent in greeting');
});

// ── Three-Package Router ──────────────────────────────────────────

test('three-pkg: keyword idea routes to journal only', () => {
  const r = previewRouting({ trigger: 'idea', text: 'Dark mode toggle', date: '2026-03-26' });
  assert(r.journal === true, 'Should route to journal');
  assert(r.notes === false, 'Non-substantive idea should not create note');
  assert(r.memory === false, 'Idea should not route to memory');
});

test('three-pkg: keyword note routes to journal + notes', () => {
  const r = previewRouting({ trigger: 'note', text: 'Architecture uses three layers', date: '2026-03-26' });
  assert(r.journal === true, 'Should route to journal');
  assert(r.notes === true, 'Note should always create note');
  assert(r.memory === false, 'Keyword note without salience should not route to memory');
});

test('three-pkg: high-confidence decision routes to all three', () => {
  const r = previewRouting({
    salienceClass: 'decision',
    confidence: 0.9,
    text: 'Using Postgres for the main database',
    date: '2026-03-26',
  });
  assert(r.journal === true, 'Decision should route to journal');
  assert(r.notes === true, 'Decision should create note');
  assert(r.memory === true, 'High-confidence decision should route to memory');
  assert(r.memoryClass === 'decision', `Memory class should be 'decision', got '${r.memoryClass}'`);
});

test('three-pkg: high-confidence preference routes to all three', () => {
  const r = previewRouting({
    salienceClass: 'preference',
    confidence: 0.85,
    text: 'Prefer short replies in main chat',
    date: '2026-03-26',
  });
  assert(r.memory === true, 'High-confidence preference should route to memory');
  assert(r.memoryClass === 'preference', `Memory class should be 'preference', got '${r.memoryClass}'`);
});

test('three-pkg: low-confidence skips memory', () => {
  const r = previewRouting({
    salienceClass: 'factual_learning',
    confidence: 0.5,
    text: 'API limit is 100rpm',
    date: '2026-03-26',
  });
  assert(r.memory === false, 'Low-confidence should not route to memory');
});

test('three-pkg: casual messages ignored', () => {
  const r = previewRouting({ text: 'ok sounds good', date: '2026-03-26' });
  assert(r.wouldCapture === false, 'Casual message should be ignored');
});

// ── Capture That ──────────────────────────────────────────────────

test('capture-that: identifies substantive content', () => {
  const messages = [
    { role: 'user', content: 'Tell me about the architecture' },
    { role: 'assistant', content: 'The JarvOS architecture has three modules:\n\n## jarvos-memory\nCompact durable recall.\n\n## jarvos-ontology\nBelief graph.\n\n## jarvos-secondbrain\nContent layer.' },
    { role: 'user', content: 'capture that' },
  ];
  const best = findBestCapture(messages);
  assert(best !== null, 'Should find content to capture');
  assert(best.message.role === 'assistant', 'Should pick the assistant response');
  assert(best.score > 0, 'Score should be positive');
});

test('capture-that: skips capture command itself', () => {
  assert(isCaptureCommand('capture that'), 'Should identify capture command');
  assert(isCaptureCommand('save that'), 'Should identify save that');
  assert(!isCaptureCommand('I decided to use Postgres'), 'Should not mark normal text as command');
});

test('capture-that: extracts title from heading', () => {
  const title = extractTitle('# Architecture Overview\n\nThe system has three modules.');
  assert(title === 'Architecture Overview', `Expected 'Architecture Overview', got '${title}'`);
});

test('capture-that: extracts title from first line', () => {
  const title = extractTitle('The API rate limit is 100 requests per minute.\nThis matters for batch jobs.');
  assert(title.includes('API rate limit'), `Title should contain 'API rate limit', got '${title}'`);
});

test('capture-that: handles empty messages', () => {
  const best = findBestCapture([]);
  assert(best === null, 'Should return null for empty messages');
});

// ── Memory Records ────────────────────────────────────────────────

test('memory: creates decision record', () => {
  const result = createMemoryRecord({
    class: 'decision',
    content: 'TEST_SUP370: using three-package routing',
    rationale: 'Clean separation of concerns',
    source: 'journal/2026-03-26',
    confidence: 0.9,
  });
  assert(result.record !== null, 'Should create record object');
  assert(result.record.class === 'decision', 'Record class should be decision');
  assert(result.written === true, 'Should write the file');
  assert(result.error === null, `Should have no error, got: ${result.error}`);

  // Clean up test file
  if (result.path && fs.existsSync(result.path)) {
    fs.unlinkSync(result.path);
  }
});

test('memory: rejects unknown class', () => {
  const result = createMemoryRecord({
    class: 'unknown_class',
    content: 'This should fail',
  });
  assert(result.record === null, 'Should not create record');
  assert(result.error !== null, 'Should have an error');
});

test('memory: rejects empty content', () => {
  const result = createMemoryRecord({
    class: 'fact',
    content: '',
  });
  assert(result.record === null, 'Should not create record');
  assert(result.error !== null, 'Should have an error');
});

test('memory: dedup detects existing content', () => {
  // First, create a record
  const r1 = createMemoryRecord({
    class: 'decision',
    content: 'TEST_SUP370_DEDUP: duplicate detection test',
    source: 'test',
    confidence: 0.9,
  });
  assert(r1.written === true, 'First write should succeed');

  // Now check dedup
  const dedup = checkMemoryDedup('TEST_SUP370_DEDUP: duplicate detection test', 'decision');
  assert(dedup.isDuplicate === true, 'Should detect duplicate');

  // Clean up
  if (r1.path && fs.existsSync(r1.path)) {
    fs.unlinkSync(r1.path);
  }
});

// ── Summary ───────────────────────────────────────────────────────

console.log('='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
