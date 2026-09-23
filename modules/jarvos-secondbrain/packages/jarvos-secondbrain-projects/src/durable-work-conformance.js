'use strict';

// Durable-work conformance runner. Every harness adapter that produces
// durable work events must pass these cases against the public contracts:
// signed admission, generation guard, identical replay no-op, evidence merge,
// causal conflict quarantine, unsigned/wrong producer rejection, repository
// binding precedence and ambiguity, linked-worktree equivalence, redaction,
// and every typed target omission. The runner uses only an isolated work
// directory supplied by the caller; its receipt is metadata-only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { ActivityStore } = require('./activity-store');
const { createHostAdmission } = require('./provider-contracts');
const { ProjectRegistry } = require('./registry');
const { buildContextPacket } = require('./projects-context');
const { issueCapability } = require('./projects-context-capability');
const {
  createDurableWorkEvent,
  invocationReference,
  projectDurableWorkEvent,
  receiptKind,
  EVENT_KINDS,
  validateDurableWorkEvent,
} = require('./durable-work-event');
const { createRepoBinding, createRepoObservation, bindingToken, resolveRepoBinding } = require('./repo-binding');
const { OMISSION_CODES, assessTargetHydration } = require('./target-hydration');

const DURABLE_WORK_CONFORMANCE_CONTRACT = 'jarvos.durable-work-conformance/v1';
const DEFAULT_FIXTURES = path.join(__dirname, '..', 'fixtures', 'durable-work', 'conformance.json');
const FIXTURE_PRODUCER = 'fixture.durable-work-collector';
const FIXTURE_ADMISSION_SECRET = 'public-fixture-admission-secret';
const FIXTURE_CAPABILITY_SECRET = 'public-fixture-capability-secret';

function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function fileDigest(file) { return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null; }

function loadFixtures(file = DEFAULT_FIXTURES) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function freshDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function storeDigest(stateDir) {
  const marker = path.join(stateDir, 'CURRENT');
  if (!fs.existsSync(marker)) return { current: null, state: null };
  const name = fs.readFileSync(marker, 'utf8').trim();
  return { current: fileDigest(marker), state: fileDigest(path.join(stateDir, name)) };
}

function buildWorld(fixtures, workDir) {
  const registry = new ProjectRegistry({ stateDir: freshDir(workDir, 'registry'), now: () => fixtures.now });
  const projects = {};
  for (const project of fixtures.projects) {
    const created = registry.create({ title: project.title, ...(project.parent ? { parentId: projects[project.parent].id } : {}) });
    projects[project.key] = created.record;
  }
  const secret = fixtures.bindingSecret;
  const repoKey = (name) => fixtures.repositories[name].repositoryKey;
  const bindings = fixtures.bindings.map((binding) => createRepoBinding({
    canonicalId: projects[binding.project].id,
    repositoryDigest: bindingToken('repository', repoKey(binding.repository), secret),
    worktreeDigest: binding.worktree ? bindingToken('worktree', binding.worktree, secret) : null,
    branchDigest: binding.branch ? bindingToken('branch', binding.branch, secret) : null,
    pullRequest: binding.pullRequest ?? null,
  }));
  const observe = (observation) => createRepoObservation({
    repositoryKey: repoKey(observation.repository),
    worktreeKey: observation.worktree || null,
    branch: observation.branch || null,
    pullRequest: observation.pullRequest ?? null,
  }, secret);
  return { registry, projects, bindings, observe, secret };
}

function baseEventInput(world, fixtures, overrides = {}) {
  const observation = world.observe({ repository: 'fx-alpha', branch: 'main' });
  const commitOid = 'a'.repeat(40);
  return {
    eventKind: 'commit',
    harness: 'claude',
    sessionDigest: sha256('fixture-session-claude'),
    repositoryDigest: observation.repositoryDigest,
    worktreeDigest: null,
    branchDigest: observation.branchDigest,
    pullRequest: null,
    commitOid,
    subjectRef: null,
    evidenceRefs: [`git-commit:${commitOid}`],
    occurredAt: fixtures.now,
    observedAt: fixtures.now,
    invocationRef: invocationReference('fixture-invocation-nonce-0001'),
    ...overrides,
  };
}

