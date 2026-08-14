'use strict';

const path = require('node:path');

const {
  loadCompoundEngineeringProviderManifest,
} = require('../../providers/compound-engineering');
const {
  buildWorkflowProviderRequest,
  validateWorkflowProviderReceipt,
} = require('../../providers/workflow-provider');
const {
  evaluateLearningEligibility,
  screenLearningReceipt,
} = require('../../providers/learning-eligibility');
const {
  runTakeIssueToDone,
} = require('../orchestrator');
const { deriveLearningSignal } = require('../learning-signal');
const { assessTerminalSubmission } = require('../../adapters/hosts');

const MANAGED_WORKFLOW_SCHEMA_VERSION = 'jarvos-managed-coding-workflow/v1';
const IMPLEMENTATION_PACKET_VERSION = 'jarvos-implementation-packet/v1';
const DEFAULT_PROVIDER_TIMEOUT_MS = 120000;
const SHA256 = /^[a-f0-9]{64}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RELATIVE_PATH = /^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const SHELL_META = /[;&|`$<>\n\r]/;
const FORBIDDEN_INVOCATION_FIELDS = new Set(['executable', 'command', 'shell', 'cwd', 'plugin', 'pluginId', 'activation', 'activationCommand', 'prompt', 'artifactPath', 'receiptPath']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function digest(value) {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function defaultManifestPath() {
  return path.resolve(__dirname, '../../providers/compound-engineering.json');
}

function resolveManifest(options = {}) {
  if (options.manifest) return options.manifest;
  return loadCompoundEngineeringProviderManifest(options.manifestPath || defaultManifestPath(), { root: options.root || path.resolve(__dirname, '../../..') }).manifest;
}

function validateImplementationPacket(packet = {}, expectedPlanDigest) {
  const errors = [];
  if (!isObject(packet)) return { ok: false, errors: ['implementation packet must be an object'] };
  if (packet.version !== IMPLEMENTATION_PACKET_VERSION) errors.push(`implementation packet.version must be ${IMPLEMENTATION_PACKET_VERSION}`);
  if (!SHA256.test(packet.planDigest || '')) errors.push('implementation packet.planDigest must be a SHA-256 digest');
  if (expectedPlanDigest && packet.planDigest !== expectedPlanDigest) errors.push('implementation packet.planDigest must match the accepted plan');
  if (!Array.isArray(packet.steps) || packet.steps.length < 1 || packet.steps.length > 128) errors.push('implementation packet.steps must contain 1 to 128 steps');
  if (Array.isArray(packet.steps)) packet.steps.forEach((step, index) => {
    if (!isObject(step)) { errors.push(`implementation packet.steps[${index}] must be an object`); return; }
    if (!OPAQUE_ID.test(step.id || '')) errors.push(`implementation packet.steps[${index}].id must be opaque`);
    if (typeof step.description !== 'string' || !step.description.trim() || step.description.length > 500 || SHELL_META.test(step.description)) errors.push(`implementation packet.steps[${index}].description is unsafe`);
    if (step.files !== undefined && (!Array.isArray(step.files) || step.files.length > 64 || step.files.some((file) => typeof file !== 'string' || !RELATIVE_PATH.test(file)))) errors.push(`implementation packet.steps[${index}].files must be safe repo-relative paths`);
    if (step.mutation !== undefined && (typeof step.mutation !== 'string' || SHELL_META.test(step.mutation) || step.mutation.length > 500)) errors.push(`implementation packet.steps[${index}].mutation is unsafe`);
  });
  for (const key of Object.keys(packet)) if (!['version', 'planDigest', 'steps', 'summary'].includes(key)) errors.push(`implementation packet.${key} is unknown`);
  if (packet.summary !== undefined && (typeof packet.summary !== 'string' || packet.summary.length > 500 || SHELL_META.test(packet.summary))) errors.push('implementation packet.summary is unsafe');
  return { ok: errors.length === 0, errors, packet };
}

function providerHealthy(manifest, snapshot, operation) {
  return Boolean(
    manifest && snapshot
      && manifest.operations?.includes(operation)
      && manifest.harnesses?.[snapshot.harness]?.status === 'supported'
      && snapshot.id === manifest.id
      && snapshot.version === manifest.version
      && snapshot.pinDigest === manifest.source.contentDigest
      && snapshot.status === 'verified',
  );
}

function buildProviderInvocation({ operation, request, packet = null }) {
  if (!request || !isObject(request.provider)) throw new Error('provider invocation requires a validated request');
  const invocation = {
    version: MANAGED_WORKFLOW_SCHEMA_VERSION,
    operation,
    workRunId: request.workRunId,
    operationNonce: request.operationNonce,
    idempotencyKey: request.idempotencyKey,
    provider: clone(request.provider),
    canonicalWorktree: request.canonicalWorktree,
    input: clone(request.input),
    args: [operation, request.workRunId, request.operationNonce],
    env: {
      JARVOS_WORK_RUN_ID: request.workRunId,
      JARVOS_PROVIDER_OPERATION: operation,
    },
    implementationPacket: packet ? clone(packet) : null,
  };
  for (const key of Object.keys(invocation)) if (FORBIDDEN_INVOCATION_FIELDS.has(key)) throw new Error(`provider invocation.${key} is forbidden`);
  return invocation;
}

function createManagedCodingWorkflow(options = {}) {
  if (!options.workRunStore) throw new Error('workRunStore is required');
  const manifest = resolveManifest(options);
  const providerAdapter = options.providerAdapter || {};
  const nativeAdapter = options.nativeAdapter || {};
  const ownerId = options.ownerId || 'jarvos-coding';
  const providerSnapshot = options.providerSnapshot || null;
  const providerSnapshotVerifier = options.providerSnapshotVerifier;
  const pendingProviders = new Set();
  const manifestValidation = isObject(manifest) && manifest.source ? null : { ok: false, errors: ['provider manifest is required'] };
  if (manifestValidation && !manifestValidation.ok) throw new Error(manifestValidation.errors.join('; '));

  function isTrustedProviderSnapshot(snapshot) {
    if (!isObject(snapshot)) return false;
    try {
      const identityMatches = snapshot.id === manifest.id
        && snapshot.version === manifest.version
        && snapshot.pinDigest === manifest.source.contentDigest
        && typeof snapshot.harness === 'string'
        && manifest.harnesses?.[snapshot.harness]
        && snapshot.adapterVersion === manifest.harnesses[snapshot.harness].adapter
        && ['verified', 'degraded', 'unsupported', 'unavailable'].includes(snapshot.status);
      if (!identityMatches) return false;
      if (typeof providerSnapshotVerifier !== 'function') return true;
      const result = providerSnapshotVerifier({ snapshot: clone(snapshot), manifest: clone(manifest) });
      return result === true || result?.ok === true;
    } catch (error) {
      return false;
    }
  }

  const trustedConfiguredSnapshot = isTrustedProviderSnapshot(providerSnapshot) ? providerSnapshot : null;

  function claim(input) {
    const subjectKey = input.subjectKey || input.issueIdentifier || input.issue?.identifier;
    if (typeof subjectKey !== 'string' || !subjectKey) throw new Error('coding workflow requires a stable subjectKey');
    let claimed = options.workRunStore.claimWorkRun({
      subjectKey,
      workRunId: input.workRunId,
      canonicalWorktree: input.canonicalWorktree,
      ownerId: input.ownerId || ownerId,
      providerSnapshot: trustedConfiguredSnapshot,
    });
    if (!claimed.ok) throw new Error(`coding work-run claim failed: ${claimed.reason}`);
    if (trustedConfiguredSnapshot && claimed.workRun.providerSnapshot
      && claimed.workRun.providerSnapshot.pinDigest !== trustedConfiguredSnapshot.pinDigest) {
      throw new Error('coding provider snapshot failed: provider_pin_conflict');
    }
    if (trustedConfiguredSnapshot && !claimed.workRun.providerSnapshot) {
      const recorded = options.workRunStore.recordProviderSnapshot({
        workRunId: claimed.workRunId,
        ownerId: claimed.ownerId,
        fence: claimed.fence,
        providerSnapshot: trustedConfiguredSnapshot,
      });
      if (!recorded.ok) throw new Error(`coding provider snapshot failed: ${recorded.reason}`);
      claimed = { ...claimed, workRun: recorded.workRun, public: recorded.public };
    }
    return claimed;
  }

  function providerSnapshotFor(input, claimed) {
    return claimed.workRun.providerSnapshot || null;
  }

  function nativeInvocation({ operation, claimed, input, packet = null }) {
    const requestInput = input.input || { kind: `${operation}-input`, digest: digest(input.payload || input.issue || input.subjectKey) };
    const operationNonce = input.operationNonce || `${operation}-${claimed.workRunId}`;
    return {
      version: MANAGED_WORKFLOW_SCHEMA_VERSION,
      operation,
      workRunId: claimed.workRunId,
      operationNonce,
      idempotencyKey: input.idempotencyKey || `${operation}:${claimed.workRunId}`,
      provider: null,
      canonicalWorktree: input.canonicalWorktree || claimed.workRun.canonicalWorktree,
      input: clone(requestInput),
      args: [operation, claimed.workRunId, operationNonce],
      env: {
        JARVOS_WORK_RUN_ID: claimed.workRunId,
        JARVOS_PROVIDER_OPERATION: operation,
      },
      implementationPacket: packet ? clone(packet) : null,
    };
  }

  function nativeFallbackInvocation(invocation) {
    return {
      ...invocation,
      provider: null,
      route: 'native-fallback',
    };
  }

  function recordNativeRecovery(claimed, invocation) {
    return options.workRunStore.appendEvent({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      type: 'recovery',
      operation: 'work',
      status: 'succeeded',
      operationNonce: `recovery-work-${digest(invocation.operationNonce).slice(0, 24)}`,
      reasonCode: 'native_fallback_succeeded',
    });
  }

  function providerIdentity(snapshot) {
    if (!isObject(snapshot)) return snapshot;
    const { status, observedAt, ...identity } = snapshot;
    return identity;
  }

  function requestFor(operation, input, claimed, acceptedPlanDigest) {
    const provider = providerIdentity(providerSnapshotFor(input, claimed));
    const requestInput = input.input || { kind: `${operation}-input`, digest: digest(input.payload || input.issue || input.subjectKey) };
    const result = buildWorkflowProviderRequest({
      manifest,
      operation,
      workRunId: claimed.workRunId,
      operationNonce: input.operationNonce || `${operation}-${claimed.workRunId}`,
      idempotencyKey: input.idempotencyKey || `${operation}:${claimed.workRunId}`,
      provider,
      canonicalWorktree: input.canonicalWorktree || claimed.workRun.canonicalWorktree,
      input: requestInput,
      acceptedPlanDigest,
    });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.request;
  }

  function appendRoute(claimed, request, status, reasonCode, detail) {
    return options.workRunStore.appendEvent({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      type: 'route',
      operation: request.operation,
      status,
      operationNonce: `route-${request.operation}-${digest(request.operationNonce).slice(0, 24)}`,
      reasonCode,
      detail: detail ? [detail] : null,
    });
  }

  function providerReceiptRecording(recorded, receipt) {
    if (!recorded?.ok) return { ok: false, reason: recorded?.reason || 'provider_receipt_not_recorded' };
    if (!recorded.deduped) return { ok: true };
    const prior = recorded.event;
    const matches = prior?.type === 'provider'
      && prior.operation === receipt.operation
      && prior.status === receipt.status
      && prior.provider?.pinDigest === receipt.provider?.pinDigest
      && prior.artifact?.digest === receipt.artifact?.digest;
    return matches ? { ok: true } : { ok: false, reason: 'provider_receipt_replay_conflict' };
  }

  function providerOperationKey(operation, invocation) {
    return `${operation}:${invocation.workRunId}:${invocation.operationNonce}`;
  }

  function pendingWork(workRunId) {
    const prefix = `work:${workRunId}:`;
    return [...pendingProviders].some((key) => key.startsWith(prefix));
  }

  function providerTimeoutMs(input) {
    const value = input.providerTimeoutMs ?? options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async function invokeProvider(operation, invocation, providerFunction, input) {
    const key = providerOperationKey(operation, invocation);
    if (pendingProviders.has(key)) {
      const error = new Error(`provider ${operation} is still settling`);
      error.code = 'PROVIDER_PENDING';
      throw error;
    }
    pendingProviders.add(key);
    let timer;
    const providerPromise = Promise.resolve().then(() => providerFunction(invocation));
    providerPromise.then(() => pendingProviders.delete(key), () => pendingProviders.delete(key));
    try {
      return await Promise.race([
        providerPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`provider ${operation} timed out`);
            error.code = 'PROVIDER_TIMEOUT';
            reject(error);
          }, providerTimeoutMs(input));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function recoverWork(claimed, invocation, reasonCode, detail) {
    const recovery = options.workRunStore.setRecoveryState({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      state: 'blocked',
      reasonCode,
    });
    if (!recovery.ok || typeof nativeAdapter.reconcileWork !== 'function') {
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode, detail };
    }
    let reconciled;
    try {
      reconciled = await nativeAdapter.reconcileWork({ ...invocation, reasonCode });
    } catch (error) {
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode, detail: error.message };
    }
    if (!reconciled || reconciled.safe !== true) {
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode, detail };
    }
    const resumed = options.workRunStore.setRecoveryState({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      state: 'active',
      reasonCode: 'provider_work_reconciled',
    });
    if (!resumed.ok || typeof nativeAdapter.work !== 'function') {
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode, detail };
    }
    let native;
    try {
      native = await nativeAdapter.work({ ...nativeFallbackInvocation(invocation), reconciliation: reconciled });
    } catch (error) {
      options.workRunStore.setRecoveryState({
        workRunId: claimed.workRunId,
        ownerId: claimed.ownerId,
        fence: claimed.fence,
        state: 'failed',
        reasonCode: 'native_fallback_failed',
      });
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'native_fallback_failed', detail: error.message };
    }
    const recoveryEvent = recordNativeRecovery(claimed, invocation);
    if (!recoveryEvent.ok) {
      options.workRunStore.setRecoveryState({
        workRunId: claimed.workRunId,
        ownerId: claimed.ownerId,
        fence: claimed.fence,
        state: 'blocked',
        reasonCode: 'recovery_event_not_recorded',
      });
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'recovery_event_not_recorded' };
    }
    return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, work: native };
  }

  async function plan(input = {}) {
    const claimed = claim(input);
    const snapshot = providerSnapshotFor(input, claimed);
    const healthy = isTrustedProviderSnapshot(snapshot) && providerHealthy(manifest, snapshot, 'plan') && typeof providerAdapter.plan === 'function';
    if (healthy) {
      const request = requestFor('plan', input, claimed);
      const invocation = buildProviderInvocation({ operation: 'plan', request });
      let receipt;
      try {
        receipt = await invokeProvider('plan', invocation, providerAdapter.plan, input);
      } catch (error) {
        appendRoute(claimed, request, 'fallback', 'provider_unavailable', error.message);
        if (error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_PENDING') return { ok: false, status: 'blocked', route: 'compound-engineering', workRunId: claimed.workRunId, reasonCode: error.code === 'PROVIDER_TIMEOUT' ? 'provider_timeout' : 'provider_pending' };
        if (typeof nativeAdapter.plan !== 'function') return { ok: false, status: 'blocked', route: 'compound-engineering', workRunId: claimed.workRunId, reasonCode: 'provider_unavailable' };
        const native = await nativeAdapter.plan(nativeFallbackInvocation(invocation));
        return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, plan: native };
      }
      const validation = validateWorkflowProviderReceipt(receipt, { manifest, request });
      if (!validation.ok) {
        appendRoute(claimed, request, 'fallback', 'invalid_provider_receipt', validation.errors.join('; '));
        if (typeof nativeAdapter.plan !== 'function') return { ok: false, status: 'blocked', route: 'compound-engineering', workRunId: claimed.workRunId, reasonCode: 'invalid_provider_receipt' };
        const native = await nativeAdapter.plan(nativeFallbackInvocation(invocation));
        return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, plan: native };
      }
      const recorded = options.workRunStore.recordProviderReceipt({ ...input, workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, receipt, manifest, request });
      const recording = providerReceiptRecording(recorded, validation.receipt);
      if (recording.ok && validation.receipt.status === 'succeeded') {
        return { ok: true, status: 'succeeded', route: 'compound-engineering', workRunId: claimed.workRunId, request, receipt: validation.receipt, artifact: validation.receipt.artifact };
      }
      const reasonCode = recording.ok ? 'provider_failed' : recording.reason;
      appendRoute(claimed, request, 'fallback', reasonCode, recording.ok ? validation.receipt.status : recording.reason);
      if (typeof nativeAdapter.plan !== 'function') return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode };
      const native = await nativeAdapter.plan(nativeFallbackInvocation(invocation));
      return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, plan: native };
    }
    const route = {
      operation: 'plan',
      operationNonce: input.operationNonce || `plan-${claimed.workRunId}`,
    };
    appendRoute(claimed, route, 'fallback', 'provider_unsupported', 'provider is not healthy for the active harness');
    if (typeof nativeAdapter.plan !== 'function') return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'native_route_unavailable' };
    const native = await nativeAdapter.plan(nativeInvocation({ operation: 'plan', claimed, input }));
    return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, plan: native };
  }

  async function acceptPlan(input = {}) {
    const claimed = claim(input);
    const snapshot = providerSnapshotFor(input, claimed);
    if (snapshot && !isTrustedProviderSnapshot(snapshot)) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'provider_snapshot_untrusted' };
    const packetValidation = validateImplementationPacket(input.packet, input.planDigest);
    if (!packetValidation.ok) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'invalid_implementation_packet', errors: packetValidation.errors };
    // The standalone legacy constructor remains compatible; the public
    // runtime always passes the owner-controlled policy explicitly.
    const policy = input.acceptancePolicy || options.acceptancePolicy || { mode: 'agent-mediated-allowed' };
    const evidence = input.acceptanceEvidence || null;
    if (policy.mode !== 'agent-mediated-allowed' && (!evidence || evidence.planDigest !== input.planDigest || typeof evidence.source !== 'string')) {
      return { ok: false, status: 'awaiting-plan-acceptance', workRunId: claimed.workRunId, reasonCode: 'acceptance_evidence_required' };
    }
    return options.workRunStore.acceptPlan({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      expectedPlanDigest: input.expectedPlanDigest,
      planDigest: input.planDigest,
      providerPinDigest: snapshot?.pinDigest || null,
      packetDigest: digest(packetValidation.packet),
      artifact: input.artifact,
      acceptanceEvidence: evidence,
    });
  }

  async function work(input = {}) {
    const claimed = claim(input);
    const snapshot = providerSnapshotFor(input, claimed);
    if (snapshot && !isTrustedProviderSnapshot(snapshot)) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'provider_snapshot_untrusted' };
    const accepted = claimed.workRun.acceptedPlan;
    if (!accepted || accepted.digest !== input.planDigest) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'accepted_plan_mismatch' };
    const packetValidation = validateImplementationPacket(input.packet, accepted.digest);
    if (!packetValidation.ok) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'invalid_implementation_packet', errors: packetValidation.errors };
    if (!accepted.packetDigest || accepted.packetDigest !== digest(packetValidation.packet)) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'accepted_plan_mismatch' };
    if (accepted.providerPinDigest && accepted.providerPinDigest !== snapshot?.pinDigest) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'provider_pin_conflict' };
    if (!accepted.providerPinDigest && snapshot?.pinDigest) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'provider_pin_conflict' };
    const previousRecovery = claimed.workRun.recovery;
    const priorNativeRecovery = claimed.workRun.events?.find((event) => event.type === 'recovery' && event.operation === 'work' && event.status === 'succeeded');
    if (priorNativeRecovery) return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, recovery: priorNativeRecovery, deduped: true };
    if (previousRecovery?.state === 'failed' || ['native_fallback_failed', 'recovery_event_not_recorded'].includes(previousRecovery?.reasonCode)) {
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: previousRecovery.reasonCode || 'recovery_failed' };
    }
    if (previousRecovery?.state === 'blocked' && previousRecovery.reasonCode === 'native_fallback_in_progress') {
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'native_fallback_in_progress' };
    }
    if (previousRecovery?.state === 'blocked' && previousRecovery.reasonCode === 'provider_timeout') {
      if (pendingWork(claimed.workRunId)) return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'provider_pending' };
      return recoverWork(claimed, nativeInvocation({ operation: 'work', claimed, input, packet: packetValidation.packet }), 'provider_timeout_recovery', 'provider timeout requires reconciliation before retry');
    }
    const managedRoute = Boolean(snapshot && providerHealthy(manifest, snapshot, 'work') && typeof providerAdapter.work === 'function');
    if (managedRoute) {
      const request = requestFor('work', input, claimed, accepted.digest);
      const invocation = buildProviderInvocation({ operation: 'work', request, packet: packetValidation.packet });
      try {
        const receipt = await invokeProvider('work', invocation, providerAdapter.work, input);
        const validation = validateWorkflowProviderReceipt(receipt, { manifest, request });
        if (validation.ok) {
          const recorded = options.workRunStore.recordProviderReceipt({ ...input, workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, receipt, manifest, request });
          const recording = providerReceiptRecording(recorded, validation.receipt);
          if (recording.ok && validation.receipt.status === 'succeeded') return { ok: true, status: 'succeeded', route: 'compound-engineering', workRunId: claimed.workRunId, receipt: validation.receipt };
          const reasonCode = recording.ok ? 'provider_failed' : recording.reason;
          appendRoute(claimed, request, 'fallback', reasonCode, recording.ok ? validation.receipt.status : recording.reason);
          return recoverWork(claimed, invocation, reasonCode, recording.ok ? validation.receipt.status : recording.reason);
        }
        appendRoute(claimed, request, 'fallback', 'invalid_provider_receipt', validation.errors?.join('; ') || 'provider receipt was not recorded');
        return recoverWork(claimed, invocation, 'invalid_provider_receipt', validation.errors?.join('; '));
      } catch (error) {
        appendRoute(claimed, request, 'fallback', 'provider_unavailable', error.message);
        if (error.code === 'PROVIDER_TIMEOUT') {
          options.workRunStore.setRecoveryState({
            workRunId: claimed.workRunId,
            ownerId: claimed.ownerId,
            fence: claimed.fence,
            state: 'blocked',
            reasonCode: 'provider_timeout',
          });
          return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'provider_timeout' };
        }
        if (error.code === 'PROVIDER_PENDING') return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'provider_pending' };
        return recoverWork(claimed, invocation, error.code === 'PROVIDER_TIMEOUT' ? 'provider_timeout' : 'provider_unavailable', error.message);
      }
    }
    const route = {
      operation: 'work',
      operationNonce: input.operationNonce || `work-${claimed.workRunId}`,
    };
    appendRoute(claimed, route, 'fallback', 'provider_unsupported', 'provider is not healthy for the active harness');
    if (typeof nativeAdapter.work !== 'function') return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'native_route_unavailable' };
    const nativeInvocationValue = nativeInvocation({ operation: 'work', claimed, input, packet: packetValidation.packet });
    const preparing = options.workRunStore.setRecoveryState({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      state: 'blocked',
      reasonCode: 'native_fallback_in_progress',
    });
    if (!preparing.ok) {
      const reasonCode = preparing.reason === 'recovery_in_progress'
        ? 'native_fallback_in_progress'
        : 'recovery_state_not_recorded';
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode };
    }
    let native;
    try {
      native = await nativeAdapter.work(nativeInvocationValue);
    } catch (error) {
      options.workRunStore.setRecoveryState({
        workRunId: claimed.workRunId,
        ownerId: claimed.ownerId,
        fence: claimed.fence,
        state: 'failed',
        reasonCode: 'native_fallback_failed',
      });
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'native_fallback_failed', detail: error.message };
    }
    const recorded = recordNativeRecovery(claimed, nativeInvocationValue);
    if (!recorded.ok) {
      options.workRunStore.setRecoveryState({
        workRunId: claimed.workRunId,
        ownerId: claimed.ownerId,
        fence: claimed.fence,
        state: 'failed',
        reasonCode: 'recovery_event_not_recorded',
      });
      return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'recovery_event_not_recorded' };
    }
    options.workRunStore.setRecoveryState({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      state: 'active',
      reasonCode: 'native_fallback_succeeded',
    });
    return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, work: native };
  }

  function learningEvent(claimed) {
    const run = options.workRunStore.getWorkRun(claimed.workRunId, { public: false });
    return run?.events?.find((event) => event.operation === 'compound'
      && !(event.type === 'route' && ['unavailable', 'failed'].includes(event.status))
      && !(event.type === 'provider' && event.status !== 'succeeded')) || null;
  }

  function learningNonce(claimed) {
    const run = options.workRunStore.getWorkRun(claimed.workRunId, { public: false });
    const attempts = run?.events?.filter((event) => event.operation === 'compound').length || 0;
    return attempts === 0 ? `compound-${claimed.workRunId}` : `compound-${claimed.workRunId}-retry-${attempts}`;
  }

  function recordLearningOutcome(claimed, outcome, nonce, detail) {
    return options.workRunStore.appendEvent({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      type: 'route',
      operation: 'compound',
      status: outcome,
      // Keep the provider's stable operation nonce separate from route
      // receipts.  A retry must reuse the provider idempotency identity while
      // still allowing the ledger to record a new route outcome.
      operationNonce: `learning-outcome-${nonce}-${outcome}`,
      reasonCode: detail?.reasonCode || null,
      detail: detail?.rationale ? [detail.rationale] : null,
    });
  }

  function learningOutcomeResponse({ claimed, nonce, status, reasonCode, rationale, ok, errors, deferredCount }) {
    const outcome = { status, reasonCode, rationale };
    const recorded = recordLearningOutcome(claimed, status, nonce, outcome);
    return {
      ok,
      status,
      learningStatus: status,
      route: 'jarvos-learning-gate',
      workRunId: claimed.workRunId,
      reasonCode,
      rationale,
      ...(errors ? { errors } : {}),
      ...(deferredCount === undefined ? {} : { deferredCount }),
      event: recorded.event || null,
    };
  }

  async function compound(input = {}) {
    const claimed = claim(input);
    const existing = learningEvent(claimed);
    if (existing) {
      return {
        ok: existing.status === 'succeeded',
        status: existing.status || 'deferred',
        learningStatus: existing.status || 'deferred',
        route: existing.type === 'provider' ? 'compound-engineering' : 'jarvos-learning-gate',
        workRunId: claimed.workRunId,
        reasonCode: 'one_learning_per_work_run',
        event: existing,
      };
    }

    const eligibility = input.persistLearningSignal === true
      ? { status: 'eligible', learning: input.learning, deferredCount: 0 }
      : evaluateLearningEligibility({
        verification: input.verification || input.orchestration,
        signals: input.learningSignals ?? input.learning,
        declined: input.declineLearning === true || input.declinedLearning === true,
      });
    const nonce = input.persistLearningSignal
      ? `compound-${claimed.workRunId}`
      : learningNonce(claimed);
    if (eligibility.status !== 'eligible') {
      return learningOutcomeResponse({
        claimed,
        nonce,
        status: eligibility.status,
        reasonCode: eligibility.reasonCode,
        rationale: eligibility.rationale,
        ok: eligibility.status !== 'failed',
        deferredCount: eligibility.deferredCount,
      });
    }

    const persistedSignal = input.persistLearningSignal === true;
    if (persistedSignal) {
      const reserved = options.workRunStore.reserveLearningFinalizer({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence });
      if (!reserved.ok) return { ok: reserved.deduped === true, status: reserved.learningTail?.status || 'finalizing', learningStatus: reserved.learningTail?.status || 'finalizing', workRunId: claimed.workRunId, reasonCode: reserved.reason, route: 'jarvos-learning-gate' };
    }

    const run = options.workRunStore.getWorkRun(claimed.workRunId, { public: false });
    const acceptedPlanDigest = input.planDigest || run?.acceptedPlan?.digest;
    if (!acceptedPlanDigest) {
      const outcome = { status: 'unavailable', reasonCode: 'accepted_plan_missing', rationale: 'learning capture requires an accepted provider-independent plan revision' };
      if (persistedSignal) options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'retryable-unavailable', reasonCode: outcome.reasonCode });
      return learningOutcomeResponse({ claimed, nonce, ...outcome, ok: true });
    }

    let request;
    try {
      request = requestFor('compound', { ...input, operationNonce: nonce }, claimed, acceptedPlanDigest);
    } catch (error) {
      const outcome = { status: 'unavailable', reasonCode: 'provider_identity_unavailable', rationale: 'approved provider identity is not available for learning capture' };
      if (persistedSignal) options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'retryable-unavailable', reasonCode: outcome.reasonCode });
      return learningOutcomeResponse({ claimed, nonce, ...outcome, ok: true });
    }

    const snapshot = providerSnapshotFor(input, claimed);
    if (!providerHealthy(manifest, snapshot, 'compound') || typeof providerAdapter.compound !== 'function') {
      const outcome = { status: 'unavailable', reasonCode: 'provider_unsupported', rationale: 'provider is not healthy for the active harness' };
      if (persistedSignal) options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'retryable-unavailable', reasonCode: outcome.reasonCode });
      return learningOutcomeResponse({ claimed, nonce, ...outcome, ok: true });
    }

    const invocation = buildProviderInvocation({ operation: 'compound', request });
    invocation.learning = {
      category: eligibility.learning.category,
      summary: eligibility.learning.summary,
      evidenceDigest: eligibility.learning.evidenceDigest,
    };
    let receipt;
    try {
      receipt = await invokeProvider('compound', invocation, providerAdapter.compound, input);
    } catch (error) {
      const outcome = { status: 'unavailable', reasonCode: 'provider_unavailable', rationale: 'provider did not return a learning receipt' };
      if (persistedSignal) options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'retryable-unavailable', reasonCode: outcome.reasonCode });
      return learningOutcomeResponse({ claimed, nonce, ...outcome, ok: true });
    }
    const validation = validateWorkflowProviderReceipt(receipt, { manifest, request });
    if (!validation.ok) {
      const outcome = { status: 'failed', reasonCode: 'invalid_provider_receipt', rationale: 'provider learning receipt failed the strict contract' };
      if (persistedSignal) options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'failed', reasonCode: outcome.reasonCode });
      return learningOutcomeResponse({ claimed, nonce, ...outcome, ok: false, errors: validation.errors });
    }
    const screen = screenLearningReceipt(validation.receipt);
    if (!screen.ok) {
      const outcome = { status: 'failed', reasonCode: 'unsafe_learning_artifact', rationale: 'learning receipt contained private or unsafe content' };
      if (persistedSignal) options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'unsafe', reasonCode: outcome.reasonCode });
      return learningOutcomeResponse({ claimed, nonce, ...outcome, ok: false, errors: screen.errors });
    }
    const recorded = options.workRunStore.recordProviderReceipt({
      ...input,
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      receipt,
      manifest,
      request,
    });
    const recording = providerReceiptRecording(recorded, validation.receipt);
    if (!recording.ok) {
      const outcome = { status: 'failed', reasonCode: recording.reason || 'learning_receipt_not_recorded', rationale: 'learning receipt could not be durably attached to the work run' };
      if (persistedSignal) options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'failed', reasonCode: outcome.reasonCode });
      return { ok: false, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, event: null };
    }
    if (persistedSignal && validation.receipt.status !== 'succeeded') {
      options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'failed', reasonCode: 'provider_learning_failed' });
    }
    return {
      ok: validation.receipt.status === 'succeeded',
      status: validation.receipt.status,
      learningStatus: validation.receipt.status === 'succeeded' ? 'captured' : 'failed',
      route: 'compound-engineering',
      workRunId: claimed.workRunId,
      receipt: validation.receipt,
      artifact: validation.receipt.artifact,
      deferredCount: eligibility.deferredCount,
    };
  }

  async function complete(input = {}, adapters = {}) {
    const claimed = claim(input);
    if (!claimed.workRun.acceptedPlan || claimed.workRun.acceptedPlan.digest !== input.planDigest) {
      return { ok: false, status: 'awaiting-plan-acceptance', workRunId: claimed.workRunId, reasonCode: 'accepted_plan_mismatch' };
    }
    const result = await runTakeIssueToDone({ ...input, workRunId: claimed.workRunId, branch: input.branch || input.branchName }, adapters);
    return { ...result, workRunId: claimed.workRunId, route: 'jarvos-orchestrator' };
  }

  async function finish(input = {}, adapters = {}) {
    const claimed = claim(input);
    const run = claimed.workRun;
    if (!run.acceptedPlan || run.acceptedPlan.digest !== input.planDigest) {
      return { ok: false, status: 'awaiting-plan-acceptance', workRunId: claimed.workRunId, reasonCode: 'accepted_plan_mismatch' };
    }
    const result = await complete(input, adapters);
    if (result.ok === false) return result;
    const assessment = assessTerminalSubmission(result);
    const verification = {
      ...result,
      submissionGate: assessment.submissionGate,
      submissionEvidence: assessment.submissionEvidence,
      nonRoutine: input.nonRoutine === true && input.routine !== true,
    };
    if (result.status !== 'completed' || !assessment.ok) {
      return {
        ...result,
        verification: null,
        primaryCompletion: result.status,
        learning: {
          status: 'not-eligible',
          reasonCode: result.status !== 'completed' ? 'coding_outcome_not_verified' : 'submission_gate_not_ready',
          reasons: assessment.reasons,
        },
      };
    }
    const evidence = {
      reference: `terminal_${digest(JSON.stringify(verification.submissionGate || verification.events || verification)).slice(0, 24)}`,
      digest: digest(JSON.stringify(verification.submissionGate || verification.events || verification)),
      status: result.status,
    };
    const terminal = options.workRunStore.setTerminalEvidence({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, evidence });
    const derived = deriveLearningSignal(verification);
    if (!derived.ok) {
      options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: derived.status === 'unsafe' ? 'unsafe' : 'not-eligible', reasonCode: derived.reasonCode });
      return { ...result, verification: terminal.ok ? terminal.terminalEvidence : null, primaryCompletion: result.status, learning: { status: derived.status, reasonCode: derived.reasonCode } };
    }
    options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'eligible', signal: derived.signal, reasonCode: 'reusable_learning_signal' });
    const learning = await compound({ ...input, workRunId: claimed.workRunId, verification, learning: derived.signal, persistLearningSignal: true });
    if (learning.learningStatus === 'captured' || learning.status === 'succeeded') options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'captured', artifact: learning.artifact || null });
    return { ...result, verification: terminal.ok ? terminal.terminalEvidence : null, primaryCompletion: result.status, learning };
  }

  async function catchUp(input = {}) {
    const claimed = claim(input);
    const run = options.workRunStore.getWorkRun(claimed.workRunId, { public: false });
    if (!run?.terminalEvidence) return { ok: true, status: run?.state || 'active', workRunId: claimed.workRunId, learning: null };
    const tail = run.learningTail || { status: 'not-evaluated' };
    if (!tail.signal || ['captured', 'not-eligible', 'declined', 'unsafe', 'unavailable'].includes(tail.status)) return { ok: true, status: 'verified', workRunId: claimed.workRunId, primaryCompletion: 'completed', learning: tail };
    if (tail.status === 'finalizing') options.workRunStore.reconcileLearningFinalizer({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence });
    const learning = await compound({ ...input, workRunId: claimed.workRunId, planDigest: run.acceptedPlan?.digest, verification: { status: 'completed', submissionGate: { ready: true }, events: [] }, learning: tail.signal, persistLearningSignal: true });
    if (learning.learningStatus === 'captured' || learning.status === 'succeeded') options.workRunStore.setLearningTail({ workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, status: 'captured', artifact: learning.artifact || null });
    return { ok: true, status: 'verified', workRunId: claimed.workRunId, primaryCompletion: 'completed', learning };
  }

  return {
    manifest,
    plan,
    acceptPlan,
    work,
    compound,
    complete,
    finish,
    status: catchUp,
    resume: catchUp,
    validateImplementationPacket,
    buildProviderInvocation,
    providerHealthy: (snapshot, operation) => providerHealthy(manifest, snapshot, operation),
  };
}

module.exports = {
  IMPLEMENTATION_PACKET_VERSION,
  MANAGED_WORKFLOW_SCHEMA_VERSION,
  buildProviderInvocation,
  createManagedCodingWorkflow,
  validateImplementationPacket,
};
