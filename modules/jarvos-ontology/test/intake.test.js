import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  ingestCaptureEvent,
  ingestCaptureEvents,
  ingestMemoryResults,
  SALIENCE_TO_ONTOLOGY,
} from '../src/intake.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeOntologyDir(base) {
  const dir = join(base, 'ontology');
  mkdirSync(dir, { recursive: true });

  // Minimal stubs so appendToSection can find files
  const stubs = {
    '2-beliefs.md': '## Beliefs\n\n',
    '3-predictions.md': '## Predictions\n\n',
    '4-core-self.md': '## Core Self\n\n',
    '5-goals.md': '## Goals\n\n',
    '6-projects.md': '## Projects\n\n',
  };
  for (const [name, content] of Object.entries(stubs)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

// ─── SALIENCE_TO_ONTOLOGY ──────────────────────────────────────────────────

describe('SALIENCE_TO_ONTOLOGY', () => {
  it('maps belief_change to beliefs section', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.belief_change.section, 'beliefs');
  });

  it('maps lesson to beliefs section', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.lesson.section, 'beliefs');
  });

  it('maps commitment to goals section', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.commitment.section, 'goals');
  });

  it('maps idea to goals section', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.idea.section, 'goals');
  });

  it('maps preference to core-self section', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.preference.section, 'core-self');
  });

  it('maps decision to core-self section', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.decision.section, 'core-self');
  });

  it('does not map factual_learning (not an ontology signal)', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.factual_learning, undefined);
  });

  it('does not map nothing', () => {
    assert.equal(SALIENCE_TO_ONTOLOGY.nothing, undefined);
  });
});

// ─── ingestCaptureEvent ────────────────────────────────────────────────────

