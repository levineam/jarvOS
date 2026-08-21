'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('../scripts/lib/active-assistant-synthesis-contract');

const VERSION = contract.ACTIVE_ASSISTANT_SYNTHESIS_CONTRACT_VERSION;
const V2 = contract.ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION;
const source = 'note:synthetic-1';

test('public contract derives dispositions and salvages a guarded sibling deterministically', () => {
  const result = contract.composeProposal({
    proposal: {
      contractVersion: VERSION,
      kind: 'proposal',
      segments: [
        { id: 'good', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
        { id: 'bad', type: 'source_backed_observation', text: 'The system sent the draft.', sourceRefs: [source] },
      ],
    },
    eligibleSourceIds: [source],
  });
  assert.equal(result.ok, true);
  assert.equal(result.terminalOutcome, 'salvaged');
  assert.deepEqual(result.accepted.map((row) => row.id), ['good']);
  assert.equal(result.dispositions[source].disposition, 'reflected');
});

test('public contract rejects model-authored accounting and active links', () => {
  const proposal = { contractVersion: VERSION, kind: 'proposal', sourcePacketDispositions: {}, segments: [] };
  assert.equal(contract.validateProposal(proposal).reasonCode, 'malformed_envelope');
  const linked = contract.composeProposal({
    proposal: { contractVersion: VERSION, kind: 'proposal', segments: [{ id: 'link', type: 'source_backed_observation', text: 'Read https://example.com next.', sourceRefs: [source] }] },
    eligibleSourceIds: [source],
  });
  assert.equal(linked.terminalOutcome, 'policy_rejected');
});

test('redacted receipt contains no prose fields', () => {
  const receipt = contract.redactedReceipt({ runId: 'synthetic-run', terminalOutcome: 'rendered', evidenceDigest: 'a'.repeat(64), accepted: [{ id: 'good' }] });
  assert.equal(JSON.stringify(receipt).includes('coachMessage'), false);
  assert.equal(JSON.stringify(receipt).includes('sourceText'), false);
  assert.equal(receipt.contractVersion, VERSION);
});

test('v2 renders a grounded multi-sentence narrative and one closing question', () => {
  const second = 'project:synthetic-2';
  const result = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'week', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
        { id: 'connection', type: 'cross_project_connection', text: 'That work sits beside a renewed research thread.', sourceRefs: [source, second] },
      ],
      closingQuestion: { id: 'question', text: 'Does the manuscript still deserve the next clear block of attention?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source, second],
  });
  assert.equal(result.ok, true);
  assert.equal(result.terminalOutcome, 'rendered');
  assert.equal(result.rejected.length, 0);
  assert.match(result.message, /^Good morning, Sir! You returned/);
  assert.equal((result.message.match(/\?/g) || []).length, 1);
  assert.ok(result.message.length <= 1500);
  assert.equal(result.dispositions[second].disposition, 'reflected');
});

test('v2 rejects the whole narrative instead of salvaging an invalid sibling', () => {
  const result = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'good', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
        { id: 'bad', type: 'source_backed_observation', text: 'The assistant drafted the missing chapter.', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'What deserves attention next?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(result.ok, false);
  assert.equal(result.terminalOutcome, 'policy_rejected');
  assert.equal(result.accepted.length, 0);
  assert.notEqual(result.terminalOutcome, 'salvaged');
  assert.deepEqual(result.rejected.map((row) => row.reasonCode), ['unsupported_assistant_action']);
});

test('v2 permits evidence-backed work-state claims and uses no_nudge as its product outcome', () => {
  const rendered = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'draft', type: 'source_backed_observation', text: 'You drafted a new manuscript passage.', sourceRefs: [source] },
        { id: 'return', type: 'source_backed_observation', text: 'You also returned to the underlying research.', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'Is that the thread to continue?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(rendered.terminalOutcome, 'rendered');

  const quiet = contract.composeProposal({
    proposal: { contractVersion: V2, kind: 'no_nudge', sourceRefs: [source] },
    eligibleSourceIds: [source],
  });
  assert.equal(quiet.terminalOutcome, 'no_nudge');
  assert.equal(quiet.message, null);
});

test('v2 receipt cannot publish salvaged as a terminal outcome', () => {
  const rejected = contract.redactedReceipt({
    contractVersion: V2,
    runId: 'synthetic-v2',
    terminalOutcome: 'salvaged',
    evidenceDigest: 'b'.repeat(64),
  });
  assert.deepEqual(rejected, { ok: false, reasonCode: 'unknown_terminal_outcome' });
  const accepted = contract.redactedReceipt({
    contractVersion: V2,
    runId: 'synthetic-v2',
    terminalOutcome: 'context_incomplete',
    evidenceDigest: 'b'.repeat(64),
  });
  assert.equal(accepted.schemaVersion, 2);
  assert.equal(accepted.contractVersion, V2);
});
