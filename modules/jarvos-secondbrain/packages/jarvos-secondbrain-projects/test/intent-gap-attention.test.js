'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProjectRegistry } = require('../src/registry');
const { createHostAdmission } = require('../src/provider-contracts');
const {
  createMemoryIntentGapAlertState,
  deriveIntentGapAttention,
  acknowledgeIntentGapAlerts,
  intentSourceDescriptorDigest,
} = require('../src/intent-gap-attention');

const NOW = '2026-09-05T12:00:00.000Z';
const DIGEST = 'a'.repeat(64);

function makeRegistry() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-intent-gap-'));
  const registry = new ProjectRegistry({ stateDir, now: () => NOW });
  const complete = registry.create({ title: 'Complete project', goal: 'Keep going', definitionOfDone: 'Done' }).record;
  const incomplete = registry.create({ title: 'Missing project', goal: '-', definitionOfDone: '' }).record;
  return { registry, complete, incomplete, stateDir };
}

function sourceAuthority() {
  return createHostAdmission({
    producerId: 'projects-intent-source',
    secret: 'intent-source-secret',
    allowedSourceClasses: ['note', 'chat', 'execution'],
  });
}

function sourceFor(authority, record, overrides = {}, evidenceOverrides = {}) {
  const descriptor = {
    canonicalId: record.id,
    recordRevision: record.revision,
    registryGeneration: 2,
    role: 'migration-source',
    status: 'current',
    scope: 'record',
    fields: { goal: 'Restore the portable Projects context', definitionOfDone: 'Context is proven' },
    sourceRef: 'project-source-1',
    sourceDigest: DIGEST,
    ...overrides,
  };
  const descriptorDigest = intentSourceDescriptorDigest(descriptor);
  const evidence = authority.admitEvidenceUnit({
    observationId: `obs_${descriptorDigest.slice(0, 24)}`,
    evidenceId: `ev_${descriptorDigest.slice(0, 24)}`,
    sourceClass: 'note', occurredAt: NOW, observedAt: NOW, sourceRevision: 'brief-v1', sensitivity: 'owner-private', coverageState: 'fresh',
    ...evidenceOverrides,
    contentDigest: descriptorDigest,
  });
  return { ...descriptor, evidence };
}

function derive(registry, sources, options = {}) {
  return deriveIntentGapAttention({
    records: registry.list(),
    registryGeneration: registry.generation,
    sources,
    sourceAuthority: options.sourceAuthority,
    alertState: options.alertState,
    now: options.now || NOW,
  });
}

