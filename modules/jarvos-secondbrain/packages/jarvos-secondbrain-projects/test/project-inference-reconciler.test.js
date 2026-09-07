'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const contracts = require('../src/project-inference-contracts');
const { ProjectRegistry } = require('../src/registry');
const ledgerModule = require('../src/project-inference-ledger');
const {
  ENGINE_REVISION,
  POLICY_REVISION,
  ProjectInferenceReconciler,
} = require('../src/project-inference-reconciler');

const DIGEST = 'a'.repeat(64);
const LATER_DIGEST = 'b'.repeat(64);

function stateRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-project-inference-reconciler-'));
}

function fixture({ registryDir = stateRoot(), ledgerDir = stateRoot(), now = '2026-08-03T12:00:00.000Z', attestor = null } = {}) {
  const clock = () => now;
  const registry = new ProjectRegistry({ stateDir: registryDir, now: clock });
  const ledger = ledgerModule.createFileInferenceLedger({ root: ledgerDir, ...(attestor ? { attestor } : {}) });
  return {
    registry,
    ledger,
    attestor,
    make: () => new ProjectInferenceReconciler({
      registry,
      ledger,
      now: clock,
      engineRevision: ENGINE_REVISION,
      policyRevision: POLICY_REVISION,
      correctionAttestor: attestor,
    }),
  };
}

function evidence(id, occurredAt, sourceClass = 'note', overrides = {}) {
  return contracts.createEvidenceUnit({
    evidenceId: id,
    observationId: `obs_${id}`,
    sourceClass,
    occurredAt,
    observedAt: occurredAt,
    sourceRevision: `${sourceClass}-r1`,
    sensitivity: 'public-fixture',
    coverageState: 'fresh',
    contentDigest: DIGEST,
    ...overrides,
  });
}

function candidate(evidenceIds, overrides = {}) {
  return contracts.createProjectCandidate({
    candidateId: overrides.candidateId || undefined,
    origin: 'inference',
    evidenceIds,
    engineRevision: ENGINE_REVISION,
    policyRevision: POLICY_REVISION,
    kind: 'project',
    title: 'Field Research',
    aliases: [],
    parentId: null,
    parentAlternatives: [],
    confidence: {
      identityMatch: 0.9,
      novelty: 0.9,
      sourceDiversity: 0.8,
      temporalContinuity: 0.8,
      parentFit: 0.5,
      sourceCoverage: 1,
    },
    disposition: 'provisional',
    reasonCodes: [],
    lineage: [],
    ...overrides,
  });
}

function coverage(sourceClass, observedAt, state = 'fresh') {
  return contracts.createCoverageStatus({
    sourceClass,
    state,
    observedAt,
    sourceRevision: `${sourceClass}-coverage-r1`,
  });
}

function reconcileInput(c, evidenceUnits, extra = {}) {
  return {
    candidate: c,
    evidence: evidenceUnits,
    coverage: [...new Set(evidenceUnits.map((item) => item.sourceClass))]
      .map((sourceClass) => coverage(sourceClass, '2026-08-03T12:00:00.000Z')),
    ...extra,
  };
}

function ledgerDecisions(ledger) {
  return ledger.listEvents().filter((event) => event.eventType === 'decision');
}

test('one source and two same-day sources remain provisional without registry mutation', () => {
  const one = fixture();
  const oneEvidence = [evidence('ev_weak', '2026-08-01T09:00:00.000Z', 'note')];
  const first = one.make().reconcile(reconcileInput(candidate(['ev_weak']), oneEvidence));
  assert.equal(first.status, 'provisional');
  assert.equal(one.registry.generation, 0);

  const omitted = fixture();
  const omittedEvidence = [
    evidence('ev_omitted_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_omitted_chat', '2026-08-02T09:00:00.000Z', 'chat'),
  ];
  const omittedResult = omitted.make().reconcile({
    candidate: candidate(['ev_omitted_note', 'ev_omitted_chat']),
    evidence: omittedEvidence,
  });
  assert.equal(omittedResult.status, 'provisional');
  assert.equal(omitted.registry.generation, 0);

  const two = fixture();
  const sameDay = [
    evidence('ev_same_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_same_chat', '2026-08-01T19:00:00.000Z', 'chat'),
  ];
  const second = two.make().reconcile(reconcileInput(candidate(['ev_same_note', 'ev_same_chat']), sameDay));
  assert.equal(second.status, 'provisional');
  assert.equal(two.registry.generation, 0);
});

