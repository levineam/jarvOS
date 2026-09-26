'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProjectRegistry } = require('../src/registry');
const {
  buildContextPacket,
  buildCanonicalRosterPacket,
  buildPortfolioProof,
  verifyPortfolioProof,
  PORTFOLIO_PROOF_SCOPE,
  PORTFOLIO_PROOF_QUERY,
} = require('../src/projects-context');
const { issueCapability, issueProofCapability } = require('../src/projects-context-capability');
const { evaluatePortfolioProofCoverage } = require('../../../../../scripts/lib/active-assistant-portfolio-coverage');

const NOW = '2026-09-11T12:00:00.000Z';
const EXPIRES = '2026-09-11T13:00:00.000Z';
const ORIENT_SECRET = 'orientation-test-only-secret';
const PROOF_SECRET = 'proof-test-only-secret';
const HOST_BINDING_DIGESTS = { configDigest: 'a'.repeat(64), providerDigest: 'b'.repeat(64) };

function fixture(t, count = 12, { verbose = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-portfolio-proof-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const registry = new ProjectRegistry({ stateDir, now: () => NOW });
  for (let i = 0; i < count; i += 1) {
    registry.create({
      title: `Project ${String(i).padStart(3, '0')}`,
      ...(verbose ? { definitionOfDone: 'Long accepted criteria. '.repeat(100) } : {}),
    });
  }
  return { registry, stateDir };
}

function orientationQuery(overrides = {}) {
  return {
    scope: { projectIds: [], outcomeIds: [], includeDescendants: true },
    include: ['hierarchy', 'activity', 'currentWork', 'attention'],
    limits: { maxItems: 24, maxBytes: 16000, maxProviderAgeSeconds: 3600 },
    ...overrides,
  };
}

function issueDefaultOrientationCapability(query, overrides = {}) {
  return issueCapability({
    authorization: { allowed: true },
    hostId: 'orientation-host',
    hostSecret: ORIENT_SECRET,
    subject: 'orientation-observer',
    query,
    scope: query.scope,
    limits: query.limits,
    redactionClass: 'private',
    providerCoverage: [],
    capabilityRevision: 'orientation-test-1',
    issuedAt: NOW,
    expiresAt: EXPIRES,
    nonce: 'orientation-test',
    ...overrides,
  });
}

function orientationInput(registry, { query, capability, capabilityOverrides, ...overrides } = {}) {
  const finalQuery = query || orientationQuery();
  return {
    registry,
    query: finalQuery,
    capability: capability || issueDefaultOrientationCapability(finalQuery, capabilityOverrides),
    capabilitySecret: ORIENT_SECRET,
    subject: 'orientation-observer',
    hostId: 'orientation-host',
    now: NOW,
    ...overrides,
  };
}

function issueDefaultProofCapability(overrides = {}) {
  return issueProofCapability({
    authorization: { allowed: true },
    hostId: 'proof-host',
    hostSecret: PROOF_SECRET,
    subject: 'proof-observer',
    query: PORTFOLIO_PROOF_QUERY,
    scope: PORTFOLIO_PROOF_SCOPE,
    limits: PORTFOLIO_PROOF_QUERY.limits,
    redactionClass: 'private',
    providerCoverage: [],
    capabilityRevision: 'proof-test-1',
    issuedAt: NOW,
    expiresAt: EXPIRES,
    nonce: 'proof-test',
    ...overrides,
  });
}

function proofInput(registry, { capability, capabilityOverrides, ...overrides } = {}) {
  return {
    registry,
    capability: capability || issueDefaultProofCapability(capabilityOverrides),
    capabilitySecret: PROOF_SECRET,
    subject: 'proof-observer',
    hostId: 'proof-host',
    hostBindingDigests: HOST_BINDING_DIGESTS,
    now: NOW,
    expectedGeneration: registry.generation,
    ...overrides,
  };
}

test('an orientation capability cannot authorize a portfolio proof and a proof capability cannot authorize orientation', (t) => {
  const { registry } = fixture(t, 3);
  const orientationCap = issueDefaultOrientationCapability(orientationQuery());
  const proofCap = issueDefaultProofCapability();

  assert.equal(buildPortfolioProof(proofInput(registry, { capability: orientationCap })).status, 'unavailable');
  assert.equal(buildContextPacket(orientationInput(registry, { capability: proofCap })).status, 'unavailable');
  assert.equal(buildCanonicalRosterPacket(orientationInput(registry, { capability: proofCap })).status, 'unavailable');
  assert.equal(buildPortfolioProof(proofInput(registry)).status, 'ok');
});

test('a 74-record portfolio truncates in orientation and the old roster but the fixed proof stays complete', (t) => {
  const { registry } = fixture(t, 74, { verbose: true });

  const orientation = buildContextPacket(orientationInput(registry));
  assert.equal(orientation.status, 'ok');
  assert.equal(orientation.packet.truncation.truncated, true);
  assert.ok(orientation.packet.canonical.records.length < 74);

  const roster = buildCanonicalRosterPacket(orientationInput(registry));
  assert.equal(roster.status, 'incomplete');
  assert.deepEqual(roster.roster.records, []);

  const proof = buildPortfolioProof(proofInput(registry));
  assert.equal(proof.status, 'ok');
  assert.equal(proof.proof.complete, true);
  assert.equal(proof.proof.records.length, 74);
  assert.equal(proof.proof.counts.records, 74);
  assert.equal(proof.proof.counts.projects, 74);
  assert.equal(proof.proof.counts.outcomes, 0);
  assert.deepEqual(proof.proof.records.map((r) => r.id), registry.list().map((r) => r.id).sort());
});

test('tampering any proof field, digest, or signature invalidates verification', (t) => {
  const { registry } = fixture(t, 5);
  const request = proofInput(registry);
  const built = buildPortfolioProof(request);
  assert.equal(built.status, 'ok');
  const verifyArgs = { capability: request.capability, capabilitySecret: request.capabilitySecret, subject: request.subject, hostId: request.hostId, now: NOW };
  assert.equal(verifyPortfolioProof(built.proof, verifyArgs).ok, true);

  const tamperCases = [
    (p) => ({ ...p, generation: p.generation + 1 }),
    (p) => ({ ...p, capturedAt: '2026-09-11T12:00:01.000Z' }),
    (p) => ({ ...p, hostBindingDigests: { ...p.hostBindingDigests, extra: 'c'.repeat(64) } }),
    (p) => ({ ...p, records: [...p.records].reverse() }),
    (p) => ({ ...p, records: p.records.slice(1) }),
    (p) => ({ ...p, complete: false }),
    (p) => ({ ...p, counts: { ...p.counts, records: p.counts.records + 1 } }),
    (p) => ({ ...p, recordsDigest: 'f'.repeat(64) }),
    (p) => ({ ...p, proofDigest: 'f'.repeat(64) }),
    (p) => ({ ...p, signature: `${p.signature}-tampered` }),
  ];
  for (const tamper of tamperCases) {
    const result = verifyPortfolioProof(tamper(built.proof), verifyArgs);
    assert.equal(result.ok, false, JSON.stringify(tamper(built.proof)));
  }
});

test('hostBindingDigests must be exactly configDigest and providerDigest, both 64-hex', (t) => {
  const { registry } = fixture(t, 2);
  const missingKey = { configDigest: 'a'.repeat(64) };
  const extraKey = { configDigest: 'a'.repeat(64), providerDigest: 'b'.repeat(64), extra: 'c'.repeat(64) };
  const empty = {};
  const wrongKeys = { deploymentConfig: 'a'.repeat(64), rollbackSource: 'b'.repeat(64) };

  for (const hostBindingDigests of [missingKey, extraKey, empty, wrongKeys]) {
    assert.equal(buildPortfolioProof(proofInput(registry, { hostBindingDigests })).status, 'unavailable');
  }

  const built = buildPortfolioProof(proofInput(registry));
  assert.equal(built.status, 'ok');
  const verifyArgs = { capability: issueDefaultProofCapability(), capabilitySecret: PROOF_SECRET, subject: 'proof-observer', hostId: 'proof-host', now: NOW };
  for (const hostBindingDigests of [missingKey, extraKey, empty, wrongKeys]) {
    const tampered = { ...built.proof, hostBindingDigests };
    assert.equal(verifyPortfolioProof(tampered, verifyArgs).ok, false);
  }
});

test('proof expiresAt is capped at capturedAt+900s when the capability outlives that window', (t) => {
  const { registry } = fixture(t, 2);
  const longCapability = issueDefaultProofCapability({ issuedAt: NOW, expiresAt: '2026-09-12T12:00:00.000Z' });
  const request = proofInput(registry, { capability: longCapability });
  const built = buildPortfolioProof(request);
  assert.equal(built.status, 'ok');
  assert.equal(built.proof.expiresAt, '2026-09-11T12:15:00.000Z');

  const verifyArgs = { capability: request.capability, capabilitySecret: request.capabilitySecret, subject: request.subject, hostId: request.hostId, now: NOW };
  assert.equal(verifyPortfolioProof(built.proof, verifyArgs).ok, true);
  assert.equal(verifyPortfolioProof(built.proof, { ...verifyArgs, now: '2026-09-11T12:15:00.000Z' }).ok, false);
});

test('proof expiresAt falls back to the shorter capability expiry when under the 900s cap', (t) => {
  const { registry } = fixture(t, 2);
  const shortCapability = issueDefaultProofCapability({ issuedAt: NOW, expiresAt: '2026-09-11T12:05:00.000Z' });
  const request = proofInput(registry, { capability: shortCapability });
  const built = buildPortfolioProof(request);
  assert.equal(built.status, 'ok');
  assert.equal(built.proof.expiresAt, '2026-09-11T12:05:00.000Z');
});

test('a proof capability with TTL over 24h is rejected outright', (t) => {
  const { registry } = fixture(t, 2);
  const longTtlCapability = issueDefaultProofCapability({ issuedAt: NOW, expiresAt: '2026-09-12T12:00:01.000Z' });
  assert.equal(buildPortfolioProof(proofInput(registry, { capability: longTtlCapability })).status, 'unavailable');
});

test('tampering proof expiresAt to a value beyond the recomputed cap invalidates verification', (t) => {
  const { registry } = fixture(t, 2);
  const longCapability = issueDefaultProofCapability({ issuedAt: NOW, expiresAt: '2026-09-12T12:00:00.000Z' });
  const request = proofInput(registry, { capability: longCapability });
  const built = buildPortfolioProof(request);
  assert.equal(built.status, 'ok');
  const verifyArgs = { capability: request.capability, capabilitySecret: request.capabilitySecret, subject: request.subject, hostId: request.hostId, now: NOW };
  const tampered = { ...built.proof, expiresAt: longCapability.expiresAt };
  const result = verifyPortfolioProof(tampered, verifyArgs);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-contract');
});

test('evaluatePortfolioProofCoverage requires strict equality between active IDs and the proof roster', (t) => {
  const { registry } = fixture(t, 3);
  const built = buildPortfolioProof(proofInput(registry));
  assert.equal(built.status, 'ok');
  const activeIds = built.proof.records.map((r) => r.id);

  const ready = evaluatePortfolioProofCoverage({ registryGeneration: registry.generation, activeProjectIds: activeIds, proof: built.proof });
  assert.equal(ready.ready, true);

  const missing = evaluatePortfolioProofCoverage({ registryGeneration: registry.generation, activeProjectIds: activeIds.slice(1), proof: built.proof });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.reasonCodes, ['portfolio_active_set_mismatch']);

  const extra = evaluatePortfolioProofCoverage({ registryGeneration: registry.generation, activeProjectIds: [...activeIds, 'prj_999999'], proof: built.proof });
  assert.equal(extra.ready, false);
  assert.deepEqual(extra.reasonCodes, ['portfolio_active_set_mismatch']);
});

