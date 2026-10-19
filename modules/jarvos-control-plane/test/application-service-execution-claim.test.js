'use strict';

// One-use execution admission on the authenticated application service.
//
// Contract under test (internal operations, never transport/model callable):
//   execute('claimExecution', { credential, requestId, actionKey, fence, expectedApprover })
//     -> { ok: true, claim: { claimId, requestId, actionKey, claimFence, claimedAt, approvedBy } }
//   execute('recordExecutionOutcome', { credential, requestId, claimId, outcome })
//     outcome is one of 'installed' | 'failed' | 'indeterminate'
//     -> { ok: true, execution: { claimId, outcome, outcomeAt, ... } }
// State lives on the existing request record (request.execution) and evidence
// list, persisted through the existing store save(state, expectedRevision) CAS.
// The claim allocates its own fence (claimFence = approval fence + 1) so a
// post-claim read can tell its own increment from an actual supersession.
// Evidence for an outcome is host-reported, never verified lifecycle success.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createApplicationService, createMemoryApplicationStore } = require('../src');

const T0 = Date.parse('2026-10-19T12:00:00.000Z');
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const PRINCIPALS = {
  creator: { id: 'principal:creator', capabilities: ['control-plane.read', 'control-plane.mutate'] },
  'creator-readonly': { id: 'principal:creator', capabilities: ['control-plane.read'] },
  steward: { id: 'principal:steward', capabilities: ['control-plane.read', 'control-plane.approve'] },
  deputy: { id: 'principal:deputy', capabilities: ['control-plane.read', 'control-plane.approve'] },
  intruder: { id: 'principal:intruder', capabilities: ['control-plane.read', 'control-plane.mutate', 'control-plane.approve'] },
  limited: { id: 'principal:limited', capabilities: ['control-plane.read', 'control-plane.mutate'], maxSensitivity: 'public' },
};

function world({ outcome = 'require_approval', store = createMemoryApplicationStore(), policyExtra = {} } = {}) {
  const clock = { now: T0 };
  const service = createApplicationService({
    store,
    clock: () => clock.now,
    policy: () => ({ outcome, requiredCapability: 'control-plane.approve', ...policyExtra }),
    canRead: () => true,
    resolveCredential: (credential) => PRINCIPALS[credential] || null,
  });
  return { store, clock, service };
}

function create(service, { credential = 'creator', idempotencyKey, resourceId = 'prj_900001', sensitivity, marker = false } = {}) {
  const commandSpec = { operation: 'pms-read-grant', arguments: { rootProjectId: resourceId, includeDescendants: true } };
  if (marker) commandSpec.arguments.secretMarker = 'SYNTHETIC-MARKER-900001';
  return service.execute('createRequest', {
    credential,
    idempotencyKey,
    actor: { kind: 'system', id: 'fixture-host' },
    resource: { machineId: 'machine:fixture', type: 'pms-read-grant', id: resourceId },
    mutationClass: 'pms.read-access.grant',
    desiredGeneration: '1',
    sensitivity,
    commandSpec,
  }).request;
}

// Returns the stored record: a record redacted from its creator projects no
// approval/fence, but the fixture still needs them to attempt a claim.
function approved(w, { approver = 'steward', ...options } = {}) {
  const request = create(w.service, options);
  const record = stored(w, request.id);
  w.service.execute('approve', { credential: approver, requestId: record.id, fence: record.approval.fence });
  return record;
}

function claimInput(request, overrides = {}) {
  return {
    credential: 'creator',
    requestId: request.id,
    actionKey: request.actionKey,
    fence: request.fence,
    expectedApprover: 'principal:steward',
    ...overrides,
  };
}

function stored(w, requestId) {
  return w.store.load().requests.find((item) => item.id === requestId) || null;
}

function binding(w, requestId, credential = 'creator') {
  return w.service.execute('approval-state', { credential, requestId }).binding;
}

function pause(w) {
  const state = w.store.load();
  state.paused = true;
  w.store.save(state, state.revision);
}

// A failed claim must leave persisted state byte-for-byte untouched: no
// consumption, no fence allocation, no evidence, no revision bump.
function assertRefusedWithoutEffect(w, run, label) {
  const before = w.store.load();
  assert.throws(run, label);
  const after = w.store.load();
  assert.equal(after.revision, before.revision, `${label}: revision changed`);
  assert.deepEqual(after.keyedFences, before.keyedFences, `${label}: fence allocated`);
  assert.equal(after.evidence.length, before.evidence.length, `${label}: evidence appended`);
  assert.deepEqual(
    after.requests.map((request) => request.execution || null),
    before.requests.map((request) => request.execution || null),
    `${label}: execution state changed`,
  );
}

