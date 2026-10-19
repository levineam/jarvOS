'use strict';

// Fictional fixture data only: no private names, IDs, paths or digests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  accountabilityCriterionDigest,
  accountabilityPinDigest,
  accountabilityScopeDigest,
  createAccountabilityPin,
  createCanonicalReference,
  createExplicitHandoff,
  createHostAdmission,
  validateAccountabilityPin,
} = require('../src/provider-contracts.js');
const {
  accountabilityAttentionSummaries,
  accountabilitySignalDigest,
  deriveAccountabilityAttention,
  reconcileAccountabilityScope,
} = require('../src/accountability-attention.js');
const { acknowledgeIntentGapAlerts, createMemoryIntentGapAlertState } = require('../src/intent-gap-attention.js');

const PINNED_AT = '2026-10-18T12:00:00.000Z';
const NOW = PINNED_AT;
const BRIEF = 'b'.repeat(64);
const OWNER = 'actor_fixture_owner';
const KEEPER = 'actor_fixture_keeper';
const MAINTENANCE = Object.freeze({ owner: KEEPER, revisitTrigger: { type: 'time', at: '2026-11-01T09:00:00.000Z' } });
const CRIT_A = Object.freeze({ criterionId: 'crit-a', acceptance: 'Route guide reviewed by fixture owner' });
const CRIT_B = Object.freeze({ criterionId: 'crit-b', acceptance: 'Lantern map exported' });
const CRIT_C = Object.freeze({ criterionId: 'crit-c', acceptance: 'Trail markers listed' });

function reference(revision = 3) {
  return createCanonicalReference({
    contract: 'jarvos.canonical-reference/v1', kind: 'outcome', id: 'out_000001', revision, breadcrumb: 'Fixture Garden › Lantern outcome',
  });
}

function projectReference(revision = 5) {
  return createCanonicalReference({
    contract: 'jarvos.canonical-reference/v1', kind: 'project', id: 'prj_000001', revision, breadcrumb: 'Fixture Garden',
  });
}

function scope(overrides = {}) {
  return {
    reference: reference(), goal: 'Lantern route is documented',
    criteria: [{ criterionId: 'crit-a', acceptance: 'Route guide reviewed by fixture owner' }],
    priority: 'p2', updatedAt: PINNED_AT, registryGeneration: 11, ...overrides,
  };
}

function pinInput(overrides = {}) {
  const s = scope({ reference: overrides.reference || reference() });
  return {
    reference: s.reference, registryGeneration: 11, scopeDigest: accountabilityScopeDigest(s),
    briefDigest: BRIEF, owner: OWNER, responsibility: 'finite-outcome',
    milestone: { criteria: s.criteria, checkpoint: { type: 'event', event: 'route-guide-reviewed' } },
    reason: 'assignment', pinnedAt: PINNED_AT, ...overrides,
  };
}

function ongoingInput(overrides = {}) {
  return pinInput({ reference: projectReference(), responsibility: 'ongoing', maintenance: MAINTENANCE, reason: 'resume', ...overrides });
}

// ---- derivation fixtures ---------------------------------------------------

