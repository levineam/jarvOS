#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const {
  extractTicketIds,
  classificationFromLabels,
  parseReleaseIntakeDocument,
  resolveReleaseFit,
  evaluateReleaseIntakeGate,
} = require('../scripts/release-intake-gate');
const { releaseFitFromPaperclipReleaseIntake } = require('../modules/jarvos-coding/src/adapters/paperclip');

// Real release-intake document bodies captured live from the Paperclip API
// (GET /api/issues/{id}/documents/release-intake) while building this gate —
// two different agent runs wrote two slightly different formats, which is
// exactly why parseReleaseIntakeDocument is written leniently.
const SUP_3493_DOCUMENT_BODY = `# jarvOS Release Intake

Issue: SUP-3493
Classification: release-candidate
Release placement: active-release
Target version: v0.7.0
Release parent issue: SUP-3497
Release rationale: PRs #107 and #108 merged after v0.6.3 as part of the first usable public control-plane surface. The historical SUP-2023/v0.4 local-dogfood placement is superseded for this public work.
Verification gate: [Unreleased] entry, documentation-impact evidence, release-candidates placement, public tests/package checks, and Andrew approval before publication.
Public notes impact: yes
`;

const SUP_3478_DOCUMENT_BODY = `# jarvOS release intake

- Classification: release-candidate.
- Target version: v0.6.3.
- Release parent: SUP-3250.
- Repository: levineam/jarvOS.
`;

test('extractTicketIds finds SUP-#### references across title, body, and commits', () => {
  const ids = extractTicketIds(
    'fix(SUP-3499): add merge gate',
    'Closes SUP-3499. See also SUP-3496 for parent context.',
    'chore: unrelated commit',
    'fix(sup-3496): lowercase should still match'
  );
  assert.deepEqual(ids, ['SUP-3496', 'SUP-3499']);
});

test('extractTicketIds returns empty array when nothing references a ticket', () => {
  assert.deepEqual(extractTicketIds('fix: typo', 'no ticket here', ''), []);
});

test('classificationFromLabels maps documented labels to the shared classification vocabulary', () => {
  assert.equal(classificationFromLabels(['jarvos', 'jarvos-release-candidate']).classification, 'release-candidate');
  assert.equal(classificationFromLabels(['jarvos-future-release']).classification, 'future-release');
  assert.equal(classificationFromLabels(['jarvos-release-ops']).classification, 'release-ops');
  assert.equal(classificationFromLabels(['jarvos', 'some-other-label']).classification, 'unknown');
  assert.equal(classificationFromLabels([]).classification, 'unknown');
});

test('evaluateReleaseIntakeGate fails closed when no ticket is linked at all', () => {
  const result = evaluateReleaseIntakeGate({ ticketIds: [], releaseFitByTicket: {} });
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /no linked Paperclip issue/);
});