test('source-diverse evidence must span three calendar days to establish a root Project', () => {
  const f = fixture();
  const tooSoon = [
    evidence('ev_root_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_root_chat', '2026-08-02T09:00:00.000Z', 'chat'),
  ];
  assert.equal(f.make().reconcile(reconcileInput(candidate(['ev_root_note', 'ev_root_chat']), tooSoon)).status, 'provisional');

  const qualified = fixture();
  const evidenceUnits = [
    evidence('ev_qualified_note', '2026-08-01T23:59:00.000Z', 'note'),
    evidence('ev_qualified_chat', '2026-08-03T00:01:00.000Z', 'chat'),
  ];
  const result = qualified.make().reconcile(reconcileInput(candidate(['ev_qualified_note', 'ev_qualified_chat']), evidenceUnits));
  assert.equal(result.status, 'established');
  assert.equal(result.record.kind, 'project');
  assert.equal(result.record.parentId, null);
  assert.equal(result.decision.canonical.recordId, result.record.id);
  assert.equal(qualified.registry.generation, 1);
});

test('verified Correction establishes immediately and a rename preserves the canonical ID and old alias', () => {
  const attestor = contracts.createCorrectionAttestor({
    issuerId: 'owner-host',
    secret: 'reconciler-test-secret',
    allowedMethods: ['telegram-owner'],
    allowedSourceClasses: ['chat'],
  });
  const f = fixture({ attestor });
  const e = evidence('ev_verified', '2026-08-03T10:00:00.000Z', 'chat');
  const c = candidate(['ev_verified'], { title: 'Old Working Name' });
  const correction = attestor.attest({
    ...e,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: c.candidateId, canonicalId: null, alias: null },
    operation: 'establish',
    assertedChange: { title: 'Verified Portfolio', aliases: [], parentId: null, kind: 'project', canonicalId: null },
    attestation: { method: 'telegram-owner' },
  });
  const established = f.make().reconcile(reconcileInput(c, [e], { correction }));
  assert.equal(established.status, 'corrected');
  const canonicalId = established.record.id;
  assert.equal(established.record.title, 'Verified Portfolio');

  const renameEvidence = evidence('ev_verified_rename', '2026-08-04T10:00:00.000Z', 'chat', { contentDigest: LATER_DIGEST });
  const renameCorrection = attestor.attest({
    ...renameEvidence,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: c.candidateId, canonicalId, alias: null },
    operation: 'rename',
    assertedChange: { title: 'Portfolio Thesis', aliases: [], parentId: null, kind: 'project', canonicalId },
    attestation: { method: 'telegram-owner' },
  });
  const renamed = f.make().reconcile(reconcileInput(
    c,
    [e],
    { correction: renameCorrection },
  ));
  assert.equal(renamed.status, 'corrected');
  assert.equal(renamed.record.id, canonicalId);
  assert.equal(renamed.record.title, 'Portfolio Thesis');
  assert.deepEqual(renamed.record.aliases, ['Old Working Name', 'Verified Portfolio']);
});

test('verified merge correction atomically preserves the survivor, children, aliases, and replay', () => {
  const attestor = contracts.createCorrectionAttestor({
    issuerId: 'owner-host', secret: 'merge-secret', allowedMethods: ['telegram-owner'], allowedSourceClasses: ['chat'],
  });
  const f = fixture({ attestor });
  const source = f.registry.create({ title: 'Research Observatory' });
  const survivor = f.registry.create({ title: 'Amazing Abundance Portfolio' }, { expectedGeneration: source.generation });
  const child = f.registry.create({ title: 'Portfolio Memo', parentId: source.record.id }, { expectedGeneration: survivor.generation });
  const e = evidence('ev_merge', '2026-08-03T10:00:00.000Z', 'chat');
  const c = candidate([e.evidenceId], { title: 'Research Observatory' });
  const correction = attestor.attest({
    ...e,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: null, canonicalId: source.record.id, alias: null },
    operation: 'merge',
    assertedChange: { title: null, aliases: ['AAF Observatory'], parentId: null, kind: 'project', canonicalId: survivor.record.id },
    attestation: { method: 'telegram-owner' },
  });
  const merged = f.make().reconcile(reconcileInput(c, [e], { correction }));
  assert.equal(merged.status, 'corrected');
  assert.equal(merged.record.id, survivor.record.id);
  assert.deepEqual(merged.record.aliases, ['AAF Observatory', 'Research Observatory']);
  assert.equal(f.registry.get(source.record.id).lifecycle, 'archived');
  assert.equal(f.registry.get(source.record.id).inference.disposition, 'superseded');
  assert.equal(f.registry.get(child.record.id).parentId, survivor.record.id);
  const generation = f.registry.generation;
  const replay = f.make().reconcile(reconcileInput(c, [e], { correction }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, survivor.record.id);
  assert.equal(f.registry.generation, generation);
});

