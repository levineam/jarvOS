'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  projectPublicWorkflowProviderReceipt,
  validateWorkflowProviderReceipt,
} = require('../../providers/workflow-provider');

const WORK_RUN_STORE_SCHEMA_VERSION = 'jarvos-coding-work-run/v1';
// v2 state adds the exclusive workspace binding index; run records stay WORK_RUN_STORE_SCHEMA_VERSION.
const WORK_RUN_STORE_SCHEMA_VERSION_V2 = 'jarvos-coding-work-run/v2';
const WORKSPACE_BINDING_VERSION = 'jarvos-coding-workspace-binding/v1';
const WORKSPACE_BINDING_PUBLIC_VERSION = 'jarvos-coding-workspace-binding-public/v1';
const WORKSPACE_ID = /^ws_[0-9a-f]{24}$/;
// Strict allowlists: this slice must not consume future (handoff/revision) binding state.
const WORKSPACE_BINDING_KEYS = new Set(['version', 'workspaceId', 'identity', 'workRunId', 'subjectKey', 'ownerId', 'runFence', 'bindingFence', 'state', 'boundAt', 'updatedAt']);
const WORKSPACE_IDENTITY_KEYS = new Set(['canonicalPath', 'dev', 'ino']);
const WORK_RUN_EVENT_VERSION = 'jarvos-coding-work-run-event/v1';
const WORK_RUN_PUBLIC_VERSION = 'jarvos-coding-work-run-public/v1';
const FOLLOW_THROUGH_BINDING_VERSION = 'jarvos-coding-follow-through-binding/v1';
const WORK_RUN_STATES = new Set(['active', 'blocked', 'completed', 'failed']);
const WORK_RUN_EVENT_TYPES = new Set(['route', 'provider', 'artifact', 'recovery', 'terminal']);
const SHA256 = /^[a-f0-9]{64}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_OUTCOME_ID = /^out_[0-9]{6,}$/;
const ARTIFACT_REFERENCE = /^artifact:[A-Za-z0-9._-]{6,160}$/;
const SUBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ABSOLUTE_PATH = /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/;
const SECRET_VALUE = /(?:\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\bxox[baprs]-|(?:api[_-]?key|token|secret|password)\s*[:=])/i;
const AUTHORITY_KEYS = new Set(['branch', 'worktree', 'worktreePath', 'approval', 'submissionReady', 'completion', 'owner', 'authority', 'terminalStatus', 'nextStep', 'pr', 'pullRequest']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDigest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

// Own-property lookup so ids such as "__proto__" never resolve to prototype members.
function own(map, key) {
  return isObject(map) && typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
}

function isRootPath(value) {
  return path.parse(value).root === value;
}

function isCanonicalWorkspacePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && path.isAbsolute(value)
    && path.normalize(value) === value && !isRootPath(value) && !value.endsWith(path.sep);
}

function isWorkspaceIdentity(identity) {
  return isObject(identity)
    && Object.keys(identity).every((key) => WORKSPACE_IDENTITY_KEYS.has(key))
    && isCanonicalWorkspacePath(identity.canonicalPath)
    && Number.isSafeInteger(identity.dev) && identity.dev >= 0
    && Number.isSafeInteger(identity.ino) && identity.ino > 0;
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameWorkspaceIdentity(a, b) {
  return sameInode(a, b) && a.canonicalPath === b.canonicalPath;
}

// Path-segment aware: "/ws/a" overlaps "/ws" and "/ws/a/child" but not "/ws/a-b".
function workspacePathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

function assertSafeValue(value, label, options = {}) {
  if (typeof value === 'string') {
    if (value.includes('\0') || SECRET_VALUE.test(value)) throw new Error(`${label} contains unsafe content`);
    if (!options.allowPath && ABSOLUTE_PATH.test(value)) throw new Error(`${label} must not contain a local path`);
  }
  if (Array.isArray(value)) value.forEach((entry, index) => assertSafeValue(entry, `${label}[${index}]`, options));
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (AUTHORITY_KEYS.has(key)) throw new Error(`${label}.${key} is an authority-shaped field`);
      assertSafeValue(entry, `${label}.${key}`, options);
    }
  }
}

function emptyState() {
  return {
    schemaVersion: WORK_RUN_STORE_SCHEMA_VERSION,
    revision: 0,
    workRuns: {},
    followThrough: {},
  };
}