let sequence = 0;
function authority(producerId = 'fixture-accountability-producer') {
  return createHostAdmission({ producerId, secret: `${producerId}-secret`, allowedSourceClasses: ['execution'] });
}
function admit(auth, contentDigest, observedAt = NOW) {
  sequence += 1;
  return auth.admitEvidenceUnit({
    observationId: `obs_acct_${sequence}`, evidenceId: `ev_acct_${sequence}`, sourceClass: 'execution', occurredAt: observedAt, observedAt,
    sourceRevision: `fixture-rev-${sequence}`, sensitivity: 'public-fixture', coverageState: 'fresh', contentDigest,
  });
}
function outcomeRecord(overrides = {}) {
  return {
    id: 'out_000001', kind: 'outcome', title: 'Lantern outcome', lifecycle: 'active', revision: 3,
    goal: 'Lantern route is documented', definitionOfDone: 'Guide and map accepted', ...overrides,
  };
}
function projectRecord(overrides = {}) {
  return { id: 'prj_000001', kind: 'project', title: 'Fixture Garden', lifecycle: 'active', revision: 5, goal: 'Fixture garden stays tended', ...overrides };
}
function refFor(record, revision = record.revision) {
  return createCanonicalReference({ contract: 'jarvos.canonical-reference/v1', kind: record.kind, id: record.id, revision, breadcrumb: record.title });
}
function pinFor(record, overrides = {}) {
  const { criteria = [CRIT_A, CRIT_B], checkpoint = { type: 'event', event: 'route-guide-reviewed' }, ...rest } = overrides;
  const ref = refFor(record);
  return createAccountabilityPin({
    reference: ref, registryGeneration: 11,
    scopeDigest: accountabilityScopeDigest({ reference: ref, goal: record.goal, definitionOfDone: record.definitionOfDone, criteria }),
    briefDigest: BRIEF, owner: OWNER, responsibility: record.kind === 'project' ? 'ongoing' : 'finite-outcome',
    milestone: { criteria, checkpoint }, reason: 'assignment', pinnedAt: PINNED_AT,
    ...(record.kind === 'project' ? { maintenance: MAINTENANCE } : {}),
    ...rest,
  });
}
function admittedPin(auth, pin) { return { pin, evidence: admit(auth, accountabilityPinDigest(pin)) }; }
function signal(auth, descriptor, observedAt = NOW) { return { ...descriptor, evidence: admit(auth, accountabilitySignalDigest(descriptor), observedAt) }; }
function progress(criterion, overrides = {}) {
  return {
    type: 'progress', referenceId: 'out_000001', criterionId: criterion.criterionId, criterionDigest: accountabilityCriterionDigest(criterion),
    state: 'progress', remaining: 'Draft review notes', nextCheckpoint: { type: 'time', at: '2026-10-20T12:00:00.000Z' },
    actor: OWNER, sourceRef: `fixture-progress-${criterion.criterionId}`, sourceDigest: 'c'.repeat(64), ...overrides,
  };
}
function accepted(criterion, overrides = {}) { return progress(criterion, { state: 'accepted', remaining: null, nextCheckpoint: null, ...overrides }); }
function brief(criteria, overrides = {}) {
  return { type: 'brief', referenceId: 'out_000001', briefDigest: BRIEF, status: 'current', criteria, sourceRef: 'fixture-brief', sourceDigest: 'e'.repeat(64), ...overrides };
}
function derive(args) { return deriveAccountabilityAttention({ registryGeneration: 12, now: NOW, ...args }); }
function criterion(result, criterionId) { return result.entries[0].criteria.find((entry) => entry.criterionId === criterionId); }

// ---- contract ---------------------------------------------------------------

test('scope digest ignores revision/priority/timestamp/generation churn but tracks definition of done', () => {
  const base = accountabilityScopeDigest(scope());
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(accountabilityScopeDigest(scope({
    reference: reference(9), priority: 'p0', updatedAt: '2026-10-19T08:30:00.000Z', registryGeneration: 42,
  })), base);
  assert.notEqual(accountabilityScopeDigest(scope({
    criteria: [{ criterionId: 'crit-a', acceptance: 'Route guide published and reviewed' }],
  })), base);
  assert.notEqual(accountabilityScopeDigest(scope({ goal: 'Lantern route is retired' })), base);
  assert.notEqual(accountabilityScopeDigest(scope({ definitionOfDone: 'Guide accepted by two reviewers' })), base);

  const pin = createAccountabilityPin(pinInput({ reference: reference(9) }));
  assert.equal(pin.contract, 'jarvos.accountability-pin/v1');
  assert.equal(pin.reference.revision, 9);
  assert.equal(pin.reference.id, 'out_000001');
  assert.equal(pin.scopeDigest, base);
  assert.equal(pin.registryGeneration, 11);
  assert.equal(Object.hasOwn(pin, 'canonical'), false);
});