describe('ingestCaptureEvent', () => {
  let tmpBase;
  let ontologyDir;

  before(() => {
    tmpBase = join(tmpdir(), `intake-test-${Date.now()}`);
    ontologyDir = makeOntologyDir(tmpBase);
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('rejects events with no text', () => {
    const result = ingestCaptureEvent({}, ontologyDir);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /no text or content/);
  });

  it('rejects events with empty text', () => {
    const result = ingestCaptureEvent({ text: '   ' }, ontologyDir);
    assert.equal(result.outcome, 'rejected');
  });

  it('skips events with no salienceClass', () => {
    const result = ingestCaptureEvent({ text: 'some text without classification' }, ontologyDir);
    assert.equal(result.outcome, 'skipped');
    assert.match(result.reason, /no salienceClass/);
  });

  it('skips events with unmapped salienceClass (factual_learning)', () => {
    const result = ingestCaptureEvent(
      { text: 'Water boils at 100°C at sea level', salienceClass: 'factual_learning' },
      ontologyDir,
    );
    assert.equal(result.outcome, 'skipped');
    assert.match(result.reason, /does not map to an ontology section/);
  });

  it('skips events with salienceClass nothing', () => {
    const result = ingestCaptureEvent(
      { text: 'just chatting', salienceClass: 'nothing' },
      ontologyDir,
    );
    assert.equal(result.outcome, 'skipped');
  });

  it('writes a belief_change event to beliefs section', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'belief_change',
        text: 'I no longer think that motivation is primarily intrinsic; external structure matters enormously.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.equal(result.section, 'beliefs');
    assert.match(result.entry, /Belief change/);
  });

  it('writes a lesson event to beliefs section', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'lesson',
        text: 'Shipping fast beats shipping perfect — but only when you have feedback loops in place.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.equal(result.section, 'beliefs');
    assert.match(result.label, /Lesson/);
  });

  it('writes a commitment event to goals section', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'commitment',
        text: 'I am committing to publishing a weekly update on the AI agent ecosystem.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.equal(result.section, 'goals');
  });

  it('writes an idea event to goals section', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'idea',
        text: 'Build a shared memory layer across all JarvOS agents so they can reference the same episodic store.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.equal(result.section, 'goals');
  });

  it('writes a preference event to core-self section', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'preference',
        text: 'I prefer async communication over synchronous meetings for deep-work contexts.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.equal(result.section, 'core-self');
  });

  it('writes a decision event to core-self section', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'decision',
        text: 'Decided to sunset the Vibey project and fold its learnings into the main agent stack.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.equal(result.section, 'core-self');
  });

  it('includes rationale in the entry when provided', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'decision',
        text: 'Moving all AI agent work to a monorepo structure.',
        rationale: 'Reduces cross-repo sync friction and makes shared tooling simpler.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.match(result.entry, /Reduces cross-repo sync friction/);
  });

  it('uses content over text when both are present', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'idea',
        text: 'raw text that should be ignored',
        content: 'Agent federation protocol should be based on capability advertisement not capability query.',
        date: '2026-04-08',
      },
      ontologyDir,
    );
    assert.equal(result.outcome, 'written');
    assert.match(result.entry, /Agent federation/);
    assert.doesNotMatch(result.entry, /raw text/);
  });

  it('writes eligible cited knowledge units only when ontology promotion is explicit', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'decision',
        knowledgeUnit: {
          id: 'ku-ontology-decision',
          kind: 'decision',
          text: 'Generated wiki pages are derived artifacts, not canonical truth.',
          source: {
            type: 'note',
            path: 'Notes/Generated Wiki.md',
          },
          evidence: [{
            sourcePath: 'Notes/Generated Wiki.md',
            quote: 'Generated wiki pages are derived artifacts, not canonical truth.',
          }],
          privacyDecision: {
            tier: 'local-private',
            excludedFromPromotion: false,
          },
          downstreamEligibility: {
            ontologyPromotion: true,
          },
        },
        date: '2026-04-08',
      },
      ontologyDir,
    );

    assert.equal(result.outcome, 'written');
    assert.equal(result.section, 'core-self');
    assert.match(result.entry, /Generated wiki pages are derived artifacts/);
  });

  it('rejects knowledge units without source evidence', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'decision',
        knowledgeUnit: {
          id: 'ku-uncited',
          kind: 'decision',
          text: 'Uncited units should not enter ontology.',
          privacyDecision: {
            tier: 'local-private',
            excludedFromPromotion: false,
          },
          downstreamEligibility: {
            ontologyPromotion: true,
          },
        },
      },
      ontologyDir,
    );

    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /requires source evidence/);
  });

  it('rejects private knowledge units and raw transcripts', () => {
    const privateResult = ingestCaptureEvent(
      {
        salienceClass: 'preference',
        knowledgeUnit: {
          id: 'ku-private',
          kind: 'preference',
          text: 'Private unit should not enter ontology.',
          evidence: [{ sourcePath: 'Notes/Private.md', quote: 'Private unit should not enter ontology.' }],
          privacyDecision: {
            tier: 'sensitive',
            excludedFromPromotion: true,
          },
          downstreamEligibility: {
            ontologyPromotion: true,
          },
        },
      },
      ontologyDir,
    );
    assert.equal(privateResult.outcome, 'rejected');
    assert.match(privateResult.reason, /privacy tier 'sensitive'/);

    const transcriptResult = ingestCaptureEvent(
      {
        salienceClass: 'lesson',
        text: 'Raw transcript line',
        source: { type: 'transcript' },
      },
      ontologyDir,
    );
    assert.equal(transcriptResult.outcome, 'rejected');
    assert.match(transcriptResult.reason, /raw transcript/);
  });

  it('rejects raw source-backed CaptureEvent v2 events before ontology intake', () => {
    const result = ingestCaptureEvent(
      {
        schemaVersion: '2.0',
        salienceClass: 'decision',
        text: 'Raw source-backed capture should not enter ontology directly.',
        source: {
          tool: 'codex',
          sessionId: 'codex-session-1',
        },
      },
      ontologyDir,
    );

    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /source-backed captures/);
  });

  it('rejects knowledge units when event text differs from the cited unit text', () => {
    const result = ingestCaptureEvent(
      {
        salienceClass: 'decision',
        text: 'Unverified wrapper text.',
        knowledgeUnit: {
          id: 'ku-mismatch',
          kind: 'decision',
          text: 'Verified cited unit text.',
          evidence: [{ sourcePath: 'Notes/Unit.md', quote: 'Verified cited unit text.' }],
          privacyDecision: {
            tier: 'local-private',
            excludedFromPromotion: false,
          },
          downstreamEligibility: {
            ontologyPromotion: true,
          },
        },
      },
      ontologyDir,
    );

    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /must match knowledgeUnit\.text/);
  });

  it('rejects knowledge units unless ontology promotion is explicitly eligible', () => {
    const missingEligibility = ingestCaptureEvent(
      {
        salienceClass: 'decision',
        knowledgeUnit: {
          id: 'ku-missing-eligibility',
          kind: 'decision',
          text: 'Missing ontology eligibility should not enter ontology.',
          evidence: [{ sourcePath: 'Notes/Unit.md', quote: 'Missing ontology eligibility should not enter ontology.' }],
          privacyDecision: {
            tier: 'local-private',
            excludedFromPromotion: false,
          },
        },
      },
      ontologyDir,
    );
    assert.equal(missingEligibility.outcome, 'rejected');
    assert.match(missingEligibility.reason, /ontologyPromotion must be true/);

    const falseEligibility = ingestCaptureEvent(
      {
        salienceClass: 'decision',
        knowledgeUnit: {
          id: 'ku-false-eligibility',
          kind: 'decision',
          text: 'False ontology eligibility should not enter ontology.',
          evidence: [{ sourcePath: 'Notes/Unit.md', quote: 'False ontology eligibility should not enter ontology.' }],
          privacyDecision: {
            tier: 'local-private',
            excludedFromPromotion: false,
          },
          downstreamEligibility: {
            ontologyPromotion: false,
          },
        },
      },
      ontologyDir,
    );
    assert.equal(falseEligibility.outcome, 'rejected');
    assert.match(falseEligibility.reason, /ontologyPromotion must be true/);
  });

  it('dry-run returns written outcome without modifying files', () => {
    const uniqueText = 'Unique belief about dry run testing only unique-1234567890.';
    const result = ingestCaptureEvent(
      { salienceClass: 'belief_change', text: uniqueText, date: '2026-04-08' },
      ontologyDir,
      { dryRun: true },
    );
    assert.equal(result.outcome, 'written');
    assert.equal(result.dryRun, true);

    // File should NOT contain the dry-run entry
    const beliefs = readFileSync(join(ontologyDir, '2-beliefs.md'), 'utf8');
    assert.ok(!beliefs.includes('unique-1234567890'), 'dry-run must not write to file');
  });

  it('deduplicates near-identical entries', () => {
    const text = 'Remote work enables deep-focus and eliminates commute overhead for knowledge workers.';

    const first = ingestCaptureEvent(
      { salienceClass: 'preference', text, date: '2026-04-08' },
      ontologyDir,
    );
    assert.equal(first.outcome, 'written');

    const second = ingestCaptureEvent(
      { salienceClass: 'preference', text, date: '2026-04-08' },
      ontologyDir,
    );
    assert.equal(second.outcome, 'skipped');
    assert.match(second.reason, /duplicate/);
  });
});