test('a real required approval is claimed exactly once with its own fence and audit', () => {
  const w = world();
  const request = approved(w);
  const before = w.store.load();

  const result = w.service.execute('claimExecution', claimInput(request));
  assert.equal(result.ok, true);
  assert.equal(result.claim.requestId, request.id);
  assert.equal(result.claim.actionKey, request.actionKey);
  assert.equal(result.claim.approvedBy, 'principal:steward');
  assert.match(result.claim.claimId, OPAQUE);
  assert.equal(result.claim.claimFence, request.fence + 1);
  assert.equal(result.claim.claimedAt, new Date(T0).toISOString());

  const after = w.store.load();
  assert.equal(after.revision, before.revision + 1, 'claim persists through one CAS save');
  assert.equal(after.keyedFences[request.actionKey], result.claim.claimFence);
  const claimEvidence = after.evidence.filter((item) => item.requestId === request.id && item.outcome === 'execution_claimed');
  assert.equal(claimEvidence.length, 1);
  assert.doesNotMatch(JSON.stringify(claimEvidence), /principal:steward/, 'audit carries no raw approver identity');

  // The post-claim binding distinguishes the claim's own increment: the
  // pre-claim fence is retained, the current fence equals the claim fence.
  const view = binding(w, request.id);
  assert.equal(view.fence, request.fence);
  assert.equal(view.currentFence, result.claim.claimFence);
  assert.equal(view.approvedBy, 'principal:steward');
  assert.equal(view.execution.claimId, result.claim.claimId);
  assert.equal(view.execution.claimFence, result.claim.claimFence);
  // A claim without a reported outcome is never installed.
  assert.notEqual(view.execution.outcome, 'installed');
  assert.ok([null, 'indeterminate'].includes(view.execution.outcome));

  assertRefusedWithoutEffect(w, () => w.service.execute('claimExecution', claimInput(request)), /consumed|claimed|stale|fence/);
  assertRefusedWithoutEffect(
    w,
    () => w.service.execute('claimExecution', claimInput(request, { fence: result.claim.claimFence })),
    /consumed|claimed|stale|fence/,
  );
});

test('claims fail closed without effects for every non-admissible request', () => {
  const cases = [
    ['missing request', (w) => ({ ...claimInput(approved(w)), requestId: 'request_missing' })],
    ['unauthenticated caller', (w) => claimInput(approved(w), { credential: 'nobody' })],
    ['foreign principal with mutate', (w) => claimInput(approved(w), { credential: 'intruder' })],
    ['creator without mutate capability', (w) => claimInput(approved(w), { credential: 'creator-readonly' })],
    ['pending approval', (w) => claimInput(create(w.service))],
    ['expired approval', (w) => { const input = claimInput(approved(w)); w.clock.now = T0 + 300001; return input; }],
    ['paused control plane', (w) => { const input = claimInput(approved(w)); pause(w); return input; }],
    ['wrong fence', (w) => { const r = approved(w); return claimInput(r, { fence: r.fence + 1 }); }],
    ['string fence', (w) => { const r = approved(w); return claimInput(r, { fence: String(r.fence) }); }],
    ['missing fence', (w) => claimInput(approved(w), { fence: undefined })],
    ['wrong actionKey', (w) => claimInput(approved(w), { actionKey: 'a'.repeat(64) })],
    ['wrong expected approver', (w) => claimInput(approved(w), { expectedApprover: 'principal:deputy' })],
    ['missing expected approver', (w) => claimInput(approved(w), { expectedApprover: undefined })],
    ['approved by a different approver', (w) => claimInput(approved(w, { approver: 'deputy' }))],
    ['superseded after approval', (w) => {
      const r = approved(w);
      create(w.service, { idempotencyKey: 'superseding-request' });
      return claimInput(r);
    }],
  ];
  for (const [label, setup] of cases) {
    const w = world();
    const input = setup(w);
    assertRefusedWithoutEffect(w, () => w.service.execute('claimExecution', input), label);
  }

  for (const outcome of ['deny', 'defer', 'allow']) {
    // Policy allow is not a real required approval and cannot be claimed.
    const w = world({ outcome });
    const request = create(w.service);
    assertRefusedWithoutEffect(w, () => w.service.execute('claimExecution', claimInput(request)), `policy ${outcome}`);
  }

  const unauthenticated = world();
  const request = approved(unauthenticated);
  assert.throws(
    () => unauthenticated.service.execute('claimExecution', claimInput(request, { credential: 'nobody' })),
    (error) => error.code === 'AUTH_REQUIRED',
  );
});