function validateState(state) {
  const errors = [];
  if (!isObject(state)) return { ok: false, errors: ['work-run state must be an object'] };
  if (state.schemaVersion !== WORK_RUN_STORE_SCHEMA_VERSION && state.schemaVersion !== WORK_RUN_STORE_SCHEMA_VERSION_V2) {
    errors.push(`state.schemaVersion must be ${WORK_RUN_STORE_SCHEMA_VERSION} or ${WORK_RUN_STORE_SCHEMA_VERSION_V2}`);
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push('state.revision must be a non-negative integer');
  if (!isObject(state.workRuns)) errors.push('state.workRuns must be an object');
  if (state.followThrough !== undefined && !isObject(state.followThrough)) errors.push('state.followThrough must be an object');
  const workRuns = isObject(state.workRuns) ? state.workRuns : {};
  for (const [id, run] of Object.entries(workRuns)) {
    if (!isObject(run)) { errors.push(`workRuns.${id} must be an object`); continue; }
    if (id !== run.workRunId) errors.push(`workRuns.${id}.workRunId must match its key`);
    if (run.schemaVersion !== WORK_RUN_STORE_SCHEMA_VERSION) errors.push(`workRuns.${id}.schemaVersion is invalid`);
    if (!OPAQUE_ID.test(run.workRunId || '')) errors.push(`workRuns.${id}.workRunId must be opaque`);
    if (!SUBJECT_KEY.test(run.subjectKey || '')) errors.push(`workRuns.${id}.subjectKey must be safe`);
    if (!WORK_RUN_STATES.has(run.state)) errors.push(`workRuns.${id}.state is invalid`);
    if (!Number.isInteger(run.fence) || run.fence < 0) errors.push(`workRuns.${id}.fence must be a non-negative integer`);
    if (!Array.isArray(run.events)) errors.push(`workRuns.${id}.events must be an array`);
    if (!Array.isArray(run.artifacts)) errors.push(`workRuns.${id}.artifacts must be an array`);
    if (!isObject(run.recovery)) errors.push(`workRuns.${id}.recovery must be an object`);
  }
  for (const [outcomeId, binding] of Object.entries(state.followThrough || {})) {
    if (!isObject(binding)) { errors.push(`followThrough.${outcomeId} must be an object`); continue; }
    if (binding.outcomeId !== outcomeId || !PROJECT_OUTCOME_ID.test(outcomeId) || binding.version !== FOLLOW_THROUGH_BINDING_VERSION) errors.push(`followThrough.${outcomeId} is invalid`);
    for (const field of ['outcomeId', 'executorOwnerId', 'harnessWorkspaceId', 'workRunId', 'todoId', 'triggerId']) {
      if ((field === 'outcomeId' ? !PROJECT_OUTCOME_ID.test(binding[field] || '') : !OPAQUE_ID.test(binding[field] || ''))) errors.push(`followThrough.${outcomeId}.${field} must be opaque`);
    }
    if (!Number.isInteger(binding.fence) || binding.fence < 1) errors.push(`followThrough.${outcomeId}.fence is invalid`);
    if (binding.leaseHistory !== undefined) {
      if (!Array.isArray(binding.leaseHistory) || !binding.leaseHistory.length) errors.push(`followThrough.${outcomeId}.leaseHistory is invalid`);
      for (const lease of binding.leaseHistory || []) {
        if (!isObject(lease) || !Number.isInteger(lease.fence) || lease.fence < 1 || typeof lease.boundAt !== 'string' || Number.isNaN(Date.parse(lease.boundAt))) {
          errors.push(`followThrough.${outcomeId}.leaseHistory contains an invalid entry`);
        }
      }
    }
    if (typeof binding.boundAt !== 'string' || Number.isNaN(Date.parse(binding.boundAt))) errors.push(`followThrough.${outcomeId}.boundAt is invalid`);
  }
  validateWorkspaceState(state, workRuns, errors);
  return { ok: errors.length === 0, errors };
}

function validateWorkspaceState(state, workRuns, errors) {
  if (state.schemaVersion !== WORK_RUN_STORE_SCHEMA_VERSION_V2) {
    // v1 state cannot carry (or hide) workspace bindings; the first successful bind upgrades to v2.
    if (state.workspaceBindings !== undefined) errors.push('state.workspaceBindings requires v2 state');
    if (state.workspaceFenceSeq !== undefined) errors.push('state.workspaceFenceSeq requires v2 state');
    for (const [id, run] of Object.entries(workRuns)) {
      if (isObject(run) && run.workspaceId != null) errors.push(`workRuns.${id}.workspaceId requires v2 state`);
    }
    return;
  }
  if (!Number.isSafeInteger(state.workspaceFenceSeq) || state.workspaceFenceSeq < 0) errors.push('state.workspaceFenceSeq must be a non-negative safe integer');
  if (!isObject(state.workspaceBindings)) { errors.push('state.workspaceBindings must be an object'); return; }
  const identities = [];
  for (const [key, binding] of Object.entries(state.workspaceBindings)) {
    const label = `workspaceBindings.${key}`;
    if (!WORKSPACE_ID.test(key)) errors.push(`${label} key is invalid`);
    if (!isObject(binding)) { errors.push(`${label} must be an object`); continue; }
    const unsupported = Object.keys(binding).filter((field) => !WORKSPACE_BINDING_KEYS.has(field));
    if (unsupported.length) errors.push(`${label} has unsupported fields: ${unsupported.join(', ')}`);
    if (binding.version !== WORKSPACE_BINDING_VERSION) errors.push(`${label}.version is invalid`);
    if (binding.workspaceId !== key) errors.push(`${label}.workspaceId must match its key`);
    if (isWorkspaceIdentity(binding.identity)) identities.push({ key, ...binding.identity });
    else errors.push(`${label}.identity is invalid`);
    const run = own(workRuns, binding.workRunId);
    if (!isObject(run)) {
      errors.push(`${label}.workRunId must reference an existing work run`);
    } else {
      if (run.workspaceId !== key) errors.push(`${label} is not reciprocated by its work run`);
      if (binding.subjectKey !== run.subjectKey) errors.push(`${label}.subjectKey must match its work run`);
      if (binding.ownerId !== run.ownerId) errors.push(`${label}.ownerId must match its work run`);
      if (binding.runFence !== run.fence) errors.push(`${label}.runFence must match its work run`);
    }
    if (typeof binding.ownerId !== 'string' || !OPAQUE_ID.test(binding.ownerId)) errors.push(`${label}.ownerId must be opaque`);
    if (!Number.isSafeInteger(binding.runFence) || binding.runFence < 1) errors.push(`${label}.runFence must be a positive integer`);
    if (!Number.isSafeInteger(binding.bindingFence) || binding.bindingFence < 1 || !(binding.bindingFence <= state.workspaceFenceSeq)) {
      errors.push(`${label}.bindingFence must be a positive integer within state.workspaceFenceSeq`);
    }
    if (binding.state !== 'bound') errors.push(`${label}.state is invalid`);
    if (!isTimestamp(binding.boundAt) || !isTimestamp(binding.updatedAt)) errors.push(`${label} timestamps are invalid`);
  }
  for (let i = 0; i < identities.length; i += 1) {
    for (let j = i + 1; j < identities.length; j += 1) {
      const [a, b] = [identities[i], identities[j]];
      if (sameInode(a, b)) errors.push(`workspaceBindings.${a.key} and ${b.key} share one identity`);
      else if (workspacePathsOverlap(a.canonicalPath, b.canonicalPath)) errors.push(`workspaceBindings.${a.key} and ${b.key} have overlapping paths`);
    }
  }
  for (const [id, run] of Object.entries(workRuns)) {
    if (!isObject(run) || run.workspaceId == null) continue;
    const binding = own(state.workspaceBindings, run.workspaceId);
    if (!isObject(binding) || binding.workRunId !== id) errors.push(`workRuns.${id}.workspaceId has no reciprocal binding`);
  }
}

function publicWorkspaceBinding(binding) {
  return {
    version: WORKSPACE_BINDING_PUBLIC_VERSION,
    workspaceId: binding.workspaceId,
    workRunId: binding.workRunId,
    subjectKey: binding.subjectKey,
    bindingFence: binding.bindingFence,
    state: binding.state,
    boundAt: binding.boundAt,
    updatedAt: binding.updatedAt,
  };
}

// Default file-store resolver: an existing directory's realpath plus its (dev, ino) identity.
function createFsWorkspaceResolver() {
  return function resolveWorkspace(worktreePath) {
    const canonicalPath = fs.realpathSync.native(worktreePath);
    const stat = fs.statSync(canonicalPath, { bigint: true });
    if (!stat.isDirectory()) throw new Error('workspace must be an existing directory');
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (stat.dev > max || stat.ino > max) throw new Error('workspace identity exceeds the safe integer range');
    return { canonicalPath, dev: Number(stat.dev), ino: Number(stat.ino) };
  };
}

function normalizeProviderSnapshot(snapshot) {
  if (!isObject(snapshot)) throw new Error('providerSnapshot must be an object');
  const normalized = {
    id: snapshot.id,
    version: snapshot.version,
    pinDigest: snapshot.pinDigest,
    harness: snapshot.harness,
    adapterVersion: snapshot.adapterVersion,
    status: snapshot.status || 'verified',
    observedAt: snapshot.observedAt || null,
  };
  if (!OPAQUE_ID.test(normalized.id || '') || typeof normalized.version !== 'string' || !normalized.version || !isDigest(normalized.pinDigest)
    || typeof normalized.harness !== 'string' || !OPAQUE_ID.test(normalized.harness)
    || typeof normalized.adapterVersion !== 'string' || !OPAQUE_ID.test(normalized.adapterVersion)) {
    throw new Error('providerSnapshot has invalid identity fields');
  }
  if (!['verified', 'degraded', 'unsupported', 'unavailable'].includes(normalized.status)) throw new Error('providerSnapshot.status is invalid');
  return normalized;
}

function normalizeArtifact(input, options = {}) {
  if (!isObject(input)) throw new Error('artifact must be an object');
  const artifact = {
    kind: input.kind,
    reference: input.reference,
    digest: input.digest,
    path: input.path || null,
    createdAt: input.createdAt || null,
    expiresAt: input.expiresAt || null,
  };
  if (!['plan', 'work', 'compound'].includes(artifact.kind)) throw new Error('artifact.kind is invalid');
  if (typeof artifact.reference !== 'string' || !ARTIFACT_REFERENCE.test(artifact.reference)) throw new Error('artifact.reference must be opaque');
  if (!isDigest(artifact.digest)) throw new Error('artifact.digest must be a SHA-256 digest');
  if (artifact.path !== null && (typeof artifact.path !== 'string' || !ABSOLUTE_PATH.test(artifact.path))) throw new Error('artifact.path must be an absolute private path');
  if (!options.allowPrivatePath) delete artifact.path;
  return artifact;
}

function publicEvent(event) {
  const projection = {
    version: WORK_RUN_EVENT_VERSION,
    eventId: event.eventId,
    type: event.type,
    operation: event.operation || null,
    status: event.status || null,
    at: event.at,
  };
  if (event.provider) projection.provider = {
    id: event.provider.id,
    version: event.provider.version,
    harness: event.provider.harness,
  };
  if (event.artifact) projection.artifact = {
    kind: event.artifact.kind,
    reference: event.artifact.reference,
    digest: event.artifact.digest,
  };
  if (event.reasonCode) projection.reasonCode = event.reasonCode;
  return projection;
}

function publicRun(run) {
  return {
    version: WORK_RUN_PUBLIC_VERSION,
    workRunId: run.workRunId,
    subjectKey: run.subjectKey,
    state: run.state,
    fence: run.fence,
    acceptedPlan: run.acceptedPlan ? {
      digest: run.acceptedPlan.digest,
      artifactReference: run.acceptedPlan.artifactReference,
      packetDigest: run.acceptedPlan.packetDigest || null,
      providerPinDigest: run.acceptedPlan.providerPinDigest,
      acceptedAt: run.acceptedPlan.acceptedAt,
    } : null,
    providerSnapshot: run.providerSnapshot ? {
      id: run.providerSnapshot.id,
      version: run.providerSnapshot.version,
      pinDigest: run.providerSnapshot.pinDigest,
      harness: run.providerSnapshot.harness,
      adapterVersion: run.providerSnapshot.adapterVersion,
      status: run.providerSnapshot.status,
      observedAt: run.providerSnapshot.observedAt,
    } : null,
    artifacts: run.artifacts.map((artifact) => ({ kind: artifact.kind, reference: artifact.reference, digest: artifact.digest })),
    events: run.events.map(publicEvent),
    recovery: clone(run.recovery),
    terminalEvidence: run.terminalEvidence ? clone(run.terminalEvidence) : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function publicFollowThrough(binding) {
  return {
    version: FOLLOW_THROUGH_BINDING_VERSION,
    outcomeId: binding.outcomeId,
    executorOwnerId: binding.executorOwnerId,
    harnessWorkspaceId: binding.harnessWorkspaceId,
    workRunId: binding.workRunId,
    fence: binding.fence,
    todoId: binding.todoId,
    triggerId: binding.triggerId,
    boundAt: binding.boundAt,
    leaseHistory: clone(binding.leaseHistory || [{ fence: binding.fence, boundAt: binding.boundAt }]),
  };
}

function assertRunOwner(run, ownerId, fence) {
  if (typeof ownerId !== 'string' || !OPAQUE_ID.test(ownerId)) return { ok: false, reason: 'owner_required' };
  if (run.ownerId !== ownerId || run.fence !== fence) return { ok: false, reason: 'stale_fence', expectedFence: run.fence, providedFence: fence };
  return { ok: true };
}

function noCommit(value) {
  return { __noCommit: true, value };
}

function createWorkRunStore(options = {}) {
  if (!options.backend || typeof options.backend.load !== 'function' || typeof options.backend.save !== 'function') throw new Error('work-run store backend must implement load/save');
  const clock = options.clock || (() => Date.now());
  const evidencePort = options.evidencePort || null;
  const workspaceResolver = typeof options.workspaceResolver === 'function' ? options.workspaceResolver : null;

  const backendIo = {
    load: () => options.backend.load(),
    save: (next, expectedRevision) => options.backend.save(next, expectedRevision),
  };

  function loadState(io = backendIo) {
    const state = io.load();
    // v1 stores created before the additive follow-through index remain readable.
    if (state && state.followThrough === undefined) state.followThrough = {};
    const validation = validateState(state);
    if (!validation.ok) throw new Error(`invalid work-run state: ${validation.errors.join('; ')}`);
    return state;
  }

  function commit(state, expectedRevision, io) {
    const validation = validateState(state);
    if (!validation.ok) throw new Error(`invalid work-run state: ${validation.errors.join('; ')}`);
    state.revision = expectedRevision + 1;
    io.save(state, expectedRevision);
  }

  function mutate(mutator) {
    const transaction = (io) => {
      const state = loadState(io);
      const expectedRevision = state.revision;
      const result = mutator(state);
      if (result && result.__noCommit) return result.value;
      commit(state, expectedRevision, io);
      return result;
    };
    // Transactional backends hold one lock across load, decision and commit; others keep load/save CAS.
    return typeof options.backend.transact === 'function' ? options.backend.transact(transaction) : transaction(backendIo);
  }

  function createRun(state, input, workRunId) {
    const now = nowIso(clock);
    const run = {
      schemaVersion: WORK_RUN_STORE_SCHEMA_VERSION,
      workRunId,
      subjectKey: input.subjectKey,
      canonicalWorktree: input.canonicalWorktree || null,
      ownerId: null,
      fence: 0,
      state: 'active',
      acceptedPlan: null,
      providerSnapshot: null,
      artifacts: [],
      events: [],
      eventNonces: {},
      recovery: { state: 'active', reasonCode: null, updatedAt: now },
      terminalEvidence: null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.providerSnapshot) run.providerSnapshot = normalizeProviderSnapshot(input.providerSnapshot);
    state.workRuns[workRunId] = run;
    return run;
  }

  function normalizeWorkRunInput(input = {}) {
    if (!isObject(input) || typeof input.subjectKey !== 'string' || !SUBJECT_KEY.test(input.subjectKey)) throw new Error('subjectKey must be a safe stable identifier');
    if (input.canonicalWorktree !== undefined && (typeof input.canonicalWorktree !== 'string' || !ABSOLUTE_PATH.test(input.canonicalWorktree))) throw new Error('canonicalWorktree must be an absolute path');
    const workRunId = input.workRunId || `run_${digest(input.subjectKey).slice(0, 24)}`;
    if (!OPAQUE_ID.test(workRunId)) throw new Error('workRunId must be an opaque identifier');
    return { ...input, workRunId };
  }

  function resolveWorkRun(input = {}) {
    const normalized = normalizeWorkRunInput(input);
    const { workRunId } = normalized;
    return mutate((state) => {
      const existing = state.workRuns[workRunId];
      if (existing) {
        if (existing.subjectKey !== normalized.subjectKey) throw new Error('workRunId is bound to a different subject');
        return noCommit({ ok: true, created: false, workRun: clone(existing), public: publicRun(existing) });
      }
      const run = createRun(state, normalized, workRunId);
      return { ok: true, created: true, workRun: clone(run), public: publicRun(run) };
    });
  }

  function getWorkRun(workRunId, options = {}) {
    if (!OPAQUE_ID.test(workRunId || '')) throw new Error('workRunId must be an opaque identifier');
    const state = loadState();
    const run = state.workRuns[workRunId];
    if (!run) return null;
    return options.public === false ? clone(run) : publicRun(run);
  }

  function normalizeFollowThroughBinding(input = {}) {
    if (!isObject(input)) throw new Error('follow-through binding must be an object');
    const binding = {
      version: FOLLOW_THROUGH_BINDING_VERSION,
      outcomeId: input.outcomeId,
      executorOwnerId: input.executorOwnerId,
      harnessWorkspaceId: input.harnessWorkspaceId,
      workRunId: input.workRunId,
      fence: input.fence,
      todoId: input.todoId,
      triggerId: input.triggerId,
    };
    for (const field of Object.keys(binding).filter((field) => field !== 'version' && field !== 'fence')) {
      if ((field === 'outcomeId' ? !PROJECT_OUTCOME_ID.test(binding[field] || '') : !OPAQUE_ID.test(binding[field] || ''))) throw new Error(`follow-through ${field} must be an opaque identifier`);
    }
    if (!Number.isInteger(binding.fence) || binding.fence < 1) throw new Error('follow-through fence must be a positive integer');
    return binding;
  }

  function getFollowThrough(outcomeId) {
    if (!PROJECT_OUTCOME_ID.test(outcomeId || '')) throw new Error('outcomeId must be a Projects outcome identifier');
    const binding = loadState().followThrough[outcomeId];
    return binding ? publicFollowThrough(binding) : null;
  }

  function bindFollowThrough(input = {}) {
    const binding = normalizeFollowThroughBinding(input);
    return mutate((state) => {
      const run = state.workRuns[binding.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      if (run.ownerId !== binding.executorOwnerId) return noCommit({ ok: false, reason: 'executor_owner_conflict' });
      const existing = state.followThrough[binding.outcomeId];
      if (existing) {
        const sameReferences = ['executorOwnerId', 'harnessWorkspaceId', 'workRunId', 'todoId', 'triggerId']
          .every((field) => existing[field] === binding[field]);
        if (sameReferences && existing.fence === binding.fence) return noCommit({ ok: true, deduped: true, binding: publicFollowThrough(existing) });
        if (sameReferences
          && existing.executorOwnerId === run.ownerId
          && binding.fence > existing.fence) {
          const boundAt = nowIso(clock);
          const leaseHistory = [...(existing.leaseHistory || [{ fence: existing.fence, boundAt: existing.boundAt }]), { fence: binding.fence, boundAt }];
          const renewed = { ...existing, fence: binding.fence, boundAt, leaseHistory };
          state.followThrough[binding.outcomeId] = renewed;
          return { ok: true, renewed: true, binding: publicFollowThrough(renewed) };
        }
        return noCommit({ ok: false, reason: 'outcome_binding_conflict', binding: publicFollowThrough(existing) });
      }
      const boundElsewhere = Object.values(state.followThrough).find((entry) => entry.workRunId === binding.workRunId);
      if (boundElsewhere) return noCommit({ ok: false, reason: 'work_run_binding_conflict', binding: publicFollowThrough(boundElsewhere) });
      const boundAt = nowIso(clock);
      const stored = { ...binding, boundAt, leaseHistory: [{ fence: binding.fence, boundAt }] };
      state.followThrough[binding.outcomeId] = stored;
      return { ok: true, deduped: false, binding: publicFollowThrough(stored) };
    });
  }

  function claimWorkRun(input = {}) {
    if (!OPAQUE_ID.test(input.ownerId || '')) throw new Error('ownerId must be an opaque identifier');
    const normalized = normalizeWorkRunInput(input);
    return mutate((state) => {
      let run = state.workRuns[normalized.workRunId];
      if (run && run.subjectKey !== normalized.subjectKey) throw new Error('workRunId is bound to a different subject');
      if (!run) run = createRun(state, normalized, normalized.workRunId);
      if (!run.ownerId || run.ownerId === input.ownerId) {
        if (!run.ownerId) run.fence += 1;
        run.ownerId = input.ownerId;
        run.updatedAt = nowIso(clock);
        return { ok: true, workRunId: run.workRunId, ownerId: run.ownerId, fence: run.fence, workRun: clone(run), public: publicRun(run) };
      }
      return noCommit({ ok: false, reason: 'owner_conflict', workRunId: run.workRunId, ownerId: run.ownerId, fence: run.fence, public: publicRun(run) });
    });
  }

  function releaseWorkRun(input = {}) {
    if (input.handoffTo !== undefined) return { ok: false, reason: 'workspace_handoff_unavailable' };
    return mutate((state) => {
      const run = state.workRuns[input.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      if (run.workspaceId != null) {
        // A bound run releases only together with its current binding token, in one commit.
        if (input.releaseWorkspace !== true) return noCommit({ ok: false, reason: 'workspace_binding_held' });
        const binding = currentWorkspaceBinding(state, run, input);
        if (!binding) return noCommit({ ok: false, reason: 'stale_binding_fence' });
        delete state.workspaceBindings[binding.workspaceId];
        run.workspaceId = null;
      }
      run.ownerId = null;
      run.updatedAt = nowIso(clock);
      return { ok: true, workRun: clone(run), public: publicRun(run) };
    });
  }

  // Exact current token only: the run must point at workspaceId and bindingFence must be current.
  function currentWorkspaceBinding(state, run, input) {
    if (typeof input.workspaceId !== 'string' || run.workspaceId !== input.workspaceId) return null;
    const binding = own(state.workspaceBindings, input.workspaceId);
    if (!isObject(binding) || binding.bindingFence !== input.bindingFence) return null;
    return binding;
  }

  function workspaceRefusal(reason, binding) {
    // Redacted holder: never the holder's owner, path, dev or ino.
    return noCommit({
      ok: false,
      reason,
      conflict: {
        workspaceId: binding.workspaceId,
        holder: { workRunId: binding.workRunId, subjectKey: binding.subjectKey },
        bindingFence: binding.bindingFence,
      },
    });
  }

  // Resolution runs before the lock. Honest limit (TOCTOU): the directory can be swapped after
  // resolution; an effect-time identity recheck is later work, so a binding is not effect authority.
  function resolveWorkspaceIdentity(worktreePath) {
    if (typeof worktreePath !== 'string' || !worktreePath || worktreePath.includes('\0') || !path.isAbsolute(worktreePath)) return null;
    if (isRootPath(path.resolve(worktreePath))) return null;
    try {
      const resolved = workspaceResolver(worktreePath);
      if (!isObject(resolved)) return null;
      const identity = { canonicalPath: resolved.canonicalPath, dev: resolved.dev, ino: resolved.ino };
      return isWorkspaceIdentity(identity) ? identity : null;
    } catch {
      return null;
    }
  }

  function bindWorkspace(input = {}) {
    if (input.revision !== undefined) return { ok: false, reason: 'workspace_revision_unavailable' };
    if (!workspaceResolver) return { ok: false, reason: 'workspace_resolver_required' };
    const identity = resolveWorkspaceIdentity(input.worktreePath);
    if (!identity) return { ok: false, reason: 'workspace_unresolvable' };
    return mutate((state) => {
      const run = own(state.workRuns, input.workRunId);
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      const bindings = isObject(state.workspaceBindings) ? state.workspaceBindings : {};
      if (run.workspaceId != null) {
        const current = own(bindings, run.workspaceId);
        if (sameWorkspaceIdentity(current.identity, identity) && current.ownerId === run.ownerId && current.runFence === run.fence) {
          return noCommit({ ok: true, deduped: true, binding: clone(current), public: publicWorkspaceBinding(current) });
        }
        return workspaceRefusal('run_workspace_conflict', current);
      }
      const others = Object.values(bindings);
      const replaced = others.find((entry) => entry.identity.canonicalPath === identity.canonicalPath && !sameInode(entry.identity, identity));
      if (replaced) return workspaceRefusal('workspace_identity_changed', replaced);
      const held = others.find((entry) => sameInode(entry.identity, identity));
      if (held) return workspaceRefusal('workspace_conflict', held);
      const overlapping = others.find((entry) => workspacePathsOverlap(entry.identity.canonicalPath, identity.canonicalPath));
      if (overlapping) return workspaceRefusal('workspace_overlap_conflict', overlapping);
      if (state.schemaVersion !== WORK_RUN_STORE_SCHEMA_VERSION_V2) {
        // Lazy upgrade on the first successful bind only; the fence sequence never resets afterwards.
        state.schemaVersion = WORK_RUN_STORE_SCHEMA_VERSION_V2;
        state.workspaceBindings = {};
        state.workspaceFenceSeq = 0;
      }
      state.workspaceFenceSeq += 1;
      let workspaceId;
      do { workspaceId = `ws_${crypto.randomBytes(12).toString('hex')}`; } while (Object.hasOwn(state.workspaceBindings, workspaceId));
      const at = nowIso(clock);
      const binding = {
        version: WORKSPACE_BINDING_VERSION,
        workspaceId,
        identity: { canonicalPath: identity.canonicalPath, dev: identity.dev, ino: identity.ino },
        workRunId: run.workRunId,
        subjectKey: run.subjectKey,
        ownerId: run.ownerId,
        runFence: run.fence,
        bindingFence: state.workspaceFenceSeq,
        state: 'bound',
        boundAt: at,
        updatedAt: at,
      };
      state.workspaceBindings[workspaceId] = binding;
      run.workspaceId = workspaceId;
      run.updatedAt = at;
      return { ok: true, bound: true, binding: clone(binding), public: publicWorkspaceBinding(binding) };
    });
  }

  function getWorkspaceBinding(workspaceId, options = {}) {
    const state = loadState();
    if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId)) return null;
    const binding = own(state.workspaceBindings, workspaceId);
    if (!binding) return null;
    return options.public === false ? clone(binding) : publicWorkspaceBinding(binding);
  }

  // Pure read (no lock, no write). A positive answer is a point-in-time check, not effect authority.
  function verifyWorkspaceFence(input = {}) {
    if (input.expectedRevisionSeq !== undefined || input.expectedHeadOid !== undefined || input.revision !== undefined) {
      return { ok: false, reason: 'workspace_revision_unavailable' };
    }
    const state = loadState();
    const run = own(state.workRuns, input.workRunId);
    if (!run) return { ok: false, reason: 'not_found' };
    const owner = assertRunOwner(run, input.ownerId, input.fence);
    if (!owner.ok) return owner;
    const binding = currentWorkspaceBinding(state, run, input);
    if (!binding) return { ok: false, reason: 'stale_binding_fence' };
    return { ok: true, binding: clone(binding) };
  }

  function releaseWorkspace(input = {}) {
    if (input.handoffTo !== undefined) return { ok: false, reason: 'workspace_handoff_unavailable' };
    return mutate((state) => {
      const run = own(state.workRuns, input.workRunId);
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      const binding = currentWorkspaceBinding(state, run, input);
      if (!binding) return noCommit({ ok: false, reason: 'stale_binding_fence' });
      // The binding is removed; state stays v2 and workspaceFenceSeq is kept so fences never repeat.
      delete state.workspaceBindings[binding.workspaceId];
      run.workspaceId = null;
      run.updatedAt = nowIso(clock);
      return { ok: true, released: true, handoffPending: false, public: publicWorkspaceBinding(binding) };
    });
  }

  function appendEvent(input = {}) {
    let evidence = null;
    const result = mutate((state) => {
      const run = state.workRuns[input.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      if (!WORK_RUN_EVENT_TYPES.has(input.type)) return noCommit({ ok: false, reason: 'invalid_event_type' });
      if (!OPAQUE_ID.test(input.operationNonce || '')) return noCommit({ ok: false, reason: 'operation_nonce_required' });
      const previous = run.eventNonces[input.operationNonce];
      if (previous) return noCommit({ ok: true, deduped: true, event: clone(previous), workRun: clone(run), public: publicRun(run) });
      const detail = input.detail === undefined || input.detail === null
        ? null
        : Array.isArray(input.detail) ? input.detail : [input.detail];
      const event = {
        version: WORK_RUN_EVENT_VERSION,
        eventId: `event_${digest([run.workRunId, input.operationNonce]).slice(0, 24)}`,
        type: input.type,
        operation: input.operation || null,
        status: input.status || null,
        reasonCode: input.reasonCode || null,
        provider: input.provider ? normalizeProviderSnapshot(input.provider) : null,
        artifact: input.artifact ? normalizeArtifact(input.artifact, { allowPrivatePath: true }) : null,
        detail,
        operationNonce: input.operationNonce,
        at: nowIso(clock),
      };
      assertSafeValue(event.detail, 'event.detail', { allowPath: true });
      run.events.push(event);
      run.eventNonces[input.operationNonce] = event;
      if (event.artifact && !run.artifacts.some((artifact) => artifact.reference === event.artifact.reference)) run.artifacts.push(event.artifact);
      run.updatedAt = event.at;
      evidence = { workRunId: run.workRunId, ownerId: input.ownerId, fence: input.fence, event };
      return { ok: true, deduped: false, event: clone(event), workRun: clone(run), public: publicRun(run) };
    });
    // Best-effort post-commit delivery (after lock release): not exactly-once and not an outbox.
    if (evidence && evidencePort && typeof evidencePort.append === 'function') evidencePort.append(evidence);
    return result;
  }

  function recordProviderSnapshot(input = {}) {
    return mutate((state) => {
      const run = state.workRuns[input.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      const snapshot = normalizeProviderSnapshot(input.providerSnapshot);
      if (run.providerSnapshot && run.providerSnapshot.pinDigest !== snapshot.pinDigest) return noCommit({ ok: false, reason: 'provider_pin_conflict', public: publicRun(run) });
      run.providerSnapshot = snapshot;
      run.updatedAt = nowIso(clock);
      return { ok: true, providerSnapshot: clone(snapshot), workRun: clone(run), public: publicRun(run) };
    });
  }

  function acceptPlan(input = {}) {
    return mutate((state) => {
      const run = state.workRuns[input.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      if (!isDigest(input.planDigest)) return noCommit({ ok: false, reason: 'invalid_plan_digest' });
      const expected = input.expectedPlanDigest === undefined ? null : input.expectedPlanDigest;
      const current = run.acceptedPlan?.digest || null;
      if (current !== expected) return noCommit({ ok: false, reason: 'plan_compare_and_set_conflict', authoritativePlanDigest: current, public: publicRun(run) });
      if (input.packetDigest !== undefined && !isDigest(input.packetDigest)) return noCommit({ ok: false, reason: 'invalid_packet_digest' });
      const artifact = normalizeArtifact({ ...(input.artifact || {}), kind: 'plan', digest: input.planDigest }, { allowPrivatePath: true });
      if (run.providerSnapshot && input.providerPinDigest && run.providerSnapshot.pinDigest !== input.providerPinDigest) return noCommit({ ok: false, reason: 'provider_pin_conflict' });
      run.acceptedPlan = {
        digest: input.planDigest,
        artifactReference: artifact.reference,
        packetDigest: input.packetDigest || null,
        providerPinDigest: input.providerPinDigest || run.providerSnapshot?.pinDigest || null,
        acceptedAt: nowIso(clock),
      };
      if (!run.artifacts.some((entry) => entry.reference === artifact.reference)) run.artifacts.push(artifact);
      run.updatedAt = run.acceptedPlan.acceptedAt;
      return { ok: true, accepted: true, acceptedPlan: clone(run.acceptedPlan), workRun: clone(run), public: publicRun(run) };
    });
  }

  function setRecoveryState(input = {}) {
    return mutate((state) => {
      const run = state.workRuns[input.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      if (!WORK_RUN_STATES.has(input.state) || input.state === 'completed') return noCommit({ ok: false, reason: 'invalid_recovery_state' });
      if (typeof input.reasonCode !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(input.reasonCode)) return noCommit({ ok: false, reason: 'invalid_reason_code' });
      if (input.state === 'blocked'
        && input.reasonCode === 'native_fallback_in_progress'
        && run.recovery?.state === 'blocked'
        && run.recovery?.reasonCode === 'native_fallback_in_progress') {
        return noCommit({ ok: false, reason: 'recovery_in_progress', workRun: clone(run), public: publicRun(run) });
      }
      const at = nowIso(clock);
      run.state = input.state;
      run.recovery = { state: input.state, reasonCode: input.reasonCode, updatedAt: at };
      run.updatedAt = at;
      return { ok: true, workRun: clone(run), public: publicRun(run) };
    });
  }

  function setTerminalEvidence(input = {}) {
    return mutate((state) => {
      const run = state.workRuns[input.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      if (!isObject(input.evidence) || typeof input.evidence.reference !== 'string' || !OPAQUE_ID.test(input.evidence.reference)) return noCommit({ ok: false, reason: 'invalid_terminal_evidence' });
      const evidence = { reference: input.evidence.reference, digest: input.evidence.digest || null, status: input.evidence.status || null, fence: input.fence, recordedAt: nowIso(clock) };
      if (evidence.digest !== null && !isDigest(evidence.digest)) return noCommit({ ok: false, reason: 'invalid_terminal_evidence_digest' });
      run.terminalEvidence = evidence;
      run.state = input.state === 'failed' ? 'failed' : input.state === 'blocked' ? 'blocked' : 'completed';
      run.updatedAt = evidence.recordedAt;
      return { ok: true, terminalEvidence: clone(evidence), workRun: clone(run), public: publicRun(run) };
    });
  }

  function recordProviderReceipt(input = {}) {
    const validation = validateWorkflowProviderReceipt(input.receipt, { manifest: input.manifest, request: input.request });
    if (!validation.ok) return { ok: false, reason: 'invalid_provider_receipt', errors: validation.errors };
    const projected = projectPublicWorkflowProviderReceipt(validation.receipt);
    return appendEvent({
      workRunId: input.workRunId,
      ownerId: input.ownerId,
      fence: input.fence,
      type: 'provider',
      operation: validation.receipt.operation,
      status: validation.receipt.status,
      operationNonce: validation.receipt.operationNonce,
      provider: validation.receipt.provider,
      artifact: validation.receipt.artifact,
      detail: projected.projection?.diagnostics || [],
    });
  }

  return {
    resolveWorkRun,
    getWorkRun,
    getFollowThrough,
    bindFollowThrough,
    claimWorkRun,
    releaseWorkRun,
    bindWorkspace,
    getWorkspaceBinding,
    verifyWorkspaceFence,
    releaseWorkspace,
    appendEvent,
    recordProviderSnapshot,
    recordProviderReceipt,
    acceptPlan,
    setRecoveryState,
    setTerminalEvidence,
    projectPublicWorkRun: (workRun) => publicRun(workRun),
    validateState,
  };
}

function createMemoryWorkRunStore(options = {}) {
  let state = clone(options.initialState || emptyState());
  if (state.schemaVersion === undefined) state = emptyState();
  const backend = {
    load: () => clone(state),
    save(next, expectedRevision) {
      if (state.revision !== expectedRevision) throw new Error('concurrent work-run state mutation');
      state = clone(next);
    },
  };
  return createWorkRunStore({ ...options, backend });
}

function readWorkRunStateFile(statePath) {
  if (!fs.existsSync(statePath)) return emptyState();
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (error) { throw new Error(`corrupt work-run state: ${error.message}`); }
  const validation = validateState(state);
  if (!validation.ok) throw new Error(`invalid work-run state: ${validation.errors.join('; ')}`);
  return state;
}

function createFileWorkRunStore(rootDir, options = {}) {
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('rootDir is required');
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(rootDir, 'work-runs.json');
  const lockPath = path.join(rootDir, 'work-runs.lock');
  const read = () => readWorkRunStateFile(statePath);
  function withLock(fn) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      return fn();
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('work-run store is busy');
      throw error;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  // Caller must hold the lock.
  function saveLocked(next, expectedRevision) {
    const current = read();
    if (current.revision !== expectedRevision) throw new Error('concurrent work-run state mutation');
    const tempPath = `${statePath}.${process.pid}.tmp`;
    const fd = fs.openSync(tempPath, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tempPath, statePath);
  }
  const backend = {
    load: read,
    save(next, expectedRevision) {
      return withLock(() => saveLocked(next, expectedRevision));
    },
    transact(fn) {
      return withLock(() => fn({ load: read, save: saveLocked }));
    },
  };
  const workspaceResolver = options.workspaceResolver || createFsWorkspaceResolver();
  return Object.assign(createWorkRunStore({ ...options, workspaceResolver, backend }), { paths: { rootDir, statePath, lockPath } });
}

// Read-only status view: never creates the root, takes the lock, or writes state.
function createFileWorkRunStatusReader(rootDir) {
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('rootDir is required');
  const statePath = path.join(rootDir, 'work-runs.json');
  const store = createWorkRunStore({
    backend: {
      load: () => readWorkRunStateFile(statePath),
      save() { throw new Error('work-run status reader is read-only'); },
    },
  });
  // Pure loadState getters only; none of them reach mutate, so the throwing save is never called.
  return {
    getWorkRun: store.getWorkRun,
    getFollowThrough: store.getFollowThrough,
    getWorkspaceBinding: store.getWorkspaceBinding,
    verifyWorkspaceFence: store.verifyWorkspaceFence,
  };
}

function createControlPlaneWorkRunEvidencePort(options = {}) {
  if (!options.service || typeof options.service.execute !== 'function') throw new Error('control-plane service is required');
  if (typeof options.credential !== 'string') throw new Error('control-plane credential is required');
  return {
    append({ workRunId, ownerId, fence, event }) {
      return options.service.execute('recordEvidence', {
        credential: options.credential,
        workRunId,
        ownerId,
        fence,
        evidence: event,
      });
    },
    list(workRunId) {
      return options.service.execute('listEvidence', { credential: options.credential, workRunId });
    },
  };
}

module.exports = {
  FOLLOW_THROUGH_BINDING_VERSION,
  WORK_RUN_EVENT_VERSION,
  WORK_RUN_PUBLIC_VERSION,
  WORK_RUN_STORE_SCHEMA_VERSION,
  WORK_RUN_STORE_SCHEMA_VERSION_V2,
  WORKSPACE_BINDING_PUBLIC_VERSION,
  WORKSPACE_BINDING_VERSION,
  WORK_RUN_STATES: [...WORK_RUN_STATES],
  createControlPlaneWorkRunEvidencePort,
  createFileWorkRunStatusReader,
  createFileWorkRunStore,
  createFsWorkspaceResolver,
  createMemoryWorkRunStore,
  createWorkRunStore,
  publicFollowThrough,
  publicRun,
  publicWorkspaceBinding,
  validateState,
};