test('ongoing pin requires a project, maintenance owner and revisit trigger; finite milestone never completes the project', () => {
  const ongoing = createAccountabilityPin(ongoingInput());
  assert.equal(validateAccountabilityPin(ongoing).ok, true);
  assert.equal(ongoing.reference.kind, 'project');
  assert.deepEqual(ongoing.maintenance, MAINTENANCE);

  const { maintenance: _omitted, ...missing } = ongoing;
  assert.throws(() => validateAccountabilityPin(missing), TypeError);
  assert.throws(() => createAccountabilityPin(ongoingInput({ maintenance: undefined })), TypeError);
  assert.throws(() => createAccountabilityPin(ongoingInput({ maintenance: { owner: KEEPER } })), TypeError);
  assert.throws(() => createAccountabilityPin(ongoingInput({ maintenance: { owner: '', revisitTrigger: MAINTENANCE.revisitTrigger } })), TypeError);
  assert.throws(() => createAccountabilityPin(ongoingInput({ reference: reference() })), TypeError, 'ongoing on an outcome');
  assert.throws(() => createAccountabilityPin(pinInput({ reference: projectReference() })), TypeError, 'finite-outcome on a project');
  assert.throws(() => createAccountabilityPin(pinInput({ maintenance: MAINTENANCE })), TypeError, 'finite pins carry no maintenance');
  assert.throws(() => createAccountabilityPin(pinInput({
    milestone: { criteria: [{ criterionId: 'crit-a', acceptance: 'x' }], checkpoint: {} },
  })), TypeError);
  assert.throws(() => createAccountabilityPin(pinInput({
    milestone: { criteria: [], checkpoint: { type: 'event', event: 'route-guide-reviewed' } },
  })), TypeError);

  const input = pinInput();
  const snapshot = structuredClone(input);
  const finite = createAccountabilityPin(input);
  const result = validateAccountabilityPin(finite);
  assert.equal(result.ok, true);
  assert.deepEqual(input, snapshot);
  for (const obj of [finite, result, result.pin || {}]) {
    for (const key of ['lifecycle', 'status', 'state', 'completed', 'closed', 'completedAt']) {
      assert.equal(Object.hasOwn(obj, key), false, `pin must not carry project ${key}`);
    }
  }
  assert.equal(Object.hasOwn(finite, 'maintenance'), false);
});

test('pin contract rejects unknown keys, open-ended or oversized milestones and bad reasons', () => {
  assert.throws(() => createAccountabilityPin({ ...pinInput(), canonical: reference() }), TypeError);
  assert.throws(() => createAccountabilityPin(pinInput({ reason: 'whenever' })), TypeError);
  assert.throws(() => createAccountabilityPin(pinInput({ milestone: { criteria: [CRIT_A] } })), TypeError);
  assert.throws(() => createAccountabilityPin(pinInput({ milestone: { criteria: [CRIT_A], checkpoint: { type: 'time', at: 'later' } } })), TypeError);
  const many = Array.from({ length: 17 }, (_, index) => ({ criterionId: `crit-${index}`, acceptance: `Check ${index}` }));
  assert.throws(() => createAccountabilityPin(pinInput({ milestone: { criteria: many, checkpoint: { type: 'event', event: 'done' } } })), TypeError);
  assert.throws(() => createAccountabilityPin(pinInput({ milestone: { criteria: [CRIT_A, CRIT_A], checkpoint: { type: 'event', event: 'done' } } })), TypeError);
});

test('explicit handoff accepts an optional pin only for the same canonical revision; legacy handoffs are unchanged', () => {
  const legacyInput = {
    contract: 'jarvos.explicit-handoff/v1', operationId: 'op-fixture-1', fromAuthority: 'beads', toAuthority: 'paperclip', state: 'requested',
    canonical: reference(3), executionReference: null, externalReference: null, requestedAt: NOW, confirmedAt: null, evidenceRefs: [],
  };
  const legacy = createExplicitHandoff(legacyInput);
  assert.equal(Object.hasOwn(legacy, 'accountability'), false);
  const pin = createAccountabilityPin(pinInput({ reference: reference(3) }));
  const pinned = createExplicitHandoff({ ...legacyInput, accountability: pin });
  assert.deepEqual(pinned.accountability, pin);
  assert.throws(() => createExplicitHandoff({ ...legacyInput, accountability: createAccountabilityPin(pinInput({ reference: reference(4) })) }), TypeError);
  assert.throws(() => createExplicitHandoff({ ...legacyInput, accountability: { ...pin, extra: true } }), TypeError);
});

// ---- derived attention ------------------------------------------------------

