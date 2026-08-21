'use strict';

// Public plain-data contract. Host orchestration owns evidence collection and
// persistence; this module only validates opaque IDs and deterministic policy.
const crypto = require('node:crypto');
const {
  ACTIVE_ASSISTANT_SEMANTIC_POLICY_VERSION,
  ACTIVE_ASSISTANT_NARRATIVE_POLICY_VERSION,
  composeSegments,
  composeNarrative,
} = require('./active-assistant-semantic-policy');

const ACTIVE_ASSISTANT_SYNTHESIS_CONTRACT_VERSION = 'active-assistant-synthesis/v1';
const ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION = 'active-assistant-synthesis/v2';
const TERMINAL_OUTCOMES = Object.freeze(['rendered', 'salvaged', 'intentional_silence', 'model_refusal', 'model_output_incomplete', 'model_output_invalid', 'policy_rejected', 'source_invalid', 'provider_failed']);
const NARRATIVE_TERMINAL_OUTCOMES = Object.freeze(['rendered', 'no_nudge', 'model_refusal', 'model_output_incomplete', 'model_output_invalid', 'policy_rejected', 'source_invalid', 'provider_failed', 'context_incomplete']);

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
    || ![ACTIVE_ASSISTANT_SYNTHESIS_CONTRACT_VERSION, ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION].includes(proposal.contractVersion)) {
    return { ok: false, reasonCode: 'malformed_envelope' };
  }
  if (proposal.kind === 'refusal') return { ok: false, terminalOutcome: 'model_refusal', reasonCode: 'model_refusal' };
  if (proposal.kind === 'incomplete') return { ok: false, terminalOutcome: 'model_output_incomplete', reasonCode: 'model_output_incomplete' };
  if (proposal.kind === 'no_nudge') return Array.isArray(proposal.sourceRefs) ? { ok: true, value: proposal } : { ok: false, reasonCode: 'malformed_envelope' };
  if (Object.prototype.hasOwnProperty.call(proposal, 'sourcePacketDispositions')) return { ok: false, reasonCode: 'malformed_envelope' };
  if (proposal.contractVersion === ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION) {
    if (proposal.kind !== 'proposal' || !Array.isArray(proposal.claims) || !proposal.closingQuestion || Object.prototype.hasOwnProperty.call(proposal, 'segments')) {
      return { ok: false, reasonCode: 'malformed_envelope' };
    }
    return { ok: true, value: proposal };
  }
  if (proposal.kind !== 'proposal' || !Array.isArray(proposal.segments)) return { ok: false, reasonCode: 'malformed_envelope' };
  return { ok: true, value: proposal };
}

function deriveDispositions({ eligibleSourceIds = [], retainedSegments = [], retainedSourceRefs = [] } = {}) {
  const eligible = [...new Set(eligibleSourceIds)].sort();
  const referenced = new Set(retainedSourceRefs);
  for (const segment of retainedSegments) for (const ref of segment.sourceRefs || []) referenced.add(ref);
  return Object.fromEntries(eligible.map((id) => [id, { disposition: referenced.has(id) ? 'reflected' : 'appropriately_silent', reasonCode: referenced.has(id) ? 'accepted' : 'not_selected' }]));
}

function composeProposal({ proposal, eligibleSourceIds = [], greeting = 'Good morning, Sir!', maxLength = 2000 } = {}) {
  const validation = validateProposal(proposal);
  if (!validation.ok) return validation.terminalOutcome ? validation : { ok: false, terminalOutcome: 'model_output_invalid', reasonCode: validation.reasonCode };
  const eligible = new Set(eligibleSourceIds);
  if (validation.value.kind === 'no_nudge') {
    const refs = validation.value.sourceRefs.map((ref) => String(ref || '').trim()).filter(Boolean);
    if (!refs.length || new Set(refs).size !== refs.length || refs.some((ref) => !eligible.has(ref))) return { ok: false, terminalOutcome: 'policy_rejected', reasonCode: 'no_nudge_missing_source' };
    const narrative = validation.value.contractVersion === ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION;
    return { ok: true, terminalOutcome: narrative ? 'no_nudge' : 'intentional_silence', reasonCode: 'intentional_no_nudge', accepted: [], rejected: [], message: null, dispositions: deriveDispositions({ eligibleSourceIds: eligible, retainedSourceRefs: refs }) };
  }
  if (validation.value.contractVersion === ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION) {
    const composed = composeNarrative({ claims: validation.value.claims, closingQuestion: validation.value.closingQuestion }, {
      eligibleSourceIds: eligible,
      greeting,
      maxLength: maxLength === 2000 ? 1500 : maxLength,
    });
    if (!composed.ok) return { ok: false, terminalOutcome: 'policy_rejected', reasonCode: composed.reasonCode, accepted: [], rejected: composed.rejected, dispositions: deriveDispositions({ eligibleSourceIds: eligible }) };
    return {
      ok: true,
      terminalOutcome: 'rendered',
      reasonCode: 'accepted',
      accepted: composed.accepted,
      closingQuestion: composed.closingQuestion,
      rejected: [],
      message: composed.message,
      dispositions: deriveDispositions({ eligibleSourceIds: eligible, retainedSegments: [...composed.accepted, composed.closingQuestion] }),
    };
  }
  const composed = composeSegments(validation.value.segments, { eligibleSourceIds: eligible, greeting, maxLength });
  if (!composed.ok) return { ok: false, terminalOutcome: 'policy_rejected', reasonCode: composed.reasonCode, accepted: [], rejected: composed.rejected, dispositions: deriveDispositions({ eligibleSourceIds: eligible }) };
  return { ok: true, terminalOutcome: composed.rejected.length ? 'salvaged' : 'rendered', reasonCode: 'accepted', accepted: composed.accepted, rejected: composed.rejected, message: composed.message, dispositions: deriveDispositions({ eligibleSourceIds: eligible, retainedSegments: composed.accepted }) };
}

function redactedReceipt({ runId, terminalOutcome, evidenceDigest, artifactDigest = null, accepted = [], rejected = [], contractVersion = ACTIVE_ASSISTANT_SYNTHESIS_CONTRACT_VERSION } = {}) {
  const outcomes = contractVersion === ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION ? NARRATIVE_TERMINAL_OUTCOMES : TERMINAL_OUTCOMES;
  if (!outcomes.includes(terminalOutcome)) return { ok: false, reasonCode: 'unknown_terminal_outcome' };
  return {
    schemaVersion: contractVersion === ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION ? 2 : 1,
    contractVersion,
    policyVersion: contractVersion === ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION ? ACTIVE_ASSISTANT_NARRATIVE_POLICY_VERSION : ACTIVE_ASSISTANT_SEMANTIC_POLICY_VERSION,
    runId: String(runId || ''),
    terminalOutcome,
    evidenceDigest: String(evidenceDigest || crypto.createHash('sha256').update('').digest('hex')),
    artifactDigest: artifactDigest || null,
    acceptedSegmentCodes: accepted.map(() => 'accepted'),
    rejectedSegmentCodes: rejected.map((row) => row.reasonCode).filter(Boolean),
  };
}

module.exports = {
  ACTIVE_ASSISTANT_SYNTHESIS_CONTRACT_VERSION,
  ACTIVE_ASSISTANT_NARRATIVE_CONTRACT_VERSION,
  TERMINAL_OUTCOMES,
  NARRATIVE_TERMINAL_OUTCOMES,
  validateProposal,
  composeProposal,
  deriveDispositions,
  redactedReceipt,
};