test('proof build rejects an expected generation mismatch and a mid-collection generation change', (t) => {
  const { registry } = fixture(t, 2);
  assert.equal(buildPortfolioProof(proofInput(registry, { expectedGeneration: registry.generation - 1 })).status, 'unavailable');

  const list = registry.list.bind(registry);
  const changing = {
    generation: registry.generation,
    list() { this.generation += 1; return list(); },
  };
  assert.equal(buildPortfolioProof(proofInput(changing, { expectedGeneration: registry.generation })).status, 'unavailable');
});

test('malformed, duplicate, dangling, or cyclic hierarchy fails closed with no proof', (t) => {
  const { registry } = fixture(t, 1);
  const generation = registry.generation;
  const base = { id: 'prj_000001', kind: 'project', parentId: null, lifecycle: 'active', revision: 1 };

  const dangling = { generation, list: () => [{ ...base, parentId: 'prj_000099' }] };
  assert.equal(buildPortfolioProof(proofInput(dangling, { expectedGeneration: generation })).status, 'unavailable');

  const duplicate = { generation, list: () => [base, base] };
  assert.equal(buildPortfolioProof(proofInput(duplicate, { expectedGeneration: generation })).status, 'unavailable');

  const cyclic = {
    generation,
    list: () => [
      { id: 'prj_000001', kind: 'project', parentId: 'prj_000002', lifecycle: 'active', revision: 1 },
      { id: 'prj_000002', kind: 'project', parentId: 'prj_000001', lifecycle: 'active', revision: 1 },
    ],
  };
  assert.equal(buildPortfolioProof(proofInput(cyclic, { expectedGeneration: generation })).status, 'unavailable');

  const wrongKindParent = {
    generation,
    list: () => [
      { id: 'prj_000001', kind: 'project', parentId: null, lifecycle: 'active', revision: 1 },
      { id: 'out_000001', kind: 'outcome', parentId: 'prj_000001', lifecycle: 'active', revision: 1 },
      { id: 'prj_000002', kind: 'project', parentId: 'out_000001', lifecycle: 'active', revision: 1 },
    ],
  };
  assert.equal(buildPortfolioProof(proofInput(wrongKindParent, { expectedGeneration: generation })).status, 'unavailable');
});

