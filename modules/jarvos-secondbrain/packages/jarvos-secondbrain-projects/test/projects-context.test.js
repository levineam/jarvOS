'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ProjectRegistry } = require('../src/registry');
const { CONTEXT_CONTRACT, buildContextPacket, normalizeContextPacket, SUPPORTED_CONTEXT_SCHEMA_VERSIONS, validateContextPacket, validateContextQuery } = require('../src/projects-context');
const { CAPABILITY_CONTRACT, issueCapability, verifyCapability } = require('../src/projects-context-capability');
const inferenceContracts = require('../src/project-inference-contracts');
const {
  PROVIDER_STATES,
  createHostAdmission,
  submitAgentObservation,
  validateProviderSnapshot,
} = require('../src/provider-contracts');

const NOW = '2026-08-08T12:00:00.000Z';
const LATER = '2026-08-08T13:00:00.000Z';
const SECRET = 'test-only-host-secret';
const PROVIDER_SECRET = 'test-only-provider-secret';

function makeRegistry() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvos-project-context-'));
  const registry = new ProjectRegistry({ stateDir, now: () => NOW });
  const root = registry.create({ title: 'jarvOS', aliases: ['JarvOS'], declaredPriority: 'high' });
  const outcome = registry.create({ kind: 'outcome', title: 'v1.0.0 release', parentId: root.record.id });
  return { registry, root: root.record, outcome: outcome.record, stateDir };
}

function queryFor(root, outcome, overrides = {}) {
  return {
    scope: { projectIds: [root.id], outcomeIds: [outcome.id], includeDescendants: false },
    include: ['hierarchy', 'activity', 'currentWork', 'attention'],
    limits: { maxItems: 50, maxBytes: 20000, maxProviderAgeSeconds: 3600 },
    ...overrides,
  };
}

function issue(query, overrides = {}) {
  return issueCapability({
    authorization: { allowed: true },
    hostId: 'projects-host',
    hostSecret: SECRET,
    subject: 'agent:test-session',
    query,
    redactionClass: 'private',
    providerCoverage: ['activity', 'todo', 'beads', 'paperclip', 'release', 'stewardship'],
    capabilityRevision: 'projects-context-cap-1',
    issuedAt: NOW,
    expiresAt: LATER,
    nonce: 'nonce-1',
    ...overrides,
  });
}

function snapshot(provider, state, overrides = {}) {
  const base = {
    contract: 'jarvos.provider-snapshot/v1',
    provider,
    state,
    trust: 'verified',
    capturedAt: NOW,
    watermark: `${provider}-watermark-1`,
    scope: { projectIds: [], outcomeIds: [] },
    summaries: [],
    omissions: [],
    errorCode: null,
    admission: null,
    ...overrides,
  };
  if (base.trust === 'unverified') return base;
  return createHostAdmission({ producerId: `provider:${provider}`, secret: PROVIDER_SECRET, allowedProviders: [provider] }).admitProviderSnapshot(base);
}

function providerAuthorities(providers) {
  return Object.fromEntries(Object.keys(providers).map((provider) => [
    provider,
    createHostAdmission({ producerId: `provider:${provider}`, secret: PROVIDER_SECRET, allowedProviders: [provider] }),
  ]));
}

function candidate(overrides = {}) {
  return inferenceContracts.createProjectCandidate({
    evidenceIds: ['ev_000001'],
    evidenceSetWatermark: 'a'.repeat(64),
    engineRevision: 'deterministic-baseline-v1',
    policyRevision: 'jarvos.project-inference-policy-v1',
    kind: 'project',
    title: 'A provisional project',
    aliases: [],
    parentId: null,
    parentAlternatives: [],
    confidence: {
      identityMatch: 0.5,
      novelty: 0.5,
      sourceDiversity: 0.5,
      temporalContinuity: 0.5,
      parentFit: 0.5,
      sourceCoverage: 0.5,
    },
    disposition: 'provisional',
    reasonCodes: ['needs-review'],
    lineage: [],
    ...overrides,
  });
}

function coverage(sourceClass, state) {
  return inferenceContracts.createCoverageStatus({
    sourceClass, state, observedAt: NOW, sourceRevision: `${sourceClass}-revision-1`,
  });
}