test('verified split correction atomically creates a new canonical record and preserves its source', () => {
  const attestor = contracts.createCorrectionAttestor({
    issuerId: 'owner-host', secret: 'split-secret', allowedMethods: ['telegram-owner'], allowedSourceClasses: ['chat'],
  });
  const f = fixture({ attestor });
  const source = f.registry.create({ title: 'Combined Research' });
  const e = evidence('ev_split', '2026-08-03T10:00:00.000Z', 'chat');
  const c = candidate([e.evidenceId], { title: 'Macro Research' });
  const correction = attestor.attest({
    ...e,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: null, canonicalId: source.record.id, alias: null },
    operation: 'split',
    assertedChange: { title: 'Macro Research', aliases: [], parentId: null, kind: 'project', canonicalId: null },
    attestation: { method: 'telegram-owner' },
  });
  const split = f.make().reconcile(reconcileInput(c, [e], { correction }));
  assert.equal(split.status, 'corrected');
  assert.notEqual(split.record.id, source.record.id);
  assert.equal(split.record.title, 'Macro Research');
  assert.equal(f.registry.get(source.record.id).title, 'Combined Research');
  assert.equal(f.registry.get(source.record.id).lifecycle, 'active');
});

test('merge and split corrections reject stale source revisions without mutation', () => {
  const attestor = contracts.createCorrectionAttestor({
    issuerId: 'owner-host', secret: 'stale-correction-secret', allowedMethods: ['telegram-owner'], allowedSourceClasses: ['chat'],
  });
  for (const operation of ['merge', 'split']) {
    const f = fixture({ attestor });
    const source = f.registry.create({ title: `${operation} source` });
    const survivor = operation === 'merge'
      ? f.registry.create({ title: 'merge survivor' }, { expectedGeneration: source.generation })
      : null;
    const currentGeneration = survivor?.generation || source.generation;
    const e = evidence(`ev_${operation}_stale`, '2026-08-03T10:00:00.000Z', 'chat');
    const c = candidate([e.evidenceId], { title: `${operation} candidate` });
    const correction = attestor.attest({
      ...e,
      contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
      target: { candidateId: null, canonicalId: source.record.id, alias: null },
      operation,
      assertedChange: {
        title: operation === 'split' ? 'split result' : null,
        aliases: [],
        parentId: null,
        kind: 'project',
        canonicalId: survivor?.record.id || null,
      },
      attestation: { method: 'telegram-owner' },
    });
    const result = f.make().reconcile(reconcileInput(c, [e], {
      correction,
      expectedRegistryGeneration: currentGeneration,
      expectedRegistryRevision: source.record.revision + 1,
    }));
    assert.equal(result.status, 'blocked');
    assert.match(result.reasonCodes.join(','), /stale-registry/);
    assert.equal(f.registry.generation, currentGeneration);
    assert.equal(f.registry.get(source.record.id).lifecycle, 'active');
    assert.equal(f.registry.list().length, operation === 'merge' ? 2 : 1);
  }
});

