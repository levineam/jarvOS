'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const contracts = require('../src/project-inference-contracts');

const DIGEST = 'a'.repeat(64);

function evidence(overrides = {}) {
  return contracts.createEvidenceUnit({
    sourceClass: 'note',
    occurredAt: '2026-08-01T10:00:00-04:00',
    observedAt: '2026-08-01T15:00:00.000Z',
    sourceRevision: 'note-r1',
    sensitivity: 'public-fixture',
    coverageState: 'fresh',
    contentDigest: DIGEST,
    ...overrides,
  });
}

function candidate(overrides = {}) {
  return contracts.createProjectCandidate({
    evidenceIds: ['ev_001', 'ev_002'],
    engineRevision: 'engine-v1',
    policyRevision: 'policy-v1',
    kind: 'project',
    title: 'Swarm Theory Book',
    aliases: ['the manuscript'],
    parentId: null,
    parentAlternatives: [],
    confidence: {
      identityMatch: 0.8,
      novelty: 0.7,
      sourceDiversity: 0.5,
      temporalContinuity: 0.6,
      parentFit: 0.5,
      sourceCoverage: 1,
    },
    disposition: 'provisional',
    ...overrides,
  });
}

function correction(overrides = {}) {
  return {
    sourceClass: 'chat',
    occurredAt: '2026-08-08T09:00:00.000Z',
    observedAt: '2026-08-08T10:00:00.000Z',
    sourceRevision: 'chat-r3',
    sensitivity: 'public-fixture',
    coverageState: 'fresh',
    contentDigest: DIGEST,
    target: { alias: 'AAF Observatory', candidateId: null, canonicalId: null },
    operation: 'rename',
    assertedChange: { title: 'Amazing Abundance Portfolio', aliases: [], parentId: null, kind: null, canonicalId: null },
    attestation: { method: 'owner-bound-interactive', admission: null },
    ...overrides,
  };
}

test('evidence units normalize portable metadata and derive stable IDs', () => {
  const first = evidence({ evidenceId: undefined, observationId: undefined });
  const second = evidence({
    evidenceId: undefined,
    observationId: undefined,
    occurredAt: '2026-08-01T10:00:00-04:00',
  });

  assert.equal(first.occurredAt, second.occurredAt);
  assert.equal(first.evidenceId, second.evidenceId);
  assert.equal(first.observationId, second.observationId);
  assert.equal(contracts.evidenceUnitDigest(first), contracts.evidenceUnitDigest(second));
  assert.deepEqual(contracts.validateEvidenceUnit(first), { ok: true, evidence: first });
  assert.deepEqual(contracts.SOURCE_CLASSES, ['note', 'chat', 'execution', 'release', 'stewardship']);
  assert.deepEqual(contracts.COVERAGE_STATES, ['fresh', 'stale', 'partial', 'unknown', 'unavailable', 'healthy-empty', 'policy-omitted']);
});

test('evidence units preserve distinct coverage states and reject raw or extra fields', () => {
  for (const coverageState of contracts.COVERAGE_STATES) {
    assert.equal(evidence({ coverageState }).coverageState, coverageState);
  }
  for (const field of ['text', 'content', 'prompt', 'transcript', 'diff', 'path', 'credential', 'locator']) {
    assert.throws(() => evidence({ [field]: 'private source material' }), /unsupported fields|exact fields/);
  }
  assert.throws(() => evidence({ sourceClass: 'calendar' }), /sourceClass/);
  assert.throws(() => evidence({ sourceRevision: '/Users/andrew/private-note.md' }), /opaque|sourceRevision/);
});

test('policy-omitted coverage remains distinct through evidence and coverage validation round trips', () => {
  const unit = evidence({ coverageState: 'policy-omitted', contentDigest: null });
  assert.equal(unit.coverageState, 'policy-omitted');
  assert.deepEqual(contracts.validateEvidenceUnit(unit), { ok: true, evidence: unit });

  const status = contracts.createCoverageStatus({
    sourceClass: 'chat',
    state: 'policy-omitted',
    observedAt: '2026-08-01T15:00:00.000Z',
    sourceRevision: 'chat-policy-v1',
  });
  assert.equal(status.state, 'policy-omitted');
  assert.deepEqual(contracts.validateCoverageStatus(status), { ok: true, coverage: status });
  assert.notEqual(status.state, 'unavailable');
  assert.notEqual(status.state, 'healthy-empty');
});