test('canonical-only packet is useful and optional providers are visibly omitted', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const result = buildContextPacket({
    registry,
    query,
    capability: issue(query),
    capabilitySecret: SECRET,
    subject: 'agent:test-session',
    hostId: 'projects-host',
    now: NOW,
    providers: {},
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.packet.contract, CONTEXT_CONTRACT);
  assert.deepEqual(result.packet.query, query);
  assert.equal(result.packet.canonical.records.length, 2);
  assert.equal(result.packet.canonical.records[0].breadcrumb, 'jarvOS');
  const child = result.packet.canonical.records.find((record) => record.id === outcome.id);
  assert.equal(child.breadcrumb, 'jarvOS › v1.0.0 release');
  assert.deepEqual(child.priority, {
    declared: 'unset', effective: 'high', source: 'inherited', sourceRecordId: root.id, sourceKind: 'project',
  });
  assert.equal(result.packet.providers.todo.state, 'omitted');
  assert.equal(result.packet.providers.beads.state, 'omitted');
  assert.deepEqual(result.packet.activity, []);
  assert.deepEqual(result.packet.currentWork, []);
  assert.deepEqual(result.packet.attention, []);
  assert.equal(validateContextPacket(result.packet).ok, true);
});

test('inference is versioned, provisional candidates are explicitly non-actionable, and coverage remains typed', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const provisional = candidate({ parentId: root.id, parentAlternatives: [root.id, 'prj_999999'] });
  const result = buildContextPacket({
    registry,
    query,
    capability: issue(query),
    capabilitySecret: SECRET,
    subject: 'agent:test-session',
    hostId: 'projects-host',
    now: NOW,
    providers: {},
    inference: {
      candidates: [provisional],
      coverage: [
        coverage('note', 'fresh'),
        coverage('chat', 'healthy-empty'),
        coverage('execution', 'partial'),
        coverage('release', 'unavailable'),
        coverage('stewardship', 'policy-omitted'),
      ],
      watermark: 'b'.repeat(64),
      watermarks: {},
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.packet.schemaVersion, 2);
  assert.equal(result.packet.inference.candidates.length, 1);
  assert.equal(result.packet.inference.candidates[0].disposition, 'provisional');
  assert.equal(result.packet.inference.candidates[0].actionable, false);
  assert.deepEqual(result.packet.inference.candidates[0].parentAlternatives, [root.id]);
  assert.deepEqual(result.packet.inference.coverage.map((entry) => entry.state), ['healthy-empty', 'partial', 'fresh', 'unavailable', 'policy-omitted']);
  assert.equal(result.packet.inference.watermark, 'b'.repeat(64));
  assert.equal(result.packet.watermarks.registry, `registry:${registry.generation}`);
  assert.equal(validateContextPacket(result.packet).ok, true);

  const forged = {
    ...result.packet,
    inference: {
      ...result.packet.inference,
      candidates: [{ ...result.packet.inference.candidates[0], privateEvidence: 'must-not-cross' }],
    },
  };
  assert.equal(validateContextPacket(forged).ok, false);
});

test('narrow Projects scope excludes unbound candidates and does not enumerate alternative parents', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome, { scope: { projectIds: [root.id], outcomeIds: [], includeDescendants: false } });
  const inScope = candidate({ parentId: root.id, parentAlternatives: [root.id, 'prj_999999'] });
  const outOfScope = candidate({
    candidateId: 'cand_22222222222222222222222222222222',
    title: 'Unbound candidate',
    evidenceIds: ['ev_000002'],
    parentId: 'prj_999999',
  });
  const result = buildContextPacket({
    registry,
    query,
    capability: issue(query, { nonce: 'nonce-narrow' }),
    capabilitySecret: SECRET,
    subject: 'agent:test-session',
    hostId: 'projects-host',
    now: NOW,
    providers: {},
    inference: { candidates: [inScope, outOfScope] },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.packet.canonical.records.map((record) => record.id), [root.id]);
  assert.deepEqual(result.packet.inference.candidates.map((entry) => entry.title), ['A provisional project']);
  assert.deepEqual(result.packet.inference.candidates[0].parentAlternatives, [root.id]);
});

test('public context redacts provisional candidate identities', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const result = buildContextPacket({
    registry,
    query,
    capability: issue(query, { nonce: 'nonce-public-inference', redactionClass: 'public' }),
    capabilitySecret: SECRET,
    subject: 'agent:test-session',
    hostId: 'projects-host',
    now: NOW,
    providers: {},
    inference: { candidates: [candidate({ parentId: root.id })] },
  });

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.packet.inference.candidates, []);
  assert.ok(result.packet.omissions.includes('inference:candidates:redacted'));
  assert.equal(JSON.stringify(result.packet).includes('A provisional project'), false);
  assert.equal(validateContextPacket(result.packet).ok, true);
});