test('merging a source into its descendant survivor repairs the hierarchy without a cycle', () => {
  const attestor = contracts.createCorrectionAttestor({
    issuerId: 'owner-host', secret: 'descendant-merge-secret', allowedMethods: ['telegram-owner'], allowedSourceClasses: ['chat'],
  });
  const f = fixture({ attestor });
  const source = f.registry.create({ title: 'Parent Research' });
  const survivor = f.registry.create({ title: 'Focused Research', parentId: source.record.id }, { expectedGeneration: source.generation });
  const grandchild = f.registry.create({ title: 'Research Memo', parentId: survivor.record.id }, { expectedGeneration: survivor.generation });
  const sibling = f.registry.create({ title: 'Adjacent Research', parentId: source.record.id }, { expectedGeneration: grandchild.generation });
  const e = evidence('ev_descendant_merge', '2026-08-03T10:00:00.000Z', 'chat');
  const c = candidate([e.evidenceId], { title: source.record.title });
  const correction = attestor.attest({
    ...e,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: null, canonicalId: source.record.id, alias: null },
    operation: 'merge',
    assertedChange: { title: null, aliases: [], parentId: null, kind: 'project', canonicalId: survivor.record.id },
    attestation: { method: 'telegram-owner' },
  });
  const result = f.make().reconcile(reconcileInput(c, [e], { correction }));
  assert.equal(result.status, 'corrected');
  assert.equal(f.registry.get(survivor.record.id).parentId, null);
  assert.equal(f.registry.get(sibling.record.id).parentId, survivor.record.id);
  assert.equal(f.registry.get(grandchild.record.id).parentId, survivor.record.id);
  assert.equal(f.registry.integrity().ok, true);
});

test('unverified correction cannot mutate the registry', () => {
  const f = fixture();
  const e = evidence('ev_unverified', '2026-08-01T09:00:00.000Z', 'chat');
  const c = candidate(['ev_unverified'], { title: 'Unverified Name' });
  const correction = contracts.createCorrection({
    ...e,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: c.candidateId, canonicalId: null, alias: null },
    operation: 'establish',
    assertedChange: { title: 'Should Not Mutate', aliases: [], parentId: null, kind: 'project', canonicalId: null },
    attestation: { method: 'conversation-text' },
  });
  const result = f.make().reconcile(reconcileInput(c, [e], { correction }));
  assert.equal(result.status, 'provisional');
  assert.equal(f.registry.generation, 0);
  assert.match(result.reasonCodes.join(','), /correction-unverified/);
});

test('a caller cannot supply its own correction authority', () => {
  const trusted = contracts.createCorrectionAttestor({
    issuerId: 'trusted-owner', secret: 'trusted-secret', allowedMethods: ['telegram-owner'], allowedSourceClasses: ['chat'],
  });
  const attacker = contracts.createCorrectionAttestor({
    issuerId: 'caller-controlled', secret: 'attacker-secret', allowedMethods: ['telegram-owner'], allowedSourceClasses: ['chat'],
  });
  const f = fixture({ attestor: trusted });
  const e = evidence('ev_forged_authority', '2026-08-03T10:00:00.000Z', 'chat');
  const c = candidate([e.evidenceId]);
  const correction = attacker.attest({
    ...e,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: c.candidateId, canonicalId: null, alias: null },
    operation: 'establish',
    assertedChange: { title: 'Attacker Project', aliases: [], parentId: null, kind: 'project', canonicalId: null },
    attestation: { method: 'telegram-owner' },
  });
  assert.throws(
    () => f.make().reconcile(reconcileInput(c, [e], { correction, correctionAttestor: attacker })),
    /unsupported fields|signature|claim|admission/i,
  );
  assert.equal(f.registry.generation, 0);
});

test('fresh coverage can advance a previously provisional candidate', () => {
  const f = fixture();
  const evidenceUnits = [
    evidence('ev_advancing_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_advancing_chat', '2026-08-03T09:00:00.000Z', 'chat'),
  ];
  const c = candidate(evidenceUnits.map((item) => item.evidenceId));
  const incomplete = f.make().reconcile(reconcileInput(c, evidenceUnits, {
    coverage: [
      coverage('note', '2026-08-03T12:00:00.000Z'),
      coverage('chat', '2026-08-03T12:00:00.000Z', 'unavailable'),
    ],
  }));
  assert.equal(incomplete.status, 'provisional');
  const established = f.make().reconcile(reconcileInput(c, evidenceUnits, {
    coverage: [
      coverage('note', '2026-08-03T13:00:00.000Z'),
      coverage('chat', '2026-08-03T13:00:00.000Z'),
    ],
  }));
  assert.equal(established.status, 'established');
  assert.equal(f.registry.generation, 1);
  assert.equal(f.ledger.latestWatermarks().chat.state, 'fresh');
});

