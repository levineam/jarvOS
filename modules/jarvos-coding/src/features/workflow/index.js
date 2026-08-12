'use strict';

const fs = require('node:fs');
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

const MANAGED_WORKFLOW_SCHEMA_VERSION = 'jarvos-managed-coding-workflow/v1';
const IMPLEMENTATION_PACKET_VERSION = 'jarvos-implementation-packet/v1';
const OPERATIONS = new Set(['plan', 'work', 'compound', 'complete']);
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
  const manifestValidation = isObject(manifest) && manifest.source ? null : { ok: false, errors: ['provider manifest is required'] };
  if (manifestValidation && !manifestValidation.ok) throw new Error(manifestValidation.errors.join('; '));

  function claim(input) {
    const subjectKey = input.subjectKey || input.issueIdentifier || input.issue?.identifier;
    if (typeof subjectKey !== 'string' || !subjectKey) throw new Error('coding workflow requires a stable subjectKey');
    const claimed = options.workRunStore.claimWorkRun({
      subjectKey,
      workRunId: input.workRunId,
      canonicalWorktree: input.canonicalWorktree,
      ownerId: input.ownerId || ownerId,
    });
    if (!claimed.ok) throw new Error(`coding work-run claim failed: ${claimed.reason}`);
    return claimed;
  }

  function providerSnapshotFor(input, claimed) {
    return input.provider || claimed.workRun.providerSnapshot || options.provider || null;
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
      operationNonce: request.operationNonce,
      reasonCode,
      detail: detail ? [detail] : null,
    });
  }

  async function plan(input = {}) {
    const claimed = claim(input);
    const request = requestFor('plan', input, claimed);
    const snapshot = providerSnapshotFor(input, claimed);
    if (providerHealthy(manifest, snapshot, 'plan') && typeof providerAdapter.plan === 'function') {
      const invocation = buildProviderInvocation({ operation: 'plan', request });
      let receipt;
      try {
        receipt = await providerAdapter.plan(invocation);
      } catch (error) {
        appendRoute(claimed, request, 'fallback', 'provider_unavailable', error.message);
        if (typeof nativeAdapter.plan !== 'function') return { ok: false, status: 'blocked', route: 'compound-engineering', workRunId: claimed.workRunId, reasonCode: 'provider_unavailable' };
        const native = await nativeAdapter.plan({ ...invocation, route: 'native-fallback' });
        return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, plan: native };
      }
      const validation = validateWorkflowProviderReceipt(receipt, { manifest, request });
      if (!validation.ok) {
        appendRoute(claimed, request, 'fallback', 'invalid_provider_receipt', validation.errors.join('; '));
        if (typeof nativeAdapter.plan !== 'function') return { ok: false, status: 'blocked', route: 'compound-engineering', workRunId: claimed.workRunId, reasonCode: 'invalid_provider_receipt' };
        const native = await nativeAdapter.plan({ ...invocation, route: 'native-fallback' });
        return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, plan: native };
      }
      const recorded = options.workRunStore.recordProviderReceipt({ ...input, workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, receipt, manifest, request });
      if (!recorded.ok) return { ok: false, status: 'blocked', route: 'compound-engineering', workRunId: claimed.workRunId, reasonCode: recorded.reason, errors: recorded.errors || [] };
      return { ok: true, status: 'succeeded', route: 'compound-engineering', workRunId: claimed.workRunId, request, receipt: validation.receipt, artifact: validation.receipt.artifact };
    }
    appendRoute(claimed, request, 'fallback', 'provider_unsupported', 'provider is not healthy for the active harness');
    if (typeof nativeAdapter.plan !== 'function') return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'native_route_unavailable' };
    const native = await nativeAdapter.plan(buildProviderInvocation({ operation: 'plan', request }));
    return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, plan: native };
  }

  async function acceptPlan(input = {}) {
    const claimed = claim(input);
    const packetValidation = validateImplementationPacket(input.packet, input.planDigest);
    if (!packetValidation.ok) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'invalid_implementation_packet', errors: packetValidation.errors };
    return options.workRunStore.acceptPlan({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      expectedPlanDigest: input.expectedPlanDigest,
      planDigest: input.planDigest,
      providerPinDigest: input.providerPinDigest || claimed.workRun.providerSnapshot?.pinDigest,
      artifact: input.artifact,
    });
  }

  async function work(input = {}) {
    const claimed = claim(input);
    const accepted = claimed.workRun.acceptedPlan;
    if (!accepted || accepted.digest !== input.planDigest) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'accepted_plan_mismatch' };
    const packetValidation = validateImplementationPacket(input.packet, accepted.digest);
    if (!packetValidation.ok) return { ok: false, status: 'blocked', workRunId: claimed.workRunId, reasonCode: 'invalid_implementation_packet', errors: packetValidation.errors };
    const request = requestFor('work', input, claimed, accepted.digest);
    const invocation = buildProviderInvocation({ operation: 'work', request, packet: packetValidation.packet });
    if (providerHealthy(manifest, providerSnapshotFor(input, claimed), 'work') && typeof providerAdapter.work === 'function') {
      try {
        const receipt = await providerAdapter.work(invocation);
        const validation = validateWorkflowProviderReceipt(receipt, { manifest, request });
        if (validation.ok) {
          const recorded = options.workRunStore.recordProviderReceipt({ ...input, workRunId: claimed.workRunId, ownerId: claimed.ownerId, fence: claimed.fence, receipt, manifest, request });
          if (recorded.ok) return { ok: true, status: 'succeeded', route: 'compound-engineering', workRunId: claimed.workRunId, receipt: validation.receipt };
        }
        appendRoute(claimed, request, 'fallback', 'invalid_provider_receipt', validation.errors?.join('; ') || 'provider receipt was not recorded');
      } catch (error) {
        appendRoute(claimed, request, 'fallback', 'provider_unavailable', error.message);
      }
    } else {
      appendRoute(claimed, request, 'fallback', 'provider_unsupported', 'provider is not healthy for the active harness');
    }
    if (typeof nativeAdapter.work !== 'function') return { ok: false, status: 'blocked', route: 'native-fallback', workRunId: claimed.workRunId, reasonCode: 'native_route_unavailable' };
    const native = await nativeAdapter.work({ ...invocation, route: 'native-fallback' });
    return { ok: true, status: 'succeeded', route: 'native-fallback', workRunId: claimed.workRunId, work: native };
  }

  function learningEvent(claimed) {
    const run = options.workRunStore.getWorkRun(claimed.workRunId, { public: false });
    return run?.events?.find((event) => event.operation === 'compound') || null;
  }

  function recordLearningOutcome(claimed, outcome, nonce, detail) {
    return options.workRunStore.appendEvent({
      workRunId: claimed.workRunId,
      ownerId: claimed.ownerId,
      fence: claimed.fence,
      type: 'route',
      operation: 'compound',
      status: outcome,
      operationNonce: nonce,
      reasonCode: detail?.reasonCode || null,
      detail: detail?.rationale ? [detail.rationale] : null,
    });
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

    const eligibility = input.learningEligibility || evaluateLearningEligibility({
      verification: input.verification || input.orchestration,
      signals: input.learningSignals ?? input.learning,
      declined: input.declineLearning === true || input.declinedLearning === true,
    });
    const nonce = `compound-${claimed.workRunId}`;
    if (eligibility.status !== 'eligible') {
      const recorded = recordLearningOutcome(claimed, eligibility.status, nonce, eligibility);
      return {
        ok: eligibility.status !== 'failed',
        status: eligibility.status,
        learningStatus: eligibility.status,
        route: 'jarvos-learning-gate',
        workRunId: claimed.workRunId,
        reasonCode: eligibility.reasonCode,
        rationale: eligibility.rationale,
        event: recorded.event || null,
      };
    }

    const run = options.workRunStore.getWorkRun(claimed.workRunId, { public: false });
    const acceptedPlanDigest = input.planDigest || run?.acceptedPlan?.digest;
    if (!acceptedPlanDigest) {
      const outcome = { status: 'unavailable', reasonCode: 'accepted_plan_missing', rationale: 'learning capture requires an accepted provider-independent plan revision' };
      const recorded = recordLearningOutcome(claimed, outcome.status, nonce, outcome);
      return { ok: true, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, event: recorded.event || null };
    }

    let request;
    try {
      request = requestFor('compound', input, claimed, acceptedPlanDigest);
    } catch (error) {
      const outcome = { status: 'unavailable', reasonCode: 'provider_identity_unavailable', rationale: 'approved provider identity is not available for learning capture' };
      const recorded = recordLearningOutcome(claimed, outcome.status, nonce, outcome);
      return { ok: true, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, event: recorded.event || null };
    }

    const snapshot = providerSnapshotFor(input, claimed);
    if (!providerHealthy(manifest, snapshot, 'compound') || typeof providerAdapter.compound !== 'function') {
      const outcome = { status: 'unavailable', reasonCode: 'provider_unsupported', rationale: 'provider is not healthy for the active harness' };
      const recorded = recordLearningOutcome(claimed, outcome.status, nonce, outcome);
      return { ok: true, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, event: recorded.event || null };
    }

    const invocation = buildProviderInvocation({ operation: 'compound', request });
    invocation.learning = {
      category: eligibility.learning.category,
      summary: eligibility.learning.summary,
      evidenceDigest: eligibility.learning.evidenceDigest,
    };
    let receipt;
    try {
      receipt = await providerAdapter.compound(invocation);
    } catch (error) {
      const outcome = { status: 'unavailable', reasonCode: 'provider_unavailable', rationale: 'provider did not return a learning receipt' };
      const recorded = recordLearningOutcome(claimed, outcome.status, nonce, outcome);
      return { ok: true, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, event: recorded.event || null };
    }
    const validation = validateWorkflowProviderReceipt(receipt, { manifest, request });
    if (!validation.ok) {
      const outcome = { status: 'failed', reasonCode: 'invalid_provider_receipt', rationale: 'provider learning receipt failed the strict contract' };
      const recorded = recordLearningOutcome(claimed, outcome.status, nonce, outcome);
      return { ok: false, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, errors: validation.errors, event: recorded.event || null };
    }
    const screen = screenLearningReceipt(validation.receipt);
    if (!screen.ok) {
      const outcome = { status: 'failed', reasonCode: 'unsafe_learning_artifact', rationale: 'learning receipt contained private or unsafe content' };
      const recorded = recordLearningOutcome(claimed, outcome.status, nonce, outcome);
      return { ok: false, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, errors: screen.errors, event: recorded.event || null };
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
    if (!recorded.ok) {
      const outcome = { status: 'failed', reasonCode: recorded.reason || 'learning_receipt_not_recorded', rationale: 'learning receipt could not be durably attached to the work run' };
      return { ok: false, ...outcome, learningStatus: outcome.status, route: 'jarvos-learning-gate', workRunId: claimed.workRunId, event: null };
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
    const result = await runTakeIssueToDone({ ...input, workRunId: claimed.workRunId, branch: input.branch || input.branchName }, adapters);
    if (result.learning?.status === 'eligible') {
      const learning = await compound({
        ...input,
        workRunId: claimed.workRunId,
        learning: result.learning.learning,
        learningEligibility: result.learning,
        verification: result,
        planDigest: input.planDigest || claimed.workRun.acceptedPlan?.digest,
      });
      return { ...result, learning, workRunId: claimed.workRunId, route: 'jarvos-orchestrator' };
    }
    return { ...result, workRunId: claimed.workRunId, route: 'jarvos-orchestrator' };
  }

  return {
    manifest,
    plan,
    acceptPlan,
    work,
    compound,
    complete,
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