test('activity summaries carry the admission-time canonical root tuple', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const activity = snapshot('activity', 'fresh', {
    summaries: [{
      id: 'activity-admission', canonicalId: outcome.id, category: 'activity', status: 'done', title: 'admitted activity',
      occurredAt: NOW, observedAt: NOW, evidenceRefs: ['activity:admission'],
      canonicalAtAdmission: {
        canonicalId: outcome.id,
        canonicalKind: 'outcome',
        canonicalRevision: 1,
        rootProjectId: root.id,
        rootProjectRevision: 1,
        rootProjectLifecycle: 'active',
        registryGeneration: registry.generation,
      },
    }],
  });
  const result = buildContextPacket({
    registry, query, capability: issue(query, { nonce: 'nonce-admission' }), capabilitySecret: SECRET,
    subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: { activity },
    providerAuthorities: providerAuthorities({ activity }),
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.packet.activity[0].canonicalAtAdmission, {
    canonicalId: outcome.id,
    canonicalKind: 'outcome',
    canonicalRevision: 1,
    rootProjectId: root.id,
    rootProjectRevision: 1,
    rootProjectLifecycle: 'active',
    registryGeneration: registry.generation,
  });
  assert.equal(validateContextPacket(result.packet).ok, true);

  const tampered = structuredClone(activity);
  tampered.summaries[0].canonicalAtAdmission.rootProjectRevision += 1;
  const rejected = buildContextPacket({
    registry, query, capability: issue(query, { nonce: 'nonce-admission-tamper' }), capabilitySecret: SECRET,
    subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: { activity: tampered },
    providerAuthorities: providerAuthorities({ activity: tampered }),
  });
  assert.equal(rejected.packet.providers.activity.state, 'unknown');
  assert.deepEqual(rejected.packet.activity, []);
});

test('provider states remain distinct and verified summaries feed bounded sections', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const providers = {
    todo: snapshot('todo', 'fresh', {
      summaries: [
        {
          id: 'todo-1', canonicalId: outcome.id, category: 'intent', status: 'open', title: 'Finish release notes',
          occurredAt: NOW, observedAt: NOW, evidenceRefs: ['todo:todo-1'],
        },
        {
          id: 'todo-closed', canonicalId: outcome.id, category: 'work', status: 'closed', title: 'Finished release notes',
          occurredAt: NOW, observedAt: NOW, evidenceRefs: ['todo:todo-closed'],
        },
      ],
    }),
    beads: snapshot('beads', 'healthy-empty'),
    paperclip: snapshot('paperclip', 'stale', { capturedAt: '2026-08-08T10:00:00.000Z' }),
    release: snapshot('release', 'partial', { omissions: ['release-proof'], errorCode: 'PARTIAL' }),
    stewardship: snapshot('stewardship', 'unknown', { trust: 'unverified' }),
    activity: snapshot('activity', 'unavailable', { errorCode: 'OFFLINE' }),
  };
  const result = buildContextPacket({
    registry, query, capability: issue(query), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers, providerAuthorities: providerAuthorities(providers),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.packet.providers.todo.state, 'fresh');
  assert.equal(result.packet.providers.todo.trust, 'verified');
  assert.equal(result.packet.providers.beads.state, 'healthy-empty');
  assert.equal(result.packet.providers.paperclip.state, 'stale');
  assert.equal(result.packet.providers.release.state, 'partial');
  assert.equal(result.packet.providers.stewardship.state, 'unknown');
  assert.equal(result.packet.providers.activity.state, 'unavailable');
  assert.equal(result.packet.currentWork.length, 1);
  assert.equal(result.packet.currentWork[0].id, 'todo-1');
  assert.equal(result.packet.currentWork.some((entry) => entry.id === 'todo-closed'), false);
  assert.equal(result.packet.omissions.some((entry) => entry.includes('untrusted')), true);
});