test('a later host attestation advances the same logical correction', () => {
  const attestor = contracts.createCorrectionAttestor({
    issuerId: 'owner-host', secret: 'upgrade-secret', allowedMethods: ['telegram-owner'], allowedSourceClasses: ['chat'],
  });
  const f = fixture({ attestor });
  const e = evidence('ev_correction_upgrade', '2026-08-03T10:00:00.000Z', 'chat');
  const c = candidate([e.evidenceId], { title: 'Working Name' });
  const base = {
    ...e,
    contract: contracts.CORRECTION_EVIDENCE_CONTRACT,
    target: { candidateId: c.candidateId, canonicalId: null, alias: null },
    operation: 'establish',
    assertedChange: { title: 'Confirmed Name', aliases: [], parentId: null, kind: 'project', canonicalId: null },
  };
  const supportOnly = contracts.createCorrectionEvidence({
    ...base,
    attestation: { method: 'conversation-text', admission: null },
  });
  assert.equal(f.make().reconcile(reconcileInput(c, [e], { correction: supportOnly })).status, 'provisional');

  const verified = attestor.attest({ ...base, attestation: { method: 'telegram-owner' } });
  assert.equal(verified.correctionId, supportOnly.correctionId);
  const result = f.make().reconcile(reconcileInput(c, [e], { correction: verified }));
  assert.equal(result.status, 'corrected');
  assert.equal(result.record.title, 'Confirmed Name');
  assert.equal(f.registry.generation, 1);
});

test('missing coverage cannot demote an established Project or write a second registry record', () => {
  const f = fixture();
  const initialEvidence = [
    evidence('ev_coverage_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_coverage_chat', '2026-08-03T09:00:00.000Z', 'chat'),
  ];
  const c = candidate(['ev_coverage_note', 'ev_coverage_chat']);
  const established = f.make().reconcile(reconcileInput(c, initialEvidence));
  assert.equal(established.status, 'established');
  const before = f.registry.generation;
  const unavailableEvidence = [
    evidence('ev_coverage_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_coverage_chat_unavailable', '2026-08-03T09:00:00.000Z', 'chat', { coverageState: 'unavailable', contentDigest: null }),
  ];
  const result = f.make().reconcile(reconcileInput(
    candidate(['ev_coverage_note', 'ev_coverage_chat_unavailable'], { title: c.title }),
    unavailableEvidence,
    { coverage: [coverage('note', '2026-08-03T12:00:00.000Z'), coverage('chat', '2026-08-03T12:00:00.000Z', 'unavailable')] },
  ));
  assert.equal(result.status, 'unchanged');
  assert.equal(f.registry.generation, before);
  assert.equal(f.registry.get(established.record.id).lifecycle, 'active');
});

test('ambiguous parentage quarantines and parentless established candidates become roots', () => {
  const f = fixture();
  const parentA = f.registry.create({ title: 'Parent A' });
  f.registry.create({ title: 'Parent B' }, { expectedGeneration: parentA.generation });
  const e = [evidence('ev_ambiguous_parent_1', '2026-08-01T09:00:00.000Z', 'note'), evidence('ev_ambiguous_parent_2', '2026-08-02T09:00:00.000Z', 'chat')];
  const c = candidate(e.map((item) => item.evidenceId), { parentAlternatives: [parentA.record.id, 'prj_000002'] });
  const result = f.make().reconcile(reconcileInput(c, e));
  assert.equal(result.status, 'quarantined');
  assert.equal(f.registry.list().length, 2);
  assert.equal(f.registry.get(parentA.record.id).parentId, null);
});

test('engine quarantine remains non-mutating even with otherwise qualifying evidence', () => {
  const f = fixture();
  const evidenceUnits = [
    evidence('ev_quarantine_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_quarantine_chat', '2026-08-02T09:00:00.000Z', 'chat'),
  ];
  const quarantined = candidate(evidenceUnits.map((item) => item.evidenceId), {
    disposition: 'quarantined',
    reasonCodes: ['ambiguous-identity', 'prompt-injection-data'],
  });
  const result = f.make().reconcile(reconcileInput(quarantined, evidenceUnits));
  assert.equal(result.status, 'quarantined');
  assert.equal(result.record, null);
  assert.equal(f.registry.generation, 0);
  assert.match(result.reasonCodes.join(','), /candidate-quarantined/);
});

test('rejection suppression prevents the same stale candidate from recreating a record', () => {
  const f = fixture();
  const e = [evidence('ev_rejected', '2026-08-01T09:00:00.000Z', 'note')];
  const c = candidate(['ev_rejected'], { disposition: 'rejected' });
  const first = f.make().reconcile(reconcileInput(c, e));
  assert.equal(first.status, 'rejected');
  const replay = f.make().reconcile(reconcileInput(c, e));
  assert.equal(replay.status, 'rejected');
  assert.equal(replay.replayed, true);
  assert.equal(f.registry.generation, 0);
});

