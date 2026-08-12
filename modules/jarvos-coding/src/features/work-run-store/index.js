'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  projectPublicWorkflowProviderReceipt,
  validateWorkflowProviderReceipt,
} = require('../../providers/workflow-provider');

const WORK_RUN_STORE_SCHEMA_VERSION = 'jarvos-coding-work-run/v1';
const WORK_RUN_EVENT_VERSION = 'jarvos-coding-work-run-event/v1';
const WORK_RUN_PUBLIC_VERSION = 'jarvos-coding-work-run-public/v1';
const WORK_RUN_STATES = new Set(['active', 'blocked', 'completed', 'failed']);
const WORK_RUN_EVENT_TYPES = new Set(['route', 'provider', 'artifact', 'recovery', 'terminal']);
const SHA256 = /^[a-f0-9]{64}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
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
  };
}

function validateState(state) {
  const errors = [];
  if (!isObject(state)) return { ok: false, errors: ['work-run state must be an object'] };
  if (state.schemaVersion !== WORK_RUN_STORE_SCHEMA_VERSION) errors.push(`state.schemaVersion must be ${WORK_RUN_STORE_SCHEMA_VERSION}`);
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push('state.revision must be a non-negative integer');
  if (!isObject(state.workRuns)) errors.push('state.workRuns must be an object');
  for (const [id, run] of Object.entries(state.workRuns || {})) {
    if (id !== run.workRunId) errors.push(`workRuns.${id}.workRunId must match its key`);
    if (!isObject(run)) { errors.push(`workRuns.${id} must be an object`); continue; }
    if (run.schemaVersion !== WORK_RUN_STORE_SCHEMA_VERSION) errors.push(`workRuns.${id}.schemaVersion is invalid`);
    if (!OPAQUE_ID.test(run.workRunId || '')) errors.push(`workRuns.${id}.workRunId must be opaque`);
    if (!SUBJECT_KEY.test(run.subjectKey || '')) errors.push(`workRuns.${id}.subjectKey must be safe`);
    if (!WORK_RUN_STATES.has(run.state)) errors.push(`workRuns.${id}.state is invalid`);
    if (!Number.isInteger(run.fence) || run.fence < 0) errors.push(`workRuns.${id}.fence must be a non-negative integer`);
    if (!Array.isArray(run.events)) errors.push(`workRuns.${id}.events must be an array`);
    if (!Array.isArray(run.artifacts)) errors.push(`workRuns.${id}.artifacts must be an array`);
    if (!isObject(run.recovery)) errors.push(`workRuns.${id}.recovery must be an object`);
  }
  return { ok: errors.length === 0, errors };
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

  function loadState() {
    const state = options.backend.load();
    const validation = validateState(state);
    if (!validation.ok) throw new Error(`invalid work-run state: ${validation.errors.join('; ')}`);
    return state;
  }

  function commit(state, expectedRevision) {
    const validation = validateState(state);
    if (!validation.ok) throw new Error(`invalid work-run state: ${validation.errors.join('; ')}`);
    state.revision = expectedRevision + 1;
    options.backend.save(state, expectedRevision);
  }

  function mutate(mutator) {
    const state = loadState();
    const expectedRevision = state.revision;
    const result = mutator(state);
    if (result && result.__noCommit) return result.value;
    commit(state, expectedRevision);
    return result;
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
    return mutate((state) => {
      const run = state.workRuns[input.workRunId];
      if (!run) return noCommit({ ok: false, reason: 'not_found' });
      const owner = assertRunOwner(run, input.ownerId, input.fence);
      if (!owner.ok) return noCommit(owner);
      run.ownerId = null;
      run.updatedAt = nowIso(clock);
      return { ok: true, workRun: clone(run), public: publicRun(run) };
    });
  }

  function appendEvent(input = {}) {
    return mutate((state) => {
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
      if (evidencePort && typeof evidencePort.append === 'function') evidencePort.append({ workRunId: run.workRunId, event });
      return { ok: true, deduped: false, event: clone(event), workRun: clone(run), public: publicRun(run) };
    });
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
      const artifact = normalizeArtifact({ ...(input.artifact || {}), kind: 'plan', digest: input.planDigest }, { allowPrivatePath: true });
      if (run.providerSnapshot && input.providerPinDigest && run.providerSnapshot.pinDigest !== input.providerPinDigest) return noCommit({ ok: false, reason: 'provider_pin_conflict' });
      run.acceptedPlan = {
        digest: input.planDigest,
        artifactReference: artifact.reference,
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
      const evidence = { reference: input.evidence.reference, digest: input.evidence.digest || null, status: input.evidence.status || null, recordedAt: nowIso(clock) };
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
    claimWorkRun,
    releaseWorkRun,
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

function createFileWorkRunStore(rootDir, options = {}) {
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('rootDir is required');
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(rootDir, 'work-runs.json');
  const lockPath = path.join(rootDir, 'work-runs.lock');
  function read() {
    if (!fs.existsSync(statePath)) return emptyState();
    let state;
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (error) { throw new Error(`corrupt work-run state: ${error.message}`); }
    const validation = validateState(state);
    if (!validation.ok) throw new Error(`invalid work-run state: ${validation.errors.join('; ')}`);
    return state;
  }
  function withLock(fn) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      return fn();
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('work-run store is busy');
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const backend = {
    load: read,
    save(next, expectedRevision) {
      return withLock(() => {
        const current = read();
        if (current.revision !== expectedRevision) throw new Error('concurrent work-run state mutation');
        const tempPath = `${statePath}.${process.pid}.tmp`;
        const fd = fs.openSync(tempPath, 'w', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tempPath, statePath);
      });
    },
  };
  return Object.assign(createWorkRunStore({ ...options, backend }), { paths: { rootDir, statePath, lockPath } });
}

function createControlPlaneWorkRunEvidencePort(options = {}) {
  if (!options.service || typeof options.service.execute !== 'function') throw new Error('control-plane service is required');
  if (typeof options.credential !== 'string') throw new Error('control-plane credential is required');
  return {
    append({ workRunId, event }) {
      return options.service.execute('recordEvidence', {
        credential: options.credential,
        workRunId,
        evidence: event,
      });
    },
    list(workRunId) {
      return options.service.execute('listEvidence', { credential: options.credential, workRunId });
    },
  };
}

module.exports = {
  WORK_RUN_EVENT_VERSION,
  WORK_RUN_PUBLIC_VERSION,
  WORK_RUN_STORE_SCHEMA_VERSION,
  WORK_RUN_STATES: [...WORK_RUN_STATES],
  createControlPlaneWorkRunEvidencePort,
  createFileWorkRunStore,
  createMemoryWorkRunStore,
  createWorkRunStore,
  publicRun,
  validateState,
};