test('candidates are deterministic, support provisional and quarantined states, and enforce outcome leaf semantics', () => {
  const first = candidate({ evidenceIds: ['ev_002', 'ev_001'] });
  const second = candidate({ evidenceIds: ['ev_001', 'ev_002'] });
  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.candidateId, candidate({ origin: 'replay' }).candidateId);
  assert.equal(contracts.projectCandidateDigest(first), contracts.projectCandidateDigest(second));
  assert.equal(
    contracts.projectCandidateDigest(first),
    contracts.projectCandidateDigest(candidate({ origin: 'replay' })),
  );
  assert.equal(candidate({ disposition: 'quarantined' }).disposition, 'quarantined');
  assert.throws(() => candidate({ kind: 'outcome', parentId: null }), /outcome.*parent/i);
  assert.throws(() => candidate({ confidence: { ...candidate().confidence, identityMatch: 2 } }), /confidence/);
});

test('decisions validate typed dispositions, canonical metadata, lineage, and suppression', () => {
  const decision = contracts.createInferenceDecision({
    candidateId: candidate().candidateId,
    policyRevision: 'policy-v1',
    disposition: 'established',
    canonical: {
      recordId: 'prj_000001',
      kind: 'project',
      revision: 2,
      parentId: null,
      refDigest: DIGEST,
    },
    reasonCodes: ['policy-qualified'],
    suppressionKey: 'suppress-old-alias',
    supersededBy: null,
    lineage: [],
  });
  assert.match(decision.decisionId, /^dec_[a-f0-9]{32}$/);
  for (const disposition of contracts.DECISION_DISPOSITIONS) {
    assert.equal(contracts.createInferenceDecision({
      candidateId: candidate().candidateId,
      policyRevision: 'policy-v1',
      disposition,
      canonical: null,
      reasonCodes: [],
      suppressionKey: null,
      supersededBy: null,
      lineage: [],
    }).disposition, disposition);
  }
  assert.throws(() => contracts.createInferenceDecision({
    candidateId: candidate().candidateId,
    policyRevision: 'policy-v1',
    disposition: 'established',
    canonical: { recordId: 'out_000001', kind: 'outcome', revision: 1, parentId: null, refDigest: DIGEST },
    reasonCodes: [], suppressionKey: null, supersededBy: null, lineage: [],
  }), /outcome.*parent|leaf/i);
  assert.throws(() => contracts.createInferenceDecision({
    candidateId: candidate().candidateId,
    policyRevision: 'policy-v1',
    disposition: 'established',
    canonical: null,
    reasonCodes: [], suppressionKey: null, supersededBy: null, lineage: [],
    extra: true,
  }), /unsupported fields|exact fields/);
});

test('corrections require a host-issued admission for verification and preserve support-only text', () => {
  const attestor = contracts.createCorrectionAttestor({
    issuerId: 'host-projects',
    secret: 'host-only-correction-secret',
    allowedMethods: ['owner-bound-interactive'],
    allowedSourceClasses: ['chat'],
  });
  const verified = attestor.attest(correction());
  assert.equal(verified.trustTier, 'verified');
  assert.equal(verified.attestation.status, 'verified');
  assert.deepEqual(Object.keys(verified.attestation.admission).sort(), ['authorityDigest', 'claimDigest', 'issuerId', 'signature']);
  assert.equal(contracts.isVerifiedCorrection(verified), false);
  assert.equal(contracts.isVerifiedCorrection(verified, attestor), true);
  assert.equal(attestor.verify(verified), true);
  assert.doesNotMatch(JSON.stringify(verified), /host-only-correction-secret/);

  const support = contracts.createCorrectionEvidence(correction({
    observedAt: '2026-08-08T12:00:00.000Z',
    coverageState: 'unknown',
    attestation: { method: 'conversation-text', admission: null },
  }));
  assert.equal(support.trustTier, 'unverified');
  assert.equal(support.attestation.status, 'unverified');
  assert.equal(support.attestation.admission, null);
  assert.equal(contracts.isVerifiedCorrection(support), false);
  assert.throws(() => contracts.createCorrectionEvidence({
    ...correction(),
    attestation: { method: 'owner-bound-interactive', admission: { issuerId: 'forged', authorityDigest: DIGEST, claimDigest: DIGEST, signature: DIGEST }, status: 'verified' },
  }), /trusted host attestor|admission/);
});

