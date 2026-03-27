import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSignals,
  extractCandidateLines,
  textOverlap,
} from '../src/extractor.js';

describe('extractor', () => {
  describe('extractSignals', () => {
    it('detects belief signals', () => {
      const text = 'I believe that consciousness is fundamental to reality and shapes everything we perceive.';
      const signals = extractSignals(text, { date: '2026-03-20' });
      assert.ok(signals.length > 0, 'should detect at least one signal');
      assert.equal(signals[0].type, 'belief');
      assert.equal(signals[0].section, 'beliefs');
    });

    it('detects prediction signals', () => {
      const text = 'I predict that AI agents will be mainstream by end of 2026.';
      const signals = extractSignals(text, { date: '2026-03-20' });
      assert.ok(signals.length > 0);
      assert.equal(signals[0].type, 'prediction');
    });

    it('detects goal signals', () => {
      const text = 'I want to build a community of people working together to understand the world deeply.';
      const signals = extractSignals(text, { date: '2026-03-20' });
      assert.ok(signals.length > 0);
      assert.equal(signals[0].type, 'goal');
    });

    it('detects mission signals', () => {
      const text = 'What matters is helping people find meaning in a world increasingly dominated by AI.';
      const signals = extractSignals(text, { date: '2026-03-20' });
      assert.ok(signals.length > 0);
      assert.equal(signals[0].type, 'mission');
    });

    it('detects value signals', () => {
      const text = 'I care about intellectual honesty and being transparent about what I know and what I am guessing.';
      const signals = extractSignals(text, { date: '2026-03-20' });
      assert.ok(signals.length > 0);
      assert.equal(signals[0].type, 'value');
    });

    it('ignores short/empty text', () => {
      const signals = extractSignals('hi', { date: '2026-03-20' });
      assert.equal(signals.length, 0);
    });

    it('skips metadata lines', () => {
      const text = '**Status:** Active\n**Source:** [[2025-11-21]]\n## Heading\n| col | col |';
      const signals = extractSignals(text, { date: '2026-03-20' });
      assert.equal(signals.length, 0, 'metadata should not produce signals');
    });

    it('deduplicates similar signals', () => {
      const text = 'I believe AI is important. I believe AI is really important and transformative.';
      const signals = extractSignals(text, { date: '2026-03-20' });
      // Should deduplicate similar signals within same type
      assert.ok(signals.length <= 2);
    });
  });

  describe('extractCandidateLines', () => {
    it('extracts from plain text', () => {
      const lines = extractCandidateLines('Some regular text here with enough content.\nAnother line of content.');
      assert.ok(lines.length > 0);
    });

    it('extracts from session log format', () => {
      const content = 'user: I think we should build a new tool for this.\nassistant: Sounds good.\nuser: Let me explain my vision for it.';
      const lines = extractCandidateLines(content, { isSessionLog: true });
      assert.ok(lines.length >= 2, `should extract user blocks, got ${lines.length}`);
    });

    it('skips code blocks', () => {
      const content = 'Some text\n```\nI believe this is code\n```\nMore text here for testing.';
      const lines = extractCandidateLines(content);
      const hasCode = lines.some(l => l.includes('this is code'));
      assert.ok(!hasCode, 'should skip code block contents');
    });
  });

  describe('textOverlap', () => {
    it('returns 1 for identical texts', () => {
      const score = textOverlap('hello world test', 'hello world test');
      assert.equal(score, 1);
    });

    it('returns 0 for completely different texts', () => {
      const score = textOverlap('apples oranges bananas', 'quantum physics thermodynamics');
      assert.equal(score, 0);
    });

    it('returns high score for similar texts', () => {
      const score = textOverlap(
        'Reality is constructed out of nested swarms',
        'Reality is constructed out of nested swarms of nodes'
      );
      assert.ok(score > 0.5, `overlap should be high, got ${score}`);
    });
  });
});