test('restart and reordered replay return the prior result without duplicate registry writes', () => {
  const f = fixture();
  const e = [
    evidence('ev_replay_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_replay_chat', '2026-08-03T09:00:00.000Z', 'chat'),
  ];
  const c = candidate(e.map((item) => item.evidenceId));
  const first = f.make().reconcile(reconcileInput(c, e));
  const generation = f.registry.generation;
  const restarted = new ProjectInferenceReconciler({
    registry: new ProjectRegistry({ stateDir: f.registry.stateDir, now: f.registry.now }),
    ledger: ledgerModule.createFileInferenceLedger({ root: f.ledger.root }),
    now: f.registry.now,
  });
  const replay = restarted.reconcile(reconcileInput(candidate(e.map((item) => item.evidenceId).reverse(), { candidateId: c.candidateId }), [...e].reverse()));
  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, first.record.id);
  assert.equal(replay.registryGeneration, generation);
  assert.equal(restarted.registry.generation, generation);
  assert.equal(ledgerDecisions(f.ledger).length, 1);
});

test('restart recovers a registry commit that preceded the final decision append', () => {
  const f = fixture();
  const evidenceUnits = [
    evidence('ev_crash_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_crash_chat', '2026-08-03T09:00:00.000Z', 'chat'),
  ];
  const c = candidate(evidenceUnits.map((item) => item.evidenceId));
  const originalAppendDecision = f.ledger.appendDecision.bind(f.ledger);
  let failed = false;
  f.ledger.appendDecision = (decision) => {
    if (!failed) {
      failed = true;
      throw new Error('injected decision append failure');
    }
    return originalAppendDecision(decision);
  };
  assert.throws(() => f.make().reconcile(reconcileInput(c, evidenceUnits)), /injected decision append failure/);
  assert.equal(f.registry.generation, 1);
  assert.equal(f.registry.list().length, 1);

  const restartedLedger = ledgerModule.createFileInferenceLedger({ root: f.ledger.root });
  const restarted = new ProjectInferenceReconciler({
    registry: new ProjectRegistry({ stateDir: f.registry.stateDir, now: f.registry.now }),
    ledger: restartedLedger,
    now: f.registry.now,
  });
  const recovered = restarted.reconcile(reconcileInput(c, evidenceUnits));
  assert.equal(recovered.status, 'established');
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.record.inference.decisionId, recovered.decision.decisionId);
  assert.equal(restarted.registry.generation, 1);
  assert.equal(restarted.registry.list().length, 1);
  assert.equal(ledgerDecisions(restartedLedger).length, 1);
});

test('same candidate ID with a different digest conflicts before any registry mutation', () => {
  const f = fixture();
  const firstEvidence = [evidence('ev_conflict', '2026-08-01T09:00:00.000Z', 'note')];
  const c = candidate(['ev_conflict']);
  f.make().reconcile(reconcileInput(c, firstEvidence));
  const changed = [evidence('ev_conflict', '2026-08-01T09:00:00.000Z', 'note', { contentDigest: LATER_DIGEST })];
  assert.throws(() => f.make().reconcile(reconcileInput(c, changed)), /conflict|digest/i);
  assert.equal(f.registry.generation, 0);
});

test('stale registry CAS fails closed without creating a record', () => {
  const f = fixture();
  const e = [
    evidence('ev_stale_note', '2026-08-01T09:00:00.000Z', 'note'),
    evidence('ev_stale_chat', '2026-08-03T09:00:00.000Z', 'chat'),
  ];
  const c = candidate(e.map((item) => item.evidenceId));
  const result = f.make().reconcile(reconcileInput(c, e), { expectedRegistryGeneration: 42 });
  assert.equal(result.status, 'blocked');
  assert.match(result.reasonCodes.join(','), /stale-registry/);
  assert.equal(f.registry.generation, 0);

  const retry = f.make().reconcile(reconcileInput(c, e), { expectedRegistryGeneration: 0 });
  assert.equal(retry.status, 'established');
  assert.equal(retry.replayed, false);
  assert.equal(f.registry.generation, 1);
});
