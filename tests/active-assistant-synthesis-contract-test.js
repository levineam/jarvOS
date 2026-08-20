'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const contract = require('../scripts/lib/active-assistant-synthesis-contract');

const VERSION = contract.ACTIVE_ASSISTANT_SYNTHESIS_CONTRACT_VERSION;
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

test('public contract rejects raw HTML elements', () => {
  for (const text of [
    '<script>alert(1)</script>',
    '<svg onload=alert(1)>source reflection</svg>',
    '<iframe srcdoc="hostile content"></iframe>',
    '<div onmouseover=alert(1)>source reflection</div>',
  ]) {
    const result = contract.composeProposal({
      proposal: { contractVersion: VERSION, kind: 'proposal', segments: [{ id: 'html', type: 'source_backed_observation', text, sourceRefs: [source] }] },
      eligibleSourceIds: [source],
    });
    assert.equal(result.terminalOutcome, 'policy_rejected', text);
    assert.equal(result.rejected[0].reasonCode, 'active_markup', text);
  }
});

test('redacted receipt contains no prose fields', () => {
  const receipt = contract.redactedReceipt({ runId: 'synthetic-run', terminalOutcome: 'rendered', evidenceDigest: 'a'.repeat(64), accepted: [{ id: 'good' }] });
  assert.equal(JSON.stringify(receipt).includes('coachMessage'), false);
  assert.equal(JSON.stringify(receipt).includes('sourceText'), false);
  assert.equal(receipt.contractVersion, VERSION);
});