test('verified provider snapshots fail closed without their configured authority', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const providers = {
    todo: snapshot('todo', 'fresh', {
      summaries: [{
        id: 'todo-forged', canonicalId: outcome.id, category: 'intent', status: 'open', title: 'must not appear',
        occurredAt: NOW, observedAt: NOW, evidenceRefs: ['forged:1'],
      }],
    }),
  };
  const result = buildContextPacket({
    registry, query, capability: issue(query), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.packet.providers.todo.state, 'unknown');
  assert.deepEqual(result.packet.currentWork, []);
  assert.equal(result.packet.omissions.some((entry) => entry.includes('untrusted')), true);
});

test('provider coverage and serving-host identity are enforced by the capability', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const providers = { beads: snapshot('beads', 'fresh') };
  const coverageLimited = issue(query, { providerCoverage: ['todo'] });
  const limited = buildContextPacket({
    registry, query, capability: coverageLimited, capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW,
    providers, providerAuthorities: providerAuthorities(providers),
  });
  assert.equal(limited.status, 'ok');
  assert.equal(limited.packet.providers.beads.state, 'omitted');
  assert.equal(limited.packet.providers.beads.omissions.includes('provider:beads:not-covered'), true);
  assert.deepEqual(buildContextPacket({
    registry, query, capability: issue(query), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'other-host', now: NOW, providers: {},
  }), { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' });
  const mismatchedScope = issue(query, { scope: { projectIds: [], outcomeIds: [], includeDescendants: false }, nonce: 'nonce-scope' });
  assert.deepEqual(buildContextPacket({
    registry, query, capability: mismatchedScope, capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: {},
  }), { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' });
  assert.equal(outcome.kind, 'outcome');
});

test('freshness, capture boundary, redaction, deterministic ordering, and truncation are explicit', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome, {
    limits: { maxItems: 1, maxBytes: 20000, maxProviderAgeSeconds: 60 },
  });
  const providers = {
    todo: snapshot('todo', 'fresh', {
      capturedAt: '2026-08-08T10:00:00.000Z',
      summaries: [{
        id: 'todo-2', canonicalId: outcome.id, category: 'intent', status: 'open', title: 'older',
        occurredAt: '2026-08-08T10:00:00.000Z', observedAt: '2026-08-08T10:00:00.000Z', evidenceRefs: ['todo:2'],
      }, {
        id: 'todo-1', canonicalId: outcome.id, category: 'intent', status: 'open', title: 'future',
        occurredAt: '2026-08-08T13:00:01.000Z', observedAt: '2026-08-08T13:00:01.000Z', evidenceRefs: ['todo:1'],
      }],
    }),
  };
  const result = buildContextPacket({
    registry,
    query,
    capability: issue(query, { redactionClass: 'public' }),
    capabilitySecret: SECRET,
    subject: 'agent:test-session',
    hostId: 'projects-host',
    now: NOW,
    providers,
    providerAuthorities: providerAuthorities(providers),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.packet.providers.todo.state, 'stale');
  assert.equal(result.packet.truncation.truncated, true);
  assert.equal(result.packet.truncation.omittedItems > 0, true);
  assert.equal(result.packet.omissions.some((entry) => entry.includes('capture-boundary')), true);
  assert.equal(result.packet.canonical.records[0].goal, null);
  assert.deepEqual(result.packet.canonical.records[0].links, {});
  assert.equal(result.packet.currentWork.length, 0);
});

test('bounded activity windows filter before classification and truncation', () => {
  const { registry, root, outcome } = makeRegistry();
  const windowNow = '2026-08-13T05:00:00.000Z';
  const query = queryFor(root, outcome, { limits: { maxItems: 20, maxBytes: 20000, maxProviderAgeSeconds: 3600 } });
  const providers = {
    activity: snapshot('activity', 'fresh', {
      summaries: [{
        id: 'activity-before', canonicalId: outcome.id, category: 'activity', status: 'done', title: 'before window',
        occurredAt: '2026-08-12T03:59:59.000Z', observedAt: windowNow, evidenceRefs: ['activity:before'],
      }, {
        id: 'activity-inside', canonicalId: outcome.id, category: 'activity', status: 'done', title: 'inside window',
        occurredAt: '2026-08-12T04:00:00.000Z', observedAt: windowNow, evidenceRefs: ['activity:inside'],
      }, {
        id: 'activity-after', canonicalId: outcome.id, category: 'activity', status: 'done', title: 'after window',
        occurredAt: '2026-08-13T04:00:00.000Z', observedAt: windowNow, evidenceRefs: ['activity:after'],
      }],
    }),
  };
  const result = buildContextPacket({
    registry,
    query,
    activityWindow: {
      from: '2026-08-12T04:00:00.000Z',
      to: '2026-08-13T04:00:00.000Z',
      localDate: '2026-08-12',
      timeZone: 'America/New_York',
    },
    capability: issue(query, {
      issuedAt: '2026-08-12T00:00:00.000Z',
      expiresAt: '2026-08-14T00:00:00.000Z',
    }),
    capabilitySecret: SECRET,
    subject: 'agent:test-session',
    hostId: 'projects-host',
    now: windowNow,
    providers,
    providerAuthorities: providerAuthorities(providers),
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.packet.activity.map((summary) => summary.id), ['activity-inside']);
  assert.equal(result.packet.providers.activity.itemCount, 1);
  assert.equal(result.packet.evidence.length, 1);
});

test('bounds preserve attention evidence over ordinary activity and reject impossible byte budgets', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome, { limits: { maxItems: 2, maxBytes: 20000, maxProviderAgeSeconds: 3600 } });
  const providers = {
    todo: snapshot('todo', 'fresh', {
      summaries: [{
        id: 'todo-activity', canonicalId: outcome.id, category: 'activity', status: 'done', title: 'ordinary activity',
        occurredAt: NOW, observedAt: NOW, evidenceRefs: ['todo:activity'],
      }, {
        id: 'todo-blocked', canonicalId: outcome.id, category: 'attention', status: 'blocked', title: 'blocked release',
        occurredAt: NOW, observedAt: NOW, evidenceRefs: ['todo:blocked'],
      }],
    }),
  };
  const result = buildContextPacket({
    registry, query, capability: issue(query), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW,
    providers, providerAuthorities: providerAuthorities(providers),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.packet.attention[0].id, 'todo-blocked');
  assert.equal(result.packet.activity.length, 0);
  const tooSmallQuery = queryFor(root, outcome, { limits: { maxItems: 1, maxBytes: 512, maxProviderAgeSeconds: 3600 } });
  assert.deepEqual(buildContextPacket({
    registry, query: tooSmallQuery, capability: issue(tooSmallQuery, { nonce: 'nonce-small' }), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: {},
  }), { status: 'unavailable', code: 'CONTEXT_BUDGET_TOO_SMALL' });
});

test('expired, invalid-scope, and missing-record requests are non-enumerating', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const unavailable = { status: 'unavailable', code: 'CONTEXT_UNAVAILABLE' };
  assert.deepEqual(buildContextPacket({
    registry, query, capability: issue(query, { issuedAt: '2026-08-08T11:00:00.000Z', expiresAt: '2026-08-08T11:59:00.000Z' }), capabilitySecret: SECRET,
    subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: {},
  }), unavailable);
  const missingQuery = queryFor(root, outcome, { scope: { projectIds: ['prj_999999'], outcomeIds: [], includeDescendants: false } });
  assert.deepEqual(buildContextPacket({
    registry, query: missingQuery, capability: issue(missingQuery, { nonce: 'nonce-2' }), capabilitySecret: SECRET,
    subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: {},
  }), unavailable);
  assert.deepEqual(buildContextPacket({
    registry, query, capability: issue(query), capabilitySecret: 'wrong-secret', subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: {},
  }), unavailable);
});

test('query and packet contracts reject unsupported keys', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  assert.throws(() => validateContextQuery({ ...query, extra: true }), /unsupported fields/);
  assert.equal(verifyCapability(issue(query), { hostSecret: SECRET, now: NOW, expectedSubject: 'agent:test-session', expectedQuery: query }).ok, true);
  assert.equal(CAPABILITY_CONTRACT, 'jarvos.projects-context-capability/v1');
  assert.throws(() => validateProviderSnapshot({ ...snapshot('todo', 'fresh'), extra: true }), /unsupported fields/);
  assert.deepEqual(validateContextPacket({ contract: CONTEXT_CONTRACT }), { ok: false, reason: 'invalid-contract' });
  const packet = buildContextPacket({
    registry, query, capability: issue(query), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: {},
  }).packet;
  assert.equal(validateContextPacket(packet).ok, true);
  assert.equal(validateContextPacket({ ...packet, canonical: { ...packet.canonical, records: [{}] } }).ok, false);
});

