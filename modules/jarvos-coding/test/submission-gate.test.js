'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const {
  SUBMISSION_GATE_SCHEMA_VERSION,
  buildSubmissionGate,
  formatSubmissionGateMarkdown,
  validateSubmissionEvidence,
} = require('../src');

function deliveryEvidence(identifier) {
  const headCommit = 'a'.repeat(40);
  const digest = 'd'.repeat(64);
  const changedFiles = [`docs/plans/${identifier}.md`, 'modules/jarvos-coding/README.md', 'modules/jarvos-coding/src/lifecycle/policy.js'];
  return {
    deliveryTrace: {
      schemaVersion: 'jarvos-coding-delivery-trace/v1',
      workIdentifier: identifier,
      plan: { path: changedFiles[0], digest },
      docImpact: { decision: 'affected', docs: [changedFiles[1]] },
      implementation: { headCommit, changedFiles },
      proof: [{
        kind: 'behavioral',
        level: 'source',
        criterion: 'Submission requires the plan, documentation, implementation, and proof path.',
        claim: 'Supported evidence is admitted with a verified source trace.',
        command: 'node --test modules/jarvos-coding/test/submission-gate.test.js',
        observation: 'The focused submission cases passed at this head.',
        status: 'passed',
        headCommit,
      }],
    },
    deliveryObservation: { headCommit, changedFiles, plan: { digest, mentionsWorkIdentifier: true } },
  };
}

function supportedEvidence() {
  return {
    workIdentity: { identifier: 'SUP-2138' },
    branch: 'SUP-2138/submission-gate',
    tests: { status: 'passed' },
    clawpatch: { status: 'passed' },
    autoreview: { status: 'recorded' },
    goalAlignment: { status: 'aligned' },
    pullRequest: { status: 'created', url: 'https://example.test/pr/1' },
    ...deliveryEvidence('SUP-2138'),
  };
}

test('supported submission admission does not require a Paperclip record', () => {
  const withoutPaperclip = validateSubmissionEvidence(supportedEvidence(), { identifier: 'SUP-2138' });
  const withUnavailablePaperclip = validateSubmissionEvidence({
    ...supportedEvidence(),
    paperclipEvidence: { ok: false, status: 'unavailable' },
  }, { identifier: 'SUP-2138' });

  assert.equal(withoutPaperclip.ok, true);
  assert.equal(SUBMISSION_GATE_SCHEMA_VERSION, 'jarvos-coding-submission-gate/v3');
  assert.equal(withoutPaperclip.schemaVersion, 'jarvos-coding-submission-gate/v3');
  assert.deepEqual(withUnavailablePaperclip, withoutPaperclip);
  assert.equal(buildSubmissionGate({ identifier: 'SUP-2138' }).evidenceKeys.includes('paperclipEvidence'), false);
  assert.equal(formatSubmissionGateMarkdown({ identifier: 'SUP-2138' }).includes('Paperclip intake'), false);
});

test('Paperclip data cannot transfer submission authority', () => {
  const result = validateSubmissionEvidence({
    paperclipEvidence: { status: 'recorded', issueIdentifier: 'SUP-2138' },
    issue: { identifier: 'SUP-2138' },
  }, { identifier: 'SUP-2138' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['branch', 'tests', 'clawpatch', 'autoreview', 'goalAlignment', 'pullRequest', 'deliveryTrace']);
});