test('a request redacted from its creator cannot be claimed and leaks nothing', () => {
  for (const sensitivity of [
    { level: 'secret' },
    { level: 'public', fields: [{ path: 'commandSpec.arguments.secretMarker', level: 'secret' }] },
  ]) {
    const w = world();
    const request = approved(w, { credential: 'limited', sensitivity, marker: true });
    let message = '';
    assertRefusedWithoutEffect(w, () => {
      try {
        w.service.execute('claimExecution', claimInput(request, { credential: 'limited' }));
      } catch (error) {
        message = error.message;
        throw error;
      }
    }, JSON.stringify(sensitivity));
    assert.doesNotMatch(message, /SYNTHETIC-MARKER-900001|principal:steward/);
  }
});

test('two services racing on one store produce exactly one claim through store CAS', () => {
  const store = createMemoryApplicationStore();
  const winner = world({ store });
  const request = approved(winner);
  let winnerClaim = null;
  let armed = true;
  // Service A loads, then service B claims and saves before A's save; A's
  // save carries the stale revision and the real store refuses it.
  const racingStore = {
    load: () => store.load(),
    save(next, expectedRevision) {
      if (armed) {
        armed = false;
        winnerClaim = winner.service.execute('claimExecution', claimInput(request)).claim;
      }
      return store.save(next, expectedRevision);
    },
  };
  const loser = world({ store: racingStore });
  assert.throws(() => loser.service.execute('claimExecution', claimInput(request)), /concurrent state mutation/);
  assert.ok(winnerClaim, 'the interleaved service won');

  const state = store.load();
  const record = state.requests.find((item) => item.id === request.id);
  assert.equal(record.execution.claimId, winnerClaim.claimId);
  assert.equal(state.evidence.filter((item) => item.requestId === request.id && item.outcome === 'execution_claimed').length, 1);
  assert.equal(state.keyedFences[request.actionKey], winnerClaim.claimFence);
  assert.throws(() => loser.service.execute('claimExecution', claimInput(request)));
  assert.equal(store.load().revision, state.revision);
});

test('a stale snapshot that still looks unclaimed cannot claim again', () => {
  const store = createMemoryApplicationStore();
  const fresh = world({ store });
  const request = approved(fresh);
  const staleSnapshot = store.load();
  const first = fresh.service.execute('claimExecution', claimInput(request)).claim;
  const stale = world({ store: { load: () => structuredClone(staleSnapshot), save: (next, revision) => store.save(next, revision) } });
  assert.throws(() => stale.service.execute('claimExecution', claimInput(request)), /concurrent state mutation/);
  assert.equal(store.load().requests.find((item) => item.id === request.id).execution.claimId, first.claimId);
});

test('an outcome is recorded once for the exact claim and creator as host-reported evidence', () => {
  const w = world();
  const request = approved(w);
  const claim = w.service.execute('claimExecution', claimInput(request)).claim;

  const outcomeInput = (overrides = {}) => ({ credential: 'creator', requestId: request.id, claimId: claim.claimId, outcome: 'installed', ...overrides });
  for (const [label, input] of [
    ['wrong claim', outcomeInput({ claimId: 'claim_forged' })],
    ['missing claim id', outcomeInput({ claimId: undefined })],
    ['foreign principal', outcomeInput({ credential: 'intruder' })],
    ['creator without mutate', outcomeInput({ credential: 'creator-readonly' })],
    ['unauthenticated', outcomeInput({ credential: 'nobody' })],
    ['verified-shaped outcome', outcomeInput({ outcome: 'satisfied' })],
    ['unknown outcome', outcomeInput({ outcome: 'verified' })],
    ['missing outcome', outcomeInput({ outcome: undefined })],
    ['missing request', outcomeInput({ requestId: 'request_missing' })],
  ]) {
    const before = w.store.load();
    assert.throws(() => w.service.execute('recordExecutionOutcome', input), label);
    assert.equal(w.store.load().revision, before.revision, label);
  }

  const recorded = w.service.execute('recordExecutionOutcome', outcomeInput());
  assert.equal(recorded.ok, true);
  assert.equal(recorded.execution.outcome, 'installed');
  const view = binding(w, request.id);
  assert.equal(view.execution.outcome, 'installed');
  assert.equal(typeof view.execution.outcomeAt, 'string');
  const state = w.store.load();
  const evidence = state.evidence.filter((item) => item.requestId === request.id && item.outcome === 'execution_installed');
  assert.equal(evidence.length, 1);
  assert.match(evidence[0].detail, /host-reported/);
  assert.ok(!['satisfied', 'executed', 'verifying'].includes(stored(w, request.id).status), 'outcome is not verified lifecycle success');

  for (const outcome of ['installed', 'failed', 'indeterminate']) {
    const before = w.store.load();
    assert.throws(() => w.service.execute('recordExecutionOutcome', outcomeInput({ outcome })), `second ${outcome}`);
    assert.equal(w.store.load().revision, before.revision);
  }
});