test('no trusted producer leaves pins and progress unknown/pending, never accepted', () => {
  const auth = authority();
  const record = outcomeRecord();
  const pin = pinFor(record);
  const pins = [admittedPin(auth, pin)];
  const signals = [signal(auth, accepted(CRIT_A)), signal(auth, accepted(CRIT_B))];
  for (const sourceAuthority of [null, authority('fixture-other-producer')]) {
    const result = derive({ records: [record], pins, signals, sourceAuthority });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].disposition, 'pending-reconciliation');
    assert.match(result.entries[0].repair, /^pin-admission-required:/);
    assert.equal(result.entries[0].nextOwner, 'protected-project-owner');
    assert.deepEqual(result.entries[0].criteria, []);
    assert.equal(result.entries[0].proposal, null);
    assert.ok(result.omissions.some((omission) => omission.startsWith('accountability:signal-')));
  }
});

test('unrelated revision/generation refresh keeps acceptance; material criterion change reopens only the affected criterion', () => {
  const auth = authority();
  const pinnedRecord = outcomeRecord();
  const pins = [admittedPin(auth, pinFor(pinnedRecord))];
  const work = [signal(auth, accepted(CRIT_A)), signal(auth, progress(CRIT_B))];

  const refreshed = derive({ records: [outcomeRecord({ revision: 7, title: 'Lantern outcome (renamed)' })], registryGeneration: 20, pins, signals: work, sourceAuthority: auth });
  assert.equal(refreshed.entries[0].referenceState, 'refreshed');
  assert.equal(refreshed.entries[0].pinnedRevision, 3);
  assert.equal(refreshed.entries[0].currentRevision, 7);
  assert.equal(criterion(refreshed, 'crit-a').state, 'accepted');
  assert.equal(criterion(refreshed, 'crit-a').exception, null);
  assert.equal(criterion(refreshed, 'crit-b').available, true);

  const changedB = { criterionId: 'crit-b', acceptance: 'Lantern map exported and printed' };
  const revisedBrief = signal(auth, brief([CRIT_A, changedB], { briefDigest: 'd'.repeat(64) }));
  const material = derive({ records: [pinnedRecord], pins, signals: [...work, revisedBrief], sourceAuthority: auth });
  assert.equal(material.entries[0].referenceState, 'stale-scope');
  assert.equal(material.entries[0].briefState, 'revised');
  assert.equal(material.entries[0].repair, 're-pin-with-owner');
  assert.equal(criterion(material, 'crit-a').state, 'accepted');
  assert.equal(criterion(material, 'crit-a').exception, null);
  assert.equal(criterion(material, 'crit-a').reopened, false);
  assert.deepEqual(criterion(material, 'crit-b').exception, { type: 'stale-scope', reason: 'criterion-changed' });
  assert.equal(criterion(material, 'crit-b').reopened, true);
  assert.equal(criterion(material, 'crit-b').state, 'ready', 'progress against superseded acceptance text no longer counts');

  const intent = derive({ records: [outcomeRecord({ goal: 'Lantern route is retired', revision: 4 })], pins, signals: work, sourceAuthority: auth });
  assert.deepEqual(criterion(intent, 'crit-a').exception, { type: 'stale-scope', reason: 'intent-changed' });
  assert.equal(criterion(intent, 'crit-a').state, 'accepted', 'material intent change flags but never erases acceptance');
  assert.equal(intent.entries[0].proposal, null);
});

test('superseded brief flags stale scope on every criterion without erasing acceptance', () => {
  const auth = authority();
  const record = outcomeRecord();
  const result = derive({
    records: [record], pins: [admittedPin(auth, pinFor(record))], sourceAuthority: auth,
    signals: [signal(auth, accepted(CRIT_A)), signal(auth, accepted(CRIT_B)), signal(auth, brief([CRIT_A, CRIT_B], { status: 'superseded' }))],
  });
  assert.equal(result.entries[0].briefState, 'superseded');
  assert.equal(result.entries[0].referenceState, 'stale-scope');
  for (const id of ['crit-a', 'crit-b']) {
    assert.deepEqual(criterion(result, id).exception, { type: 'stale-scope', reason: 'brief-superseded' });
    assert.equal(criterion(result, id).state, 'accepted');
  }
  assert.equal(result.entries[0].proposal, null);
});

