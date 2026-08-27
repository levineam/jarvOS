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
    expectedContractVersion: VERSION,
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
  assert.equal(receipt.contractVersion, V2);
});

test('v2 renders a grounded multi-sentence narrative and one closing question', () => {
  const second = 'project:synthetic-2';
  const result = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'week', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
        { id: 'connection', type: 'cross_project_connection', text: 'The manuscript work sits beside a renewed research thread.', sourceRefs: [source, second] },
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

test('v2 accepts a narrative claim punctuated immediately before a closing quotation mark', () => {
  const result = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'one', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
        { id: 'two', type: 'source_backed_observation', text: 'You wrote that “the thread became clearer.”', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'Is the manuscript the thread to continue?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(result.ok, true);
  assert.equal(result.terminalOutcome, 'rendered');
  assert.equal(result.rejected.length, 0);
});

test('v2 still rejects a narrative claim with trailing words after punctuation or no terminal punctuation', () => {
  const trailingWords = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'one', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
        { id: 'two', type: 'source_backed_observation', text: 'You wrote that “the thread became clearer.” today', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'Is the manuscript the thread to continue?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(trailingWords.ok, false);
  assert.deepEqual(trailingWords.rejected.map((row) => row.reasonCode), ['narrative_claim_invalid']);

  const noPunctuation = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'one', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
        { id: 'two', type: 'source_backed_observation', text: 'You wrote that “the thread became clearer”', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'Is the manuscript the thread to continue?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(noPunctuation.ok, false);
  assert.deepEqual(noPunctuation.rejected.map((row) => row.reasonCode), ['narrative_claim_invalid']);
});

test('v2 rejects dangling subjects such as “that work”', () => {
  const result = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'one', type: 'source_backed_observation', text: 'You returned to the manuscript.', sourceRefs: [source] },
        { id: 'two', type: 'cross_project_connection', text: 'That work connects to the research.', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'Is the manuscript the thread to continue?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.rejected.map((row) => row.reasonCode), ['subject_not_named']);
});

test('v2 rejects an anaphoric closing question but allows a named subject', () => {
  const rejected = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'one', type: 'source_backed_observation', text: 'You returned to the manuscript.', sourceRefs: [source] },
        { id: 'two', type: 'source_backed_observation', text: 'The manuscript now has a clearer opening.', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'Is that the thread to continue?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.rejected.map((row) => row.reasonCode), ['subject_not_named']);

  const named = contract.composeProposal({
    proposal: {
      contractVersion: V2,
      kind: 'proposal',
      claims: [
        { id: 'one', type: 'source_backed_observation', text: 'You returned to the manuscript.', sourceRefs: [source] },
        { id: 'two', type: 'source_backed_observation', text: 'The manuscript now has a clearer opening.', sourceRefs: [source] },
      ],
      closingQuestion: { id: 'question', text: 'Is the manuscript the thread to continue?', sourceRefs: [source] },
    },
    eligibleSourceIds: [source],
  });
  assert.equal(named.ok, true);
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
      closingQuestion: { id: 'question', text: 'Is the manuscript the thread to continue?', sourceRefs: [source] },
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
  assert.equal(quiet.dispositions[source].disposition, 'appropriately_silent');
});

test('v2 baseline rejects a legacy v1 proposal unless its compatibility mode is explicit', () => {
  const proposal = {
    contractVersion: VERSION,
    kind: 'proposal',
    segments: [
      { id: 'good', type: 'source_backed_observation', text: 'You returned to the manuscript this week.', sourceRefs: [source] },
    ],
  };
  const baseline = contract.composeProposal({ proposal, eligibleSourceIds: [source] });
  assert.equal(baseline.ok, false);
  assert.equal(baseline.reasonCode, 'contract_version_mismatch');

  const legacy = contract.composeProposal({ proposal, eligibleSourceIds: [source], expectedContractVersion: VERSION });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.terminalOutcome, 'rendered');
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