function activitySnapshot(store, ids, now, admission) {
  const result = store.query({ from: new Date(Date.parse(now) - 86_400_000).toISOString(), to: now, projectIds: ids.filter((id) => id.startsWith('prj_')) }, { now: new Date(now) });
  const base = {
    contract: 'jarvos.provider-snapshot/v1',
    provider: 'activity',
    state: result.activities.length ? 'fresh' : 'healthy-empty',
    trust: 'unverified',
    capturedAt: now,
    watermark: result.watermark,
    scope: { projectIds: ids.filter((id) => id.startsWith('prj_')), outcomeIds: [] },
    summaries: result.activities.map((entry) => ({
      id: entry.receipt.eventId,
      canonicalId: entry.receipt.canonicalId,
      category: 'activity',
      status: 'observed',
      title: null,
      occurredAt: entry.receipt.occurredAt,
      observedAt: entry.receipt.observedAt,
      evidenceRefs: entry.receipt.evidenceRefs,
    })),
    omissions: [],
    errorCode: null,
    admission: null,
  };
  return admission.admitProviderSnapshot(base);
}

function packetFor(world, fixtures, store, { scopeIds, maxItems = 50, maxBytes = 50_000, withActivity = true } = {}) {
  const now = fixtures.now;
  const query = {
    scope: { projectIds: scopeIds, outcomeIds: [], includeDescendants: true },
    include: ['hierarchy', 'activity', 'currentWork', 'attention'],
    limits: { maxItems, maxBytes, maxProviderAgeSeconds: 3600 },
  };
  const capability = issueCapability({
    authorization: { allowed: true }, hostId: 'fixture-host', hostSecret: FIXTURE_CAPABILITY_SECRET, subject: 'fixture-session',
    query, limits: query.limits, providerCoverage: ['activity'], capabilityRevision: 'fixture-1',
    issuedAt: now, expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(), nonce: 'fixture-capability-nonce',
  });
  const providerAdmission = createHostAdmission({ producerId: 'fixture.activity-provider', secret: FIXTURE_ADMISSION_SECRET, allowedProviders: ['activity'] });
  const selected = scopeIds.length ? scopeIds : world.registry.list().map((record) => record.id);
  return buildContextPacket({
    registry: world.registry, query, capability, capabilitySecret: FIXTURE_CAPABILITY_SECRET, subject: 'fixture-session', hostId: 'fixture-host', now,
    providers: withActivity ? { activity: activitySnapshot(store, selected, now, providerAdmission) } : {},
    providerAuthorities: { activity: providerAdmission },
  });
}

function check(cases, id, fn) {
  try {
    const detail = fn();
    cases.push({ id, status: detail === true || detail === undefined ? 'pass' : 'fail', detail: detail === true || detail === undefined ? null : String(detail) });
  } catch (error) {
    cases.push({ id, status: 'fail', detail: `threw:${String(error && error.message || 'error').slice(0, 120)}` });
  }
}

function throwsWith(fn, pattern) {
  try { fn(); } catch (error) { return pattern.test(String(error && error.message)); }
  return false;
}