test('complete records do not produce gaps; digest-matched source proposes without a registry write', () => {
  const { registry, complete, incomplete, stateDir } = makeRegistry();
  try {
    const authority = sourceAuthority();
    const before = registry.generation;
    const result = derive(registry, [sourceFor(authority, incomplete)], { sourceAuthority: authority });
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].canonicalId, incomplete.id);
    assert.deepEqual(result.entries[0].missingFields, ['goal', 'definitionOfDone']);
    assert.equal(result.entries[0].disposition, 'recoverable-migration');
    assert.deepEqual(result.entries[0].proposedPatch, { goal: 'Restore the portable Projects context', definitionOfDone: 'Context is proven' });
    assert.equal(result.entries[0].registryGeneration, before);
    assert.match(result.entries[0].evidence[0].digest, /^[a-f0-9]{64}$/);
    assert.equal(result.entries[0].evidence[0].sourceDigest, DIGEST);
    assert.equal(result.entries.some((entry) => entry.canonicalId === complete.id), false);
    assert.equal(registry.generation, before);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('mismatch, stale, and narrower evidence cannot promote intent', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const authority = sourceAuthority();
    const current = sourceFor(authority, incomplete);
    const mismatch = derive(registry, [sourceFor(authority, incomplete, { canonicalId: 'prj_999999' })], { sourceAuthority: authority });
    assert.equal(mismatch.entries[0].disposition, 'unresolved-intent');
    const stale = derive(registry, [sourceFor(authority, incomplete, { registryGeneration: registry.generation - 1 })], { sourceAuthority: authority });
    assert.equal(stale.entries[0].disposition, 'stale-source');
    assert.deepEqual(stale.entries[0].evidence.map((entry) => entry.sourceRef), ['project-source-1']);
    const narrower = derive(registry, [sourceFor(authority, incomplete, { scope: 'narrower', role: 'canonical-brief' })], { sourceAuthority: authority });
    assert.equal(narrower.entries[0].disposition, 'brief-narrower-than-record');
    assert.equal(narrower.entries[0].proposedPatch, null);
    assert.equal(current.registryGeneration, registry.generation);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('signed source descriptors reject substituted fields and unauthenticated withdrawal', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const authority = sourceAuthority();
    const signed = sourceFor(authority, incomplete);
    const substituted = derive(registry, [{ ...signed, fields: { goal: 'Forged goal', definitionOfDone: 'Forged done' } }], { sourceAuthority: authority });
    assert.equal(substituted.entries[0].disposition, 'stale-source');
    assert.equal(substituted.entries[0].proposedPatch, null);
    const withdrawn = derive(registry, [{ ...signed, status: 'withdrawn' }], { sourceAuthority: authority });
    assert.equal(withdrawn.entries[0].disposition, 'stale-source');
    assert.deepEqual(withdrawn.retired, []);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('stale, future, or expired admitted evidence cannot recover intent', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const staleAuthority = sourceAuthority();
    const stale = derive(registry, [sourceFor(staleAuthority, incomplete, {}, {
      coverageState: 'stale', occurredAt: '2020-01-01T00:00:00.000Z', observedAt: '2020-01-01T00:00:00.000Z',
    })], { sourceAuthority: staleAuthority });
    assert.equal(stale.entries[0].disposition, 'stale-source');
    const futureAuthority = sourceAuthority();
    const future = derive(registry, [sourceFor(futureAuthority, incomplete, {}, {
      occurredAt: '2030-01-01T00:00:00.000Z', observedAt: '2030-01-01T00:00:00.000Z',
    })], { sourceAuthority: futureAuthority });
    assert.equal(future.entries[0].disposition, 'stale-source');
    const expiredAuthority = sourceAuthority();
    const expired = derive(registry, [sourceFor(expiredAuthority, incomplete, {}, {
      occurredAt: '2026-09-05T10:00:00.000Z', observedAt: '2026-09-05T10:00:00.000Z',
    })], { sourceAuthority: expiredAuthority });
    assert.equal(expired.entries[0].disposition, 'stale-source');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('persistent read visibility is distinct from alert-once and changes re-alert', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const authority = sourceAuthority();
    const alerts = createMemoryIntentGapAlertState();
    const source = sourceFor(authority, incomplete, { fields: { goal: '-', definitionOfDone: '-' } });
    const first = derive(registry, [source], { sourceAuthority: authority });
    const second = derive(registry, [source], { sourceAuthority: authority });
    const changed = derive(registry, [sourceFor(authority, incomplete, { sourceRef: 'project-source-2', fields: { goal: '-', definitionOfDone: '-' } })], { sourceAuthority: authority });
    assert.equal(first.entries.length, 1);
    assert.equal(acknowledgeIntentGapAlerts(first.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 1);
    assert.equal(second.entries.length, 1);
    assert.equal(acknowledgeIntentGapAlerts(second.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 0);
    assert.equal(changed.entries.length, 1);
    assert.equal(acknowledgeIntentGapAlerts(changed.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 1);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('withdrawn sources retire an obsolete gap without fabricating a resolution', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const authority = sourceAuthority();
    const result = derive(registry, [sourceFor(authority, incomplete, { status: 'withdrawn' })], { sourceAuthority: authority });
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.retired, [{ canonicalId: incomplete.id, reason: 'source-withdrawn-or-superseded' }]);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('overdue deferred evidence changes alert state without clearing the visible gap', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const authority = sourceAuthority();
    const alerts = createMemoryIntentGapAlertState();
    const source = sourceFor(authority, incomplete, {
      status: 'deferred',
      promisedResolutionAt: '2026-09-05T12:10:00.000Z',
      fields: { goal: '-', definitionOfDone: '-' },
    });
    const first = derive(registry, [source], { sourceAuthority: authority });
    const overdue = derive(registry, [source], { sourceAuthority: authority, now: '2026-09-05T12:30:00.000Z' });
    assert.equal(first.entries[0].disposition, 'deferred');
    assert.equal(overdue.entries[0].disposition, 'deferred');
    assert.equal(overdue.entries[0].resolutionOverdue, true);
    assert.equal(acknowledgeIntentGapAlerts(first.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 1);
    assert.equal(acknowledgeIntentGapAlerts(overdue.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 1);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('unrelated registry generations do not re-alert unchanged unresolved intent', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const alerts = createMemoryIntentGapAlertState();
    const first = derive(registry, [], {});
    assert.equal(acknowledgeIntentGapAlerts(first.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 1);
    registry.create({ title: 'Unrelated project', goal: 'Complete', definitionOfDone: 'Done' });
    const later = derive(registry, [], {});
    assert.equal(later.entries[0].canonicalId, incomplete.id);
    assert.equal(acknowledgeIntentGapAlerts(later.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 0);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('refresh-only evidence re-admission does not re-alert unchanged intent', () => {
  const { registry, incomplete, stateDir } = makeRegistry();
  try {
    const alerts = createMemoryIntentGapAlertState();
    const firstAuthority = sourceAuthority();
    const first = derive(registry, [sourceFor(firstAuthority, incomplete)], { sourceAuthority: firstAuthority });
    assert.equal(acknowledgeIntentGapAlerts(first.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 1);
    const refreshedAuthority = sourceAuthority();
    const refreshed = derive(registry, [sourceFor(refreshedAuthority, incomplete, {}, {
      occurredAt: '2026-09-05T11:30:00.000Z', observedAt: '2026-09-05T11:30:00.000Z', sourceRevision: 'brief-v2',
    })], { sourceAuthority: refreshedAuthority });
    assert.equal(refreshed.entries[0].disposition, 'recoverable-migration');
    assert.equal(acknowledgeIntentGapAlerts(refreshed.entries, { alertState: alerts, consumerKey: 'overseer' }).length, 0);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
