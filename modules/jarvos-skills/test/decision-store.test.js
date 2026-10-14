'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
  claimReminder,
  claimReminders,
  acknowledgeDecision,
  deferDecision,
  resumeDecision,
  approvedShareMap,
  withFileLease,
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
    // An abandoned attempt was never acknowledged, so matching its recorded
    // outcome is not a replay either.
    assert.throws(() => acknowledgeDelivery({
      statePath,
      principal: { kind: 'selected-runtime', capabilities: ['skills.delivery.ack'] },
      decisionId: decision.id,
      revision: decision.revision,
      attemptId: fallback.attemptId,
      outcome: 'ambiguous',
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

test('each distinct occurrence claims one reminder, a repeated occurrence claims none, and stalled delivery does not stop reminders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-reminder-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z' }).pending[0];
    const principal = { kind: 'selected-runtime', capabilities: ['skills.delivery.ack'] };
    const initial = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-16T16:00:00.000Z' });
    acknowledgeDelivery({ statePath, principal, decisionId: decision.id, revision: 1, attemptId: initial.attemptId, outcome: 'rejected' });
    const fallback = claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-17T16:00:01.000Z' });
    assert.equal(acknowledgeDelivery({ statePath, principal, decisionId: decision.id, revision: 1, attemptId: fallback.attemptId, outcome: 'rejected' }).deliveryStatus, 'delivery_stalled');

    const occurrences = ['hour-2026-08-17T17', 'hour-2026-08-17T18', 'hour-2026-08-17T19'];
    const claims = occurrences.map((occurrenceKey) => claimReminder({ statePath, decisionId: decision.id, occurrenceKey, now: '2026-08-17T19:00:00.000Z' }));
    assert.deepEqual(claims.map((claim) => claim?.sequence), [1, 2, 3]);
    assert.equal(claims[0].decisionReference, decision.decisionReference);
    assert.equal(claimReminder({ statePath, decisionId: decision.id, occurrenceKey: occurrences[2], now: '2026-08-17T19:30:00.000Z' }), null);
    // Reminders never consume the bounded delivery attempts.
    assert.equal(claimDelivery({ statePath, decisionId: decision.id, now: '2026-08-18T16:00:00.000Z' }), null);
    const persisted = listDecisions({ statePath, principal: owner() }).decisions[0];
    assert.equal(persisted.status, 'pending');
    assert.equal(persisted.deliveryStatus, 'delivery_stalled');
    assert.deepEqual(persisted.reminder, { status: 'active' });
    assert.throws(() => claimReminder({ statePath, decisionId: decision.id, occurrenceKey: '../etc' }), /occurrence is invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolution and disappearance stop future reminders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-reminder-stop-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const pending = reconcileDecisions({ statePath, skills: [skill(), skill({ logicalId: 'gone-skill' })] }).pending;
    const kept = pending.find((item) => item.skill === 'newsletter-generator');
    const gone = pending.find((item) => item.skill === 'gone-skill');
    assert.ok(claimReminder({ statePath, decisionId: kept.id, occurrenceKey: 'hour-1' }));
    assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: kept.id, revision: 1, option: 'keep-local', currentSkill: skill(), mutate: () => {} }).status, 'resolved');
    assert.equal(claimReminder({ statePath, decisionId: kept.id, occurrenceKey: 'hour-2' }), null);
    reconcileDecisions({ statePath, skills: [] });
    assert.equal(claimReminder({ statePath, decisionId: gone.id, occurrenceKey: 'hour-2' }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('acknowledge and defer pause reminders without resolving, resume restores them, and silence or bad input changes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-reminder-pause-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()] }).pending[0];
    const claim = (occurrenceKey, now = '2026-08-16T16:00:00.000Z') => claimReminder({ statePath, decisionId: decision.id, occurrenceKey, now });
    assert.ok(claim('hour-a'));
    assert.ok(claim('hour-b'), 'silence never pauses reminders');

    assert.throws(() => acknowledgeDecision({ statePath, principal: { kind: 'owner', capabilities: ['skills.decisions.read'] }, decisionId: decision.id }), /owner authorization/);
    assert.throws(() => deferDecision({ statePath, principal: null, decisionId: decision.id, until: '2999-01-01T00:00:00.000Z' }), /owner authorization/);
    assert.throws(() => resumeDecision({ statePath, principal: { kind: 'runtime', capabilities: ['skills.decisions.resolve'] }, decisionId: decision.id }), /owner authorization/);
    assert.ok(claim('hour-c'), 'a refused pause changes nothing');

    const acknowledged = acknowledgeDecision({ statePath, principal: owner(), decisionReference: decision.decisionReference });
    assert.equal(acknowledged.status, 'updated');
    assert.equal(acknowledged.decision.status, 'pending');
    assert.deepEqual(acknowledged.decision.reminder, { status: 'acknowledged' });
    assert.equal(acknowledgeDecision({ statePath, principal: owner(), decisionId: decision.id }).status, 'unchanged');
    assert.equal(claim('hour-d'), null);
    assert.equal(listDecisions({ statePath, principal: owner() }).decisions.length, 1);

    for (const until of ['tomorrow', '2026-08-16T15:00:00.000Z', '2026-08-16T16:00:00.000Z', '2026-08-16 20:00', undefined]) {
      assert.equal(deferDecision({ statePath, principal: owner(), decisionId: decision.id, until, now: '2026-08-16T16:00:00.000Z' }).status, 'invalid_until');
    }
    assert.deepEqual(listDecisions({ statePath, principal: owner() }).decisions[0].reminder, { status: 'acknowledged' });
    const deferred = deferDecision({ statePath, principal: owner(), decisionId: decision.id, until: '2026-08-16T20:00:00.000Z', now: '2026-08-16T16:00:00.000Z' });
    assert.equal(deferred.status, 'updated');
    assert.deepEqual(deferred.decision.reminder, { status: 'deferred', until: '2026-08-16T20:00:00.000Z' });
    assert.equal(deferDecision({ statePath, principal: owner(), decisionId: decision.id, until: '2026-08-16T20:00:00.000Z', now: '2026-08-16T16:00:00.000Z' }).status, 'unchanged');
    assert.equal(claim('hour-e', '2026-08-16T19:00:00.000Z'), null);
    assert.ok(claim('hour-f', '2026-08-16T20:00:00.000Z'), 'an expired deferral resumes by itself');

    acknowledgeDecision({ statePath, principal: owner(), decisionId: decision.id });
    const resumed = resumeDecision({ statePath, principal: owner(), decisionId: decision.id });
    assert.equal(resumed.status, 'updated');
    assert.deepEqual(resumed.decision.reminder, { status: 'active' });
    assert.equal(resumeDecision({ statePath, principal: owner(), decisionId: decision.id }).status, 'unchanged');
    assert.ok(claim('hour-g'));
    assert.equal(claim('hour-g'), null);
    assert.equal(acknowledgeDecision({ statePath, principal: owner(), decisionReference: 'not-a-reference' }).status, 'not_found');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an accepted absent source becomes a named decision with safe options and redacted owner facts, while a quiet absent source and incomplete observation stay out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-facts-'));
  const statePath = path.join(root, 'decisions.json');
  const matrix = (present = []) => ['claude', 'codex', 'hermes', 'openclaw'].map((harness) => ({
    harness,
    projection: present.includes(harness) ? 'source_present' : 'missing',
    verification: present.includes(harness) ? 'verification_pending' : 'unverifiable',
  }));
  try {
    const result = reconcileDecisions({
      statePath,
      skills: [
        skill({ logicalId: 'accepted-absent', disposition: { kind: 'needs_input', reasonCode: 'source_absent' }, matrix: matrix() }),
        skill({ logicalId: 'use-anthropic', attention: 'quiet', disposition: { kind: 'needs_input', reasonCode: 'source_absent' }, matrix: matrix() }),
        skill({ logicalId: 'still-scanning', attention: 'quiet', disposition: { kind: 'needs_input', reasonCode: 'incomplete_observation' }, matrix: matrix(['codex']) }),
        skill({ logicalId: 'held-skill', matrix: matrix(['codex']), observations: [{ absolutePath: '/Users/andrew/private/held-skill' }] }),
      ],
    });
    assert.deepEqual(result.pending.map((item) => item.skill).sort(), ['accepted-absent', 'held-skill']);
    const absent = result.pending.find((item) => item.skill === 'accepted-absent');
    assert.deepEqual(absent.options, ['keep-local', 'exclude', 'details']);
    assert.deepEqual(absent.affectedHarnesses, ['claude', 'codex', 'hermes', 'openclaw']);
    assert.equal(absent.preservedState, 'shared-copies-kept');
    const held = result.pending.find((item) => item.skill === 'held-skill');
    assert.deepEqual(held.affectedHarnesses, ['claude', 'hermes', 'openclaw']);
    assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), /\/Users\/andrew|absolutePath|matrix|verification/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a quiet absent source is never an owner decision, and a pending one recorded for it retires quietly', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-quiet-absent-'));
  const statePath = path.join(root, 'decisions.json');
  const quiet = skill({ logicalId: 'use-anthropic', attention: 'quiet', disposition: { kind: 'needs_input', reasonCode: 'source_absent' } });
  try {
    assert.deepEqual(reconcileDecisions({ statePath, skills: [quiet] }), { created: [], pending: [] });
    assert.equal(fs.existsSync(statePath), false);
    // A decision an earlier build recorded for the same quiet source is
    // retired rather than reminded.
    const decisionId = 'decision-0123456789abcdef01234567';
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 'jarvos.skill-owner-decisions/v2',
      decisions: [{
        id: decisionId, semanticKey: 'c'.repeat(64), skill: 'use-anthropic', treeDigest: 'a'.repeat(64),
        decisionReference: 'QuietReference0123456789', reason: 'source_absent', options: ['keep-local', 'exclude', 'details'],
        revision: 1, status: 'pending', deliveryStatus: 'pending', attempts: [],
        createdAt: '2026-08-16T16:00:00.000Z', updatedAt: '2026-08-16T16:00:00.000Z',
      }],
    }), { mode: 0o600 });
    const later = reconcileDecisions({ statePath, skills: [quiet] });
    assert.deepEqual(later, { created: [], pending: [] });
    assert.equal(explainDecision({ statePath, principal: owner(), decisionId }).decision.status, 'disappeared');
    assert.equal(claimReminder({ statePath, decisionId, occurrenceKey: 'hour-1' }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('v2 decisions written before reminders existed load as active and remain claimable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-legacy-v2-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 'jarvos.skill-owner-decisions/v2',
      decisions: [{
        id: 'decision-0123456789abcdef01234567', semanticKey: 'b'.repeat(64), skill: 'newsletter-generator', treeDigest: 'a'.repeat(64),
        decisionReference: 'LegacyReference0123456789', reason: 'needs_owner_input', options: ['share', 'keep-local', 'exclude', 'details'],
        revision: 1, status: 'pending', deliveryStatus: 'delivery_stalled', attempts: [],
        createdAt: '2026-08-16T16:00:00.000Z', updatedAt: '2026-08-16T16:00:00.000Z',
      }],
    }), { mode: 0o600 });
    const listed = listDecisions({ statePath, principal: owner() }).decisions[0];
    assert.deepEqual(listed.reminder, { status: 'active' });
    assert.deepEqual(listed.affectedHarnesses, []);
    assert.equal(listed.preservedState, 'unchanged');
    assert.ok(claimReminder({ statePath, decisionId: listed.id, occurrenceKey: 'hour-2026-08-16T17' }));
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

