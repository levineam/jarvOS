'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SESSION_FOCUS_PRINCIPAL_CONTRACT,
  SESSION_FOCUS_BINDING_CONTRACT,
  createSessionFocusPrincipal,
  createSessionFocusBinding,
  resolveSessionFocus,
} = require('../src/session-focus.js');
const { createCanonicalReference, createExecutionReference } = require('../src/provider-contracts.js');

const HOST_SECRET = 'host-secret-value';
const ROUTE = 'codex';
const HARNESS_ID = 'codex';
const SESSION_ID = 'sess_0000000000000001';
const ACTOR_ID = 'actor_andrew';
const WORKSPACE_ID = 'ws_0000000000000001';
const TUPLE_DIGEST = 'a'.repeat(64);
const ISSUED_AT = '2026-08-27T12:00:00.000Z';
const EXPIRES_AT = '2026-08-27T13:00:00.000Z';
const NOW = '2026-08-27T12:05:00.000Z';

function principal(overrides = {}) {
  return createSessionFocusPrincipal({
    hostSecret: HOST_SECRET,
    route: ROUTE,
    harnessId: HARNESS_ID,
    sessionId: SESSION_ID,
    actorId: ACTOR_ID,
    workspaceId: WORKSPACE_ID,
    tupleDigest: TUPLE_DIGEST,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  });
}

function weakPrincipal(overrides = {}) {
  return principal({ sessionId: null, ...overrides });
}

function baseInput(overrides = {}) {
  return {
    principal: principal(),
    hostSecret: HOST_SECRET,
    expectedRoute: ROUTE,
    expectedTupleDigest: TUPLE_DIGEST,
    now: NOW,
    ...overrides,
  };
}

function executionLink(overrides = {}) {
  return createExecutionReference({
    contract: 'jarvos.execution-reference/v1',
    authority: 'beads',
    provider: 'beads',
    workspaceId: WORKSPACE_ID,
    itemId: 'beads-1',
    itemRevision: 'rev-7',
    status: 'in_progress',
    canonical: createCanonicalReference({
      contract: 'jarvos.canonical-reference/v1',
      kind: 'outcome',
      id: 'out_000001',
      revision: 1,
      breadcrumb: 'jarvOS › v1.0.0 release',
    }),
    capturedAt: NOW,
    sourceRevision: 'beads-source-1',
    ...overrides,
  });
}

function claim(overrides = {}) {
  return {
    workspaceId: WORKSPACE_ID, itemId: 'beads-1', revision: 'rev-7', actorId: ACTOR_ID, ...overrides,
  };
}

function outcomeRecord(overrides = {}) {
  return {
    canonicalId: 'out_000001',
    canonicalKind: 'outcome',
    canonicalRevision: 1,
    rootProjectId: 'prj_000001',
    breadcrumb: 'jarvOS › v1.0.0 release',
    quarantined: false,
    ...overrides,
  };
}

function projectRecord(overrides = {}) {
  return {
    canonicalId: 'prj_000001',
    canonicalKind: 'project',
    canonicalRevision: 2,
    rootProjectId: 'prj_000001',
    breadcrumb: 'jarvOS',
    quarantined: false,
    ...overrides,
  };
}

function currentCanonicalRecords(overrides = {}) {
  return { prj_000001: projectRecord(), out_000001: outcomeRecord(), ...overrides };
}

function binding(overrides = {}) {
  return {
    contract: SESSION_FOCUS_BINDING_CONTRACT,
    harnessId: HARNESS_ID,
    sessionId: SESSION_ID,
    workspaceDigest: principal().workspaceDigest,
    canonicalId: 'prj_000001',
    childCanonicalId: 'out_000001',
    workItemId: 'beads-1',
    lastContextStamp: 'stamp-1',
    lastWorkRevision: 'rev-6',
    lastPacketFingerprint: 'ctx_fingerprint_1',
    ...overrides,
  };
}

function workspaceLink(overrides = {}) {
  return { canonicalId: 'prj_000001', childCanonicalId: null, ...overrides };
}