test('forged issuer or admission digests fail closed against the trusted attestor', () => {
  const attestor = contracts.createCorrectionAttestor({ issuerId: 'host-projects', secret: 'host-secret', allowedMethods: ['owner-bound-interactive'], allowedSourceClasses: ['chat'] });
  const verified = attestor.attest(correction());
  const forged = JSON.parse(JSON.stringify(verified));
  forged.attestation.admission.issuerId = 'forged-host';
  assert.equal(attestor.verify(forged), false);
  assert.equal(contracts.isVerifiedCorrection(forged, attestor), false);
  assert.throws(() => attestor.adopt(forged), /signature|claim|admission/);
});

test('signature tampering cannot turn a portable correction into verified evidence', () => {
  const attestor = contracts.createCorrectionAttestor({ issuerId: 'host-projects', secret: 'host-secret', allowedMethods: ['owner-bound-interactive'], allowedSourceClasses: ['chat'] });
  const tampered = JSON.parse(JSON.stringify(attestor.attest(correction())));
  tampered.attestation.admission.signature = `${tampered.attestation.admission.signature.slice(0, -1)}${tampered.attestation.admission.signature.endsWith('0') ? '1' : '0'}`;
  assert.equal(attestor.verify(tampered), false);
  assert.equal(contracts.isVerifiedCorrection(tampered, attestor), false);
  assert.throws(() => attestor.adopt(tampered), /signature|claim|admission/);
});

test('host attestors reject wrong source classes and support-only methods', () => {
  const attestor = contracts.createCorrectionAttestor({ issuerId: 'host-projects', secret: 'host-secret', allowedMethods: ['owner-bound-interactive'], allowedSourceClasses: ['chat'] });
  assert.throws(() => attestor.attest(correction({ sourceClass: 'release' })), /source class/);
  assert.throws(() => attestor.attest(correction({ attestation: { method: 'conversation-text', admission: null } })), /method/);
});

test('portable digest fields are strict while suppression keys remain opaque identifiers', () => {
  assert.throws(() => evidence({ contentDigest: 'A'.repeat(64) }), /64 lowercase/);
  assert.throws(() => evidence({ contentDigest: 'a'.repeat(63) }), /64 lowercase/);
  assert.throws(() => contracts.createInferenceDecision({
    candidateId: candidate().candidateId,
    policyRevision: 'policy-v1',
    disposition: 'established',
    canonical: { recordId: 'prj_000001', kind: 'project', revision: 1, parentId: null, refDigest: 'not-a-digest' },
    reasonCodes: [], suppressionKey: 'suppress-old-alias', supersededBy: null, lineage: [],
  }), /64 lowercase/);
  assert.equal(contracts.createInferenceDecision({
    candidateId: candidate().candidateId,
    policyRevision: 'policy-v1',
    disposition: 'established',
    canonical: null,
    reasonCodes: [], suppressionKey: 'suppress-old-alias', supersededBy: null, lineage: [],
  }).suppressionKey, 'suppress-old-alias');
});

test('reason codes detect duplicates after case folding', () => {
  assert.throws(() => candidate({ reasonCodes: ['Policy-Qualified', 'policy-qualified'] }), /reasonCodes.*duplicates/);
  assert.deepEqual(candidate({ reasonCodes: ['Policy-Qualified', 'Needs-Review'] }).reasonCodes, ['needs-review', 'policy-qualified']);
});