test('an approved but unclaimed request has no outcome to record', () => {
  const w = world();
  const request = approved(w);
  assertRefusedWithoutEffect(w, () => w.service.execute('recordExecutionOutcome', {
    credential: 'creator', requestId: request.id, claimId: 'claim_unallocated', outcome: 'failed',
  }), 'unclaimed outcome');
});

test('failed and indeterminate outcomes stay consumed, may be reported after expiry, and never resurrect', () => {
  for (const outcome of ['failed', 'indeterminate']) {
    const w = world();
    const request = approved(w, { idempotencyKey: `resurrect-${outcome}` });
    const claim = w.service.execute('claimExecution', claimInput(request)).claim;
    // Failure reporting remains possible after the approval window closed.
    w.clock.now = T0 + 3600000;
    const recorded = w.service.execute('recordExecutionOutcome', { credential: 'creator', requestId: request.id, claimId: claim.claimId, outcome });
    assert.equal(recorded.execution.outcome, outcome);
    w.clock.now = T0 + 1000;

    assert.throws(() => w.service.execute('claimExecution', claimInput(request)));
    assert.throws(() => w.service.execute('claimExecution', claimInput(request, { fence: claim.claimFence })));
    assert.throws(() => w.service.execute('approve', { credential: 'steward', requestId: request.id, fence: request.fence }));
    assert.throws(() => w.service.execute('approve', { credential: 'steward', requestId: request.id, fence: claim.claimFence }));

    // Re-submitting the same idempotent request returns the consumed record.
    const again = w.service.execute('createRequest', {
      credential: 'creator',
      idempotencyKey: `resurrect-${outcome}`,
      actor: { kind: 'system', id: 'fixture-host' },
      resource: { machineId: 'machine:fixture', type: 'pms-read-grant', id: 'prj_900001' },
      mutationClass: 'pms.read-access.grant',
      desiredGeneration: '1',
      commandSpec: { operation: 'pms-read-grant', arguments: { rootProjectId: 'prj_900001', includeDescendants: true } },
    });
    assert.equal(again.deduped, true);
    assert.equal(again.request.id, request.id);
    assert.equal(stored(w, request.id).execution.claimId, claim.claimId);
    assert.equal(stored(w, request.id).execution.outcome, outcome);
    assert.notEqual(binding(w, request.id).execution.outcome, 'installed');
  }
});

// Historical/corrupt stored expiries, simulated only by direct fixture store
// mutation. `undefined` means the field is deleted entirely.
const CORRUPT_STORED_EXPIRIES = [
  ['missing', undefined],
  ['null', null],
  ['not-a-date', 'not-a-date'],
  ['Infinity', 'Infinity'],
  ['object', {}],
  ['number', T0 + 3600000],
  ['invalid calendar date', '2099-02-30T00:00:00.000Z'],
  ['noncanonical without millis', '2099-01-01T00:00:00Z'],
  ['noncanonical offset', '2099-01-01T00:00:00.000+00:00'],
  ['date only', '2099-01-01'],
];

function corruptStoredExpiry(w, requestId, value) {
  const state = w.store.load();
  const record = state.requests.find((item) => item.id === requestId);
  if (value === undefined) delete record.approval.expiresAt;
  else record.approval.expiresAt = value;
  w.store.save(state, state.revision);
}