test('an exact actor-owned current claim produces the sole writable/owned focus', () => {
  const result = resolveSessionFocus(baseInput({
    claim: claim(), executionLink: executionLink(), currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'claim');
  assert.equal(result.focus.access, 'owned');
  assert.equal(result.focus.canonicalId, 'prj_000001');
  assert.equal(result.focus.childCanonicalId, 'out_000001');
  assert.equal(result.focus.workItemId, 'beads-1');
  assert.equal(result.focus.breadcrumb, 'jarvOS › v1.0.0 release');
});

test('a claim held by a different actor remains read-only; every non-claim-owned branch is read-only', () => {
  const foreignClaim = resolveSessionFocus(baseInput({
    claim: claim({ actorId: 'actor_someone_else' }), executionLink: executionLink(), currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(foreignClaim.status, 'ok');
  assert.equal(foreignClaim.focus.access, 'read-only');

  const bindingFocus = resolveSessionFocus(baseInput({ existingBinding: binding(), currentCanonicalRecords: currentCanonicalRecords() }));
  assert.equal(bindingFocus.focus.access, 'read-only');

  const linkFocus = resolveSessionFocus(baseInput({ workspaceLink: workspaceLink(), currentCanonicalRecords: currentCanonicalRecords() }));
  assert.equal(linkFocus.focus.access, 'read-only');

  const portfolioFocus = resolveSessionFocus(baseInput({}));
  assert.equal(portfolioFocus.focus.access, 'read-only');
});

test('a forged, unauthorized, wrong-profile, or wrong-tuple-shape principal returns unavailable with no focus, non-enumeratingly', () => {
  const validClaimInput = { claim: claim(), executionLink: executionLink(), currentCanonicalRecords: currentCanonicalRecords() };

  const tampered = principal();
  tampered.signature = `${tampered.signature.slice(0, -1)}${tampered.signature.slice(-1) === 'A' ? 'B' : 'A'}`;
  const tamperedResult = resolveSessionFocus({ ...baseInput({ principal: tampered }), ...validClaimInput });

  const wrongProfile = { ...principal(), profile: 'orientation' };
  const wrongProfileResult = resolveSessionFocus({ ...baseInput({ principal: wrongProfile }), ...validClaimInput });

  const missingField = principal();
  delete missingField.tupleDigest;
  const missingFieldResult = resolveSessionFocus({ ...baseInput({ principal: missingField }), ...validClaimInput });

  const extraField = { ...principal(), extra: 'unexpected' };
  const extraFieldResult = resolveSessionFocus({ ...baseInput({ principal: extraField }), ...validClaimInput });

  const notAuthorized = principal();
  notAuthorized.authorized = false;
  const notAuthorizedResult = resolveSessionFocus({ ...baseInput({ principal: notAuthorized }), ...validClaimInput });

  const malformedShape = { ...principal(), tupleDigest: 'not-a-digest' };
  const malformedShapeResult = resolveSessionFocus({ ...baseInput({ principal: malformedShape }), ...validClaimInput });

  const expired = principal({ issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T01:00:00.000Z' });
  const expiredResult = resolveSessionFocus({ ...baseInput({ principal: expired }), ...validClaimInput });

  for (const result of [
    tamperedResult, wrongProfileResult, missingFieldResult, extraFieldResult,
    notAuthorizedResult, malformedShapeResult, expiredResult,
  ]) {
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'FOCUS_UNAUTHORIZED');
    assert.equal(result.reason, 'session focus is unavailable');
    assert.equal(result.focus, null);
  }
});

test('created principals persist no capability secret', () => {
  const issued = principal();
  assert.deepEqual(Object.keys(issued).sort(), [
    'actorId', 'authorized', 'contract', 'expiresAt', 'harnessId', 'issuedAt', 'nonce',
    'profile', 'route', 'sessionId', 'signature', 'tupleDigest', 'workspaceDigest', 'workspaceId',
  ].sort());
  assert.equal(issued.contract, SESSION_FOCUS_PRINCIPAL_CONTRACT);
  assert.ok(!('hostSecret' in issued) && !('secret' in issued));
});

test('an empty string, empty Buffer, or empty Uint8Array host secret is rejected everywhere HMAC/signing/workspace-digest is used', () => {
  for (const emptySecret of ['', Buffer.alloc(0), new Uint8Array(0)]) {
    assert.throws(() => createSessionFocusPrincipal({
      hostSecret: emptySecret,
      route: ROUTE,
      harnessId: HARNESS_ID,
      sessionId: SESSION_ID,
      actorId: ACTOR_ID,
      workspaceId: WORKSPACE_ID,
      tupleDigest: TUPLE_DIGEST,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    }), /non-empty string or byte array/);

    const result = resolveSessionFocus(baseInput({
      hostSecret: emptySecret,
      claim: claim(),
      executionLink: executionLink(),
      currentCanonicalRecords: currentCanonicalRecords(),
    }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'FOCUS_UNAUTHORIZED');
    assert.equal(result.focus, null);
  }
});

test('a missing expected route or tuple, or a wrong route or tuple, is rejected the same non-enumerating way as a forged principal', () => {
  const validClaimInput = { claim: claim(), executionLink: executionLink(), currentCanonicalRecords: currentCanonicalRecords() };

  const missingRoute = resolveSessionFocus({ ...baseInput({ expectedRoute: undefined }), ...validClaimInput });
  const missingTuple = resolveSessionFocus({ ...baseInput({ expectedTupleDigest: undefined }), ...validClaimInput });
  const wrongRoute = resolveSessionFocus({ ...baseInput({ expectedRoute: 'claude' }), ...validClaimInput });
  const wrongTuple = resolveSessionFocus({ ...baseInput({ expectedTupleDigest: 'b'.repeat(64) }), ...validClaimInput });

  for (const result of [missingRoute, missingTuple, wrongRoute, wrongTuple]) {
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'FOCUS_UNAUTHORIZED');
    assert.equal(result.focus, null);
  }
});

test('a signed principal for a different route or tuple than it was issued for is rejected', () => {
  const forOtherTuple = principal({ tupleDigest: 'b'.repeat(64) });
  const forOtherRoute = principal({ route: 'claude' });

  const tupleResult = resolveSessionFocus(baseInput({ principal: forOtherTuple }));
  const routeResult = resolveSessionFocus(baseInput({ principal: forOtherRoute }));

  for (const result of [tupleResult, routeResult]) {
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'FOCUS_UNAUTHORIZED');
    assert.equal(result.focus, null);
  }
});

test('a weak session (sessionId: null) can resolve an exact claim into useful, always read-only focus', () => {
  const result = resolveSessionFocus(baseInput({
    principal: weakPrincipal(),
    claim: claim(),
    executionLink: executionLink(),
    currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'claim');
  assert.equal(result.focus.access, 'read-only');
  assert.equal(result.focus.canonicalId, 'prj_000001');
});

test('a weak session (sessionId: null) can resolve a workspace link into useful, always read-only focus', () => {
  const result = resolveSessionFocus(baseInput({
    principal: weakPrincipal(),
    workspaceLink: workspaceLink(),
    currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'workspace-link');
  assert.equal(result.focus.access, 'read-only');
  assert.equal(result.focus.canonicalId, 'prj_000001');
});

test('a weak session (sessionId: null) with no exact evidence returns workspace-only unknown/read-only focus, not portfolio', () => {
  const result = resolveSessionFocus(baseInput({ principal: weakPrincipal() }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'workspace-only');
  assert.equal(result.focus.access, 'read-only');
  assert.equal(result.focus.canonicalId, null);
});

test('a weak session (sessionId: null) cannot use an existing session binding: it is not consulted and resolution falls through', () => {
  const result = resolveSessionFocus(baseInput({
    principal: weakPrincipal(),
    existingBinding: binding(),
    currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'workspace-only');
  assert.equal(result.focus.access, 'read-only');
});

test('a stable session (non-null sessionId) retains normal binding and portfolio behavior', () => {
  const bindingResult = resolveSessionFocus(baseInput({ existingBinding: binding(), currentCanonicalRecords: currentCanonicalRecords() }));
  assert.equal(bindingResult.status, 'ok');
  assert.equal(bindingResult.focus.source, 'binding');

  const portfolioResult = resolveSessionFocus(baseInput({}));
  assert.equal(portfolioResult.status, 'ok');
  assert.equal(portfolioResult.focus.source, 'portfolio');
});

test('a foreign harness/session/workspace binding is a terminal typed conflict, not a fallthrough', () => {
  const foreignHarness = resolveSessionFocus(baseInput({
    existingBinding: binding({ harnessId: 'hermes' }), currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(foreignHarness.status, 'conflict');
  assert.equal(foreignHarness.code, 'FOCUS_BINDING_MISMATCH');
  assert.equal(foreignHarness.focus, null);

  const foreignSession = resolveSessionFocus(baseInput({
    existingBinding: binding({ sessionId: 'sess_other' }), currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(foreignSession.status, 'conflict');
  assert.equal(foreignSession.code, 'FOCUS_BINDING_MISMATCH');
  assert.equal(foreignSession.focus, null);

  const foreignWorkspace = resolveSessionFocus(baseInput({
    existingBinding: binding({ workspaceDigest: 'wrong-digest' }), currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(foreignWorkspace.status, 'conflict');
  assert.equal(foreignWorkspace.code, 'FOCUS_BINDING_MISMATCH');
  assert.equal(foreignWorkspace.focus, null);
});

test('a malformed existing binding is a terminal typed conflict', () => {
  const result = resolveSessionFocus(baseInput({
    existingBinding: { ...binding(), contract: 'jarvos.wrong-contract/v1' },
    currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'FOCUS_BINDING_INVALID');
  assert.equal(result.focus, null);
});

test('a binding without matching current canonical evidence, with the wrong root, or with a quarantined current record is a terminal typed conflict, even when a valid binding would otherwise resolve', () => {
  const missingEvidence = resolveSessionFocus(baseInput({
    existingBinding: binding(), currentCanonicalRecords: { prj_000001: projectRecord() },
  }));
  assert.equal(missingEvidence.status, 'conflict');
  assert.equal(missingEvidence.code, 'FOCUS_BINDING_CANONICAL_MISMATCH');
  assert.equal(missingEvidence.focus, null);

  const wrongRoot = resolveSessionFocus(baseInput({
    existingBinding: binding(),
    currentCanonicalRecords: currentCanonicalRecords({ out_000001: outcomeRecord({ rootProjectId: 'prj_000002' }) }),
  }));
  assert.equal(wrongRoot.status, 'conflict');
  assert.equal(wrongRoot.code, 'FOCUS_BINDING_CANONICAL_MISMATCH');
  assert.equal(wrongRoot.focus, null);

  const quarantined = resolveSessionFocus(baseInput({
    existingBinding: binding(),
    currentCanonicalRecords: currentCanonicalRecords({ out_000001: outcomeRecord({ quarantined: true }) }),
  }));
  assert.equal(quarantined.status, 'conflict');
  assert.equal(quarantined.code, 'FOCUS_BINDING_CANONICAL_MISMATCH');
  assert.equal(quarantined.focus, null);
});

test('a claim revision mismatch is rejected as a typed stale-work conflict, not fallthrough', () => {
  const result = resolveSessionFocus(baseInput({
    claim: claim({ revision: 'rev-stale' }),
    executionLink: executionLink(),
    currentCanonicalRecords: currentCanonicalRecords(),
    // A perfectly valid binding is available too, proving the stale claim
    // does not fall through to it.
    existingBinding: binding(),
  }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'FOCUS_CLAIM_STALE');
  assert.equal(result.focus, null);
});

test('an execution-link canonical revision mismatch is a typed claim-canonical-stale conflict, even when a lower-priority valid binding exists', () => {
  const result = resolveSessionFocus(baseInput({
    claim: claim(),
    executionLink: executionLink(),
    currentCanonicalRecords: currentCanonicalRecords({ out_000001: outcomeRecord({ canonicalRevision: 2 }) }),
    existingBinding: binding(),
  }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'FOCUS_CLAIM_CANONICAL_STALE');
  assert.equal(result.focus, null);
});

test('an existing verified session binding resolves read-only focus after rereading current canonical evidence', () => {
  const result = resolveSessionFocus(baseInput({ existingBinding: binding(), currentCanonicalRecords: currentCanonicalRecords() }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'binding');
  assert.equal(result.focus.access, 'read-only');
  assert.equal(result.focus.canonicalId, 'prj_000001');
  assert.equal(result.focus.childCanonicalId, 'out_000001');
  assert.equal(result.focus.breadcrumb, 'jarvOS › v1.0.0 release');
});

test('an unambiguous workspace/repository link resolves read-only focus', () => {
  const result = resolveSessionFocus(baseInput({ workspaceLink: workspaceLink(), currentCanonicalRecords: currentCanonicalRecords() }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'workspace-link');
  assert.equal(result.focus.access, 'read-only');
  assert.equal(result.focus.canonicalId, 'prj_000001');
});

test('an ambiguous workspace link is a terminal typed conflict, never a fallthrough to portfolio', () => {
  const result = resolveSessionFocus(baseInput({ workspaceLink: 'ambiguous' }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'FOCUS_WORKSPACE_LINK_AMBIGUOUS');
  assert.equal(result.focus, null);
});

test('a malformed supplied workspace link is a terminal typed conflict', () => {
  const result = resolveSessionFocus(baseInput({ workspaceLink: { canonicalId: 'not-canonical', childCanonicalId: null } }));
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'FOCUS_WORKSPACE_LINK_INVALID');
  assert.equal(result.focus, null);
});

test('a workspace link with missing, wrong-root, or quarantined current canonical evidence is a terminal typed conflict', () => {
  const missingEvidence = resolveSessionFocus(baseInput({ workspaceLink: workspaceLink(), currentCanonicalRecords: {} }));
  assert.equal(missingEvidence.status, 'conflict');
  assert.equal(missingEvidence.code, 'FOCUS_WORKSPACE_LINK_STALE');

  const wrongRoot = resolveSessionFocus(baseInput({
    workspaceLink: workspaceLink(), currentCanonicalRecords: { prj_000001: projectRecord({ rootProjectId: 'prj_000002' }) },
  }));
  assert.equal(wrongRoot.status, 'conflict');
  assert.equal(wrongRoot.code, 'FOCUS_WORKSPACE_LINK_STALE');

  const quarantined = resolveSessionFocus(baseInput({
    workspaceLink: workspaceLink(), currentCanonicalRecords: { prj_000001: projectRecord({ quarantined: true }) },
  }));
  assert.equal(quarantined.status, 'conflict');
  assert.equal(quarantined.code, 'FOCUS_WORKSPACE_LINK_STALE');
});

test('missing focus falls through to bounded whole-portfolio orientation with unknown focus and no identity inference', () => {
  const result = resolveSessionFocus(baseInput({}));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.source, 'portfolio');
  assert.equal(result.focus.access, 'read-only');
  assert.equal(result.focus.canonicalId, null);
  assert.equal(result.focus.childCanonicalId, null);
  assert.deepEqual(result.focus.scope, { projectIds: [], outcomeIds: [], includeDescendants: true });
});

test('createSessionFocusBinding accepts an exact metadata-only stable binding and rejects weak-session, raw/extra, or malformed input', () => {
  const created = createSessionFocusBinding({
    harnessId: HARNESS_ID,
    sessionId: SESSION_ID,
    workspaceDigest: principal().workspaceDigest,
    canonicalId: 'prj_000001',
    childCanonicalId: null,
    workItemId: null,
    lastContextStamp: null,
    lastWorkRevision: null,
    lastPacketFingerprint: null,
  });
  assert.equal(created.contract, SESSION_FOCUS_BINDING_CONTRACT);
  assert.equal(created.sessionId, SESSION_ID);
  assert.equal(created.canonicalId, 'prj_000001');

  assert.throws(() => createSessionFocusBinding({
    harnessId: HARNESS_ID,
    sessionId: null,
    workspaceDigest: principal().workspaceDigest,
    canonicalId: 'prj_000001',
    childCanonicalId: null,
    workItemId: null,
    lastContextStamp: null,
    lastWorkRevision: null,
    lastPacketFingerprint: null,
  }));

  assert.throws(() => createSessionFocusBinding({
    contract: SESSION_FOCUS_BINDING_CONTRACT,
    harnessId: HARNESS_ID,
    sessionId: SESSION_ID,
    workspaceDigest: principal().workspaceDigest,
    canonicalId: 'prj_000001',
    childCanonicalId: null,
    workItemId: null,
    lastContextStamp: null,
    lastWorkRevision: null,
    lastPacketFingerprint: null,
  }), /must not assert its own contract/);

  assert.throws(() => createSessionFocusBinding({
    harnessId: HARNESS_ID,
    sessionId: SESSION_ID,
    workspaceDigest: principal().workspaceDigest,
    canonicalId: 'prj_000001',
    childCanonicalId: null,
    workItemId: null,
    lastContextStamp: null,
    lastWorkRevision: null,
    lastPacketFingerprint: null,
    extra: 'unexpected',
  }));

  assert.throws(() => createSessionFocusBinding({
    harnessId: HARNESS_ID,
    sessionId: SESSION_ID,
    workspaceDigest: principal().workspaceDigest,
    canonicalId: 'not-canonical',
    childCanonicalId: null,
    workItemId: null,
    lastContextStamp: null,
    lastWorkRevision: null,
    lastPacketFingerprint: null,
  }));
});

test('internal host-authorized resolution stays bounded and healthy end to end', () => {
  const result = resolveSessionFocus(baseInput({
    claim: claim(), executionLink: executionLink(), currentCanonicalRecords: currentCanonicalRecords(),
  }));
  assert.equal(result.status, 'ok');
  assert.equal(result.focus.access, 'owned');
  assert.deepEqual(result.focus.scope, { projectIds: [], outcomeIds: ['out_000001'], includeDescendants: true });
});