test('evaluateReleaseIntakeGate fails when a linked issue has no explicit disposition (the #107/#108 gap)', () => {
  // Reproduces exactly the historical failure: a ticket IS referenced (unlike
  // the structural-only case above), but its release-intake classification
  // was never recorded, so it comes back "unknown".
  const undisposed = releaseFitFromPaperclipReleaseIntake({ classification: 'unknown' });
  const result = evaluateReleaseIntakeGate({
    ticketIds: ['SUP-3493'],
    releaseFitByTicket: { 'SUP-3493': undisposed },
    checkDisposition: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /SUP-3493/);
  assert.match(result.reasons[0], /no explicit release\/future\/internal-only disposition/);
});

test('evaluateReleaseIntakeGate fails when a linked ticket has no release-intake data at all', () => {
  const result = evaluateReleaseIntakeGate({
    ticketIds: ['SUP-9999'],
    releaseFitByTicket: {},
    checkDisposition: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons[0], /SUP-9999/);
});

test('evaluateReleaseIntakeGate passes a properly-classified release-candidate ticket', () => {
  const releaseFit = releaseFitFromPaperclipReleaseIntake(classificationFromLabels(['jarvos-release-candidate']));
  const result = evaluateReleaseIntakeGate({
    ticketIds: ['SUP-3499'],
    releaseFitByTicket: { 'SUP-3499': releaseFit },
    checkDisposition: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
});

test('evaluateReleaseIntakeGate passes an explicitly not-release (internal-only-shaped) ticket', () => {
  const releaseFit = releaseFitFromPaperclipReleaseIntake({ classification: 'not-release' });
  const result = evaluateReleaseIntakeGate({
    ticketIds: ['SUP-1111'],
    releaseFitByTicket: { 'SUP-1111': releaseFit },
    checkDisposition: true,
  });
  assert.equal(result.ok, true);
});

test('evaluateReleaseIntakeGate in structural-only mode passes on linkage alone, no disposition required', () => {
  // Mirrors what runs in public CI today: no Paperclip credentials, so an
  // undisposed ticket must not fail the gate — only a missing reference does.
  const result = evaluateReleaseIntakeGate({
    ticketIds: ['SUP-3499'],
    releaseFitByTicket: {},
    checkDisposition: false,
  });
  assert.equal(result.ok, true);
});

test('parseReleaseIntakeDocument reads the plain "Label: value" format (SUP-3493 live fixture)', () => {
  const parsed = parseReleaseIntakeDocument(SUP_3493_DOCUMENT_BODY);
  assert.equal(parsed.classification, 'release-candidate');
  assert.equal(parsed.targetVersion, 'v0.7.0');
  assert.equal(parsed.releaseParentIssue, 'SUP-3497');
});

test('parseReleaseIntakeDocument reads the bulleted, period-terminated format (SUP-3478 live fixture)', () => {
  const parsed = parseReleaseIntakeDocument(SUP_3478_DOCUMENT_BODY);
  assert.equal(parsed.classification, 'release-candidate');
  assert.equal(parsed.targetVersion, 'v0.6.3');
  assert.equal(parsed.releaseParentIssue, 'SUP-3250');
});

test('parseReleaseIntakeDocument returns an empty object (unknown classification) for a document with no Classification line', () => {
  const parsed = parseReleaseIntakeDocument('# jarvOS Release Intake\n\nNo classification recorded yet.\n');
  assert.equal(parsed.classification, undefined);
  assert.equal(releaseFitFromPaperclipReleaseIntake(parsed).classification, 'unknown');
});

test('resolveReleaseFit prefers labels when the issue exposes them', async () => {
  const deps = {
    getIssue: async () => ({ labels: ['jarvos-release-candidate'] }),
    paperclipGet: async () => { throw new Error('should not be called when labels match'); },
  };
  const fit = await resolveReleaseFit('SUP-1', {}, deps);
  assert.equal(fit.classification, 'release-candidate');
});

test('resolveReleaseFit falls back to the release-intake document when labels are empty (the real-world path)', async () => {
  const deps = {
    getIssue: async () => ({ labels: [] }),
    paperclipGet: async () => ({ body: SUP_3493_DOCUMENT_BODY }),
  };
  const fit = await resolveReleaseFit('SUP-3493', {}, deps);
  assert.equal(fit.classification, 'release-candidate');
});

test('resolveReleaseFit returns unknown when neither labels nor a release-intake document exist (404)', async () => {
  const deps = {
    getIssue: async () => ({ labels: [] }),
    paperclipGet: async () => {
      const error = new Error('not found');
      error.status = 404;
      throw error;
    },
  };
  const fit = await resolveReleaseFit('SUP-9999', {}, deps);
  assert.equal(fit.classification, 'unknown');
});

test('evaluateReleaseIntakeGate covers multiple linked tickets independently', () => {
  const good = releaseFitFromPaperclipReleaseIntake(classificationFromLabels(['jarvos-release-ops']));
  const bad = releaseFitFromPaperclipReleaseIntake({ classification: 'unknown' });
  const result = evaluateReleaseIntakeGate({
    ticketIds: ['SUP-1000', 'SUP-2000'],
    releaseFitByTicket: { 'SUP-1000': good, 'SUP-2000': bad },
    checkDisposition: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /SUP-2000/);
});