// ─── ingestCaptureEvents (batch) ───────────────────────────────────────────

describe('ingestCaptureEvents', () => {
  let tmpBase;
  let ontologyDir;

  before(() => {
    tmpBase = join(tmpdir(), `intake-batch-test-${Date.now()}`);
    ontologyDir = makeOntologyDir(tmpBase);
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns counts for batch ingestion', () => {
    const events = [
      { salienceClass: 'idea', text: 'Build a distributed task queue for JarvOS agents.', date: '2026-04-08' },
      { salienceClass: 'nothing', text: 'Just a passing thought about weather.' },
      { salienceClass: 'belief_change', text: 'I now believe that sleep is the primary productivity lever.', date: '2026-04-08' },
      {},                          // rejected — no text
    ];

    const summary = ingestCaptureEvents(events, ontologyDir);

    assert.equal(summary.written, 2);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.rejected, 1);
    assert.equal(summary.results.length, 4);
    assert.equal(summary.dryRun, false);
  });

  it('respects dryRun flag across all events', () => {
    const events = [
      { salienceClass: 'idea', text: 'Unique idea only seen in dry run batch unique-xyz-9876.', date: '2026-04-08' },
    ];
    const summary = ingestCaptureEvents(events, ontologyDir, { dryRun: true });
    assert.equal(summary.dryRun, true);
    assert.equal(summary.written, 1); // outcome is 'written' but file unchanged
    const goals = readFileSync(join(ontologyDir, '5-goals.md'), 'utf8');
    assert.ok(!goals.includes('unique-xyz-9876'), 'dry-run batch must not write files');
  });
});

// ─── ingestMemoryResults ───────────────────────────────────────────────────

describe('ingestMemoryResults', () => {
  let tmpBase;
  let ontologyDir;

  before(() => {
    tmpBase = join(tmpdir(), `intake-memory-test-${Date.now()}`);
    ontologyDir = makeOntologyDir(tmpBase);
  });

  after(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('routes tagged memory strings to correct sections', () => {
    const memoryStrings = [
      '[belief_change] I no longer believe big launches matter; continuous shipping is what moves the needle.',
      '[preference] I prefer functional programming patterns for data pipelines.',
    ];

    const summary = ingestMemoryResults(memoryStrings, ontologyDir, { date: '2026-04-08' });

    assert.equal(summary.written, 2);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.rejected, 0);
  });

  it('skips untagged memory strings (no salienceClass)', () => {
    const memoryStrings = [
      'No tag here — just a plain memory string from Hindsight.',
    ];

    const summary = ingestMemoryResults(memoryStrings, ontologyDir);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.written, 0);
  });

  it('handles empty array', () => {
    const summary = ingestMemoryResults([], ontologyDir);
    assert.equal(summary.written, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.rejected, 0);
    assert.deepEqual(summary.results, []);
  });
});