test('missing or compacted exact record detail is owned pending-reconciliation, not stale scope', () => {
  const auth = authority();
  const record = outcomeRecord();
  const pins = [admittedPin(auth, pinFor(record))];
  for (const records of [[], [{ ...record, compacted: true }], [{ ...record, kind: 'project' }]]) {
    const result = derive({ records, pins, signals: [], sourceAuthority: auth });
    assert.equal(result.entries[0].disposition, 'pending-reconciliation');
    assert.equal(result.entries[0].repair, 'exact-record-detail-required');
    assert.equal(result.entries[0].nextOwner, OWNER);
  }
});

test('activity and diagnostics are never progress', () => {
  const auth = authority();
  const record = outcomeRecord();
  const { criterionId: _dropped, ...noCriterion } = progress(CRIT_A);
  const result = derive({
    records: [record], pins: [admittedPin(auth, pinFor(record))], sourceAuthority: auth,
    signals: [
      { type: 'activity', referenceId: record.id, summary: 'Edited the lantern guide' },
      { ...noCriterion, evidence: null },
      signal(auth, accepted({ criterionId: 'crit-z', acceptance: 'Unpinned diagnostic' })),
    ],
  });
  assert.ok(result.omissions.includes('accountability:activity-not-progress'));
  assert.equal(criterion(result, 'crit-a').state, 'ready');
  assert.equal(criterion(result, 'crit-b').state, 'ready');
  assert.equal(result.entries[0].criteria.some((entry) => entry.criterionId === 'crit-z'), false);
  assert.equal(result.entries[0].proposal, null);
});

test('acceptance failure and event/time missed checkpoints are per-criterion; an independent ready criterion stays available', () => {
  const auth = authority();
  const record = outcomeRecord();
  const criteria = [CRIT_A, CRIT_B, CRIT_C];
  const failed = progress(CRIT_A, { state: 'failed', remaining: 'Reviewer rejected the guide', nextCheckpoint: null });

  const timed = derive({
    records: [record], sourceAuthority: auth,
    pins: [admittedPin(auth, pinFor(record, { criteria, checkpoint: { type: 'time', at: '2026-10-17T00:00:00.000Z' } }))],
    signals: [signal(auth, failed), signal(auth, progress(CRIT_C))],
  });
  assert.deepEqual(criterion(timed, 'crit-a').exception, { type: 'acceptance-failed', reason: 'acceptance-check-failed' });
  assert.deepEqual(criterion(timed, 'crit-b').exception, { type: 'checkpoint-missed', reason: 'no-progress' });
  assert.equal(criterion(timed, 'crit-c').exception, null);
  assert.equal(criterion(timed, 'crit-c').available, true);
  assert.equal(timed.entries[0].disposition, 'exception');

  const eventPin = pinFor(record, { criteria });
  const reached = { type: 'event', referenceId: record.id, event: 'route-guide-reviewed', occurredAt: '2026-10-18T11:00:00.000Z', sourceRef: 'fixture-event', sourceDigest: 'f'.repeat(64) };
  const evented = derive({
    records: [record], sourceAuthority: auth, pins: [admittedPin(auth, eventPin)],
    signals: [signal(auth, reached, '2026-10-18T11:00:00.000Z'), signal(auth, progress(CRIT_C), '2026-10-18T11:30:00.000Z')],
  });
  assert.equal(criterion(evented, 'crit-b').exception.type, 'checkpoint-missed');
  assert.equal(criterion(evented, 'crit-c').available, true);
  const quiet = derive({ records: [record], sourceAuthority: auth, pins: [admittedPin(auth, eventPin)], signals: [] });
  assert.equal(quiet.entries[0].criteria.every((entry) => entry.exception === null && entry.available), true, 'no event, no deadline, no false alarm');
});