test('a missing, invalid, or noncanonical stored expiry refuses approve without effect', () => {
  for (const [label, value] of CORRUPT_STORED_EXPIRIES) {
    const w = world();
    const request = create(w.service);
    const record = stored(w, request.id);
    corruptStoredExpiry(w, record.id, value);
    assertRefusedWithoutEffect(
      w,
      () => w.service.execute('approve', { credential: 'steward', requestId: record.id, fence: record.approval.fence }),
      `approve with ${label} expiry`,
    );
    const after = stored(w, record.id);
    assert.equal(after.status, 'approval_required', `${label}: status changed`);
    assert.equal(after.approval.usedAt, null, `${label}: approval consumed`);
    assert.equal(after.approval.approvedBy, undefined, `${label}: approver recorded`);
  }
});

test('a missing, invalid, or noncanonical stored expiry refuses claimExecution without effect', () => {
  for (const [label, value] of CORRUPT_STORED_EXPIRIES) {
    const w = world();
    const request = approved(w);
    corruptStoredExpiry(w, request.id, value);
    assertRefusedWithoutEffect(w, () => {
      try {
        w.service.execute('claimExecution', claimInput(request));
      } catch (error) {
        assert.equal(error.code, 'EXECUTION_CLAIM_REFUSED', `${label}: refusal code`);
        throw error;
      }
    }, `claim with ${label} expiry`);
    assert.equal(stored(w, request.id).execution, undefined, `${label}: execution recorded`);
  }
});

test('an explicitly supplied malformed policy expiry refuses createRequest without persistence', () => {
  for (const expiresAt of [
    'not-a-date',
    'Infinity',
    {},
    '',
    T0 + 3600000,
    '2099-02-30T00:00:00.000Z',
    '2099-01-01T00:00:00Z',
    '2099-01-01T00:00:00.000+00:00',
  ]) {
    const w = world({ policyExtra: { expiresAt } });
    const before = w.store.load();
    assert.throws(() => create(w.service), /invalid approval expiry/, JSON.stringify(expiresAt));
    const after = w.store.load();
    assert.equal(after.revision, before.revision, `${JSON.stringify(expiresAt)}: revision changed`);
    assert.deepEqual(after.requests, [], `${JSON.stringify(expiresAt)}: request saved`);
    assert.deepEqual(after.keyedFences, {}, `${JSON.stringify(expiresAt)}: fence allocated`);
    assert.deepEqual(after.idempotency, {}, `${JSON.stringify(expiresAt)}: idempotency recorded`);
    assert.deepEqual(after.evidence, [], `${JSON.stringify(expiresAt)}: evidence appended`);
  }
});

test('the default five-minute expiry and a valid explicit future expiry stay usable through approve and claim', () => {
  // Absent policy expiry keeps the five-minute default.
  const defaulted = world();
  const request = approved(defaulted);
  assert.equal(stored(defaulted, request.id).approval.expiresAt, new Date(T0 + 300000).toISOString());
  defaulted.clock.now = T0 + 299999;
  assert.equal(defaulted.service.execute('claimExecution', claimInput(request)).ok, true);

  // The exact expiry boundary still refuses the claim.
  const boundary = world();
  const atBoundary = approved(boundary);
  boundary.clock.now = T0 + 300000;
  assertRefusedWithoutEffect(boundary, () => boundary.service.execute('claimExecution', claimInput(atBoundary)), 'claim at exact expiry');

  // A valid explicit future expiry is honored beyond the default window.
  const explicitExpiry = new Date(T0 + 3600000).toISOString();
  const explicit = world({ policyExtra: { expiresAt: explicitExpiry } });
  const pending = create(explicit.service);
  const record = stored(explicit, pending.id);
  assert.equal(record.approval.expiresAt, explicitExpiry);
  explicit.clock.now = T0 + 600000;
  explicit.service.execute('approve', { credential: 'steward', requestId: record.id, fence: record.approval.fence });
  assert.equal(stored(explicit, record.id).status, 'approved');
  assert.equal(explicit.service.execute('claimExecution', claimInput(record)).ok, true);

  // The exact explicit boundary refuses approval as well.
  const lateApprove = world({ policyExtra: { expiresAt: explicitExpiry } });
  const late = stored(lateApprove, create(lateApprove.service).id);
  lateApprove.clock.now = T0 + 3600000;
  assertRefusedWithoutEffect(
    lateApprove,
    () => lateApprove.service.execute('approve', { credential: 'steward', requestId: late.id, fence: late.approval.fence }),
    'approve at exact explicit expiry',
  );
});

test('internal claim operations still require the existing authentication boundary', () => {
  const w = world();
  for (const operation of ['claimExecution', 'recordExecutionOutcome']) {
    assert.throws(() => w.service.execute(operation, {}), (error) => error.code === 'AUTH_REQUIRED');
  }
});
