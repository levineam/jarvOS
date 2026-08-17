'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  reconcileDecisions,
  migrateV1Attention,
  reconcileDecisionsWithMigration,
  listDecisions,
  explainDecision,
  resolveDecision,
  claimDelivery,
  acknowledgeDelivery,
} = require('../src/decision-store');

function skill(overrides = {}) {
  return {
    logicalId: 'newsletter-generator',
    treeDigest: 'a'.repeat(64),
    attention: 'actionable',
    disposition: { kind: 'needs_input', reasonCode: 'needs_owner_input' },
    ...overrides,
  };
}

function owner() { return { kind: 'owner', capabilities: ['skills.decisions.read', 'skills.decisions.resolve'] }; }

test('decision lifecycle dedupes unchanged observations, rejects stale replies, and mutates only on a valid resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const first = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z', generationId: 'g1' });
    assert.equal(first.created.length, 1);
    assert.equal(first.pending.length, 1);
    const decision = first.pending[0];
    assert.deepEqual(decision.options, ['share', 'keep-local', 'exclude', 'details']);
    assert.equal(reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:01:00.000Z', generationId: 'g2' }).created.length, 0);
    assert.equal(listDecisions({ statePath, principal: owner() }).decisions[0].skill, 'newsletter-generator');
    assert.throws(() => listDecisions({ statePath, principal: null }), /owner authorization/);

    let mutations = 0;
    const stale = resolveDecision({ statePath, principal: owner(), decisionId: decision.id, revision: decision.revision, option: 'share', currentSkill: skill({ treeDigest: 'b'.repeat(64) }), mutate: () => { mutations += 1; } });
    assert.equal(stale.status, 'stale');
    assert.equal(mutations, 0);

    const resolved = resolveDecision({ statePath, principal: owner(), decisionId: decision.id, revision: decision.revision, option: 'keep-local', currentSkill: skill(), mutate: () => { mutations += 1; } });
    assert.equal(resolved.status, 'resolved');
    assert.equal(mutations, 1);
    assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: decision.id, revision: decision.revision, option: 'keep-local', currentSkill: skill(), mutate: () => { mutations += 1; } }).status, 'already_resolved');
    assert.equal(mutations, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('delivery outbox is write-ahead, bounded through fallback, and rejects forged acknowledgements', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-delivery-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z' }).pending[0];
    const initial = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-16T16:00:01.000Z' });
    assert.equal(initial.kind, 'initial');
    assert.throws(() => acknowledgeDelivery({ statePath, principal: { kind: 'runtime', capabilities: [] }, decisionId: decision.id, revision: 1, attemptId: initial.attemptId, outcome: 'accepted', providerMessageId: 'p1' }), /delivery authorization/);
    acknowledgeDelivery({ statePath, principal: { kind: 'selected-runtime', capabilities: ['skills.delivery.ack'] }, decisionId: decision.id, revision: 1, attemptId: initial.attemptId, outcome: 'ambiguous' });
    assert.equal(claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-16T17:00:00.000Z' }), null);
    const fallback = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-17T16:00:02.000Z' });
    assert.equal(fallback.kind, 'fallback');
    const stalled = acknowledgeDelivery({ statePath, principal: { kind: 'selected-runtime', capabilities: ['skills.delivery.ack'] }, decisionId: decision.id, revision: 1, attemptId: fallback.attemptId, outcome: 'ambiguous' });
    assert.equal(stalled.deliveryStatus, 'delivery_stalled');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a rejected prompt waits for the cooldown, retries once, then stalls safely', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-rejected-delivery-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z' }).pending[0];
    const initial = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-16T16:00:00.000Z' });
    const principal = { kind: 'selected-runtime', capabilities: ['skills.delivery.ack'] };
    const rejected = acknowledgeDelivery({ statePath, principal, decisionId: decision.id, revision: 1, attemptId: initial.attemptId, outcome: 'rejected' });
    assert.equal(rejected.deliveryStatus, 'pending');
    assert.equal(claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-16T17:00:00.000Z' }), null);
    const fallback = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-17T16:00:01.000Z' });
    assert.equal(fallback.kind, 'fallback');
    const stalled = acknowledgeDelivery({ statePath, principal, decisionId: decision.id, revision: 1, attemptId: fallback.attemptId, outcome: 'rejected' });
    assert.equal(stalled.deliveryStatus, 'delivery_stalled');
    assert.equal(claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-18T16:00:01.000Z' }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an abandoned claimed prompt becomes one bounded fallback instead of remaining claimed forever', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-abandoned-delivery-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z' }).pending[0];
    const initial = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-16T16:00:00.000Z' });
    const fallback = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-17T16:00:01.000Z' });
    assert.equal(fallback.kind, 'fallback');
    assert.equal(initial.decisionReference, decision.decisionReference);
    const later = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-18T16:00:02.000Z' });
    assert.equal(later, null);
    const persisted = listDecisions({ statePath, principal: owner() }).decisions;
    assert.equal(persisted[0].deliveryStatus, 'delivery_stalled');
    assert.throws(() => acknowledgeDelivery({
      statePath,
      principal: { kind: 'selected-runtime', capabilities: ['skills.delivery.ack'] },
      decisionId: decision.id,
      revision: decision.revision,
      attemptId: fallback.attemptId,
      outcome: 'accepted',
    }), /delivery acknowledgement is stale/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('semantic source changes supersede rather than duplicate a pending decision, and details stays non-mutating', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-supersede-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const first = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z' }).pending[0];
    const next = reconcileDecisions({ statePath, skills: [skill({ treeDigest: 'c'.repeat(64) })], observedAt: '2026-08-16T16:01:00.000Z' });
    assert.equal(next.created.length, 1);
    assert.notEqual(next.pending[0].id, first.id);
    let mutations = 0;
    const result = resolveDecision({ statePath, principal: owner(), decisionId: next.pending[0].id, revision: 1, option: 'details', currentSkill: skill({ treeDigest: 'c'.repeat(64) }), mutate: () => { mutations += 1; } });
    assert.equal(result.status, 'pending');
    assert.equal(mutations, 0);
    assert.throws(() => resolveDecision({ statePath, principal: { kind: 'owner', capabilities: ['skills.decisions.read'] }, decisionId: next.pending[0].id, revision: 1, option: 'share', currentSkill: skill({ treeDigest: 'c'.repeat(64) }), mutate: () => {} }), /owner authorization/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a resolved semantic decision stays resolved on replay while a changed digest creates a new decision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-resolved-replay-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z' }).pending[0];
    assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: decision.id, revision: 1, option: 'keep-local', currentSkill: skill(), mutate: () => {} }).status, 'resolved');
    const replay = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:01:00.000Z', generationId: 'later' });
    assert.equal(replay.created.length, 0);
    assert.equal(replay.pending.length, 0);
    const changed = reconcileDecisions({ statePath, skills: [skill({ treeDigest: 'd'.repeat(64) })], observedAt: '2026-08-16T16:02:00.000Z' });
    assert.equal(changed.created.length, 1);
    assert.equal(changed.pending[0].skill, 'newsletter-generator');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('v1 attention migration only carries still-actionable holds and is idempotent on replay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-v1-migration-'));
  const statePath = path.join(root, 'decisions.json');
  const attentionPath = path.join(root, 'attention.json');
  try {
    fs.writeFileSync(attentionPath, JSON.stringify({
      schemaVersion: 'jarvos.skill-attention/v1',
      active: [
        { logicalId: 'newsletter-generator', reasonCode: 'needs_owner_input', fingerprint: 'a'.repeat(64) },
        { logicalId: 'gone-skill', reasonCode: 'needs_owner_input', fingerprint: 'b'.repeat(64) },
      ],
    }), { mode: 0o600 });
    const migrated = migrateV1Attention({ statePath, attentionPath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z', generationId: 'g1' });
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.summary.migratedCount, 1);
    assert.equal(migrated.summary.pendingCount, 1);
    assert.match(migrated.summary.reference, /^batch-[a-f0-9]{24}$/);
    assert.doesNotMatch(JSON.stringify(migrated.summary), /newsletter-generator|needs_owner_input|attention\.json/);
    const replay = migrateV1Attention({ statePath, attentionPath, skills: [skill()], observedAt: '2026-08-16T16:01:00.000Z', generationId: 'g2' });
    assert.equal(replay.replay, true);
    assert.equal(replay.migrated, false);
    assert.equal(reconcileDecisions({ statePath, skills: [skill()] }).created.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('combined migration and reconciliation preserves one-pass decision results', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-combined-'));
  const statePath = path.join(root, 'decisions.json');
  const attentionPath = path.join(root, 'attention.json');
  try {
    fs.writeFileSync(attentionPath, JSON.stringify({
      schemaVersion: 'jarvos.skill-attention/v1',
      active: [{ logicalId: 'newsletter-generator', reasonCode: 'needs_owner_input' }],
    }), { mode: 0o600 });
    const first = reconcileDecisionsWithMigration({
      statePath,
      attentionPath,
      skills: [skill()],
      observedAt: '2026-08-16T16:00:00.000Z',
      generationId: 'g1',
    });
    assert.equal(first.migration.migrated, true);
    assert.equal(first.migration.summary.migratedCount, 1);
    assert.equal(first.created.length, 0);
    assert.equal(first.pending.length, 1);

    const replay = reconcileDecisionsWithMigration({
      statePath,
      attentionPath,
      skills: [skill()],
      observedAt: '2026-08-16T16:01:00.000Z',
      generationId: 'g2',
    });
    assert.equal(replay.migration.replay, true);
    assert.equal(replay.created.length, 0);
    assert.equal(replay.pending.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('opaque decision references resolve owner actions without exposing or trusting an internal id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-reference-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()] }).pending[0];
    assert.match(decision.decisionReference, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(explainDecision({ statePath, principal: owner(), decisionReference: decision.decisionReference }).decision.id, decision.id);
    assert.deepEqual(explainDecision({ statePath, principal: owner(), decisionReference: 'not-a-reference' }), { found: false });
    assert.equal(resolveDecision({
      statePath, principal: owner(), decisionReference: decision.decisionReference, revision: 99, option: 'keep-local', currentSkill: skill(), mutate: () => {},
    }).status, 'stale');
    assert.equal(resolveDecision({
      statePath, principal: owner(), decisionReference: 'not-a-reference', revision: 1, option: 'keep-local', currentSkill: skill(), mutate: () => {},
    }).status, 'not_found');
    const result = resolveDecision({
      statePath, principal: owner(), decisionReference: decision.decisionReference, revision: 1, option: 'keep-local', currentSkill: skill(), mutate: () => {},
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.receipt.decisionReference, decision.decisionReference);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