test('agent observations remain untrusted and cannot self-assert a producer', () => {
  const { outcome } = makeRegistry();
  assert.throws(() => submitAgentObservation({
    observationId: 'obs-1', canonicalId: outcome.id, caller: 'agent', sessionId: 's', sourcePacket: 'ctx-1',
    summary: 'forged', evidenceRefs: [], producerId: 'release-reconciler', receivedAt: NOW,
  }), /producerId/);
  const observation = submitAgentObservation({
    observationId: 'obs-1', canonicalId: outcome.id, caller: 'agent', sessionId: 's', sourcePacket: 'ctx-1',
    summary: 'possible blocker', evidenceRefs: ['chat:1'], receivedAt: NOW,
  });
  assert.equal(observation.trust, 'unverified');
  assert.equal(observation.contract, 'jarvos.project-observation/v1');
});

test('host-bound admission alone can create a verified activity receipt', () => {
  const { outcome } = makeRegistry();
  const authority = createHostAdmission({ producerId: 'release-reconciler', secret: 'producer-secret', allowedKinds: ['release-finding'] });
  const input = {
    contract: 'jarvos.verified-activity/v1', eventId: 'event-1', canonicalId: outcome.id, producerId: 'release-reconciler',
    kind: 'release-finding', occurredAt: NOW, observedAt: NOW, evidenceRefs: ['release:v1.0.0'], sourceRevision: 'release-4',
    sensitivity: 'private', dedupeKey: 'release:v1.0.0',
  };
  const receipt = authority.admitVerifiedReceipt(input);
  assert.equal(receipt.trust, 'verified');
  assert.equal(receipt.admission.producerId, 'release-reconciler');
  assert.equal(authority.verifyVerifiedReceipt(receipt, { now: NOW }).ok, true);
  assert.throws(() => authority.admitVerifiedReceipt({ ...input, producerId: 'forged' }), /producer identity/);
  assert.deepEqual(PROVIDER_STATES, ['fresh', 'stale', 'partial', 'unknown', 'unavailable', 'healthy-empty']);
});