test('ownership conflict and lost continuation are explicit, and foreign progress never counts as acceptance', () => {
  const auth = authority();
  const record = outcomeRecord();
  const pin = pinFor(record);
  const claim = (owner, state) => ({ type: 'claim', referenceId: record.id, owner, state, sourceRef: `fixture-claim-${owner}-${state}`, sourceDigest: 'a'.repeat(64) });

  const intruder = derive({ records: [record], sourceAuthority: auth, pins: [admittedPin(auth, pin)], signals: [signal(auth, claim('actor_fixture_intruder', 'held'))] });
  assert.equal(criterion(intruder, 'crit-a').exception.type, 'ownership-conflict');

  const foreign = derive({ records: [record], sourceAuthority: auth, pins: [admittedPin(auth, pin)], signals: [signal(auth, accepted(CRIT_A, { actor: 'actor_fixture_intruder' }))] });
  assert.equal(criterion(foreign, 'crit-a').state, 'ready');
  assert.deepEqual(criterion(foreign, 'crit-a').exception, { type: 'ownership-conflict', reason: 'progress-by-unpinned-actor' });

  const rival = pinFor(record, { owner: 'actor_fixture_rival', pinnedAt: '2026-10-18T12:00:01.000Z' });
  const twoOwners = derive({ records: [record], sourceAuthority: auth, pins: [admittedPin(auth, pin), admittedPin(auth, rival)], signals: [] });
  assert.equal(twoOwners.entries.length, 1);
  assert.deepEqual(criterion(twoOwners, 'crit-b').exception, { type: 'ownership-conflict', reason: 'multiple-pinned-owners' });

  const lost = derive({
    records: [record], sourceAuthority: auth, pins: [admittedPin(auth, pin)],
    signals: [signal(auth, accepted(CRIT_A)), signal(auth, claim(OWNER, 'lost'))],
  });
  assert.equal(criterion(lost, 'crit-a').exception, null);
  assert.deepEqual(criterion(lost, 'crit-b').exception, { type: 'continuation-lost', reason: 'owner-claim-lost' });
  assert.equal(criterion(lost, 'crit-b').nextOwner, OWNER);
});

test('finite all-accepted is a readiness proposal only and alerts once across unrelated churn', () => {
  const auth = authority();
  const record = outcomeRecord();
  const snapshot = structuredClone(record);
  const pins = [admittedPin(auth, pinFor(record))];
  const signals = [signal(auth, accepted(CRIT_A)), signal(auth, accepted(CRIT_B))];
  const result = derive({ records: [record], pins, signals, sourceAuthority: auth });
  assert.deepEqual(record, snapshot, 'derivation never mutates the canonical record');
  assert.equal(result.entries[0].disposition, 'outcome-complete-ready');
  assert.deepEqual(result.entries[0].proposal, { type: 'outcome-complete-ready', referenceId: record.id, decisionOwner: OWNER, lifecycleChange: 'none' });
  assert.equal(Object.hasOwn(result.entries[0], 'lifecycle'), false);

  const alertState = createMemoryIntentGapAlertState();
  assert.equal(acknowledgeIntentGapAlerts(result.alerts, { alertState, consumerKey: 'overseer' }).length, 1);
  const churned = derive({ records: [outcomeRecord({ revision: 9 })], registryGeneration: 30, pins, signals, sourceAuthority: auth });
  assert.equal(acknowledgeIntentGapAlerts(churned.alerts, { alertState, consumerKey: 'overseer' }).length, 0);

  const summaries = accountabilityAttentionSummaries(result, { observedAt: NOW });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].source, 'projects-accountability');
  assert.equal(summaries[0].category, 'attention');
  assert.equal(summaries[0].status, 'outcome-complete-ready');
  assert.match(summaries[0].title, /readiness proposal only/);
});

test('ongoing project milestone acceptance never completes; maintenance owner and revisit trigger stay open', () => {
  const auth = authority();
  const record = projectRecord();
  const pins = [admittedPin(auth, pinFor(record))];
  const signals = [CRIT_A, CRIT_B].map((entry) => signal(auth, accepted(entry, { referenceId: record.id })));
  const result = derive({ records: [record], pins, signals, sourceAuthority: auth });
  const entry = result.entries[0];
  assert.equal(entry.responsibility, 'ongoing');
  assert.equal(entry.disposition, 'maintenance-retained');
  assert.equal(entry.proposal, null);
  assert.deepEqual(entry.maintenance, { state: 'retained', owner: KEEPER, revisitTrigger: MAINTENANCE.revisitTrigger, due: false, milestoneAccepted: true });
  const summaries = accountabilityAttentionSummaries(result, { observedAt: NOW });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, 'maintenance-retained');
  assert.match(summaries[0].title, /maintenance owner: actor_fixture_keeper; revisit: 2026-11-01T09:00:00.000Z/);

  const later = '2026-11-02T00:00:00.000Z';
  const due = derive({ records: [record], pins, signals, sourceAuthority: auth, now: later });
  assert.equal(due.entries[0].maintenance.due, true);
  assert.deepEqual(due.alerts.map((alert) => [alert.disposition, alert.nextOwner]), [['maintenance-due', KEEPER]]);
});