test('a returning semantic condition gets its own id, so id lookups never land on the retired record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-recurrence-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const first = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:00:00.000Z' }).pending[0];
    reconcileDecisions({ statePath, skills: [], observedAt: '2026-08-16T16:01:00.000Z' });
    const returned = reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:02:00.000Z' });
    assert.equal(returned.created.length, 1);
    const again = returned.created[0];
    assert.notEqual(again.id, first.id);
    assert.match(again.id, /^decision-[a-f0-9]{24}$/);
    assert.notEqual(again.decisionReference, first.decisionReference);
    // Semantic dedupe still holds for the live recurrence.
    assert.equal(reconcileDecisions({ statePath, skills: [skill()], observedAt: '2026-08-16T16:03:00.000Z' }).created.length, 0);
    assert.equal(explainDecision({ statePath, principal: owner(), decisionId: first.id }).decision.status, 'disappeared');
    assert.equal(explainDecision({ statePath, principal: owner(), decisionId: again.id }).decision.status, 'pending');
    assert.ok(claimReminder({ statePath, decisionId: again.id, occurrenceKey: 'hour-1' }));
    assert.equal(claimDelivery({ statePath, decisionId: again.id, now: '2026-08-16T16:04:00.000Z' }).kind, 'initial');
    assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: again.id, revision: 1, option: 'keep-local', currentSkill: skill(), mutate: () => {} }).status, 'resolved');
    const ids = JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a legacy ledger that already repeats an id resolves that id to the live recurrence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-legacy-duplicate-'));
  const statePath = path.join(root, 'decisions.json');
  const record = (status, decisionReference) => ({
    id: 'decision-0123456789abcdef01234567', semanticKey: 'b'.repeat(64), skill: 'newsletter-generator', treeDigest: 'a'.repeat(64),
    decisionReference, reason: 'needs_owner_input', options: ['share', 'keep-local', 'exclude', 'details'],
    revision: 1, status, deliveryStatus: 'pending', attempts: [],
    createdAt: '2026-08-16T16:00:00.000Z', updatedAt: '2026-08-16T16:00:00.000Z',
  });
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 'jarvos.skill-owner-decisions/v2',
      decisions: [record('disappeared', 'RetiredReference012345678'), record('pending', 'LiveReference0123456789ab')],
    }), { mode: 0o600 });
    const explained = explainDecision({ statePath, principal: owner(), decisionId: 'decision-0123456789abcdef01234567' }).decision;
    assert.equal(explained.status, 'pending');
    assert.equal(explained.decisionReference, 'LiveReference0123456789ab');
    const claim = claimReminder({ statePath, decisionId: explained.id, occurrenceKey: 'hour-1' });
    assert.equal(claim.decisionReference, 'LiveReference0123456789ab');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a competing process cannot lose a completed ledger transition while another mutation is in flight', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-race-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()] }).pending[0];
    const store = require.resolve('../src/decision-store');
    let competitor = null;
    // The owner resolution has loaded the ledger and is between its checks and
    // its save; a second process tries a reminder claim at exactly that point.
    const resolved = resolveDecision({
      statePath, principal: owner(), decisionId: decision.id, revision: 1, option: 'keep-local', currentSkill: skill(),
      mutate: () => {
        const script = `
          const { claimReminder } = require(${JSON.stringify(store)});
          let outcome;
          try { outcome = { claim: claimReminder({ statePath: ${JSON.stringify(statePath)}, decisionId: ${JSON.stringify(decision.id)}, occurrenceKey: 'hour-race', leaseWaitMs: 200 }) }; }
          catch (error) { outcome = { error: error.message }; }
          process.stdout.write(JSON.stringify(outcome));
        `;
        competitor = JSON.parse(spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' }).stdout);
      },
    });
    assert.equal(resolved.status, 'resolved');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions[0];
    assert.equal(persisted.status, 'resolved');
    // A claim the competitor reported as done must be durable; here it is
    // refused while the lease is held, so nothing was claimed and then lost.
    if (competitor.claim) assert.deepEqual(persisted.reminder?.occurrences, ['hour-race']);
    assert.equal(competitor.claim, undefined);
    assert.match(competitor.error, /decision state is busy/);
    assert.equal(fs.existsSync(`${statePath}.lock`), false);
    // Retrying after the lease is released sees the completed resolution.
    assert.equal(claimReminder({ statePath, decisionId: decision.id, occurrenceKey: 'hour-race' }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a nested ledger mutation in the same process fails fast instead of deadlocking or overwriting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-nested-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()] }).pending[0];
    const resolved = resolveDecision({
      statePath, principal: owner(), decisionId: decision.id, revision: 1, option: 'keep-local', currentSkill: skill(),
      mutate: () => {
        assert.throws(() => claimReminder({ statePath, decisionId: decision.id, occurrenceKey: 'hour-nested' }), /decision state is busy/);
        // Reads stay available while the mutation is in flight.
        assert.equal(listDecisions({ statePath, principal: owner() }).decisions.length, 1);
      },
    });
    assert.equal(resolved.status, 'resolved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the ledger lease recovers a dead holder, waits out a live one, and never blocks reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-lease-'));
  const statePath = path.join(root, 'decisions.json');
  const lease = `${statePath}.lock`;
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()] }).pending[0];
    fs.writeFileSync(lease, JSON.stringify({ pid: 999999, operation: 'decision-ledger', startedAt: '2000-01-01T00:00:00.000Z' }), { mode: 0o600 });
    assert.ok(claimReminder({ statePath, decisionId: decision.id, occurrenceKey: 'hour-1' }));
    assert.equal(fs.existsSync(lease), false);

    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, operation: 'decision-ledger', startedAt: new Date().toISOString() }), { mode: 0o600 });
    const before = fs.readFileSync(statePath, 'utf8');
    assert.throws(() => acknowledgeDecision({ statePath, principal: owner(), decisionId: decision.id, leaseWaitMs: 50 }), /decision state is busy/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    assert.deepEqual(listDecisions({ statePath, principal: owner() }).decisions[0].reminder, { status: 'active' });
    fs.unlinkSync(lease);
    assert.equal(acknowledgeDecision({ statePath, principal: owner(), decisionId: decision.id }).status, 'updated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('actionable blocked holds become share-free owner decisions while shareable blocked reasons and quiet holds stay out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-blocked-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const colliding = skill({ logicalId: 'colliding-skill', disposition: { kind: 'blocked', reasonCode: 'ambiguous_identity' } });
    const result = reconcileDecisions({
      statePath,
      skills: [
        colliding,
        skill({ logicalId: 'unsafe-skill', disposition: { kind: 'blocked', reasonCode: 'unsafe_source' } }),
        skill({ logicalId: 'private-skill', disposition: { kind: 'blocked', reasonCode: 'privacy_restricted' } }),
        skill({ logicalId: 'blocked-owner-input', disposition: { kind: 'blocked', reasonCode: 'needs_owner_input' } }),
        skill({ logicalId: 'excluded-skill', attention: 'quiet', disposition: { kind: 'blocked', reasonCode: 'owner_excluded' } }),
        skill({ logicalId: 'quiet-collision', attention: 'quiet', disposition: { kind: 'blocked', reasonCode: 'ambiguous_identity' } }),
        skill({ logicalId: 'still-scanning', attention: 'quiet', disposition: { kind: 'needs_input', reasonCode: 'incomplete_observation' } }),
      ],
    });
    assert.deepEqual(result.pending.map((item) => item.skill).sort(), ['colliding-skill', 'private-skill', 'unsafe-skill']);
    assert.ok(result.pending.every((item) => !item.options.includes('share')));
    const decision = result.pending.find((item) => item.skill === 'colliding-skill');
    assert.equal(decision.reason, 'ambiguous_identity');
    assert.deepEqual(decision.options, ['keep-local', 'exclude', 'details']);
    assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: decision.id, revision: 1, option: 'share', currentSkill: colliding, mutate: () => {} }).status, 'invalid_option');
    let mutated = null;
    assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: decision.id, revision: 1, option: 'keep-local', currentSkill: colliding, mutate: (input) => { mutated = input.option; } }).status, 'resolved');
    assert.equal(mutated, 'keep-local');
    assert.equal(approvedShareMap({ statePath }).has('colliding-skill'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an exact delivery acknowledgement replay is idempotent, while any mismatch stays stale', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-ack-replay-'));
  const statePath = path.join(root, 'decisions.json');
  const principal = { kind: 'selected-runtime', capabilities: ['skills.delivery.ack'] };
  const ledger = () => fs.readFileSync(statePath, 'utf8');
  try {
    const pending = reconcileDecisions({ statePath, skills: [skill(), skill({ logicalId: 'other-skill' })], observedAt: '2026-08-16T16:00:00.000Z' }).pending;
    const sent = pending.find((item) => item.skill === 'newsletter-generator');
    const refused = pending.find((item) => item.skill === 'other-skill');

    // The public acknowledgement landed, then the sender stopped before its
    // private receipt; its exact replay returns the current decision unchanged.
    const first = claimDelivery({ statePath, decisionId: sent.id, now: '2026-08-16T16:00:01.000Z' });
    const accept = (overrides = {}) => acknowledgeDelivery({
      statePath, principal, decisionId: sent.id, revision: 1, attemptId: first.attemptId, outcome: 'accepted', providerMessageId: 'provider-1', ...overrides,
    });
    assert.equal(accept().deliveryStatus, 'delivered');
    const afterAccepted = ledger();
    const replay = accept();
    assert.equal(replay.id, sent.id);
    assert.equal(replay.deliveryStatus, 'delivered');
    assert.equal(ledger(), afterAccepted);
    for (const mismatch of [
      { outcome: 'rejected' }, { outcome: 'ambiguous' }, { providerMessageId: 'provider-2' }, { providerMessageId: undefined },
      { revision: 2 }, { attemptId: 'attempt-unknown' }, { decisionId: refused.id },
    ]) {
      assert.throws(() => accept(mismatch), /delivery acknowledgement is stale/, JSON.stringify(mismatch));
    }
    assert.equal(ledger(), afterAccepted);

    const second = claimDelivery({ statePath, decisionId: refused.id, now: '2026-08-16T16:00:02.000Z' });
    const reject = (overrides = {}) => acknowledgeDelivery({
      statePath, principal, decisionId: refused.id, revision: 1, attemptId: second.attemptId, outcome: 'rejected', ...overrides,
    });
    assert.equal(reject().deliveryStatus, 'pending');
    const afterRejected = ledger();
    assert.equal(reject().deliveryStatus, 'pending');
    assert.equal(ledger(), afterRejected);
    for (const mismatch of [{ outcome: 'accepted' }, { providerMessageId: 'provider-3' }, { attemptId: first.attemptId }]) {
      assert.throws(() => reject(mismatch), /delivery acknowledgement is stale/, JSON.stringify(mismatch));
    }
    assert.equal(ledger(), afterRejected);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a bounded reminder batch is claimed once per occurrence and the next occurrence leads with the decisions left out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-reminder-batch-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const skills = ['alpha-skill', 'bravo-skill', 'charlie-skill'].map((logicalId) => skill({ logicalId }));
    const pendingIds = () => reconcileDecisions({ statePath, skills }).pending.map((item) => item.id);
    const [alpha, bravo, charlie] = pendingIds();
    const batch = (occurrenceKey, now) => claimReminders({ statePath, decisionIds: pendingIds(), occurrenceKey, now, limit: 2 })
      .map((claim) => claim.decisionId);
    assert.deepEqual(batch('hour-1', '2026-08-16T16:00:00.000Z'), [alpha, bravo]);
    assert.deepEqual(batch('hour-1', '2026-08-16T16:30:00.000Z'), [], 'a retried occurrence claims nothing, not even a decision left out');
    assert.deepEqual(batch('hour-2', '2026-08-16T17:00:00.000Z'), [charlie, alpha]);
    assert.throws(() => claimReminders({ statePath, decisionIds: [alpha], occurrenceKey: '../etc' }), /occurrence is invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a lock gate left by an interrupted process fails closed until an operator clears it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-lease-gate-'));
  const lease = path.join(root, 'decisions.json.lock');
  const gate = `${lease}.gate`;
  try {
    fs.writeFileSync(lease, JSON.stringify({ pid: 999999, operation: 'decision-ledger', startedAt: '2000-01-01T00:00:00.000Z' }), { mode: 0o600 });
    fs.mkdirSync(gate);
    let entered = false;
    assert.throws(
      () => withFileLease(lease, { busyMessage: 'decision state is busy', waitMs: 200, gateWaitMs: 30 }, () => { entered = true; }),
      (error) => error.code === 'ELEASEGATE' && /decision state is busy/.test(error.message)
        && /manual recovery/.test(error.message) && !error.message.includes(root),
    );
    assert.equal(entered, false);
    assert.ok(fs.existsSync(gate), 'the gate is never removed automatically');
    assert.ok(fs.existsSync(lease), 'a dead holder is not reclaimed without the gate');
    fs.rmdirSync(gate);
    assert.equal(withFileLease(lease, { gateWaitMs: 30 }, () => 'entered'), 'entered');
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A separate module instance has its own process-local lease table, so it
// acts like another process sharing the same filesystem.
function freshStore() {
  const id = require.resolve('../src/decision-store');
  const cached = require.cache[id];
  delete require.cache[id];
  try { return require(id); } finally { require.cache[id] = cached; }
}

test('the reviewed A/B/C stale-lease interleaving never admits two holders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-lease-race-'));
  const lease = path.join(root, 'decisions.json.lock');
  const actors = { A: freshStore(), B: freshStore(), C: freshStore() };
  const options = { operation: 'decision-ledger', busyMessage: 'decision state is busy', waitMs: 0, gateWaitMs: 50 };
  const original = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync };
  const outcomes = {}; const entered = [];
  let active = 0; let peak = 0; let armed = true;
  const run = (name, inner = () => {}) => {
    try {
      actors[name].withFileLease(lease, options, () => {
        active += 1; peak = Math.max(peak, active); entered.push(name);
        try { inner(); } finally { active -= 1; }
      });
      outcomes[name] = 'held';
    } catch (error) { outcomes[name] = error.message; }
  };
  // A has judged the dead holder's lease stale. At A's first change to the
  // lease name, B reclaims and takes the lease; A's change then lands on B's
  // live lease, and C races for the name while B still holds it.
  const intercept = (method) => function interleave(target, ...rest) {
    if (!armed || path.resolve(String(target)) !== lease) return original[method].call(fs, target, ...rest);
    armed = false;
    let landed = false;
    run('B', () => {
      original[method].call(fs, target, ...rest);
      landed = true;
      run('C');
    });
    return landed ? undefined : original[method].call(fs, target, ...rest);
  };
  try {
    fs.writeFileSync(lease, JSON.stringify({ pid: 999999, operation: 'decision-ledger', startedAt: '2000-01-01T00:00:00.000Z' }), { mode: 0o600 });
    fs.renameSync = intercept('renameSync');
    fs.unlinkSync = intercept('unlinkSync');
    try { run('A'); } finally { Object.assign(fs, original); }
    assert.equal(armed, false, 'A reached its reclamation step');
    assert.equal(peak, 1, `two holders entered together: ${JSON.stringify(outcomes)}`);
    assert.deepEqual(entered, ['A']);
    assert.equal(outcomes.A, 'held');
    assert.match(outcomes.B, /decision state is busy/);
    assert.equal(outcomes.C, undefined);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    Object.assign(fs, original);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each actionable unsafe, private, or under-trusted source becomes a share-free decision with redacted facts, while quiet ones stay out', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-restricted-'));
  const statePath = path.join(root, 'decisions.json');
  const matrix = ['claude', 'codex', 'hermes', 'openclaw'].map((harness) => ({
    harness, projection: harness === 'codex' ? 'source_present' : 'missing', verification: 'unverifiable',
  }));
  const reasons = ['privacy_restricted', 'trust_class_insufficient', 'unsafe_source'];
  const actionable = reasons.map((reasonCode) => skill({
    logicalId: reasonCode.replace(/_/g, '-'), disposition: { kind: 'blocked', reasonCode }, matrix,
    observations: [{ absolutePath: '/Users/andrew/private/restricted-skill' }],
  }));
  const quiet = reasons.map((reasonCode) => skill({ logicalId: `quiet-${reasonCode.replace(/_/g, '-')}`, attention: 'quiet', disposition: { kind: 'blocked', reasonCode } }));
  try {
    const { pending } = reconcileDecisions({ statePath, skills: [...actionable, ...quiet] });
    assert.deepEqual(pending.map((item) => [item.skill, item.reason]).sort(), actionable.map((item) => [item.logicalId, item.disposition.reasonCode]).sort());
    for (const decision of pending) {
      assert.deepEqual(decision.options, ['keep-local', 'exclude', 'details'], decision.reason);
      assert.deepEqual(decision.affectedHarnesses, ['claude', 'hermes', 'openclaw'], decision.reason);
      assert.equal(decision.preservedState, 'unchanged', decision.reason);
      const current = actionable.find((item) => item.logicalId === decision.skill);
      assert.equal(resolveDecision({
        statePath, principal: owner(), decisionId: decision.id, revision: 1, option: 'share', currentSkill: current,
        mutate: () => assert.fail('an unsafe, private, or under-trusted skill can never be shared by a decision'),
      }).status, 'invalid_option', decision.reason);
    }
    const privateDecision = pending.find((item) => item.reason === 'privacy_restricted');
    assert.equal(resolveDecision({
      statePath, principal: owner(), decisionId: privateDecision.id, revision: 1, option: 'keep-local',
      currentSkill: actionable.find((item) => item.logicalId === privateDecision.skill), mutate: () => {},
    }).status, 'resolved');
    assert.equal(approvedShareMap({ statePath }).size, 0);
    assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), /\/Users\/andrew|absolutePath|matrix/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stale share reply never resolves a decision whose current classification blocks sharing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-stale-share-'));
  const statePath = path.join(root, 'decisions.json');
  const reasons = ['privacy_restricted', 'trust_class_insufficient', 'unsafe_source'];
  const names = [...reasons.map((reasonCode) => `${reasonCode.replace(/_/g, '-')}-skill`), 'unchanged-skill'];
  const shareable = names.map((logicalId) => skill({ logicalId }));
  try {
    const pending = reconcileDecisions({ statePath, skills: shareable }).pending;
    // Every decision was recorded while the skill was still shareable.
    for (const decision of pending) assert.deepEqual(decision.options, ['share', 'keep-local', 'exclude', 'details'], decision.skill);

    reasons.forEach((reasonCode, index) => {
      const decision = pending.find((item) => item.skill === names[index]);
      // The reply is still for this logical id at this exact tree digest, but
      // a reassessment now classifies the skill as one that can never be
      // shared. The reply is superseded: no mutation, no resolution, no
      // receipt, and nothing enters the approved share map.
      const blocked = skill({ logicalId: names[index], disposition: { kind: 'blocked', reasonCode } });
      const result = resolveDecision({
        statePath, principal: owner(), decisionId: decision.id, revision: decision.revision, option: 'share', currentSkill: blocked,
        mutate: () => assert.fail(`a ${reasonCode} skill must never be shared by a stale reply`),
      });
      assert.equal(result.status, 'stale', reasonCode);
      assert.equal(result.superseded, true, reasonCode);
      assert.equal(result.receipt, undefined, reasonCode);
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8')).decisions.find((item) => item.id === decision.id);
      assert.equal(persisted.status, 'pending', reasonCode);
      assert.equal(persisted.receipt, undefined, reasonCode);
      assert.equal(approvedShareMap({ statePath }).has(names[index]), false, reasonCode);
    });

    // An unchanged decision still resolves and still mutates synchronously.
    const unchanged = pending.find((item) => item.skill === 'unchanged-skill');
    const mutated = [];
    const resolved = resolveDecision({
      statePath, principal: owner(), decisionId: unchanged.id, revision: unchanged.revision, option: 'share',
      currentSkill: shareable.find((item) => item.logicalId === 'unchanged-skill'),
      mutate: ({ skill: name, option }) => mutated.push([name, option]),
    });
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(mutated, [['unchanged-skill', 'share']]);
    assert.deepEqual([...approvedShareMap({ statePath }).keys()], ['unchanged-skill']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const HOUR_MS = 60 * 60 * 1000;
function hourAt(index) { return new Date(Date.parse('2026-08-16T00:00:00.000Z') + index * HOUR_MS).toISOString().slice(0, 13); }
function hourKey(series, index) { return `${series}-${hourAt(index)}`; }
function hourNow(index) { return new Date(Date.parse('2026-08-16T00:05:00.000Z') + index * HOUR_MS).toISOString(); }

test('an hourly occurrence can never be claimed again, however many later occurrences pass, and its record stays bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-occurrence-replay-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const pending = reconcileDecisions({ statePath, skills: [skill({ logicalId: 'single-skill' }), skill({ logicalId: 'batched-skill' })] }).pending;
    const single = pending.find((item) => item.skill === 'single-skill');
    const batched = pending.find((item) => item.skill === 'batched-skill');
    for (let index = 0; index <= 30; index += 1) {
      assert.ok(claimReminder({ statePath, decisionId: single.id, occurrenceKey: hourKey('hour', index), now: hourNow(index) }), `hour ${index}`);
      assert.equal(claimReminders({ statePath, decisionIds: [batched.id], occurrenceKey: hourKey('sched', index), now: hourNow(index), limit: 4 }).length, 1, `sched ${index}`);
    }
    const before = fs.readFileSync(statePath, 'utf8');
    const later = hourNow(31);
    assert.equal(claimReminder({ statePath, decisionId: single.id, occurrenceKey: hourKey('hour', 0), now: later }), null, 'replayed 30 occurrences later');
    assert.equal(claimReminder({ statePath, decisionId: single.id, occurrenceKey: hourKey('hour', -1), now: later }), null, 'an older hour never follows a later one');
    // The ledger remembers the batch occurrence, so a changed membership
    // (a decision never reminded in that series) cannot claim it either.
    assert.deepEqual(claimReminders({ statePath, decisionIds: [batched.id, single.id], occurrenceKey: hourKey('sched', 0), now: later, limit: 4 }), []);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    const persisted = JSON.parse(before);
    const reminder = persisted.decisions.find((item) => item.id === single.id).reminder;
    assert.deepEqual(reminder.hours, { hour: hourAt(30) });
    assert.deepEqual(reminder.occurrences, []);
    assert.equal(reminder.count, 31);
    assert.deepEqual(persisted.reminderOccurrences, { hours: { sched: hourAt(30) }, occurrences: [] });
    assert.ok(claimReminder({ statePath, decisionId: single.id, occurrenceKey: hourKey('hour', 31), now: later }), 'the next hour is still claimable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a production run key stamped to the minute is one hourly occurrence, claimable past the custom-key bound', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-occurrence-production-'));
  const statePath = path.join(root, 'decisions.json');
  // The production runner names its series with a colon and stamps the run to
  // the minute. That is the same hourly occurrence as `<series>-<hour>`: the
  // minutes are a sub-occurrence of the hour, so a within-hour retry dedupes,
  // an hourly key is never stored as a custom key, and the bounded custom
  // history can never fill up and silence later hours.
  const series = 'jarvos-shared-skill-repair';
  const key = (index, minute = '00') => `${series}:${hourAt(index)}:${minute}`;
  const HOURS = 300;
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()] }).pending[0];
    const claim = (occurrenceKey, now) => claimReminders({ statePath, decisionIds: [decision.id], occurrenceKey, now });
    for (let index = 0; index <= HOURS; index += 1) {
      const claimed = claim(key(index), hourNow(index));
      assert.equal(claimed.length, 1, `hour ${index}`);
      assert.equal(claimed[0].replay, undefined, `hour ${index} is a new reminder`);
      assert.equal(claimed[0].sequence, index + 1, `hour ${index} sequence`);
      // A retry within the hour is the same occurrence. It claims no new
      // reminder, but it replays the one that occurrence already claimed so a
      // partly delivered occurrence can still be recovered.
      assert.deepEqual(
        claim(key(index, '30'), hourNow(index)).map((item) => [item.decisionId, item.replay, item.sequence]),
        [[decision.id, true, index + 1]],
        `retry within hour ${index}`,
      );
    }
    const before = fs.readFileSync(statePath, 'utf8');
    assert.equal(claim(key(HOURS, '45'), hourNow(HOURS))[0].replay, true);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'a replay never writes the ledger');
    const persisted = JSON.parse(before);
    assert.deepEqual(persisted.reminderOccurrences.occurrences, []);
    assert.deepEqual(persisted.reminderOccurrences.hours, { [series]: hourAt(HOURS) });
    assert.deepEqual(persisted.decisions[0].reminder.occurrences, []);
    assert.equal(persisted.decisions[0].reminder.count, HOURS + 1, 'replays never move the reminder count');

    const later = hourNow(HOURS + 1);
    for (const old of [0, 1, 150, HOURS - 1]) assert.deepEqual(claim(key(old), later), [], `replay hour ${old}`);
    // Only the latest hour of the series is still the current occurrence, so
    // only it is recoverable; every earlier hour is closed for good.
    assert.equal(claim(key(HOURS), later)[0].replay, true, 'the current hour is still recoverable');
    assert.equal(claim(key(HOURS + 1), later).length, 1, 'the next hour is still deliverable');
    // The same hour named with either separator is one occurrence, not two, so
    // the second naming replays it rather than claiming it again.
    assert.deepEqual(
      claim(`${series}-${hourAt(HOURS + 1)}`, later).map((item) => [item.decisionId, item.replay]),
      [[decision.id, true]],
    );
    // Claiming the later hour closed the hour before it for good.
    assert.deepEqual(claim(key(HOURS), later), [], 'a superseded hour never reopens');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('custom occurrence keys are remembered exactly past any recent window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-occurrence-custom-'));
  const statePath = path.join(root, 'decisions.json');
  try {
    const decision = reconcileDecisions({ statePath, skills: [skill()] }).pending[0];
    for (let index = 0; index < 30; index += 1) assert.ok(claimReminder({ statePath, decisionId: decision.id, occurrenceKey: `run-${index}` }), `run-${index}`);
    assert.equal(claimReminder({ statePath, decisionId: decision.id, occurrenceKey: 'run-0' }), null);
    assert.deepEqual(claimReminders({ statePath, decisionIds: [decision.id], occurrenceKey: 'run-0' }), []);
    assert.ok(claimReminder({ statePath, decisionId: decision.id, occurrenceKey: 'run-30' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a batch whose membership changes within one occurrence is never claimed twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-occurrence-membership-'));
  const statePath = path.join(root, 'decisions.json');
  const occurrenceKey = 'hour-2026-08-16T16';
  try {
    const [alpha] = reconcileDecisions({ statePath, skills: [skill({ logicalId: 'alpha-skill' })] }).pending;
    assert.equal(claimReminders({ statePath, decisionIds: [alpha.id], occurrenceKey, now: '2026-08-16T16:00:00.000Z', limit: 4 }).length, 1);
    const skills = ['alpha-skill', 'bravo-skill', 'charlie-skill'].map((logicalId) => skill({ logicalId }));
    const grown = reconcileDecisions({ statePath, skills }).pending;
    assert.equal(grown.length, 3);
    const newcomers = grown.filter((item) => item.id !== alpha.id).map((item) => item.id);
    assert.deepEqual(claimReminders({ statePath, decisionIds: newcomers, occurrenceKey, now: '2026-08-16T16:40:00.000Z', limit: 4 }), []);
    // Resolving the decision that carried the occurrence does not reopen it.
    resolveDecision({ statePath, principal: owner(), decisionId: alpha.id, revision: 1, option: 'keep-local', currentSkill: skills[0], mutate: () => {} });
    assert.deepEqual(claimReminders({ statePath, decisionIds: newcomers, occurrenceKey, now: '2026-08-16T16:50:00.000Z', limit: 4 }), []);
    assert.deepEqual(claimReminders({ statePath, decisionIds: newcomers, occurrenceKey: 'hour-2026-08-16T17', now: '2026-08-16T17:00:00.000Z', limit: 4 })
      .map((claim) => claim.decisionId).sort(), [...newcomers].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a replay of the current occurrence reconstitutes its own membership and never revives a decision that left it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-occurrence-replay-current-'));
  const statePath = path.join(root, 'decisions.json');
  const occurrenceKey = 'hour-2026-08-16T16';
  const names = ['alpha-skill', 'bravo-skill', 'charlie-skill', 'delta-skill'];
  try {
    let skills = names.map((logicalId) => skill({ logicalId }));
    const pendingIds = () => reconcileDecisions({ statePath, skills }).pending.map((item) => item.id);
    const claim = (ids, key, now) => claimReminders({ statePath, decisionIds: ids, occurrenceKey: key, now, limit: 4 });
    const ids = pendingIds();
    const [alpha, bravo, charlie, delta] = ids;
    assert.deepEqual(claim(ids, occurrenceKey, '2026-08-16T16:00:00.000Z').map((item) => item.decisionId), ids);

    // The same occurrence replays the exact set it claimed, with no count
    // movement and no write.
    const before = fs.readFileSync(statePath, 'utf8');
    const replayed = claim(ids, occurrenceKey, '2026-08-16T16:10:00.000Z');
    assert.deepEqual(replayed.map((item) => item.decisionId), ids);
    assert.deepEqual([...new Set(replayed.map((item) => item.replay))], [true]);
    assert.deepEqual([...new Set(replayed.map((item) => item.sequence))], [1], 'a replay repeats the reminder it already claimed');
    assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'a replay never writes the ledger');

    // Whatever left the occurrence drops out of the replay rather than being
    // revived: resolved, acknowledged, deferred, disappeared, or superseded.
    const alphaSkill = skills.find((item) => item.logicalId === 'alpha-skill');
    assert.equal(resolveDecision({ statePath, principal: owner(), decisionId: alpha, revision: 1, option: 'keep-local', currentSkill: alphaSkill, mutate: () => {} }).status, 'resolved');
    acknowledgeDecision({ statePath, principal: owner(), decisionId: bravo });
    assert.equal(deferDecision({ statePath, principal: owner(), decisionId: charlie, until: '2026-08-16T23:00:00.000Z', now: '2026-08-16T16:15:00.000Z' }).status, 'updated');
    skills = skills.filter((item) => item.logicalId !== 'delta-skill');
    reconcileDecisions({ statePath, skills });
    assert.deepEqual(claim(ids, occurrenceKey, '2026-08-16T16:20:00.000Z'), [], 'nothing that left the occurrence is revived');

    // A decision that first becomes actionable inside the occurrence does not
    // join it, and the prior membership is not forgotten by its arrival.
    skills = [...skills, skill({ logicalId: 'echo-skill' })];
    const grown = pendingIds();
    const echo = grown.find((id) => ![alpha, bravo, charlie, delta].includes(id));
    assert.ok(echo, 'a newcomer exists');
    assert.deepEqual(claim(grown, occurrenceKey, '2026-08-16T16:30:00.000Z'), [], 'a newcomer never joins an in-flight occurrence');
    resumeDecision({ statePath, principal: owner(), decisionId: bravo });
    assert.deepEqual(claim(grown, occurrenceKey, '2026-08-16T16:40:00.000Z').map((item) => [item.decisionId, item.replay]),
      [[bravo, true]], 'the occurrence still knows bravo was one of its own');

    // The newcomer leads the next occurrence, together with what is still
    // pending and remindable.
    assert.deepEqual(claim(pendingIds(), 'hour-2026-08-16T17', '2026-08-16T17:00:00.000Z').map((item) => item.decisionId).sort(),
      [bravo, echo].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a future hourly occurrence is refused without changing state, and legacy recent occurrences still refuse a replay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-decision-occurrence-legacy-'));
  const statePath = path.join(root, 'decisions.json');
  const decisionId = 'decision-0123456789abcdef01234567';
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      schemaVersion: 'jarvos.skill-owner-decisions/v2',
      decisions: [{
        id: decisionId, semanticKey: 'b'.repeat(64), skill: 'newsletter-generator', treeDigest: 'a'.repeat(64),
        decisionReference: 'LegacyReference0123456789', reason: 'needs_owner_input', options: ['share', 'keep-local', 'exclude', 'details'],
        revision: 1, status: 'pending', deliveryStatus: 'pending', attempts: [],
        reminder: { status: 'active', occurrences: ['hour-2026-08-16T10', 'hour-2026-08-16T12', 'custom-run'], count: 3, lastClaimedAt: '2026-08-16T12:00:00.000Z' },
        createdAt: '2026-08-16T09:00:00.000Z', updatedAt: '2026-08-16T12:00:00.000Z',
      }],
    }), { mode: 0o600 });
    const before = fs.readFileSync(statePath, 'utf8');
    const claim = (occurrenceKey, now) => claimReminders({ statePath, decisionIds: [decisionId], occurrenceKey, now, limit: 4 });
    assert.throws(() => claim('hour-2026-08-16T20', '2026-08-16T12:30:00.000Z'), (error) => error.code === 'EOCCURRENCE' && /occurrence is invalid/.test(error.message));
    assert.throws(() => claimReminder({ statePath, decisionId, occurrenceKey: 'hour-2026-08-16T20', now: '2026-08-16T12:30:00.000Z' }), /occurrence is invalid/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    for (const key of ['hour-2026-08-16T12', 'hour-2026-08-16T11', 'custom-run']) assert.deepEqual(claim(key, '2026-08-16T12:30:00.000Z'), [], key);
    assert.equal(fs.readFileSync(statePath, 'utf8'), before);
    assert.equal(claim('hour-2026-08-16T13', '2026-08-16T13:00:00.000Z').length, 1);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.deepEqual(persisted.decisions[0].reminder.hours, { hour: '2026-08-16T13' });
    assert.deepEqual(persisted.decisions[0].reminder.occurrences, ['custom-run']);
    assert.equal(persisted.decisions[0].reminder.count, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