test('a capability that under-authorizes the fixed proof budget fails closed', (t) => {
  const { registry } = fixture(t, 3);
  const smallCapability = issueDefaultProofCapability({ limits: { maxItems: 10, maxBytes: 1000, maxProviderAgeSeconds: 3600 } });
  const result = buildPortfolioProof(proofInput(registry, { capability: smallCapability }));
  assert.equal(result.status, 'unavailable');
});

test('building a portfolio proof performs no registry writes', (t) => {
  const { registry } = fixture(t, 10);
  const before = registry.snapshot();
  const result = buildPortfolioProof(proofInput(registry));
  assert.equal(result.status, 'ok');
  assert.deepEqual(registry.snapshot(), before);
});

test('buildCanonicalRosterPacket output is unaffected by the new proof contract', (t) => {
  const { registry } = fixture(t, 12);
  const before = registry.snapshot();
  const result = buildCanonicalRosterPacket(orientationInput(registry));
  assert.equal(result.status, 'ok');
  assert.equal(result.roster.contract, 'jarvos.projects-roster/v1');
  assert.equal(result.roster.complete, true);
  assert.equal(result.roster.generation, registry.generation);
  assert.deepEqual(result.roster.records.map((r) => r.id), registry.list().map((r) => r.id).sort());
  assert.deepEqual(Object.keys(result.roster.records[0]).sort(), ['id', 'kind', 'parentId', 'revision']);
  assert.deepEqual(registry.snapshot(), before);
});