test('packet identity is stable for the same bounded input', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const args = { registry, query, capability: issue(query), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', now: NOW, providers: {} };
  const first = buildContextPacket(args);
  const second = buildContextPacket(args);
  assert.equal(first.packet.packetId, second.packet.packetId);
  assert.match(first.packet.packetId, /^ctx_[a-f0-9]{32}$/);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(first.packet.canonical.revisions)).digest('hex').length, 64);
  assert.deepEqual(first.packet.inference, second.packet.inference);
  assert.deepEqual(first.packet.watermarks, second.packet.watermarks);
});

test('packet normalization advertises the supported schema set and rejects unknown schemas', () => {
  const { registry, root, outcome } = makeRegistry();
  const query = queryFor(root, outcome);
  const result = buildContextPacket({
    registry, query, capability: issue(query), capabilitySecret: SECRET, subject: 'agent:test-session', hostId: 'projects-host', providers: {}, now: NOW,
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(normalizeContextPacket(result.packet), {
    ok: true, packet: result.packet, supportedSchemaVersions: [2],
  });
  assert.deepEqual(SUPPORTED_CONTEXT_SCHEMA_VERSIONS, [2]);
  assert.deepEqual(normalizeContextPacket({ ...result.packet, schemaVersion: 99 }), { ok: false, reason: 'unsupported-schema' });
  assert.deepEqual(normalizeContextPacket({
    ...result.packet,
    canonical: { ...result.packet.canonical, records: [{ ...result.packet.canonical.records[0], title: 42 }, ...result.packet.canonical.records.slice(1)] },
  }), { ok: false, reason: 'invalid-contract' });
  assert.deepEqual(normalizeContextPacket({
    ...result.packet,
    canonical: { ...result.packet.canonical, records: [result.packet.canonical.records[0], { ...result.packet.canonical.records[1], parentId: null }] },
  }), { ok: false, reason: 'invalid-contract' });
  for (const revisions of [
    {},
    { ...result.packet.canonical.revisions, prj_999999: 1 },
    { ...result.packet.canonical.revisions, [result.packet.canonical.records[0].id]: result.packet.canonical.records[0].revision + 1 },
  ]) assert.deepEqual(normalizeContextPacket({ ...result.packet, canonical: { ...result.packet.canonical, revisions } }), { ok: false, reason: 'invalid-contract' });
});