// Options:
//   workDir     absolute, caller-owned isolated directory (required)
//   admission   an adapter's host admission authority; defaults to a fixture authority
//   producerId  the adapter's producer identity; defaults to the fixture producer
//   fixtures    alternate fixture file
function runDurableWorkConformance({ workDir, admission = null, producerId = FIXTURE_PRODUCER, fixtures: fixturesFile } = {}) {
  if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) throw new TypeError('workDir must be an absolute path');
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const fixtures = loadFixtures(fixturesFile);
  const world = buildWorld(fixtures, workDir);
  const authority = admission || createHostAdmission({ producerId, secret: FIXTURE_ADMISSION_SECRET, allowedKinds: EVENT_KINDS.map(receiptKind) });
  const cases = [];

  // Redaction and shape: run first, before any state is written.
  for (const redaction of fixtures.redactionCases) {
    check(cases, redaction.id, () => throwsWith(() => createDurableWorkEvent(baseEventInput(world, fixtures, redaction.patch)), /./) || 'accepted');
  }
  check(cases, 'reject_causal_key_mismatch', () => {
    const event = createDurableWorkEvent(baseEventInput(world, fixtures));
    return validateDurableWorkEvent({ ...event, causalKey: `dwe_${'0'.repeat(32)}` }).ok === false || 'accepted';
  });

  const stateDir = freshDir(workDir, 'activity');
  const store = new ActivityStore({ stateDir, now: () => fixtures.now, admission: authority, registry: world.registry });
  const alpha = world.projects.alpha.id;
  const event = createDurableWorkEvent(baseEventInput(world, fixtures));
  const receipt = authority.admitVerifiedReceipt(projectDurableWorkEvent(event, { canonicalId: alpha, producerId }));

  check(cases, 'signed_admission', () => {
    const result = store.admit(receipt, { expectedGeneration: 0 });
    return (result.status === 'admitted' && store.generation === 1 && result.activity.receipt.dedupeKey === event.causalKey) || `status:${result.status}`;
  });
  check(cases, 'generation_guard', () => throwsWith(() => store.admit(receipt, { expectedGeneration: 0 }), /stale activity store generation/) || 'not-guarded');
  check(cases, 'identical_replay_noop', () => {
    const before = storeDigest(stateDir);
    const result = store.admit(receipt, { expectedGeneration: 1 });
    const after = storeDigest(stateDir);
    return (result.status === 'deduped' && result.replay === 'identical' && store.generation === 1
      && before.current === after.current && before.state === after.state) || `replay:${result.replay}`;
  });
  check(cases, 'evidence_merge_advances', () => {
    const codex = createDurableWorkEvent(baseEventInput(world, fixtures, {
      harness: 'codex', sessionDigest: sha256('fixture-session-codex'), invocationRef: invocationReference('fixture-invocation-nonce-0002'),
    }));
    if (codex.causalKey !== event.causalKey) return 'causal-key-not-cross-harness';
    const result = store.admit(authority.admitVerifiedReceipt(projectDurableWorkEvent(codex, { canonicalId: alpha, producerId })), { expectedGeneration: 1 });
    return (result.status === 'deduped' && result.replay === 'evidence_merged' && store.generation === 2) || `replay:${result.replay}`;
  });
  check(cases, 'causal_conflict_quarantined', () => {
    const before = storeDigest(stateDir);
    const conflicting = authority.admitVerifiedReceipt(projectDurableWorkEvent(event, { canonicalId: world.projects.worktree.id, producerId }));
    const result = store.admit(conflicting);
    const after = storeDigest(stateDir);
    return (result.status === 'quarantined' && result.reason === 'causal_identity_conflict' && before.state === after.state) || `status:${result.status}`;
  });
  check(cases, 'unsigned_rejected', () => {
    const before = storeDigest(stateDir);
    const forged = { ...receipt, admission: { ...receipt.admission, signature: 'forged-signature' } };
    const rejected = throwsWith(() => store.admit(forged), /admission invalid/);
    return (rejected && storeDigest(stateDir).state === before.state) || 'admitted';
  });
  check(cases, 'wrong_producer_rejected', () => {
    const before = storeDigest(stateDir);
    const intruder = createHostAdmission({ producerId: 'fixture.intruder', secret: 'fixture-intruder-secret', allowedKinds: EVENT_KINDS.map(receiptKind) });
    const other = createDurableWorkEvent(baseEventInput(world, fixtures, { commitOid: 'b'.repeat(40), evidenceRefs: [`git-commit:${'b'.repeat(40)}`] }));
    const foreign = intruder.admitVerifiedReceipt(projectDurableWorkEvent(other, { canonicalId: alpha, producerId: 'fixture.intruder' }));
    const rejected = throwsWith(() => store.admit(foreign), /admission invalid/);
    return (rejected && storeDigest(stateDir).state === before.state) || 'admitted';
  });

  for (const bindingCase of fixtures.bindingCases) {
    check(cases, bindingCase.id, () => {
      const result = resolveRepoBinding({ bindings: world.bindings, observation: world.observe(bindingCase.observation) });
      const expected = bindingCase.expect;
      if (result.status !== expected.status) return `status:${result.status}`;
      if (expected.status === 'bound') return (result.canonicalId === world.projects[expected.project].id && result.tier === expected.tier) || `tier:${result.tier}`;
      return result.reason === expected.reason || `reason:${result.reason}`;
    });
  }
  check(cases, 'binding_ambiguous_duplicate', () => {
    const duplicate = [...world.bindings, createRepoBinding({
      canonicalId: world.projects.sharedB.id,
      repositoryDigest: bindingToken('repository', fixtures.repositories['fx-shared'].repositoryKey, world.secret),
      branchDigest: bindingToken('branch', 'feature/a', world.secret),
    })];
    const result = resolveRepoBinding({ bindings: duplicate, observation: world.observe({ repository: 'fx-shared', branch: 'feature/a' }) });
    return (result.status === 'unattributed' && result.reason === 'ambiguous') || `status:${result.status}`;
  });

  // Target hydration: positive presence, then every typed omission.
  const expected = [{ causalKey: event.causalKey, occurredAt: event.occurredAt }];
  check(cases, 'target_present', () => {
    const result = assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [alpha] }), expected });
    return (result.status === 'present' && result.presentCausalKeys.includes(event.causalKey)) || `status:${result.status}`;
  });
  const omissionCases = {
    scope: () => assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [world.projects.worktree.id] }), expected }),
    generation_mismatch: () => assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [alpha] }), expected, expectedGeneration: world.registry.generation + 1 }),
    item_limit: () => assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [], maxItems: 1 }), expected }),
    byte_limit: () => assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [alpha], maxBytes: 512 }), expected }),
    age_window: () => assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [alpha] }), expected: [{ causalKey: `dwe_${'1'.repeat(32)}`, occurredAt: '2020-01-01T00:00:00.000Z' }], activityWindow: { from: '2026-09-22T00:00:00.000Z', to: '2026-09-24T00:00:00.000Z' } }),
    render_truncation: () => assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [alpha] }), expected, rendered: { text: '## Projects Context\n(truncated)', markers: [world.projects.alpha.title] } }),
    provider_unavailable: () => assessTargetHydration({ targetId: alpha, result: packetFor(world, fixtures, store, { scopeIds: [alpha], withActivity: false }), expected }),
    unbound: () => assessTargetHydration({ targetId: null, result: packetFor(world, fixtures, store, { scopeIds: [alpha] }), expected }),
  };
  for (const code of OMISSION_CODES) {
    check(cases, `omission_${code}`, () => {
      const result = omissionCases[code]();
      return (result.status !== 'present' && result.omissions.some((entry) => entry.code === code)) || `omissions:${result.omissions.map((entry) => entry.code).join(',') || 'none'}`;
    });
  }

  const failed = cases.filter((entry) => entry.status !== 'pass');
  return {
    contract: DURABLE_WORK_CONFORMANCE_CONTRACT,
    producerId,
    status: failed.length ? 'fail' : 'pass',
    cases,
  };
}

module.exports = {
  DEFAULT_FIXTURES,
  DURABLE_WORK_CONFORMANCE_CONTRACT,
  FIXTURE_PRODUCER,
  loadFixtures,
  runDurableWorkConformance,
};