// ---- owner-port scope reconciliation ---------------------------------------

function fakeOwnerPort(initial, { amendResult = null, readbackOverride = null } = {}) {
  const state = { generation: 11, record: { ...initial } };
  const calls = [];
  return {
    calls,
    state,
    async amend(request) {
      calls.push(['amend', request]);
      if (amendResult) return amendResult;
      if (request.expectedGeneration !== state.generation || request.expectedRevision !== state.record.revision) return { status: 'conflict' };
      state.generation += 1;
      state.record = { ...state.record, ...request.patch, revision: state.record.revision + 1 };
      return { status: 'committed', generation: state.generation, revision: state.record.revision };
    },
    async readRecord(request) {
      calls.push(['readRecord', request]);
      const record = readbackOverride ? readbackOverride(state.record) : state.record;
      return { status: 'ok', read: { generation: state.generation, record: { ...record } } };
    },
  };
}

test('scope reconciliation goes only through an injected owner port with CAS and readback', async () => {
  const record = outcomeRecord();
  const pin = pinFor(record);
  const proposedScope = { goal: 'Lantern route is documented and walked', criteria: [CRIT_A, CRIT_B], briefDigest: 'd'.repeat(64) };
  const current = { registryGeneration: 11, revision: 3 };

  const noPort = await reconcileAccountabilityScope({ pin, current, proposedScope, now: NOW });
  assert.deepEqual([noPort.status, noPort.repair, noPort.owner, noPort.pin], ['pending-reconciliation', 'owner-amend-port-unavailable', OWNER, null]);

  for (const [amendResult, repair] of [[{ status: 'denied' }, 'owner-amend-denied'], [{ status: 'pending' }, 'owner-amend-indeterminate']]) {
    const denied = await reconcileAccountabilityScope({ pin, current, proposedScope, ownerPort: fakeOwnerPort(record, { amendResult }), now: NOW });
    assert.equal(denied.status, 'pending-reconciliation');
    assert.equal(denied.repair, repair);
  }

  const raced = fakeOwnerPort(record);
  raced.state.generation = 12; // a concurrent writer committed first
  const conflict = await reconcileAccountabilityScope({ pin, current, proposedScope, ownerPort: raced, now: NOW });
  assert.equal(conflict.repair, 'owner-amend-conflict');

  const overwritten = fakeOwnerPort(record, { readbackOverride: (value) => ({ ...value, goal: 'Concurrent rewrite' }) });
  assert.equal((await reconcileAccountabilityScope({ pin, current, proposedScope, ownerPort: overwritten, now: NOW })).repair, 'readback-mismatch');
  const shifted = fakeOwnerPort(record, { readbackOverride: (value) => ({ ...value, revision: value.revision + 1 }) });
  assert.equal((await reconcileAccountabilityScope({ pin, current, proposedScope, ownerPort: shifted, now: NOW })).repair, 'readback-unavailable');

  const port = fakeOwnerPort(record);
  const reconciled = await reconcileAccountabilityScope({ pin, current, proposedScope, ownerPort: port, now: '2026-10-18T13:00:00.000Z' });
  assert.equal(reconciled.status, 'reconciled');
  assert.equal(reconciled.admission, 'required', 'a re-pin stays untrusted until the host admits it');
  assert.equal(reconciled.pin.reference.revision, 4);
  assert.equal(reconciled.pin.registryGeneration, 12);
  assert.equal(reconciled.pin.reason, 'scope-change');
  assert.equal(reconciled.pin.scopeDigest, accountabilityScopeDigest({
    reference: reconciled.pin.reference, goal: proposedScope.goal, definitionOfDone: record.definitionOfDone, criteria: proposedScope.criteria,
  }));
  assert.deepEqual(port.calls.map(([name, request]) => [name, request.expectedGeneration, request.expectedRevision]), [['amend', 11, 3], ['readRecord', 12, 4]]);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'accountability-attention.js'), 'utf8');
  assert.equal(/\.update\s*\(|verifyApproval/.test(source), false, 'no direct registry writer or fake approval helper');
});
